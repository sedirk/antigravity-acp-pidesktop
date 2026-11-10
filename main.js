'use strict';

/**
 * PI-Desktop 插件入口：Antigravity ACP → OpenAI 兼容本地网关。
 *
 * 边界：本插件只跟本机官方 ACP 二进制（agy_acp_server.exe）用 stdio 通信，
 * 不读取、不转发、不保存任何 Google 凭据；凭据由那个二进制自己保管。
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile, spawn } = require('node:child_process');

const configLib = require('./lib/config');
const proxyLib = require('./lib/proxy');
const { AcpRuntime, createLimiter } = require('./lib/core');
const { createGateway } = require('./lib/server');

const SERVICE_ID = 'antigravity-acp-gateway';
const COMMANDS = {
  config: 'antigravity.config',
  status: 'antigravity.status',
  models: 'antigravity.models',
  install: 'antigravity.install-runtime',
  cleanup: 'antigravity.cleanup-runtime',
};

const RUNTIME = {
  version: '1.3.0',
  url: 'https://dl.google.com/agy-extensions/releases/windows/agy-acp-server-1.3.0-windows-x86_64.zip',
  sha256: '65215E0688681FA3116E048A9EAB27EF53AF1BBD6F3DA3F1C52BD4911D8B17F9',
  archiveBytes: 124509787,
  files: ['agy_acp_server.exe', 'localharness_external.exe'],
};

let pi = null;
let packageRoot = __dirname;
let dataPath = '';
let config = null;
let acp = null;
let limiter = null;
let gateway = null;
let log = () => {};
let resolvedProxy = { url: '', source: 'none', note: '尚未解析' };

/** 解析当前生效的代理：auto 跟随系统代理，manual 用面板值，direct 直连。 */
function refreshProxy() {
  resolvedProxy = proxyLib.resolveProxy(config || {});
  const shown = resolvedProxy.url || '直连';
  log(`代理：${shown}（${resolvedProxy.source}：${resolvedProxy.note}）`);
  return resolvedProxy;
}

/** 下载/安装状态，供面板轮询；install 本身是后台任务，不阻塞面板调用。 */
let installState = { phase: 'idle', received: 0, total: RUNTIME.archiveBytes, startedAt: 0, error: '', bytes: 0 };

function setInstall(patch) {
  installState = { ...installState, ...patch };
  if (patch.phase) log(`runtime: ${patch.phase}${patch.error ? ` — ${patch.error}` : ''}`);
}

const INSTALL_BUSY = new Set(['downloading', 'verifying', 'extracting']);

function writeLogLine(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  try { console.log(`[antigravity-acp] ${message}`); } catch { /* ignore */ }
  if (!dataPath) return;
  try {
    fs.mkdirSync(dataPath, { recursive: true });
    fs.appendFileSync(path.join(dataPath, 'gateway.log'), `${line}\n`, 'utf8');
  } catch { /* ignore */ }
}

function ctx() {
  return { packageRoot, dataPath };
}

function reloadConfig() {
  config = configLib.loadConfig(ctx());
  for (const warning of config.warnings) log(`config: ${warning}`);
  return config;
}

async function toast(message, level = 'info') {
  try {
    if (pi && pi.ui && typeof pi.ui.showToast === 'function') await pi.ui.showToast(message, level);
  } catch { /* ignore */ }
}

function buildLimiter() {
  return createLimiter({
    limit: config.concurrency,
    maxQueue: config.maxQueue,
    queueTimeoutMs: config.queueTimeoutMs,
    log,
  });
}

async function startService({ log: providedLog } = {}) {
  if (typeof providedLog === 'function') log = (message) => { providedLog(message); writeLogLine(message); };
  reloadConfig();
  refreshProxy();
  limiter = buildLimiter();
  acp = new AcpRuntime({ getConfig: () => config, getProxy: () => resolvedProxy.url, log });
  gateway = createGateway({ acp, limiter, getConfig: () => config, log });
  const base = config.port;
  const port = await gateway.listen([base, base + 1, base + 2, base + 3]);
  log(`服务已启动 · 配置 ${config.source} · 并发上限 ${config.concurrency > 0 ? config.concurrency : '不限'}`);
  return { port };
}

