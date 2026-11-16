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
const { execFile, spawn, execFileSync } = require('node:child_process');

const configLib = require('./lib/config');
const proxyLib = require('./lib/proxy');
const { AcpRuntime, createLimiter, killTree } = require('./lib/core');
const { createGateway } = require('./lib/server');

const SERVICE_ID = 'antigravity-acp-gateway';
const COMMANDS = {
  config: 'antigravity.config',
  login: 'antigravity.login',
  status: 'antigravity.status',
  models: 'antigravity.models',
  install: 'antigravity.install-runtime',
  cleanup: 'antigravity.cleanup-runtime',
};

const RUNTIME = {
  version: '1.5.0',
  url: 'https://dl.google.com/agy-extensions/releases/windows/agy-acp-server-1.5.0-windows-x86_64.zip',
  sha256: '6163F6B59B381BAE419652DBAE167BC8CDA0EF29D665C0BA8AF3D8C7FDDD8867',
  archiveBytes: 105513364,
  files: ['agy_acp_server.exe', 'localharness_external.exe'],
};

const KNOWN_RUNTIME_EXE_BYTES = Object.freeze({
  81437336: '1.3.0',
  58314376: '1.5.0',
});

let pi = null;
let packageRoot = __dirname;
let dataPath = '';
let config = null;
let acp = null;
let limiter = null;
let gateway = null;
let log = () => {};
let resolvedProxy = { url: '', source: 'none', note: '尚未解析' };
let proxyAt = 0;
// auto 模式必须现读注册表：VPN/代理软件往往比 PI-Desktop 起得晚，开机那一刻的「系统代理未启用」
// 不能定死一辈子，否则运行时会一直按直连走，所有联网调用都是 Internal error。
const PROXY_TTL_MS = 5000;

/** 解析当前生效的代理：auto 跟随系统代理，manual 用面板值，direct 直连。 */
function refreshProxy({ force = true } = {}) {
  const now = Date.now();
  const first = !proxyAt;
  if (!force && proxyAt && now - proxyAt < PROXY_TTL_MS) return resolvedProxy;
  const next = proxyLib.resolveProxy(config || {});
  const changed = next.url !== resolvedProxy.url || next.source !== resolvedProxy.source;
  resolvedProxy = next;
  proxyAt = now;
  if (force || changed || first) {
    const shown = next.url || '直连';
    log(`代理：${shown}（${next.source}：${next.note}）`);
  }
  return resolvedProxy;
}

/** 下载/安装状态，供面板轮询；install 本身是后台任务，不阻塞面板调用。 */
let installState = { phase: 'idle', received: 0, total: RUNTIME.archiveBytes, startedAt: 0, error: '', bytes: 0 };

function setInstall(patch) {
  installState = { ...installState, ...patch };
  if (patch.phase) log(`runtime: ${patch.phase}${patch.error ? ` — ${patch.error}` : ''}`);
}

const INSTALL_BUSY = new Set(['downloading', 'verifying', 'extracting']);
let runtimeSwapping = false;

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

/**
 * 当前 PI-Desktop 项目目录：面板「工作目录」留空时用它当运行时的会话工作区。
 * 宿主没打开项目、或 API 不可用时返回空串，由 AcpRuntime.cwdFor 兜底用户主目录。
 */
async function workspaceCwd() {
  try {
    if (!pi || !pi.workspace || typeof pi.workspace.get !== 'function') return '';
    const info = await pi.workspace.get();
    const value = (info && info.workspace && info.workspace.path)
      || (info && typeof info.path === 'string' ? info.path : '');
    return typeof value === 'string' ? value : '';
  } catch (error) {
    writeLogLine(`读取 PI-Desktop 项目目录失败：${String(error && error.message).slice(0, 160)}`);
    return '';
  }
}

