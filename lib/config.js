'use strict';

/**
 * 配置装载与面板读写。
 *
 * 优先级：插件数据目录 config.json → 插件根目录 config.json → 内置默认值。
 * 面板保存写「实际生效的那一份」；若两份都不存在则建在数据目录。
 *
 * 约定：password / apiKey 这类字段这里没有——本插件不持有任何 Google 凭据，
 * 凭据由官方 ACP 运行时自己写在 ~/.gemini/antigravity-acp/ 下。
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const RUNTIME_RELATIVE = path.join('runtime', 'agy_acp_server.exe');

const DEFAULTS = Object.freeze({
  port: 41910,
  bind: '127.0.0.1',
  bin: '',
  proxy: '',
  proxyMode: 'auto',
  defaultEffort: '',
  defaultModel: 'gemini-3.8-flash',
  virtualModels: true,
  exposeVariantModels: false,
  modelCacheMs: 5 * 60 * 1000,
  // 硬上限只防「真的永不返回」；正常长任务交给 promptIdleTimeoutMs 的活动看门狗。
  // 旧值 10 分钟会在第 600 秒把整轮砍掉（实测 gemini 长任务正好死在 02:18:16，报 600000ms 超时）。
  promptTimeoutMs: 60 * 60 * 1000,
  // 活动看门狗：连续这么久没有任何 session/update 才判定卡死并取消本轮
  promptIdleTimeoutMs: 3 * 60 * 1000,
  maxSessions: 12,
  // 0 = 不限制（默认关闭）；>=1 时同一时刻只跑 N 个 prompt，其余排队。
  concurrency: 0,
  queueTimeoutMs: 5 * 60 * 1000,
  maxQueue: 16,
  // 工具权限：本插件自己加的那道关卡。默认 'all'（不额外拦截）——真正的边界是
  // 运行时自身的 workspace 白名单（cwd）与 PI-Desktop 的插件权限，不需要第三层默认设防。
  // 'shell' 只读+执行；'search' 只读；'agent' 只读+子代理/生图；'none' 全拒（纯聊天网关）
  toolPolicy: 'all',
  // 客户端断开时发 session/cancel（通知形式）中止本轮，保留运行时与会话
  cancelOnDisconnect: true,
  // 会话空闲多少分钟后 session/close（放掉 worker，但保留映射以便 session/resume）
  idleSessionMinutes: 10,
});

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function merge(base, override) {
  const out = { ...base };
  if (!isObject(override)) return out;
  for (const [key, value] of Object.entries(override)) {
    if (isObject(value) && isObject(out[key])) out[key] = merge(out[key], value);
    else if (value !== undefined) out[key] = value;
  }
  return out;
}

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.round(n), min), max);
}

/**
 * 配置只有一处：插件数据目录下的 config.json，且只由面板写入。
 * 插件根目录里的旧文件仅在首次迁移时读一次，之后不再参与。
 */
function configFile({ packageRoot, dataPath }) {
  if (dataPath) return path.join(dataPath, 'config.json');
  return path.join(packageRoot || '.', 'config.json');
}

function resolveTarget(ctx) {
  const file = configFile(ctx);
  return { file, exists: fs.existsSync(file) };
}

/** 旧版本把 config.json 放在插件根目录：迁移一次到数据目录，之后只认数据目录。 */
function migrateLegacy(ctx) {
  const { dataPath, packageRoot } = ctx;
  if (!dataPath || !packageRoot) return null;
  const target = path.join(dataPath, 'config.json');
  const legacy = path.join(packageRoot, 'config.json');
  if (fs.existsSync(target) || !fs.existsSync(legacy)) return null;
  try {
    fs.mkdirSync(dataPath, { recursive: true });
    fs.copyFileSync(legacy, target);
    return target;
  } catch { return null; }
}

function readRaw(file) {
  if (!fs.existsSync(file)) return {};
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!isObject(raw)) throw new Error('config.json 顶层必须是 JSON 对象');
  return raw;
}

function defaultBin({ packageRoot, dataPath }) {
  const local = dataPath ? path.join(dataPath, RUNTIME_RELATIVE) : '';
  if (local && fs.existsSync(local)) return local;
  const inPackage = path.join(packageRoot, RUNTIME_RELATIVE);
  if (fs.existsSync(inPackage)) return inPackage;
  return local || inPackage;
}

