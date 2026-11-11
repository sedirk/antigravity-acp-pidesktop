'use strict';

/**
 * ACP 运行时封装 + 模型发现 + 并发限制。
 *
 * 重要边界：本文件只用 stdio 跟官方 ACP 二进制说话，从不直接访问 Google。
 * 凭据由那个二进制自己保存（~/.gemini/antigravity-acp/）。
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const os = require('node:os');

const LEVEL_RE = /^(.*)-(low|medium|high)$/;
const STDERR_LIMIT = 16 * 1024;

/**
 * 结束整棵进程树。
 * 运行时是 agy_acp_server.exe 再派生 agy_acp_server.exe + localharness_external.exe，
 * 只用 child.kill() 会留下孤儿（Windows 不会级联），孤儿还会吃同一账号的并发额度。
 */
function killTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 15000, stdio: ['ignore', 'ignore', 'ignore'] });
      return;
    } catch { /* 落到下面的兜底 */ }
  }
  try { process.kill(pid); } catch { /* ignore */ }
}

function levelOfEffort(effort) {
  const level = String(effort || '').toLowerCase();
  if (level === 'low' || level === 'minimal') return 'low';
  if (level === 'high' || level === 'xhigh' || level === 'max') return 'high';
  return 'medium';
}

const READ_ONLY_TOOL_KINDS = new Set(['search', 'fetch', 'read']);

/**
 * 决定怎么回答 agent 的 session/request_permission。
 * policy:
 *   'all'（默认）  = 全部放行（含写文件）；本插件不额外设防，边界交给运行时工作区
 *   'shell'        = 放行只读 + execute（跑命令），仍挡 edit（写文件）
 *   'agent'        = 放行只读 + kind=other（子代理、后台任务、生图、定时），仍挡 edit 与 execute
 *   'search'       = 只放行只读工具（联网搜索、抓网页、读文件）
 *   'none'         = 全部拒绝（纯聊天网关）
 * ACP 的选项 kind 有 allow_once / allow_always / reject_once / reject_always。
 */
function permissionOutcome(policy, params) {
  const tool = (params && params.toolCall) || {};
  const kind = String(tool.kind || 'other').toLowerCase();
  const options = Array.isArray(params && params.options) ? params.options.filter((o) => o && typeof o === 'object') : [];
  const allow = options.find((o) => o.kind === 'allow_once' || o.kind === 'allow_always');
  const reject = options.find((o) => o.kind === 'reject_once' || o.kind === 'reject_always');
  const readOnly = READ_ONLY_TOOL_KINDS.has(kind);
  const shouldAllow = policy === 'all'
    || (policy === 'search' && readOnly)
    || (policy === 'agent' && (readOnly || kind === 'other'))
    || (policy === 'shell' && (readOnly || kind === 'other' || kind === 'execute'));
  if (shouldAllow && allow) return { decision: 'allow', kind, outcome: { outcome: 'selected', optionId: allow.optionId } };
  if (reject) return { decision: 'reject', kind, outcome: { outcome: 'selected', optionId: reject.optionId } };
  return { decision: 'cancel', kind, outcome: { outcome: 'cancelled' } };
}

// ---------------------------------------------------------------- 并发限制

/**
 * limit <= 0 ⇒ 不限制（默认）。
 * limit >= 1 ⇒ 同一时刻最多 limit 个任务，其余 FIFO 排队，超时/队满直接拒绝。
 */