async function workspaceAdditionalDirs() {
  try {
    if (!pi || !pi.workspace || typeof pi.workspace.get !== 'function') return [];
    const info = await pi.workspace.get();
    const candidates = [
      ...(Array.isArray(info && info.additionalDirectories) ? info.additionalDirectories : []),
      ...(Array.isArray(info && info.additionalRoots) ? info.additionalRoots : []),
      ...(Array.isArray(info && info.folders) ? info.folders : []),
      ...(Array.isArray(info && info.roots) ? info.roots : []),
      ...(Array.isArray(info && info.workspace && info.workspace.folders) ? info.workspace.folders : []),
    ];
    return candidates
      .map((item) => (typeof item === 'string' ? item : (item && typeof item.path === 'string' ? item.path : '')))
      .filter(Boolean);
  } catch {
    return [];
  }
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

/**
 * 清理插件自己留下的孤儿运行时。
 * 旧版本只用 child.kill()，Windows 下不会级联，于是 agy_acp_server.exe 与
 * localharness_external.exe 会残留；它们共享同一账号的并发额度，导致请求偶发超时。
 * 只处理「可执行文件在本插件 runtime 目录下、且父进程已不存在」的进程。
 */
function listRuntimeServers() {
  if (process.platform !== 'win32') return [];
  const script = "Get-CimInstance Win32_Process -Filter \"Name='agy_acp_server.exe'\" | Select-Object ProcessId,ParentProcessId,ExecutablePath | ConvertTo-Json -Compress";
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true, timeout: 20000, stdio: ['ignore', 'pipe', 'ignore'],
    }).toString().trim();
    if (!out) return [];
    const parsed = JSON.parse(out);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function reapOrphans(targetDir = runtimeDir()) {
  if (process.platform !== 'win32') return 0;
  const rawDir = String(targetDir || '').trim();
  if (!rawDir) return 0;
  const dirPrefix = (path.resolve(rawDir) + path.sep).toLowerCase();
  const mine = acp && acp.child ? acp.child.pid : 0;
  let killed = 0;
  for (const item of listRuntimeServers()) {
    const exe = String(item.ExecutablePath || '').toLowerCase();
    if (!exe.startsWith(dirPrefix)) continue;
    const pid = Number(item.ProcessId);
    if (!pid || pid === mine) continue;
    if (pidAlive(Number(item.ParentProcessId))) continue;
    killTree(pid);
    killed += 1;
  }
  if (killed > 0) log(`已清理 ${killed} 个残留运行时进程（父进程已退出的孤儿）`);
  return killed;
}