function stopService() {
  if (gateway) gateway.close();
  if (acp) acp.kill();
  gateway = null;
  acp = null;
  limiter = null;
}

async function restartService() {
  stopService();
  return startService();
}

// ---------------------------------------------------------------- 运行时安装

function runtimeDir() {
  return path.join(dataPath || packageRoot, 'runtime');
}

function dirSize(dir) {
  let total = 0;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    try {
      total += entry.isDirectory() ? dirSize(full) : fs.statSync(full).size;
    } catch { /* ignore */ }
  }
  return total;
}

function run(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, timeout: options.timeout || 30 * 60 * 1000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(Object.assign(error, { stdout, stderr }));
      else resolve({ stdout, stderr });
    });
  });
}

/** 用 curl 下载并轮询文件大小，进度写进 installState。 */
async function download(zip) {
  const partial = `${zip}.part`;
  try { if (fs.existsSync(partial)) fs.unlinkSync(partial); } catch { /* ignore */ }
  const args = ['-L', '--fail', '--connect-timeout', '20', '--retry', '2', '-o', partial, RUNTIME.url];
  const proxyUrl = resolvedProxy.url;
  if (proxyUrl) args.unshift('--proxy', proxyUrl);
  setInstall({ phase: 'downloading', received: 0, total: RUNTIME.archiveBytes, startedAt: Date.now(), error: '' });
  log(`下载运行时：${RUNTIME.url}${resolvedProxy.url ? `（代理 ${resolvedProxy.url}）` : '（直连）'}`);

  const child = spawn('curl.exe', args, { windowsHide: true });
  const timer = setInterval(() => {
    try {
      const size = fs.statSync(partial).size;
      setInstall({ received: size });
    } catch { /* 还没建文件 */ }
  }, 500);

  try {
    await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(`curl 退出码 ${code}`))));
    });
  } finally {
    clearInterval(timer);
  }
  const size = fs.statSync(partial).size;
  setInstall({ received: size, total: size });
  if (fs.existsSync(zip)) fs.unlinkSync(zip);
  fs.renameSync(partial, zip);
  return size;
}

/** 后台任务：下载 → 校验 → 解压 → 写配置。面板通过 runtime:status 观察。 */
async function runInstall() {
  if (process.platform !== 'win32') throw new Error('自动安装目前只支持 Windows，请手动放置 agy_acp_server.exe');
  const dir = runtimeDir();
  fs.mkdirSync(dir, { recursive: true });
  const zip = path.join(dir, `agy-acp-${RUNTIME.version}.zip`);

  await download(zip);

  setInstall({ phase: 'verifying' });
  const digest = crypto.createHash('sha256').update(fs.readFileSync(zip)).digest('hex').toUpperCase();
  if (digest !== RUNTIME.sha256) {
    try { fs.unlinkSync(zip); } catch { /* ignore */ }
    throw new Error(`运行时校验失败：期望 ${RUNTIME.sha256.slice(0, 16)}…，实际 ${digest.slice(0, 16)}…`);
  }

  setInstall({ phase: 'extracting' });
  await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${dir}' -Force`]);
  try { fs.unlinkSync(zip); } catch { /* ignore */ }
  const bin = path.join(dir, 'agy_acp_server.exe');
  for (const name of RUNTIME.files) {
    if (!fs.existsSync(path.join(dir, name))) throw new Error(`解压后缺少 ${name}`);
  }

  const saved = configLib.savePanel(ctx(), { bin }, null);
  if (!saved.ok) throw new Error(`运行时已下载，但写入配置失败：${(saved.errors || []).join('；')}`);
  reloadConfig();
  refreshProxy();
  const bytes = fs.statSync(bin).size;
  setInstall({ phase: 'done', bytes, bin });
  await restartService();
  await toast(`Antigravity 运行时已就绪（${Math.round(bytes / 1048576)} MB，SHA256 已校验）`, 'info');
}

function startInstall() {
  if (INSTALL_BUSY.has(installState.phase)) return { ok: true, started: false, phase: installState.phase };
  setInstall({ phase: 'downloading', received: 0, startedAt: Date.now(), error: '', bytes: 0 });
  runInstall().catch((error) => {
    setInstall({ phase: 'error', error: String(error.message || error).slice(0, 300) });
    void toast(`运行时安装失败：${String(error.message).slice(0, 200)}`, 'warning');
  });
  return { ok: true, started: true };
}