/** 归一化：面板与运行时共用同一套默认值。 */
function normalize(raw, ctx) {
  const merged = merge(DEFAULTS, raw);
  return {
    port: clampInt(merged.port, DEFAULTS.port, 1024, 65535),
    bind: typeof merged.bind === 'string' && merged.bind ? merged.bind : DEFAULTS.bind,
    bin: typeof merged.bin === 'string' && merged.bin ? merged.bin : defaultBin(ctx),
    proxy: typeof merged.proxy === 'string' ? merged.proxy.trim() : '',
    proxyMode: ['auto', 'manual', 'direct'].includes(merged.proxyMode) ? merged.proxyMode : 'auto',
    defaultEffort: ['', 'low', 'medium', 'high'].includes(merged.defaultEffort) ? merged.defaultEffort : '',
    defaultModel: typeof merged.defaultModel === 'string' && merged.defaultModel ? merged.defaultModel : DEFAULTS.defaultModel,
    virtualModels: merged.virtualModels !== false,
    exposeVariantModels: merged.exposeVariantModels === true,
    modelCacheMs: clampInt(merged.modelCacheMs, DEFAULTS.modelCacheMs, 0, 3600000),
    promptTimeoutMs: clampInt(merged.promptTimeoutMs, DEFAULTS.promptTimeoutMs, 60000, 3600000),
    promptIdleTimeoutMs: clampInt(merged.promptIdleTimeoutMs, DEFAULTS.promptIdleTimeoutMs, 30000, 3600000),
    maxSessions: clampInt(merged.maxSessions, DEFAULTS.maxSessions, 1, 64),
    concurrency: clampInt(merged.concurrency, DEFAULTS.concurrency, 0, 8),
    queueTimeoutMs: clampInt(merged.queueTimeoutMs, DEFAULTS.queueTimeoutMs, 5000, 3600000),
    maxQueue: clampInt(merged.maxQueue, DEFAULTS.maxQueue, 1, 256),
    toolPolicy: ['search', 'agent', 'shell', 'all', 'none'].includes(merged.toolPolicy) ? merged.toolPolicy : DEFAULTS.toolPolicy,
    cancelOnDisconnect: merged.cancelOnDisconnect !== false,
    idleSessionMinutes: clampInt(merged.idleSessionMinutes, DEFAULTS.idleSessionMinutes, 1, 240),
    // 留空 = 跟随 PI-Desktop 当前项目目录（由宿主 workspace.get 提供），取不到再兜底用户主目录
    cwd: typeof merged.cwd === 'string' ? merged.cwd.trim() : '',
  };
}

function loadConfig(ctx) {
  const migrated = migrateLegacy(ctx);
  const { file, exists } = resolveTarget(ctx);
  const warnings = [];
  if (migrated) warnings.push(`已把插件根目录的旧配置迁移到 ${migrated}`);
  let raw = {};
  if (exists) {
    try {
      raw = readRaw(file);
    } catch (error) {
      warnings.push(`config.json 解析失败（${file}）：${error.message}`);
    }
  } else {
    warnings.push('尚未配置：请在面板里填写并保存');
  }
  const cfg = normalize(raw, ctx);
  if (!cfg.bin || !fs.existsSync(cfg.bin)) {
    warnings.push('未找到 ACP 运行时，可在面板点「下载官方运行时」');
  }
  return { ...cfg, source: exists ? file : '(默认值)', warnings, migratedFrom: migrated };
}

// ---------------------------------------------------------------- 面板读写