function createLimiter({ limit, maxQueue, queueTimeoutMs, log = () => {} }) {
  const cap = Number(limit) > 0 ? Math.floor(Number(limit)) : 0;
  const capQueue = Number(maxQueue) > 0 ? Math.floor(Number(maxQueue)) : 16;
  const timeoutMs = Number(queueTimeoutMs) > 0 ? Math.floor(Number(queueTimeoutMs)) : 300000;
  let active = 0;
  const queue = [];

  function drain() {
    if (cap <= 0) return;
    while (active < cap && queue.length > 0) {
      const entry = queue.shift();
      entry.execute();
    }
  }

  function run(fn) {
    if (cap <= 0) {
      active += 1;
      return Promise.resolve().then(fn).finally(() => { active -= 1; });
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      const execute = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        active += 1;
        Promise.resolve().then(fn).then(
          (value) => { active -= 1; drain(); resolve(value); },
          (error) => { active -= 1; drain(); reject(error); },
        );
      };
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        const index = queue.findIndex((item) => item.execute === execute);
        if (index >= 0) queue.splice(index, 1);
        reject(Object.assign(new Error('排队超时，请稍后重试或调大「最大并发」'), { code: 'QUEUE_TIMEOUT' }));
      }, timeoutMs);

      if (active < cap) execute();
      else if (queue.length >= capQueue) {
        settled = true;
        clearTimeout(timer);
        reject(Object.assign(new Error('队列已满，请稍后重试'), { code: 'QUEUE_FULL' }));
      } else {
        queue.push({ execute });
        log(`请求排队：active=${active} queued=${queue.length} limit=${cap}`);
      }
    });
  }

  return {
    run,
    stats: () => ({ limit: cap, active, queued: queue.length }),
    setLimit: () => { /* 由重启服务应用新配置 */ },
  };
}

// ---------------------------------------------------------------- ACP 客户端

class AcpRuntime {
  constructor({ getConfig, getProxy, getCwd, log = () => {} }) {
    this.getConfig = getConfig;
    this.getProxy = typeof getProxy === 'function' ? getProxy : null;
    // 工作目录：配置里为空时回到宿主问「当前项目目录」，再兜底用户主目录
    this.getCwd = typeof getCwd === 'function' ? getCwd : null;
    this.log = log;
    this.child = null;
    this.buf = '';
    this.nextId = 1;
    this.pending = new Map();
    this.ready = false;
    this.starting = null;
    this.stderrTail = '';
    this.agentInfo = null;
    this.onNotification = () => {};
    this.onExit = () => {};
    // 按会话的工具权限覆盖（请求级 tool_policy / 宿主声明 web_search 时用），不传则用配置
    this.policyBySession = new Map();
    this.discovery = { at: 0, groups: new Map(), raw: [] };
  }

  childEnv() {
    const env = { ...process.env, NO_COLOR: '1' };
    const proxy = String(this.getProxy ? this.getProxy() : (this.getConfig().proxy || '') || '').trim();
    if (proxy) {
      for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']) env[key] = proxy;
      env.NO_PROXY = '127.0.0.1,localhost,::1';
      env.no_proxy = '127.0.0.1,localhost,::1';
    } else {
      for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy']) delete env[key];
    }
    return env;
  }

  async start() {
    if (this.ready) return this.agentInfo;
    if (this.starting) return this.starting;
    this.starting = this.#boot().finally(() => { this.starting = null; });
    return this.starting;
  }

  /**
   * 会话工作目录（运行时 view_file / run_command / write_to_file 的白名单根）。
   * 优先级：面板里显式填的 cwd → 宿主报告的项目目录 → 用户主目录。
   * 每次建会话时现问一次，所以切换 PI-Desktop 项目后不用重启网关。
   */
  async cwdFor() {
    const cfg = this.getConfig() || {};
    if (typeof cfg.cwd === 'string' && cfg.cwd.trim()) return cfg.cwd.trim();
    if (this.getCwd) {
      try {
        const fromHost = await this.getCwd();
        if (typeof fromHost === 'string' && fromHost.trim() && fs.existsSync(fromHost.trim())) return fromHost.trim();
      } catch (error) {
        this.log(`读取宿主项目目录失败：${String(error && error.message).slice(0, 120)}`);
      }
    }
    return os.homedir();
  }

  async #boot() {
    const cfg = this.getConfig();
    if (!cfg.bin || !fs.existsSync(cfg.bin)) {
      throw Object.assign(new Error('未找到 ACP 运行时，请在面板下载或指定 agy_acp_server.exe 路径'), { code: 'NO_RUNTIME' });
    }
    const shownProxy = this.getProxy ? this.getProxy() : cfg.proxy;
    this.log(`启动 ACP 运行时：${path.basename(cfg.bin)}${shownProxy ? `（代理 ${shownProxy}）` : '（直连）'}`);
    const child = spawn(cfg.bin, [], {
      cwd: path.dirname(cfg.bin),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: this.childEnv(),
    });
    this.child = child;
    this.buf = '';
    this.stderrTail = '';

