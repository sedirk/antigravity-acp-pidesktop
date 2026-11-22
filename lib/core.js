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

const LEVEL_ORDER = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const LEVEL_RE = /^(.+?)-(extra[-_]high|minimal|low|medium|high|xhigh|max)$/i;
const DISPLAY_LEVEL_SUFFIX_RE = /\s*\((?:minimal|extra[\s_-]*low|low|medium|high|xhigh|extra[\s_-]*high|extra|max)(?:\s+thinking)?\)\s*$/i;
const CCPA_UNAMBIGUOUS_LEGACY_VARIANTS = Object.freeze({
  'gemini-3.5-flash-extra-low': { base: 'gemini-3.5-flash', level: 'low', rawLevel: 'extra-low' },
  'gemini-3-flash-agent': { base: 'gemini-3.5-flash', level: 'high', rawLevel: 'agent' },
  'gemini-pro-agent': { base: 'gemini-3.1-pro', level: 'high', rawLevel: 'agent' },
});
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

function canonicalEffort(effort) {
  const raw = String(effort || '').trim().toLowerCase();
  if (!raw) return '';
  if (raw === 'minimal') return 'minimal';
  if (raw === 'low' || raw === 'extra-low' || raw === 'extra_low') return 'low';
  if (raw === 'medium') return 'medium';
  if (raw === 'high') return 'high';
  if (raw === 'xhigh' || raw === 'extra_high' || raw === 'extra-high' || raw === 'extra') return 'xhigh';
  if (raw === 'max') return 'max';
  return '';
}

function levelOfEffort(effort) {
  return canonicalEffort(effort) || 'medium';
}

function parseModelVariant(modelId, rawIdSet = null, modelName = '') {
  const id = String(modelId || '').trim();
  if (!id) return null;
  const lower = id.toLowerCase();
  if (Object.prototype.hasOwnProperty.call(CCPA_UNAMBIGUOUS_LEGACY_VARIANTS, lower)) {
    return CCPA_UNAMBIGUOUS_LEGACY_VARIANTS[lower];
  }
  const isCcpaFlashMedium =
    lower === 'gemini-3.5-flash-low' &&
    !(rawIdSet && rawIdSet.has('gemini-3.5-flash-medium')) &&
    Boolean(
      (rawIdSet && (rawIdSet.has('gemini-3.5-flash-extra-low') || rawIdSet.has('gemini-3-flash-agent'))) ||
      /\(\s*medium(?:\s+thinking)?\s*\)\s*$/i.test(String(modelName || '')),
    );
  if (isCcpaFlashMedium) {
    return { base: 'gemini-3.5-flash', level: 'medium', rawLevel: 'low' };
  }
  const core = id.replace(/-effort$/i, '');
  const match = LEVEL_RE.exec(core);
  if (!match || !match[1]) return null;
  const level = canonicalEffort(match[2]);
  if (!level) return null;
  return { base: match[1], level, rawLevel: match[2].toLowerCase() };
}