/** 删掉 runtime 目录，返回释放的字节数（卸载插件不会自动清理，需要这一步）。 */
function cleanupRuntime() {
  const dir = runtimeDir();
  const before = dirSize(dir);
  if (!fs.existsSync(dir)) return { ok: true, freedBytes: 0, dir };
  stopService();
  fs.rmSync(dir, { recursive: true, force: true });
  reloadConfig();
  refreshProxy();
  setInstall({ phase: 'idle', received: 0, bytes: 0, error: '' });
  log(`已清理运行时：释放 ${Math.round(before / 1048576)} MB`);
  return { ok: true, freedBytes: before, dir };
}

// ---------------------------------------------------------------- 命令

function registerCommands() {
  pi.commands.register({
    id: COMMANDS.config,
    title: 'Antigravity: 打开配置面板',
    category: 'AI',
    keywords: ['antigravity', 'agy', 'acp', '配置', 'config', '设置'],
    run: async () => {
      if (!pi.ui || typeof pi.ui.openPanel !== 'function') { await toast('当前宿主不支持面板', 'warning'); return; }
      await pi.ui.openPanel({ title: 'Antigravity ACP · 配置' });
    },
  });

  pi.commands.register({
    id: COMMANDS.status,
    title: 'Antigravity: 显示网关状态',
    category: 'AI',
    keywords: ['antigravity', 'agy', '状态', 'status'],
    run: async () => {
      if (!gateway) { await toast('网关未启动', 'warning'); return; }
      const status = gateway.status();
      const info = status.limiter || {};
      await toast([
        `网关 http://127.0.0.1:${status.port}/v1`,
        `运行时 ${status.running ? '就绪' : '未启动'}${status.pid ? ` (pid ${status.pid})` : ''}`,
        `虚拟模型 ${status.models} 个`,
        `并发 ${info.limit > 0 ? `${info.limit}（进行 ${info.active}，排队 ${info.queued}）` : '不限'}`,
        config.proxy ? `代理 ${config.proxy}` : '代理 直连',
      ].join('\n'), status.running ? 'info' : 'warning');
    },
  });

  pi.commands.register({
    id: COMMANDS.models,
    title: 'Antigravity: 显示可用模型',
    category: 'AI',
    keywords: ['antigravity', 'agy', '模型', 'models'],
    run: async () => {
      if (!acp) { await toast('服务未启动', 'warning'); return; }
      try {
        const models = await acp.modelsForApi();
        await toast(`可用模型（${models.length}）：\n${models.map((m) => m.id).join('\n')}`, 'info');
      } catch (error) {
        await toast(`获取模型失败：${String(error.message).slice(0, 200)}`, 'warning');
      }
    },
  });

  pi.commands.register({
    id: COMMANDS.install,
    title: 'Antigravity: 下载官方 ACP 运行时',
    category: 'AI',
    keywords: ['antigravity', 'agy', '运行时', 'runtime', '下载'],
    run: async () => {
      const result = startInstall();
      if (!result.started) { await toast(`已在下载中（${result.phase}），看面板进度即可`, 'info'); return; }
      await toast('开始下载官方 ACP 运行时（约 120 MB），进度见配置面板', 'info');
    },
  });

  pi.commands.register({
    id: COMMANDS.cleanup,
    title: 'Antigravity: 清理已下载的运行时',
    category: 'AI',
    keywords: ['antigravity', 'agy', '清理', '卸载', 'cleanup', '空间'],
    run: async () => {
      const result = cleanupRuntime();
      await toast(result.freedBytes > 0
        ? `已删除运行时，释放 ${(result.freedBytes / 1048576).toFixed(0)} MB`
        : '没有可清理的运行时', 'info');
    },
  });
}