function validatePatch(input, ctx) {
  const patch = {};
  const errors = [];
  if (!isObject(input)) return { patch, errors: ['没有收到任何配置字段'] };

  const int = (value, min, max, label) => {
    const n = Number(value);
    if (!Number.isFinite(n) || Math.round(n) < min || Math.round(n) > max) {
      errors.push(`${label}必须是 ${min}–${max} 的整数`);
      return undefined;
    }
    return Math.round(n);
  };

  if (input.port !== undefined) {
    const v = int(input.port, 1024, 65535, '网关端口');
    if (v !== undefined) patch.port = v;
  }
  if (input.proxyMode !== undefined) {
    const mode = String(input.proxyMode).toLowerCase();
    if (!['auto', 'manual', 'direct'].includes(mode)) errors.push('代理模式只能是 auto / manual / direct');
    else patch.proxyMode = mode;
  }
  if (input.toolPolicy !== undefined) {
    const policy = String(input.toolPolicy).toLowerCase();
    if (!['search', 'agent', 'shell', 'all', 'none'].includes(policy)) errors.push('工具权限只能是 search / agent / shell / all / none');
    else patch.toolPolicy = policy;
  }
  if (input.defaultEffort !== undefined) {
    const effort = String(input.defaultEffort).toLowerCase();
    if (!['', 'low', 'medium', 'high', 'auto'].includes(effort)) errors.push('默认思考档位只能是 自动 / low / medium / high');
    else patch.defaultEffort = effort === 'auto' ? '' : effort;
  }
  if (input.proxy !== undefined) {
    const value = String(input.proxy).trim();
    if (value && !/^(https?|socks5h?):\/\/[^\s]+$/i.test(value)) errors.push('代理地址必须是 http:// 或 socks5:// 开头');
    else patch.proxy = value;
  }
  if (input.bin !== undefined) {
    const value = String(input.bin).trim();
    if (value && !fs.existsSync(value)) errors.push(`运行时路径不存在：${value}`);
    else patch.bin = value || defaultBin(ctx);
  }
  if (input.defaultModel !== undefined) patch.defaultModel = String(input.defaultModel).trim() || DEFAULTS.defaultModel;
  if (input.virtualModels !== undefined) patch.virtualModels = input.virtualModels === true || input.virtualModels === 'true';
  if (input.cancelOnDisconnect !== undefined) patch.cancelOnDisconnect = input.cancelOnDisconnect === true || input.cancelOnDisconnect === 'true';
  if (input.idleSessionMinutes !== undefined) {
    const v = int(input.idleSessionMinutes, 1, 240, '会话空闲回收');
    if (v !== undefined) patch.idleSessionMinutes = v;
  }
  if (input.exposeVariantModels !== undefined) patch.exposeVariantModels = input.exposeVariantModels === true || input.exposeVariantModels === 'true';
  if (input.concurrency !== undefined) {
    const v = int(input.concurrency, 0, 8, '最大并发');
    if (v !== undefined) patch.concurrency = v;
  }
  if (input.queueTimeoutMinutes !== undefined) {
    const v = int(input.queueTimeoutMinutes, 1, 60, '排队超时');
    if (v !== undefined) patch.queueTimeoutMs = v * 60000;
  }
  if (input.promptTimeoutMinutes !== undefined) {
    const v = int(input.promptTimeoutMinutes, 1, 120, '单次回答超时');
    if (v !== undefined) patch.promptTimeoutMs = v * 60000;
  }
  if (input.promptIdleSeconds !== undefined) {
    const v = int(input.promptIdleSeconds, 30, 3600, '无进展判定');
    if (v !== undefined) patch.promptIdleTimeoutMs = v * 1000;
  }
  if (input.modelCacheMinutes !== undefined) {
    const v = int(input.modelCacheMinutes, 0, 60, '模型缓存时间');
    if (v !== undefined) patch.modelCacheMs = v * 60000;
  }
  if (input.cwd !== undefined) {
    const value = String(input.cwd).trim();
    let isDir = false;
    try { isDir = Boolean(value) && fs.statSync(value).isDirectory(); } catch { isDir = false; }
    if (value && !isDir) errors.push(`工作目录不存在或不是文件夹：${value}`);
    else patch.cwd = value;
  }
  return { patch, errors };
}

function readPanel(ctx, cfg) {
  const { file, exists } = resolveTarget(ctx);
  return {
    file,
    exists,
    source: cfg.source,
    port: cfg.port,
    proxy: cfg.proxy,
    proxyMode: cfg.proxyMode,
    toolPolicy: cfg.toolPolicy,
    cancelOnDisconnect: cfg.cancelOnDisconnect,
    idleSessionMinutes: cfg.idleSessionMinutes,
    defaultEffort: cfg.defaultEffort,
    bin: cfg.bin,
    binExists: Boolean(cfg.bin) && fs.existsSync(cfg.bin),
    defaultModel: cfg.defaultModel,
    virtualModels: cfg.virtualModels,
    exposeVariantModels: cfg.exposeVariantModels,
    concurrency: cfg.concurrency,
    queueTimeoutMinutes: Math.round(cfg.queueTimeoutMs / 60000),
    promptTimeoutMinutes: Math.round(cfg.promptTimeoutMs / 60000),
    promptIdleSeconds: Math.round(cfg.promptIdleTimeoutMs / 1000),
    modelCacheMinutes: Math.round(cfg.modelCacheMs / 60000),
    cwd: cfg.cwd,
    warnings: cfg.warnings || [],
  };
}

function writeAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  try {
    fs.renameSync(tmp, file);
  } catch {
    fs.copyFileSync(tmp, file);
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
  }
}

function savePanel(ctx, input, currentRaw) {
  const { file, exists } = resolveTarget(ctx);
  const { patch, errors } = validatePatch(input, ctx);
  if (errors.length > 0) return { ok: false, file, errors, changed: [] };
  if (Object.keys(patch).length === 0) return { ok: true, file, exists, changed: [], note: '没有需要修改的字段' };
  let raw;
  try {
    raw = currentRaw || readRaw(file);
  } catch (error) {
    return { ok: false, file, errors: [`现有 config.json 解析失败，已拒绝覆盖：${error.message}`], changed: [] };
  }
  writeAtomic(file, { ...raw, ...patch });
  return { ok: true, file, exists, changed: Object.keys(patch) };
}

module.exports = {
  DEFAULTS,
  RUNTIME_RELATIVE,
  resolveTarget,
  readRaw,
  loadConfig,
  normalize,
  validatePatch,
  readPanel,
  savePanel,
  defaultBin,
};
