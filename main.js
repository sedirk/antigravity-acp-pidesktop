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
const { execFile } = require('node:child_process');

const configLib = require('./lib/config');
const { AcpRuntime, createLimiter } = require('./lib/core');
const { createGateway } = require('./lib/server');

const SERVICE_ID = 'antigravity-acp-gateway';
const COMMANDS = {
  config: 'antigravity.config',
  status: 'antigravity.status',
  models: 'antigravity.models',
  install: 'antigravity.install-runtime',
};

const RUNTIME = {
  version: '1.3.0',
  url: 'https://dl.google.com/agy-extensions/releases/windows/agy-acp-server-1.3.0-windows-x86_64.zip',
  sha256: '65215E0688681FA3116E048A9EAB27EF53AF1BBD6F3DA3F1C52BD4911D8B17F9',
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
let installing = null;

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
  limiter = buildLimiter();
  acp = new AcpRuntime({ getConfig: () => config, log });
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

function run(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, timeout: options.timeout || 30 * 60 * 1000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(Object.assign(error, { stdout, stderr }));
      else resolve({ stdout, stderr });
    });
  });
}

function hashFile(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').toUpperCase();
}

/**
 * 下载官方运行时（仅 Windows）。走 curl.exe，优先使用配置里的代理，
 * 因为多数国内网络直连 dl.google.com 会超时。
 */
async function installRuntime() {
  if (installing) return installing;
  installing = (async () => {
    if (process.platform !== 'win32') throw new Error('自动安装目前只支持 Windows，请手动放置 agy_acp_server.exe');
    const dir = path.join(dataPath || packageRoot, 'runtime');
    fs.mkdirSync(dir, { recursive: true });
    const zip = path.join(dir, `agy-acp-${RUNTIME.version}.zip`);
    const args = ['-L', '--fail', '--connect-timeout', '20', '--retry', '2', '-o', zip, RUNTIME.url];
    if (config.proxy) args.unshift('--proxy', config.proxy);
    log(`下载运行时：${RUNTIME.url}${config.proxy ? `（代理 ${config.proxy}）` : '（直连）'}`);
    await run('curl.exe', args);
    const digest = hashFile(zip);
    if (digest !== RUNTIME.sha256) {
      try { fs.unlinkSync(zip); } catch { /* ignore */ }
      throw new Error(`运行时校验失败：期望 ${RUNTIME.sha256.slice(0, 16)}…，实际 ${digest.slice(0, 16)}…`);
    }
    await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${dir}' -Force`]);
    const bin = path.join(dir, 'agy_acp_server.exe');
    for (const name of RUNTIME.files) {
      if (!fs.existsSync(path.join(dir, name))) throw new Error(`解压后缺少 ${name}`);
    }
    // 落到配置里，后续启动直接用
    const saved = configLib.savePanel(ctx(), { bin }, null);
    if (!saved.ok) throw new Error(`运行时已下载，但写入配置失败：${(saved.errors || []).join('；')}`);
    reloadConfig();
    log(`运行时安装完成：${bin}`);
    return { bin, sha256: digest, bytes: fs.statSync(bin).size };
  })().finally(() => { installing = null; });
  return installing;
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
      const limiterInfo = status.limiter || {};
      await toast([
        `网关 http://127.0.0.1:${status.port}/v1`,
        `运行时 ${status.running ? '就绪' : '未启动'}${status.pid ? ` (pid ${status.pid})` : ''}`,
        `虚拟模型 ${status.models} 个`,
        `并发 ${limiterInfo.limit > 0 ? `${limiterInfo.limit}（进行 ${limiterInfo.active}，排队 ${limiterInfo.queued}）` : '不限'}`,
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
      await toast('正在下载官方 ACP 运行时（约 120 MB），请稍候…', 'info');
      try {
        const result = await installRuntime();
        await restartService();
        await toast(`运行时已就绪：${result.bin}\nSHA256 已验证`, 'info');
      } catch (error) {
        log(`运行时安装失败：${error.message}`);
        await toast(`安装失败：${String(error.message).slice(0, 240)}`, 'warning');
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

async function onPanelInvoke(channel, payload) {
  if (channel === 'config:read') {
    return configLib.readPanel(ctx(), config || reloadConfig());
  }
  if (channel === 'config:write') {
    const result = configLib.savePanel(ctx(), payload || {}, null);
    if (!result.ok) return result;
    reloadConfig();
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
    if (!gateway) return { running: false };
    const status = gateway.status();
    return {
      running: true,
      port: status.port,
      runtimeReady: status.running,
      pid: status.pid,
      models: status.models,
      limiter: status.limiter,
      proxy: config.proxy,
      stderr: status.stderr,
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
  if (channel === 'runtime:install') {
    try {
      const result = await installRuntime();
      await restartService();
      return { ok: true, ...result };
    } catch (error) {
      return { ok: false, error: String(error.message).slice(0, 400) };
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
    pi.services.register({
      id: SERVICE_ID,
      start: (context) => startService(context),
      stop: () => stopService(),
    });
    registerCommands();
    log(`loaded · config=${config.source} · port=${config.port} · concurrency=${config.concurrency || 'unlimited'}`);
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
    setDataPath: (value) => { dataPath = value; },
    setConfig: (value) => { config = value; },
    reloadConfig,
    startService,
    stopService,
    restartService,
    installRuntime,
    registerCommands,
    unregisterCommands,
    RUNTIME,
  },
};