function unregisterCommands() {
  for (const id of Object.values(COMMANDS)) {
    try { pi.commands.unregister(id); } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------- 面板

function runtimeStatus() {
  const bin = config ? config.bin : configLib.defaultBin(ctx());
  const dir = runtimeDir();
  return {
    ...installState,
    busy: INSTALL_BUSY.has(installState.phase),
    bin: bin || '',
    binExists: Boolean(bin) && fs.existsSync(bin),
    dir,
    dirBytes: dirSize(dir),
    expectedBytes: RUNTIME.archiveBytes,
    version: RUNTIME.version,
    sha256: RUNTIME.sha256,
    proxy: resolvedProxy,
  };
}

async function onPanelInvoke(channel, payload) {
  if (channel === 'config:read') {
    return configLib.readPanel(ctx(), config || reloadConfig());
  }
  if (channel === 'config:write') {
    const result = configLib.savePanel(ctx(), payload || {}, null);
    if (!result.ok) return result;
    reloadConfig();
    refreshProxy();
    if (!gateway) return { ...result, restarted: false };
    try {
      const started = await restartService();
      log(`配置面板保存：${result.changed.join(', ') || '(无变化)'} · 端口 ${started.port}`);
      return { ...result, restarted: true, port: started.port };
    } catch (error) {
      return { ...result, restarted: false, restartError: String(error.message).slice(0, 200) };
    }
  }
  if (channel === 'gateway:status') {
    if (!gateway) return { running: false, runtime: runtimeStatus() };
    const status = gateway.status();
    return {
      running: true,
      port: status.port,
      runtimeReady: status.running,
      pid: status.pid,
      models: status.models,
      limiter: status.limiter,
      proxy: resolvedProxy,
      runtime: runtimeStatus(),
    };
  }
  if (channel === 'models:list') {
    if (!acp) return { ok: false, error: '服务未启动' };
    try {
      const models = await acp.modelsForApi();
      return { ok: true, models: models.map((m) => ({ id: m.id, name: m.name })) };
    } catch (error) {
      return { ok: false, error: String(error.message).slice(0, 300) };
    }
  }
  if (channel === 'runtime:status') return runtimeStatus();
  if (channel === 'runtime:install') return startInstall();
  if (channel === 'runtime:cleanup') {
    try { return cleanupRuntime(); } catch (error) { return { ok: false, error: String(error.message).slice(0, 300) }; }
  }
  throw Object.assign(new Error(`未知的面板通道: ${channel}`), { code: 'UNSUPPORTED' });
}

// ---------------------------------------------------------------- 生命周期

module.exports = {
  onPanelInvoke,

  async onLoad() {
    pi = globalThis.pi;
    if (!pi) throw new Error('宿主 plugin API 不可用：onLoad 之前应当存在全局 pi');
    packageRoot = __dirname;
    log = writeLogLine;
    try {
      if (pi.plugin && typeof pi.plugin.getDataPath === 'function') {
        dataPath = await pi.plugin.getDataPath();
        if (dataPath) fs.mkdirSync(dataPath, { recursive: true });
      }
    } catch { dataPath = ''; }

    reloadConfig();
    refreshProxy();
    pi.services.register({
      id: SERVICE_ID,
      start: (context) => startService(context),
      stop: () => stopService(),
    });
    registerCommands();
    log(`loaded · config=${config.source} · port=${config.port} · concurrency=${config.concurrency || 'unlimited'}`);

    // 首次使用引导：缺少运行时时主动提示，不依赖用户先读 README
    if (!config.bin || !fs.existsSync(config.bin)) {
      setTimeout(() => {
        void toast('Antigravity 插件还没安装运行时。打开「Antigravity: 打开配置面板」→ 点「下载官方运行时」（约 120 MB）。', 'warning');
      }, 1500);
    }
  },

  async onUnload() {
    try { unregisterCommands(); } catch { /* ignore */ }
    stopService();
  },

  _internals: {
    get config() { return config; },
    get acp() { return acp; },
    get gateway() { return gateway; },
    get limiter() { return limiter; },
    get installState() { return installState; },
    setDataPath: (value) => { dataPath = value; },
    setConfig: (value) => { config = value; },
    reloadConfig,
    startService,
    stopService,
    restartService,
    startInstall,
    cleanupRuntime,
    runtimeStatus,
    registerCommands,
    unregisterCommands,
    RUNTIME,
  },
};