function pickVariantFromGroup(group, want, rawEffort = '') {
  if (!group || !group.levels || group.levels.size === 0) return '';
  const rawKey = String(rawEffort || '').trim().toLowerCase();
  const scopedRawKey = rawKey ? `${want}:${rawKey}` : '';
  if (scopedRawKey && group.rawLevelsByTier && group.rawLevelsByTier.has(scopedRawKey)) {
    return group.rawLevelsByTier.get(scopedRawKey);
  }
  if (group.levels.has(want)) return group.levels.get(want);
  if (want === 'max') {
    if (group.levels.has('xhigh')) return group.levels.get('xhigh');
    if (group.levels.has('high')) return group.levels.get('high');
  }
  if (want === 'xhigh') {
    if (group.levels.has('high')) return group.levels.get('high');
    if (group.levels.has('max')) return group.levels.get('max');
  }
  if (want === 'minimal' && group.levels.has('low')) return group.levels.get('low');
  if (want === 'low' && group.levels.has('minimal')) return group.levels.get('minimal');
  const fallback = group.levels.has('medium') ? 'medium' : [...group.levels.keys()][0];
  return group.levels.get(fallback);
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

  function acquireSlot({ priority = false, isCancelled = null, registerAbort = null } = {}) {
    if (typeof isCancelled === 'function' && isCancelled()) {
      return Promise.reject(Object.assign(new Error('Prompt cancelled while acquiring concurrency slot'), { code: 'PROMPT_CANCELLED' }));
    }
    if (cap <= 0 || active < cap) {
      active += 1;
      return Promise.resolve();
    }
    if (queue.length >= capQueue) {
      return Promise.reject(Object.assign(new Error('队列已满，请稍后重试'), { code: 'QUEUE_FULL' }));
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      let offAbort = null;
      const cleanup = () => {
        clearTimeout(timer);
        if (typeof offAbort === 'function') {
          try { offAbort(); } catch { /* ignore */ }
          offAbort = null;
        }
      };
      const execute = () => {
        if (settled) return;
        if (typeof isCancelled === 'function' && isCancelled()) {
          settled = true;
          cleanup();
          reject(Object.assign(new Error('Prompt cancelled while queued'), { code: 'PROMPT_CANCELLED' }));
          drain();
          return;
        }
        settled = true;
        cleanup();
        active += 1;
        resolve();
      };
      const removeQueued = () => {
        const index = queue.findIndex((item) => item.execute === execute);
        if (index >= 0) queue.splice(index, 1);
      };
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        removeQueued();
        cleanup();
        reject(Object.assign(new Error('排队超时，请稍后重试或调大「最大并发」'), { code: 'QUEUE_TIMEOUT' }));
      }, timeoutMs);
      timer.unref?.();
      if (typeof registerAbort === 'function') {
        offAbort = registerAbort(() => {
          if (settled) return;
          settled = true;
          removeQueued();
          cleanup();
          reject(Object.assign(new Error('Prompt cancelled while queued'), { code: 'PROMPT_CANCELLED' }));
        });
      }
      if (priority) queue.unshift({ execute });
      else queue.push({ execute });
      log(`请求排队：active=${active} queued=${queue.length} limit=${cap}${priority ? '（续流优先）' : ''}`);
    });
  }

  async function run(fn) {
    await acquireSlot();
    let holding = true;
    let closed = false;
    let resumingPromise = null;
    const closedListeners = new Set();
    const lease = {
      isHolding: () => holding,
      isClosed: () => closed,
      releaseForPark() {
        if (closed || !holding) return false;
        holding = false;
        active = Math.max(0, active - 1);
        drain();
        return true;
      },
      async resumeFromPark(opts = {}) {
        if (closed) {
          throw Object.assign(new Error('Prompt lease already closed'), { code: 'PROMPT_CANCELLED' });
        }
        if (holding) return true;
        if (resumingPromise) return resumingPromise;
        const isAborted = () => closed || (typeof opts.isCancelled === 'function' && opts.isCancelled());
        const wrapRegisterAbort = (cb) => {
          closedListeners.add(cb);
          const off = typeof opts.registerAbort === 'function' ? opts.registerAbort(cb) : null;
          return () => {
            closedListeners.delete(cb);
            if (typeof off === 'function') off();
          };
        };
        resumingPromise = (async () => {
          try {
            await acquireSlot({ priority: true, isCancelled: isAborted, registerAbort: wrapRegisterAbort });
            if (isAborted()) {
              active = Math.max(0, active - 1);
              drain();
              throw Object.assign(new Error('Prompt cancelled or closed on resume'), { code: 'PROMPT_CANCELLED' });
            }
            holding = true;
            return true;
          } finally {
            resumingPromise = null;
          }
        })();
        return resumingPromise;
      },
    };
    try {
      return await fn(lease);
    } finally {
      closed = true;
      for (const cb of [...closedListeners]) {
        try { cb(); } catch { /* ignore */ }
      }
      closedListeners.clear();
      if (holding) {
        holding = false;
        active = Math.max(0, active - 1);
        drain();
      }
    }
  }

  return {
    run,
    stats: () => ({ limit: cap, active, queued: queue.length }),
    setLimit: () => { /* 由重启服务应用新配置 */ },
  };
}

// ---------------------------------------------------------------- ACP 客户端

class AcpRuntime {
  constructor({ getConfig, getProxy, getCwd, getAdditionalDirs, log = () => {} }) {
    this.getConfig = getConfig;
    this.getProxy = typeof getProxy === 'function' ? getProxy : null;
    // 工作目录：配置里为空时回到宿主问「当前项目目录」，再兜底用户主目录
    this.getCwd = typeof getCwd === 'function' ? getCwd : null;
    this.getAdditionalDirs = typeof getAdditionalDirs === 'function' ? getAdditionalDirs : null;
    this.log = log;
    this.child = null;
    this.buf = '';
    this.nextId = 1;
    this.pending = new Map();
    this.ready = false;
    this.starting = null;
    this.stderrTail = '';
    // 本次运行时是用哪个代理拉起来的（空串=直连）；运行时的网络路径 spawn 之后就改不了
    this.spawnProxy = '';
    this.agentInfo = null;
    this.agentCapabilities = null;
    this.tierInfo = null;
    this.maintenanceReason = '';
    this.onExit = () => {};
    // 按会话的工具权限覆盖（请求级 tool_policy / 宿主声明 web_search 时用），不传则用配置
    this.policyBySession = new Map();
    this.discovery = { at: 0, groups: new Map(), raw: [] };
    this.configOptions = [];
  }