async function startService({ log: providedLog } = {}) {
  if (typeof providedLog === 'function') log = (message) => { providedLog(message); writeLogLine(message); };
  reloadConfig();
  refreshProxy();
  reapOrphans();
  limiter = buildLimiter();
  acp = new AcpRuntime({ getConfig: () => config, getProxy: () => refreshProxy({ force: false }).url, getCwd: workspaceCwd, getAdditionalDirs: workspaceAdditionalDirs, log });
  gateway = createGateway({ acp, limiter, getConfig: () => config, log });
  const base = config.port;
  const port = await gateway.listen([base, base + 1, base + 2, base + 3]);
  // 预热：先完成 ACP 握手与模型发现，避免第一条对话撞上运行时初始化的 10–20 秒
  acp.start()
    .then(() => acp.discover().catch(() => {}))
    .catch((error) => log(`预热失败：${String(error.message).slice(0, 160)}`));
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

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/**
 * 校验暂存目录后原子切换至正式 runtime 目录：
 * 1. 先在暂存目录校验全部核心文件并生成 runtime-meta.json，半残解压绝不触碰旧目录；
 * 2. 锁定 AcpRuntime 维护态并关闭网关/旧进程树，杜绝并发请求在切换窗口重新拉起旧二进制；
 * 3. 通过同盘目录重命名（dir → backup，stage → dir）完成原子替换，失败时自动回滚并恢复服务。
 */
async function swapStagedRuntime(stageDir, dir = runtimeDir(), options = {}) {
  for (const name of RUNTIME.files) {
    const candidate = path.join(stageDir, name);
    let st = null;
    try { st = fs.statSync(candidate); } catch { st = null; }
    if (!st || !st.isFile() || st.size <= 0) {
      try { fs.rmSync(stageDir, { recursive: true, force: true }); } catch { /* ignore */ }
      throw new Error(`解压后缺少有效的 ${name}`);
    }
  }
  const stagedBin = path.join(stageDir, 'agy_acp_server.exe');
  const bytes = fs.statSync(stagedBin).size;
  fs.writeFileSync(path.join(stageDir, 'runtime-meta.json'), `${JSON.stringify({
    version: RUNTIME.version,
    sha256: RUNTIME.sha256,
    exeBytes: bytes,
    installedAt: new Date().toISOString(),
  }, null, 2)}\n`, 'utf8');

  const shouldReap = options.reap !== false;
  const renameFn = typeof options.renameSync === 'function' ? options.renameSync : fs.renameSync;
  const retryDelayMs = Number.isFinite(options.retryDelayMs) ? Math.max(5, options.retryDelayMs) : 150;
  const hadService = Boolean(gateway || acp);
  const backupDir = `${dir}.bak-${process.pid}-${Date.now()}`;
  let movedLiveToBackup = false;
  let swapped = false;
  runtimeSwapping = true;
  try {
    if (acp) acp.enterMaintenance('正在升级官方 ACP 运行时，请稍候…');
    stopService();
    if (shouldReap) reapOrphans(dir);

    const renameWithRetry = async (fromPath, toPath) => {
      let lastErr = null;
      for (let attempt = 0; attempt < 8; attempt++) {
        try {
          renameFn(fromPath, toPath);
          return;
        } catch (err) {
          lastErr = err;
          const code = err && err.code;
          if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') throw err;
          if (shouldReap) reapOrphans(dir);
          await new Promise((r) => setTimeout(r, retryDelayMs));
        }
      }
      throw lastErr;
    };

    fs.mkdirSync(path.dirname(dir), { recursive: true });
    if (fs.existsSync(dir)) {
      await renameWithRetry(dir, backupDir);
      movedLiveToBackup = true;
    }
    try {
      await renameWithRetry(stageDir, dir);
      swapped = true;
    } catch (swapErr) {
      if (movedLiveToBackup && !fs.existsSync(dir) && fs.existsSync(backupDir)) {
        try { fs.renameSync(backupDir, dir); } catch { /* ignore */ }
      }
      throw swapErr;
    }
    if (movedLiveToBackup && fs.existsSync(backupDir)) {
      try { fs.rmSync(backupDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    return { bin: path.join(dir, 'agy_acp_server.exe'), bytes };
  } finally {
    runtimeSwapping = false;
    if (!swapped && fs.existsSync(stageDir)) {
      try { fs.rmSync(stageDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    if (!swapped && hadService && fs.existsSync(path.join(dir, 'agy_acp_server.exe'))) {
      try { await startService(); } catch (err) { log(`升级回滚后恢复服务失败：${String(err && err.message).slice(0, 160)}`); }
    }
  }
}

/** 后台任务：下载 → 校验 → 暂存解压 → 原子替换 → 写配置。面板通过 runtime:status 观察。 */
async function runInstall() {
  if (process.platform !== 'win32') throw new Error('自动安装目前只支持 Windows，请手动放置 agy_acp_server.exe');
  const dir = runtimeDir();
  const baseDir = path.dirname(dir);
  fs.mkdirSync(baseDir, { recursive: true });
  const zip = path.join(baseDir, `agy-acp-${RUNTIME.version}.zip`);

  await download(zip);

  setInstall({ phase: 'verifying' });
  const digest = crypto.createHash('sha256').update(fs.readFileSync(zip)).digest('hex').toUpperCase();
  if (digest !== RUNTIME.sha256) {
    try { fs.unlinkSync(zip); } catch { /* ignore */ }
    throw new Error(`运行时校验失败：期望 ${RUNTIME.sha256.slice(0, 16)}…，实际 ${digest.slice(0, 16)}…`);
  }

  setInstall({ phase: 'extracting' });
  const stageDir = path.join(baseDir, `runtime-staging-${process.pid}-${Date.now()}`);
  fs.rmSync(stageDir, { recursive: true, force: true });
  fs.mkdirSync(stageDir, { recursive: true });
  try {
    const expandCmd = `$ErrorActionPreference = 'Stop'; Expand-Archive -LiteralPath ${psQuote(zip)} -DestinationPath ${psQuote(stageDir)} -Force -ErrorAction Stop`;
    await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', expandCmd]);
  } catch (error) {
    try { fs.rmSync(stageDir, { recursive: true, force: true }); } catch { /* ignore */ }
    throw error;
  } finally {
    try { fs.unlinkSync(zip); } catch { /* ignore */ }
  }

  const { bin, bytes } = await swapStagedRuntime(stageDir, dir);
  const saved = configLib.savePanel(ctx(), { bin }, null);
  if (!saved.ok) {
    await restartService().catch(() => {});
    throw new Error(`运行时已下载，但写入配置失败：${(saved.errors || []).join('；')}`);
  }
  reloadConfig();
  refreshProxy();
  setInstall({ phase: 'done', bytes, bin });
  await restartService();
  await toast(`Antigravity 运行时 v${RUNTIME.version} 已就绪（${Math.round(bytes / 1048576)} MB，SHA256 已校验）`, 'info');
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
  if (runtimeSwapping || INSTALL_BUSY.has(installState.phase)) {
    throw new Error('正在安装或升级运行时，请等待完成后再清理');
  }
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

// ---------------------------------------------------------------- 认证与登录

/** 检查 Google 官方登录凭据是否在位（~/.gemini/antigravity-acp/settings.json 与 acp_token.json）。 */
function authStatus() {
  const geminiHome = process.env.GEMINI_HOME || path.join(process.env.USERPROFILE || process.env.HOME || '', '.gemini');
  const dir = path.join(geminiHome, 'antigravity-acp');
  const settingsFile = path.join(dir, 'settings.json');
  const tokenFile = path.join(dir, 'acp_token.json');
  const hasSettings = fs.existsSync(settingsFile) && fs.statSync(settingsFile).size > 0;
  const hasToken = fs.existsSync(tokenFile) && fs.statSync(tokenFile).size > 0;
  let projectId = '';
  if (hasToken) {
    try {
      const data = JSON.parse(fs.readFileSync(tokenFile, 'utf8'));
      if (data && data.project_id) projectId = String(data.project_id);
    } catch { /* ignore */ }
  }
  return {
    loggedIn: hasSettings && hasToken,
    hasSettings,
    hasToken,
    projectId,
    dir,
  };
}

/**
 * 触发官方运行时进行 Google OAuth 交互式登录：
 * 向 agy_acp_server 发送 authenticate(method_id='oauth-personal')，
 * 运行时内置的 WSGI 临时服务将自动调用 webbrowser.open 弹起默认浏览器完成授权。
 */
async function loginGoogle() {
  if (runtimeSwapping || INSTALL_BUSY.has(installState.phase)) {
    const msg = '正在安装或升级运行时，请等待完成后再登录';
    await toast(msg, 'warning');
    return { ok: false, error: msg };
  }
  const bin = config ? config.bin : configLib.defaultBin(ctx());
  if (!bin || !fs.existsSync(bin)) {
    const msg = '官方运行时尚未下载，请先在面板点击「下载官方运行时」';
    await toast(msg, 'warning');
    return { ok: false, error: msg };
  }
  if (!acp) {
    const msg = 'ACP 运行时未初始化';
    await toast(msg, 'warning');
    return { ok: false, error: msg };
  }
  await toast('已向运行时发起登录请求，正在自动调起系统浏览器...', 'info');
  try {
    if (!acp.ready || !acp.child) {
      log('登录请求：拉起运行时子进程');
      await acp.start();
    }
    log('登录请求：发送 authenticate (oauth-personal)');
    await acp.request('authenticate', { method_id: 'oauth-personal' }, 180000);
    const auth = authStatus();
    log(`Google OAuth 授权完成：loggedIn=${auth.loggedIn}`);
    await toast('Google 账号授权成功！凭据已保存，可直接在 PI-Desktop 中使用。', 'info');
    try { await acp.discover(); } catch { /* ignore */ }
    return { ok: true, ...auth };
  } catch (error) {
    const errText = error && error.message ? error.message : String(error);
    log(`Google OAuth 授权失败或取消：${errText}`);
    await toast(`Google 登录未完成：${errText.slice(0, 160)}`, 'error');
    return { ok: false, error: errText };
  }
}

// ---------------------------------------------------------------- 命令

function registerCommands() {
  pi.commands.register({
    id: COMMANDS.login,
    title: 'Antigravity: 登录 Google 账号 (调起浏览器)',
    category: 'AI',
    keywords: ['antigravity', 'agy', 'google', 'login', '登录', 'auth', 'oauth'],
    run: async () => {
      await loginGoogle();
    },
  });

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
      const activeProxy = refreshProxy({ force: false });
      await toast([
        `网关 http://127.0.0.1:${status.port}/v1`,
        `运行时 ${status.running ? '就绪' : '未启动'}${status.pid ? ` (pid ${status.pid})` : ''}`,
        `虚拟模型 ${status.models} 个`,
        `并发 ${info.limit > 0 ? `${info.limit}（进行 ${info.active}，排队 ${info.queued}）` : '不限'}`,
        `代理 ${activeProxy.url || '直连'}（${activeProxy.source}）`,
        status.lastRequest
          ? `最近一轮 ${status.lastRequest.ms} ms · 工具权限 ${status.lastRequest.policy} · 上下文 ${status.lastRequest.contextUsed}/${status.lastRequest.contextSize}`
          : '还没有请求记录',
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
      await toast('开始下载官方 ACP 运行时 v' + RUNTIME.version + '（约 101 MB），进度见配置面板', 'info');
    },
  });

  pi.commands.register({
    id: COMMANDS.cleanup,
    title: 'Antigravity: 清理已下载的运行时',
    category: 'AI',
    keywords: ['antigravity', 'agy', '清理', '卸载', 'cleanup', '空间'],
    run: async () => {
      try {
        const result = cleanupRuntime();
        await toast(result.freedBytes > 0
          ? `已删除运行时，释放 ${(result.freedBytes / 1048576).toFixed(0)} MB`
          : '没有可清理的运行时', 'info');
      } catch (error) {
        await toast(`清理运行时失败：${String((error && error.message) || error).slice(0, 160)}`, 'warning');
      }
    },
  });
}

function unregisterCommands() {
  for (const id of Object.values(COMMANDS)) {
    try { pi.commands.unregister(id); } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------- 面板

function detectInstalledVersion(bin) {
  if (!bin || !fs.existsSync(bin)) return '';
  const activeBin = config && config.bin ? config.bin : '';
  if (
    acp &&
    acp.ready &&
    acp.agentInfo &&
    acp.agentInfo.version &&
    activeBin &&
    path.resolve(activeBin).toLowerCase() === path.resolve(bin).toLowerCase()
  ) {
    return String(acp.agentInfo.version);
  }
  let exeBytes = 0;
  try { exeBytes = fs.statSync(bin).size; } catch { return ''; }
  try {
    const metaFile = path.join(path.dirname(bin), 'runtime-meta.json');
    if (fs.existsSync(metaFile)) {
      const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
      if (meta && meta.version && (!meta.exeBytes || Number(meta.exeBytes) === exeBytes)) {
        return String(meta.version);
      }
    }
  } catch { /* ignore */ }
  return KNOWN_RUNTIME_EXE_BYTES[exeBytes] || '';
}

function runtimeStatus() {
  const bin = config ? config.bin : configLib.defaultBin(ctx());
  const dir = runtimeDir();
  const binExists = Boolean(bin) && fs.existsSync(bin);
  const installedVersion = binExists ? detectInstalledVersion(bin) : '';
  const dirPrefix = dir ? (path.resolve(dir) + path.sep).toLowerCase() : '';
  const isManagedBin = Boolean(bin && dirPrefix) && path.resolve(bin).toLowerCase().startsWith(dirPrefix);
  const updateAvailable = Boolean(binExists && isManagedBin && installedVersion && installedVersion !== RUNTIME.version);
  return {
    ...installState,
    busy: runtimeSwapping || INSTALL_BUSY.has(installState.phase),
    ready: Boolean(acp && acp.ready),
    pid: acp && acp.child ? acp.child.pid : null,
    bin: bin || '',
    binExists,
    dir,
    dirBytes: dirSize(dir),
    expectedBytes: RUNTIME.archiveBytes,
    version: RUNTIME.version,
    installedVersion,
    updateAvailable,
    sha256: RUNTIME.sha256,
    proxy: resolvedProxy,
    auth: authStatus(),
    tier: (acp && acp.tierInfo) || null,
  };
}

async function onPanelInvoke(channel, payload) {
  if (channel === 'config:read' || channel === 'config:get') {
    return configLib.readPanel(ctx(), config || reloadConfig());
  }
  if (channel === 'config:write' || channel === 'config:save') {
    const result = configLib.savePanel(ctx(), payload || {}, null);
    if (!result.ok) return result;
    reloadConfig();
    refreshProxy();
    if (!gateway || runtimeSwapping) return { ...result, restarted: false };
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
      workers: status.workers,
      limiter: status.limiter,
      toolPolicy: config.toolPolicy,
      lastRequest: status.lastRequest,
      proxy: resolvedProxy,
      runtime: runtimeStatus(),
      auth: authStatus(),
    };
  }
  if (channel === 'auth:status') return authStatus();
  if (channel === 'auth:login') return await loginGoogle();
  if (channel === 'runtime:restart') {
    if (runtimeSwapping) return { ok: false, error: '正在升级运行时，请稍候' };
    if (!gateway) return { ok: false, error: '网关未运行' };
    try {
      const result = gateway.restartRuntime('panel');
      log(`面板请求重启运行时：${JSON.stringify(result)}`);
      return { ok: true, ...result };
    } catch (error) {
      return { ok: false, error: String(error.message).slice(0, 300) };
    }
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
  if (channel === 'sessions:list') {
    if (!gateway) return { ok: true, sessions: [] };
    return { ok: true, sessions: gateway.listSessions() };
  }
  if (channel === 'sessions:recycle') {
    if (!gateway) return { ok: false, error: '网关未运行' };
    try {
      const res = await gateway.recycleSessions();
      return { ok: true, ...res };
    } catch (error) {
      return { ok: false, error: String(error.message).slice(0, 300) };
    }
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
    reapOrphans();
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
        void toast(`Antigravity 插件还没安装运行时。打开「Antigravity: 打开配置面板」→ 点「下载官方运行时」（v${RUNTIME.version}，约 101 MB）。`, 'warning');
      }, 1500);
    } else {
      const rt = runtimeStatus();
      if (rt.updateAvailable) {
        setTimeout(() => {
          void toast(`检测到官方 ACP 运行时新版本 v${RUNTIME.version}（当前 v${rt.installedVersion}），可在「Antigravity: 打开配置面板」一键升级（约 101 MB）。`, 'info');
        }, 1500);
      }
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
    get workspaceCwd() { return workspaceCwd; },
    setConfig: (value) => { config = value; },
    reloadConfig,
    startService,
    stopService,
    restartService,
    startInstall,
    swapStagedRuntime,
    psQuote,
    cleanupRuntime,
    runtimeStatus,
    registerCommands,
    unregisterCommands,
    RUNTIME,
  },
};