    child.stdout.on('data', (chunk) => this.#onData(chunk));
    child.stderr.on('data', (chunk) => {
      this.stderrTail = (this.stderrTail + String(chunk)).slice(-STDERR_LIMIT);
    });
    child.on('exit', (code, signal) => {
      this.ready = false;
      this.child = null;
      for (const [, pending] of this.pending) pending.reject(new Error(`ACP 运行时退出（code=${code} signal=${signal || ''}）`));
      this.pending.clear();
      this.log(`ACP 运行时退出 code=${code} signal=${signal || ''}`);
      if (typeof this.onExit === 'function') {
        try { this.onExit(); } catch { /* ignore */ }
      }
    });

    const info = await this.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: 'antigravity-acp-pidesktop', version: '0.1.0' },
    }, 30000);
    this.ready = true;
    this.agentInfo = info.agentInfo || null;
    this.log(`ACP 就绪：${info.agentInfo?.name} ${info.agentInfo?.version}`);
    return info;
  }

  #onData(chunk) {
    this.buf += chunk.toString('utf8');
    let index;
    while ((index = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, index).trim();
      this.buf = this.buf.slice(index + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id !== undefined && msg.id !== null && this.pending.has(msg.id)) {
        const pending = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) pending.reject(Object.assign(new Error(msg.error.message || 'ACP 错误'), { acp: msg.error }));
        else pending.resolve(msg.result);
        continue;
      }
      if (!msg.method) continue;
      if (msg.id !== undefined && msg.id !== null) {
        this.#answerIncoming(msg);
      } else {
        this.onNotification(msg);
      }
    }
  }


  /** 发通知（无 id、不等回复）。ACP 的 session/cancel 就是通知形式。 */
  notify(method, params) {
    if (!this.child) return false;
    this.#write({ jsonrpc: '2.0', method, params });
    return true;
  }
  /**
   * 回答 agent 发来的客户端请求。
   * 重点是 session/request_permission：agent 的 search_web / read_url_content / run_command
   * 都要先过这里，回 null 会被运行时判成「权限响应格式不合法」→ 工具直接失败
   * （实测报错 RequestPermissionResponse input_value=None）。
   */
  #answerIncoming(msg) {
    if (msg.method === 'session/request_permission') {
      const sessionPolicy = this.policyBySession.get(msg.params && msg.params.sessionId);
      const policy = sessionPolicy || (this.getConfig().toolPolicy) || 'all';
      const { decision, kind, outcome } = permissionOutcome(policy, msg.params);
      this.#write({ jsonrpc: '2.0', id: msg.id, result: { outcome } });
      const title = String((msg.params && msg.params.toolCall && msg.params.toolCall.title) || kind).slice(0, 80);
      this.log(`工具权限 ${decision === 'allow' ? '放行' : decision === 'reject' ? '拒绝' : '取消'}：${title}（kind=${kind}，策略=${policy}）`);
      if (typeof this.onPermission === 'function') this.onPermission({ kind, decision, params: msg.params });
      return;
    }
    // 其它客户端方法（读文件/终端/MCP 握手）一律回 JSON-RPC 错误，别让 agent 挂住，也别暴露本机。
    this.#write({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `不支持的客户端方法: ${msg.method}` } });
    this.log(`已拒绝 agent 的客户端请求：${msg.method}`);
  }

  #write(payload) {
    if (!this.child) return;
    try { this.child.stdin.write(`${JSON.stringify(payload)}\n`); } catch { /* ignore */ }
  }

  request(method, params, timeoutMs = 60000) {
    if (!this.child) return Promise.reject(new Error('ACP 运行时未启动'));
    const id = this.nextId++;
    this.#write({ jsonrpc: '2.0', id, method, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Object.assign(new Error(`ACP ${method} 超时（${timeoutMs}ms）`), { code: 'ACP_TIMEOUT' }));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
    });
  }

  kill() {
    const pid = this.child ? this.child.pid : 0;
    if (pid) killTree(pid);
    this.child = null;
    this.ready = false;
    for (const [, pending] of this.pending) pending.reject(new Error('ACP 运行时已停止'));
    this.pending.clear();
  }

  status() {
    const limiterStats = this.limiter ? this.limiter.stats() : null;
    return {
      running: this.ready,
      agent: this.agentInfo,
      pid: this.child ? this.child.pid : null,
      models: this.discovery.groups.size,
      limiter: limiterStats,
      stderr: this.stderrTail.slice(-600),
    };
  }

  // -------------------------------------------------------------- 模型

  /**
   * 从 ACP 实际下发的模型名自动分组：xxx-low / xxx-medium / xxx-high → 虚拟模型 xxx。
   * 新模型上线不用改代码，只要还带档位后缀就会被自动识别。
   */
  async discover({ force = false } = {}) {
    const cfg = this.getConfig();
    const ttl = Number(cfg.modelCacheMs) > 0 ? Number(cfg.modelCacheMs) : 0;
    if (!force && this.discovery.groups.size > 0 && Date.now() - this.discovery.at < ttl) return this.discovery;
    await this.start();
    const probe = await this.request('session/new', { cwd: await this.cwdFor(), mcpServers: [] }, 60000);
    const raw = (probe.models?.availableModels || []).map((m) => ({ id: m.modelId, name: m.name || m.modelId }));
    const groups = new Map();
    for (const item of raw) {
      const match = LEVEL_RE.exec(item.id);
      const base = match ? match[1] : item.id;
      if (!groups.has(base)) groups.set(base, { base, levels: new Map(), names: [] });
      const group = groups.get(base);
      group.names.push(item.name);
      if (match) group.levels.set(match[2], item.id);
    }
    this.discovery = { at: Date.now(), groups, raw };
    this.log(`模型发现：${raw.length} 个 ACP 模型 → ${groups.size} 个虚拟模型`);
    // 探测用的会话必须关掉：旧版每 5 分钟建一个 session/new 却从不 close，
    // 后台 worker 会一直堆着（每个都不小），也会拖慢随后的首包。
    try { await this.request('session/close', { sessionId: probe.sessionId }, 5000); } catch { /* 关不掉也不阻塞模型发现 */ }
    return this.discovery;
  }

  /** OpenAI /v1/models 的 data 数组。 */
  async modelsForApi() {
    const cfg = this.getConfig();
    const found = await this.discover();
    const data = [];
    for (const group of found.groups.values()) {
      // 能力元数据：PI-Desktop 之类的宿主靠它判断能否发图/发 reasoning_effort。
      // ACP 的思考档位就编码在模型 ID 后缀里（-low/-medium/-high），所以档位列表是固定的三档。
      const meta = {
        modalities: { input: ['text', 'image'], output: ['text'] },
        capabilities: ['text', 'image', 'reasoning'],
        supports_reasoning_effort: true,
        reasoning_efforts: ['low', 'medium', 'high'],
        context_length: 1048576,
      };
      if (group.levels.size === 0 || cfg.virtualModels !== false) {
        const display = group.names[0].replace(/\s*\((?:low|medium|high)\)\s*$/i, '');
        data.push({ id: group.base, object: 'model', owned_by: 'google-antigravity', name: display || group.base, ...meta });
      }
      if (cfg.exposeVariantModels === true) {
        for (const id of group.levels.values()) data.push({ id, object: 'model', owned_by: 'google-antigravity', ...meta });
      }
    }
    return data;
  }

  /** 虚拟模型 + reasoning_effort → 具体 ACP 模型 ID。 */
  resolveModel(model, effort) {
    const requested = String(model || '');
    const group = this.discovery.groups.get(requested);
    if (group && group.levels.size > 0) {
      const want = levelOfEffort(effort);
      if (group.levels.has(want)) return group.levels.get(want);
      const fallback = group.levels.has('medium') ? 'medium' : [...group.levels.keys()][0];
      return group.levels.get(fallback);
    }
    const explicit = LEVEL_RE.exec(requested);
    if (explicit && effort) return `${explicit[1]}-${levelOfEffort(effort)}`;
    return requested;
  }
}

module.exports = { AcpRuntime, createLimiter, levelOfEffort, killTree, permissionOutcome, READ_ONLY_TOOL_KINDS };