  childEnv() {
    const env = { ...process.env, NO_COLOR: '1' };
    const proxy = this.proxyNow({ force: true });
    // 记下这次真正传给运行时的值：运行时的网络路径是 spawn 那一刻定死的，之后系统代理变了它不会跟。
    this.spawnProxy = proxy;
    if (proxy) {
      for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']) env[key] = proxy;
      env.NO_PROXY = '127.0.0.1,localhost,::1';
      env.no_proxy = '127.0.0.1,localhost,::1';
    } else {
      for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy']) delete env[key];
    }
    return env;
  }

  /** 现在应该用的代理（空串 = 直连）。每次现问，所以系统代理晚于插件启动也能拿到。 */
  proxyNow(options = {}) {
    return String(this.getProxy ? this.getProxy(options) : (this.getConfig().proxy || '') || '').trim();
  }

  /**
   * 运行时启动时的网络路径与当前应走路径不一致时触发重建：
   * 1) 直连 → 有代理，或切换了新的代理端口；
   * 2) 面板显式设为 direct 直连，但当前进程仍带着旧代理。
   * auto 模式下「有代理 → 暂时无代理」不在空闲请求前主动重启，避免 VPN 短暂抖动反复杀进程；
   * 若旧本地代理端口确实已死，会由 prompt 层的 connectex 回环自愈立即接管重启。
   */
  proxyDrift() {
    if (!this.ready || !this.child) return '';
    const current = this.proxyNow();
    if (!current) {
      const cfg = this.getConfig() || {};
      if (cfg.proxyMode === 'direct' && this.spawnProxy) return 'direct';
      return '';
    }
    if (current === this.spawnProxy) return '';
    return current;
  }

  async start() {
    if (this.maintenanceReason) {
      throw Object.assign(new Error(this.maintenanceReason), { code: 'RUNTIME_UPDATING' });
    }
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

  supportsAntigravityMeta() {
    return Boolean(this.agentCapabilities && this.agentCapabilities._meta && this.agentCapabilities._meta.antigravity);
  }

  supportsAdditionalDirectories() {
    return Boolean(this.agentCapabilities && this.agentCapabilities.sessionCapabilities && this.agentCapabilities.sessionCapabilities.additionalDirectories);
  }

  async additionalDirsFor(primaryCwd = '') {
    if (!this.supportsAdditionalDirectories()) return [];
    const cfg = this.getConfig() || {};
    const rawList = [];
    if (Array.isArray(cfg.additionalDirectories)) rawList.push(...cfg.additionalDirectories);
    if (this.getAdditionalDirs) {
      try {
        const fromHost = await this.getAdditionalDirs();
        if (Array.isArray(fromHost)) rawList.push(...fromHost);
      } catch { /* ignore */ }
    }
    if (rawList.length === 0) return [];
    const normPrimary = primaryCwd ? path.resolve(primaryCwd).toLowerCase() : '';
    const seen = new Set();
    const out = [];
    for (const entry of rawList) {
      if (typeof entry !== 'string' || !entry.trim()) continue;
      const trimmed = entry.trim();
      if (!path.isAbsolute(trimmed)) continue;
      const resolved = path.resolve(trimmed);
      const parsed = path.parse(resolved);
      if (resolved === parsed.root) continue;
      const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
      if (key === normPrimary || seen.has(key)) continue;
      try {
        if (!fs.statSync(resolved).isDirectory()) continue;
      } catch { continue; }
      seen.add(key);
      out.push(resolved);
    }
    return out;
  }

  async sessionParams(cwd, mcpServers = []) {
    const params = { cwd, mcpServers };
    const extraDirs = await this.additionalDirsFor(cwd);
    if (extraDirs.length > 0) {
      params.additionalDirectories = extraDirs;
    }
    if (this.supportsAntigravityMeta() && Array.isArray(mcpServers) && mcpServers.length > 0) {
      const cfg = this.getConfig() || {};
      const maxBytes = Number(cfg.mcpMaxOutputBytes);
      if (Number.isFinite(maxBytes) && maxBytes > 0) {
        params._meta = { antigravity: { mcpMaxOutputBytes: Math.round(maxBytes) } };
      }
    }
    return params;
  }

  ingestSessionMeta(res) {
    const tier = res && res._meta && res._meta.antigravity && res._meta.antigravity.tier;
    if (tier && typeof tier === 'object' && (tier.name || tier.id)) {
      this.tierInfo = {
        id: tier.id ? String(tier.id) : '',
        name: tier.name ? String(tier.name) : '',
        ...(tier.upgradeUri ? { upgradeUri: String(tier.upgradeUri) } : {}),
      };
    }
    return this.tierInfo;
  }

  async #boot() {
    if (this.maintenanceReason) {
      throw Object.assign(new Error(this.maintenanceReason), { code: 'RUNTIME_UPDATING' });
    }
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

    child.stdout.on('data', (chunk) => {
      if (this.child !== child) return;
      this.#onData(chunk);
    });
    child.stderr.on('data', (chunk) => {
      if (this.child !== child) return;
      this.stderrTail = (this.stderrTail + String(chunk)).slice(-STDERR_LIMIT);
    });
    child.on('error', (error) => {
      if (this.child !== child) return;
      this.log(`ACP 运行时子进程异常：${String(error && error.message).slice(0, 160)}`);
    });
    child.on('exit', (code, signal) => {
      // 旧进程在 restart()/kill() 之后的异步 exit 回调不得冲掉新拉起的进程与在途请求
      if (this.child !== child) return;
      this.ready = false;
      this.child = null;
      this.spawnProxy = '';
      this.agentCapabilities = null;
      // 运行时换了进程，旧缓存标记过期（at: 0），但保留已发现的分组作为降级兜底；
      // 这样新进程建探测会话若遇瞬态网络/认证抖动，不会立即退化为未知模型猜想。
      if (!this.discovery || !this.discovery.groups || this.discovery.groups.size === 0) {
        this.discovery = { at: 0, groups: new Map(), raw: [] };
      } else {
        this.discovery.at = 0;
      }
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
      // 上游按 clientInfo.name 门控非 Gemini 模型（Claude / GPT-OSS）。
      // 面板里填 Zed / Xcode / JetBrains / Android Studio 会解锁它们；留空就保持本插件自己的名字。
      clientInfo: { name: (cfg && cfg.clientName) || 'antigravity-acp-pidesktop', version: '0.1.0' },
    }, 30000);
    this.ready = true;
    this.agentInfo = info.agentInfo || null;
    this.agentCapabilities = info.agentCapabilities || null;
    this.log(`ACP 就绪：${info.agentInfo?.name} ${info.agentInfo?.version}`);
    return info;
  }

