'use strict';

/**
 * ACP 运行时封装 + 模型发现 + 并发限制。
 *
 * 重要边界：本文件只用 stdio 跟官方 ACP 二进制说话，从不直接访问 Google。
 * 凭据由那个二进制自己保存（~/.gemini/antigravity-acp/）。
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const LEVEL_RE = /^(.*)-(low|medium|high)$/;
const STDERR_LIMIT = 16 * 1024;

function levelOfEffort(effort) {
  const level = String(effort || '').toLowerCase();
  if (level === 'low' || level === 'minimal') return 'low';
  if (level === 'high' || level === 'xhigh' || level === 'max') return 'high';
  return 'medium';
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
  constructor({ getConfig, log = () => {} }) {
    this.getConfig = getConfig;
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
    this.discovery = { at: 0, groups: new Map(), raw: [] };
  }

  childEnv() {
    const cfg = this.getConfig();
    const env = { ...process.env, NO_COLOR: '1' };
    if (cfg.proxy) {
      for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']) env[key] = cfg.proxy;
      env.NO_PROXY = '127.0.0.1,localhost,::1';
      env.no_proxy = '127.0.0.1,localhost,::1';
    }
    return env;
  }

  async start() {
    if (this.ready) return this.agentInfo;
    if (this.starting) return this.starting;
    this.starting = this.#boot().finally(() => { this.starting = null; });
    return this.starting;
  }

  async #boot() {
    const cfg = this.getConfig();
    if (!cfg.bin || !fs.existsSync(cfg.bin)) {
      throw Object.assign(new Error('未找到 ACP 运行时，请在面板下载或指定 agy_acp_server.exe 路径'), { code: 'NO_RUNTIME' });
    }
    this.log(`启动 ACP 运行时：${path.basename(cfg.bin)}${cfg.proxy ? `（代理 ${cfg.proxy}）` : '（直连）'}`);
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
        // 纯聊天场景不提供文件/终端能力；统一回空结果避免挂起。
        this.#write({ jsonrpc: '2.0', id: msg.id, result: null });
      } else {
        this.onNotification(msg);
      }
    }
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
    try { this.child?.kill(); } catch { /* ignore */ }
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
    const probe = await this.request('session/new', { cwd: cfg.cwd || path.dirname(cfg.bin), mcpServers: [] }, 60000);
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
    return this.discovery;
  }

  /** OpenAI /v1/models 的 data 数组。 */
  async modelsForApi() {
    const cfg = this.getConfig();
    const found = await this.discover({ force: true });
    const data = [];
    for (const group of found.groups.values()) {
      if (group.levels.size === 0 || cfg.virtualModels !== false) {
        const display = group.names[0].replace(/\s*\((?:low|medium|high)\)\s*$/i, '');
        data.push({ id: group.base, object: 'model', owned_by: 'google-antigravity', name: display || group.base });
      }
      if (cfg.exposeVariantModels === true) {
        for (const id of group.levels.values()) data.push({ id, object: 'model', owned_by: 'google-antigravity' });
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

module.exports = { AcpRuntime, createLimiter, levelOfEffort };