  #onData(chunk) {
    this.buf += chunk.toString('utf8');
    let index;
    while ((index = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, index).trim();
      this.buf = this.buf.slice(index + 1);
      if (line) this.handleLine(line);
    }
  }

  /**
   * 单行 JSON-RPC 分发。单独公开是为了让「响应 vs 请求」的判定能被测试直接覆盖。
   */
  handleLine(line) {
      let msg;
      try { msg = JSON.parse(line); } catch { return; }
      // 响应（result/error）没有 method；agent 发来的请求有 method。两者共用 id 命名空间，
      // 以前这里不区分，权限请求 id 撞上在途的 session/prompt id 时会把权限请求当成
      // prompt 的返回值 resolve(undefined)：正文为 0、stopReason 丢失，而且那条权限请求
      // 再也没人回答，运行时从此阻塞——就是「空答 + 后续 180 秒零事件」的成因。
      if (!msg.method && msg.id !== undefined && msg.id !== null && this.pending.has(msg.id)) {
        const pending = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) pending.reject(Object.assign(new Error(msg.error.message || 'ACP 错误'), { acp: msg.error }));
        else pending.resolve(msg.result);
        return;
      }
      if (!msg.method) return;
      if (msg.id !== undefined && msg.id !== null) {
        this.#answerIncoming(msg);
      } else {
        if (
          msg.method === 'session/update' &&
          msg.params &&
          msg.params.update &&
          msg.params.update.sessionUpdate === 'config_option_update' &&
          Array.isArray(msg.params.update.configOptions)
        ) {
          this.ingestConfigOptions(msg.params.update.configOptions);
        }
        this.onNotification(msg);
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
      // timeoutMs <= 0 表示不设硬上限：长任务可以跑几小时，止损交给上层「无进展」看门狗
      const timer = timeoutMs > 0 ? setTimeout(() => {
        this.pending.delete(id);
        reject(Object.assign(new Error(`ACP ${method} 超时（${timeoutMs}ms）`), { code: 'ACP_TIMEOUT' }));
      }, timeoutMs) : null;
      this.pending.set(id, {
        method,
        sessionId: params && params.sessionId ? String(params.sessionId) : '',
        resolve: (value) => { if (timer) clearTimeout(timer); resolve(value); },
        reject: (error) => { if (timer) clearTimeout(timer); reject(error); },
      });
    });
  }

  /**
   * 放弃仍在等待的某类请求。取消后运行时可能永远不回复，
   * 不能让那个 promise 一直挂到硬超时才放锁。
   * 支持按 sessionId 过滤，避免误伤其它会话的请求。
   */
  abandon(method, reason, sessionId = '') {
    let count = 0;
    const targetSession = sessionId ? String(sessionId) : '';
    for (const [id, pending] of [...this.pending]) {
      if (pending.method !== method) continue;
      if (targetSession && pending.sessionId && pending.sessionId !== targetSession) continue;
      this.pending.delete(id);
      pending.reject(Object.assign(new Error(reason || `ACP ${method} 已放弃`), { code: 'ACP_ABANDONED' }));
      count += 1;
    }
    return count;
  }

  /**
   * 运行时派生的 worker 数量与内存（Windows）。
   *
   * `agy_acp_server` 自己 + 每个会话一个 `localharness_external`。正常情况下 worker 会随
   * session/close 回收，所以这个数字应该跟着会话数起落；如果长期只增不减，说明运行时那边
   * 没放掉 worker，可以手动重启一次运行时（等价于「停掉重来」）。
   * 用 tasklist 而不是 PowerShell/CIM：快一个数量级，且 /health 会被频繁调用。结果缓存 30 秒。
   */
  workers() {
    const now = Date.now();
    if (this.workerCache && now - this.workerCache.at < 30000) return this.workerCache.value;
    let value = { count: 0, memMB: 0, supported: process.platform === 'win32' };
    if (process.platform === 'win32') {
      try {
        const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq localharness_external.exe', '/FO', 'CSV', '/NH'], {
          windowsHide: true, timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'],
        }).toString('utf8');
        let count = 0;
        let memKB = 0;
        for (const line of out.split(/\r?\n/)) {
          if (!/localharness_external/i.test(line)) continue;
          const cols = line.split('","');
          if (cols.length < 5) continue;
          count += 1;
          memKB += Number(String(cols[4]).replace(/[^\d]/g, '')) || 0;
        }
        value = { count, memMB: Math.round(memKB / 1024), supported: true };
      } catch { /* tasklist 不可用时保持 0 */ }
    }
    this.workerCache = { at: now, value };
    return value;
  }

  /** 手动重启运行时：杀掉整棵进程树，下一次请求由 ensureRuntime() 自动拉起。 */
  restart(reason = 'manual') {
    const pid = this.child ? this.child.pid : 0;
    this.log(`重启运行时（${reason}${pid ? `，pid ${pid}` : ''}）`);
    if (pid) killTree(pid);
    this.child = null;
    this.ready = false;
    this.starting = null;
    this.spawnProxy = '';
    this.agentCapabilities = null;
    this.discovery = { at: 0, groups: new Map(), raw: [] };
    this.configOptions = [];
    this.workerCache = null;
    for (const [, pending] of this.pending) pending.reject(new Error('ACP 运行时已重启'));
    this.pending.clear();
    if (typeof this.onExit === 'function') {
      try { this.onExit(); } catch { /* ignore */ }
    }
    return { pid, stopped: Boolean(pid) };
  }

  kill() {
    const pid = this.child ? this.child.pid : 0;
    if (pid) killTree(pid);
    this.child = null;
    this.ready = false;
    this.starting = null;
    this.spawnProxy = '';
    this.agentCapabilities = null;
    for (const [, pending] of this.pending) pending.reject(new Error('ACP 运行时已停止'));
    this.pending.clear();
  }

  enterMaintenance(reason = '正在升级官方 ACP 运行时，请稍候…') {
    this.maintenanceReason = String(reason || '正在升级官方 ACP 运行时，请稍候…');
    this.kill();
    if (typeof this.onExit === 'function') {
      try { this.onExit(); } catch { /* ignore */ }
    }
  }

  exitMaintenance() {
    this.maintenanceReason = '';
  }

  status() {
    const limiterStats = this.limiter ? this.limiter.stats() : null;
    return {
      running: this.ready,
      agent: this.agentInfo,
      tier: this.tierInfo,
      pid: this.child ? this.child.pid : null,
      // 运行时实际按什么网络路径起的：一眼能看出「配着代理却直连」这种自杀状态
      proxy: this.spawnProxy || '',
      models: this.discovery.groups.size,
      workers: this.workers(),
      limiter: limiterStats,
      stderr: this.stderrTail.slice(-600),
    };
  }

  // -------------------------------------------------------------- 模型

  /**
   * 从 ACP 实际下发的模型名自动分组：xxx-low / xxx-medium / xxx-high → 虚拟模型 xxx。
   * 新模型上线不用改代码，只要还带档位后缀就会被自动识别。
   *
   * 缓存为空时并发请求都会进来（resolveModel 也会补做发现），所以这里单飞：
   * 同一时刻只建一个探测会话，避免运行时里堆一串 worker。
   */
  /**
   * 用任意 session/new 返回的 availableModels 被动刷新模型目录，无需专门开探测会话。
   */
  ingestConfigOptions(configOptions) {
    if (!Array.isArray(configOptions) || configOptions.length === 0) return null;
    this.configOptions = configOptions;
    const modelOpt = configOptions.find(
      (opt) => opt && (opt.id === 'model' || opt.category === 'model') && Array.isArray(opt.options),
    );
    if (modelOpt && this.discovery && this.discovery.groups instanceof Map) {
      for (const option of modelOpt.options) {
        if (!option || !option.value || !option.name) continue;
        const group = this.discovery.groups.get(String(option.value));
        if (group && !group.displayName) {
          group.displayName = String(option.name);
        }
      }
    }
    return this.configOptions;
  }

  ingestSelection(res, opts = {}) {
    if (!res || typeof res !== 'object') {
      return { at: 0, groups: new Map(), raw: [], currentModelId: '', hasModelState: false, ingestedModels: false };
    }
    const modelOpt = Array.isArray(res.configOptions)
      ? res.configOptions.find((opt) => opt && (opt.id === 'model' || opt.category === 'model'))
      : null;
    const configModelVal = modelOpt
      ? String(
        modelOpt.currentValue ||
        modelOpt.value ||
        modelOpt.defaultValue ||
        (Array.isArray(modelOpt.options) && modelOpt.options.find((o) => o && (o.selected || o.current || o.isCurrent))?.value) ||
        '',
      ).trim()
      : '';
    const currentModelId = (res.models && typeof res.models.currentModelId === 'string' && res.models.currentModelId.trim())
      ? res.models.currentModelId.trim()
      : configModelVal;
    const hasModelState = Boolean(res.models || modelOpt);
    this.ingestSessionMeta(res);
    const models = res.models && Array.isArray(res.models.availableModels)
      ? this.ingestModels(res.models.availableModels, { ...opts, configOptions: res.configOptions })
      : null;
    if (!models && Array.isArray(res.configOptions)) {
      this.ingestConfigOptions(res.configOptions);
    }
    const base = models || this.discovery || { at: 0, groups: new Map(), raw: [] };
    return {
      ...base,
      currentModelId,
      hasModelState,
      ingestedModels: Boolean(models),
    };
  }

  ingestModels(availableModels, { silent = true, configOptions = null } = {}) {
    if (!Array.isArray(availableModels) || availableModels.length === 0) return null;
    const prevNames = new Map(
      Array.isArray(this.discovery && this.discovery.raw)
        ? this.discovery.raw.map((item) => [item.id, item.name])
        : [],
    );
    const raw = availableModels
      .map((m) => {
        if (typeof m === 'string' && m.trim()) {
          const id = m.trim();
          return { id, name: prevNames.get(id) || id };
        }
        if (m && typeof m === 'object' && m.modelId) {
          const id = String(m.modelId);
          return { id, name: String(m.name || prevNames.get(id) || id) };
        }
        return null;
      })
      .filter(Boolean);
    if (raw.length === 0) return null;
    const rawIdSet = new Set(raw.map((item) => item.id.toLowerCase()));
    const groups = new Map();
    for (const item of raw) {
      const parsed = parseModelVariant(item.id, rawIdSet, item.name);
      const base = parsed ? parsed.base : item.id;
      if (!groups.has(base)) {
        groups.set(base, { base, levels: new Map(), rawLevels: new Map(), rawLevelsByTier: new Map(), names: [], displayName: '' });
      }
      const group = groups.get(base);
      group.names.push(item.name);
      if (parsed) {
        if (!group.levels.has(parsed.level)) group.levels.set(parsed.level, item.id);
        if (parsed.rawLevel) {
          const scopedKey = `${parsed.level}:${parsed.rawLevel}`;
          if (!group.rawLevelsByTier.has(scopedKey)) group.rawLevelsByTier.set(scopedKey, item.id);
          if (parsed.rawLevel === parsed.level && !group.rawLevels.has(parsed.rawLevel)) {
            group.rawLevels.set(parsed.rawLevel, item.id);
          }
        }
      }
    }
    const prevCount = this.discovery.raw.length;
    this.discovery = { at: Date.now(), groups, raw };
    if (Array.isArray(configOptions) && configOptions.length > 0) {
      this.ingestConfigOptions(configOptions);
    } else if (Array.isArray(this.configOptions) && this.configOptions.length > 0) {
      this.ingestConfigOptions(this.configOptions);
    }
    if (!silent || prevCount === 0) {
      this.log(`模型发现：${raw.length} 个 ACP 模型 → ${groups.size} 个虚拟模型`);
    }
    return this.discovery;
  }

  async discover(opts = {}) {
    const force = typeof opts === 'boolean' ? opts : Boolean(opts && opts.force);
    const cfg = this.getConfig();
    const ttl = Number(cfg.modelCacheMs) > 0 ? Number(cfg.modelCacheMs) : 0;
    if (!force && this.discovery.groups.size > 0 && Date.now() - this.discovery.at < ttl) return this.discovery;
    if (this.discovering) return this.discovering;
    this.discovering = this.#discoverNow().finally(() => { this.discovering = null; });
    return this.discovering;
  }

  async #discoverNow() {
    await this.start();
    const cwd = await this.cwdFor();
    const probe = await this.request('session/new', await this.sessionParams(cwd, []), 60000);
    try {
      const ingested = this.ingestSelection(probe, { silent: false });
      if (ingested && ingested.ingestedModels) return this.discovery;
      this.discovery = { at: Date.now(), groups: new Map(), raw: [] };
      this.log('模型发现：0 个 ACP 模型 → 0 个虚拟模型');
      return this.discovery;
    } finally {
      // 探测用的会话必须关掉：旧版每 5 分钟建一个 session/new 却从不 close，
      // 后台 worker 会一直堆着（每个都不小），也会拖慢随后的首包。
      if (probe && probe.sessionId) {
        try { await this.request('session/close', { sessionId: probe.sessionId }, 5000); } catch { /* 关不掉也不阻塞模型发现 */ }
      }
    }
  }

  /** OpenAI /v1/models 的 data 数组。 */
  async modelsForApi(opts = {}) {
    const cfg = this.getConfig();
    const found = await this.discover(opts);
    const data = [];
    for (const group of found.groups.values()) {
      const hasLevels = group.levels.size > 0;
      const priorityLevels = hasLevels ? [...group.levels.keys()] : [];
      const levels = hasLevels
        ? [...priorityLevels].sort((a, b) => {
            const ra = LEVEL_ORDER.indexOf(a);
            const rb = LEVEL_ORDER.indexOf(b);
            return (ra < 0 ? 99 : ra) - (rb < 0 ? 99 : rb);
          })
        : [];
      // 如果模型本身有档位变体，或者 ID 包含 thinking，则表明具备思考/思维链能力
      const isThinking = hasLevels || /thinking/i.test(group.base);
      // 默认通告 256K；GPT-OSS 120B 保留较小的 128K 窗口。
      const defaultContextWindow = group.base.includes('120b') ? 131072 : 256000;
      const configuredContextWindow = Number(cfg.reportedContextWindow);
      const contextWindow = (Number.isFinite(configuredContextWindow) && configuredContextWindow > 0)
        ? configuredContextWindow
        : defaultContextWindow;
      // 默认通告 32K 输出上限：ACP session/prompt 不消费客户端 max_tokens（上游按模型物理上限生成），
      // 而 PI-Desktop 会按 Math.min(maxTokens, contextWindow * 0.25) 预扣 requestHeadroom；
      // 通告 32768 可避免 256K 窗口被预扣 64K（在 172.8K 过早循环触发压缩），将自动压缩阈值恢复至 ~200.9K。
      const configuredMaxTokens = Number(cfg.reportedMaxTokens);
      const maxTokens = (Number.isFinite(configuredMaxTokens) && configuredMaxTokens > 0)
        ? configuredMaxTokens
        : 32768;

      // 思考档位列表：有具体档位就用真实档位，若为通用思考模型则提供标准档位
      const thinkingLevels = levels.length > 0 ? levels : (isThinking ? ['low', 'medium', 'high'] : []);
      const defaultThinkingLevel = thinkingLevels.includes('medium')
        ? 'medium'
        : (priorityLevels[0] || thinkingLevels[0] || undefined);
      // 能力元数据：供 PI-Desktop 与各类客户端自适应解析
      const meta = {
        input: ['text', 'image'],
        modalities: { input: ['text', 'image'], output: ['text'] },
        limit: { context: contextWindow, input: contextWindow, output: maxTokens },
        capabilities: isThinking
          ? ['text', 'image', 'reasoning', 'tools', 'steer']
          : ['text', 'image', 'tools', 'steer'],
        supports_reasoning_effort: isThinking,
        supportsReasoningEffort: isThinking,
        supportsReasoning: isThinking,
        supports_images: true,
        supportsImages: true,
        supports_documents: true,
        supportsDocuments: true,
        // 自适应思考协议支持（针对 Gemini 4 / Claude 4.6 等现代思维链模型）
        thinkingProtocol: isThinking ? 'adaptive' : 'legacy',
        thinking_protocol: isThinking ? 'adaptive' : 'legacy',
        default_thinking_protocol: isThinking ? 'adaptive' : 'legacy',
        thinkingLevels,
        supportedThinkingLevels: thinkingLevels,
        defaultThinkingLevel,
        reasoning_efforts: thinkingLevels,
        context_window: contextWindow,
        contextWindow,
        context_length: contextWindow,
        max_tokens: maxTokens,
        maxTokens,
        max_output_tokens: maxTokens,
        canSteer: true,
        supports_steer: true,
        supports_steering: true,
      };

      if (group.levels.size === 0 || cfg.virtualModels !== false) {
        const rawTitle = group.displayName || (Array.isArray(group.names) && group.names[0]) || group.base;
        const display = String(rawTitle).replace(DISPLAY_LEVEL_SUFFIX_RE, '');
        data.push({ id: group.base, object: 'model', owned_by: 'google-antigravity', name: display || group.base, ...meta });
      }
      if (cfg.exposeVariantModels === true) {
        for (const [lvl, id] of group.levels.entries()) {
          data.push({
            id,
            object: 'model',
            owned_by: 'google-antigravity',
            ...meta,
            defaultThinkingLevel: lvl,
          });
        }
      }
    }
    return data;
  }

  /** 已知模型 id 集合（模型发现没成功时为空）。 */
  hasModel(id) {
    const wanted = String(id || '');
    if (!wanted) return false;
    return this.discovery.raw.some((m) => m.id === wanted);
  }

  /**
   * 虚拟模型 + reasoning_effort → 具体 ACP 模型 ID。
   *
   * 硬约束：**绝不返回裸虚拟名**（`gemini-4-carbon`）。运行时只认带档位后缀的 id
   * （`-low/-medium/-high`），裸名一定会被拒：
   *   Rejecting model gemini-4-carbon: not available under the active auth method.
   * 旧实现依赖 `discovery.groups` 命中；一旦模型发现没成功（启动预热失败、运行时重启过），
   * groups 为空，就把裸名原样发了出去 —— 于是每一轮都是 MODEL_SWITCH_FAILED。
   * 现在缓存为空时先补一次发现；仍然拿不到就按命名规则补档位，最后才报明确错误。
   */
  async resolveModel(model, effort) {
    const requested = String(model || '');
    const hasExplicitEffort = Boolean(effort !== undefined && effort !== null && String(effort).trim() !== '');
    const want = levelOfEffort(effort);
    let groups = this.discovery.groups;
    if (groups.size === 0) {
      try {
        await this.discover();
        groups = this.discovery.groups;
      } catch (error) {
        this.log(`模型发现失败，按命名规则推断模型 id：${String(error && error.message).slice(0, 120)}`);
      }
    }
    const group = groups.get(requested);
    if (group && group.levels.size > 0) {
      return pickVariantFromGroup(group, want, hasExplicitEffort ? effort : '');
    }
    // 没有档位变体的模型：group 命中就说明它本身就是完整 id（不是虚拟分组），原样返回
    if (group) return requested;
    if (!hasExplicitEffort && this.hasModel(requested)) return requested;
    const rawIdSet = new Set(this.discovery.raw.map((m) => m.id.toLowerCase()));
    const explicit = parseModelVariant(requested, rawIdSet);
    // 已经带档位后缀：未显式指定 effort 时仅允许同档位 wire 别名映射（如 -extra_high <-> -xhigh），绝不静默降级到其它档位
    if (explicit) {
      const explicitGroup = groups.get(explicit.base);
      if (!hasExplicitEffort) {
        if (this.hasModel(requested)) return requested;
        if (explicitGroup && explicitGroup.levels.size > 0) {
          const scopedKey = explicit.level && explicit.rawLevel ? `${explicit.level}:${explicit.rawLevel}` : '';
          const sameRaw = scopedKey && explicitGroup.rawLevelsByTier && explicitGroup.rawLevelsByTier.get(scopedKey);
          if (sameRaw) return sameRaw;
          const sameTier = explicit.level && explicitGroup.levels.get(explicit.level);
          if (sameTier) return sameTier;
        }
        return requested;
      }
      if (explicitGroup && explicitGroup.levels.size > 0) {
        return pickVariantFromGroup(explicitGroup, want, effort);
      }
      const rawSuffix = String(effort || '').trim().toLowerCase() === 'extra_high' ? 'extra_high' : want;
      const id = `${explicit.base}-${rawSuffix}`;
      if (this.hasModel(id)) return id;
      if (want === 'xhigh' && this.hasModel(`${explicit.base}-extra_high`)) return `${explicit.base}-extra_high`;
      if (want === 'xhigh' && this.hasModel(`${explicit.base}-xhigh`)) return `${explicit.base}-xhigh`;
      return id;
    }
    // 裸虚拟名：补档位。已知列表里有就用真实的，没有就按命名规则拼。
    const base = requested;
    const rawSuffix = String(effort || '').trim().toLowerCase() === 'extra_high' ? 'extra_high' : want;
    const guessed = `${base}-${rawSuffix}`;
    if (this.hasModel(guessed)) return guessed;
    if (want === 'xhigh' && this.hasModel(`${base}-extra_high`)) return `${base}-extra_high`;
    const prefixed = [...this.discovery.raw].map((m) => m.id).find((x) => x.startsWith(`${base}-`));
    if (prefixed) return prefixed;
    const available = this.discovery.raw.map((m) => m.id);
    if (available.length === 0) {
      // 从未拿到过模型列表（运行时未就绪 / 发现失败）：乐观按命名规则拼，交给运行时判定。
      // 关键是不能回退成裸虚拟名——那个运行时一定拒。
      this.log(`未知模型 ${requested}，按命名规则推断为 ${guessed}（模型列表尚未就绪）`);
      return guessed;
    }
    throw Object.assign(
      new Error(`模型 ${requested} 当前不可用；运行时可用：${available.join(', ')}`),
      { code: 'MODEL_UNAVAILABLE' },
    );
  }
}

module.exports = {
  AcpRuntime,
  createLimiter,
  canonicalEffort,
  levelOfEffort,
  parseModelVariant,
  killTree,
  permissionOutcome,
  READ_ONLY_TOOL_KINDS,
};
