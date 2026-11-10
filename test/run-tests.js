'use strict';

/**
 * 离线自测：node test/run-tests.js
 * 只覆盖纯逻辑（配置、并发限制、模型分组、消息归一化），不联网、不启动运行时。
 */

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const configLib = require(path.join(root, 'lib/config.js'));
const { createLimiter, levelOfEffort, AcpRuntime } = require(path.join(root, 'lib/core.js'));
const { normalizeMessages } = require(path.join(root, 'lib/server.js'));
const manifest = require(path.join(root, 'manifest.json'));

const results = [];
async function suite(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  PASS  ${name}`);
  } catch (error) {
    results.push({ name, ok: false, error });
    console.log(`  FAIL  ${name}: ${error.message}`);
  }
}

function tempDir(prefix) {
  const dir = path.join(os.tmpdir(), `agy-test-${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  console.log('Antigravity ACP 网关自测');

  await suite('manifest: 基本字段与权限', async () => {
    assert.strictEqual(manifest.id, 'local.antigravity-acp');
    assert.ok(manifest.permissions.includes('background.service'));
    assert.ok(manifest.permissions.includes('ui.panel'));
    assert.strictEqual(manifest.ui.panel, 'renderer/config.html');
    assert.ok(fs.existsSync(path.join(root, manifest.ui.panel)));
    assert.strictEqual(manifest.contributes.services[0].id, 'antigravity-acp-gateway');
  });

  await suite('config: 默认值、钳制与校验', async () => {
    const dir = tempDir('cfg');
    const cfg = configLib.loadConfig({ packageRoot: dir, dataPath: dir });
    assert.strictEqual(cfg.port, 41910);
    assert.strictEqual(cfg.concurrency, 0, '并发默认必须关闭');
    assert.strictEqual(cfg.defaultEffort, '', '默认不干预思考档位');
    assert.deepStrictEqual(configLib.validatePatch({ defaultEffort: 'HIGH' }, { packageRoot: dir, dataPath: dir }).patch, { defaultEffort: 'high' });
    assert.strictEqual(configLib.validatePatch({ defaultEffort: 'max' }, { packageRoot: dir, dataPath: dir }).errors.length, 1);
    assert.ok(cfg.warnings.length > 0);

    const bad = configLib.validatePatch({ port: 'abc', proxy: 'ftp://x' }, { packageRoot: dir, dataPath: dir });
    assert.strictEqual(bad.errors.length, 2);

    const good = configLib.savePanel({ packageRoot: dir, dataPath: dir }, { port: '41911', concurrency: '1', proxy: 'http://127.0.0.1:10808' }, null);
    assert.strictEqual(good.ok, true);
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
    assert.strictEqual(saved.port, 41911);
    assert.strictEqual(saved.concurrency, 1);
    assert.strictEqual(saved.proxy, 'http://127.0.0.1:10808');

    const reloaded = configLib.loadConfig({ packageRoot: dir, dataPath: dir });
    assert.strictEqual(reloaded.port, 41911);
    assert.strictEqual(reloaded.concurrency, 1);
  });

  await suite('limiter: 0 = 不限制；1 = 串行；排队超时', async () => {
    const free = createLimiter({ limit: 0, maxQueue: 4, queueTimeoutMs: 50 });
    let peak = 0;
    let active = 0;
    await Promise.all([1, 2, 3].map(() => free.run(async () => {
      active += 1; peak = Math.max(peak, active);
      await sleep(20);
      active -= 1;
    })));
    assert.strictEqual(peak, 3, 'limit=0 时不应被串行');

    const serial = createLimiter({ limit: 1, maxQueue: 4, queueTimeoutMs: 2000 });
    let running = 0;
    let maxRunning = 0;
    const order = [];
    await Promise.all([1, 2, 3].map((n) => serial.run(async () => {
      running += 1; maxRunning = Math.max(maxRunning, running);
      order.push(n);
      await sleep(15);
      running -= 1;
    })));
    assert.strictEqual(maxRunning, 1, 'limit=1 时必须串行');
    assert.deepStrictEqual(order, [1, 2, 3], '必须 FIFO');

    const timeout = createLimiter({ limit: 1, maxQueue: 4, queueTimeoutMs: 30 });
    const blocker = timeout.run(() => sleep(120));
    const queued = timeout.run(() => sleep(5));
    await assert.rejects(queued, (error) => error.code === 'QUEUE_TIMEOUT');
    await blocker;
    assert.strictEqual(timeout.stats().active, 0);
  });

  await suite('proxy: 系统代理解析与三档模式', async () => {
    const proxyLib = require(path.join(root, 'lib/proxy.js'));
    assert.strictEqual(proxyLib.parseProxyServer('127.0.0.1:10808'), 'http://127.0.0.1:10808');
    assert.strictEqual(proxyLib.parseProxyServer('http=127.0.0.1:8080;https=127.0.0.1:8443'), 'http://127.0.0.1:8443');
    assert.strictEqual(proxyLib.parseProxyServer('socks=127.0.0.1:1080'), 'http://127.0.0.1:1080');
    assert.strictEqual(proxyLib.parseProxyServer(''), '');
    assert.strictEqual(proxyLib.parseProxyServer('nonsense'), '');

    const sysOn = { enabled: true, server: '127.0.0.1:10808', pac: '' };
    assert.deepStrictEqual(proxyLib.resolveProxy({ proxyMode: 'auto' }, sysOn).source, 'system');
    assert.strictEqual(proxyLib.resolveProxy({ proxyMode: 'auto' }, sysOn).url, 'http://127.0.0.1:10808');

    const sysOff = { enabled: false, server: '', pac: '' };
    assert.strictEqual(proxyLib.resolveProxy({ proxyMode: 'auto' }, sysOff).url, '');
    assert.strictEqual(proxyLib.resolveProxy({ proxyMode: 'direct' }, sysOn).url, '', 'direct 必须无视系统代理');
    assert.strictEqual(proxyLib.resolveProxy({ proxyMode: 'manual', proxy: 'http://10.0.0.2:3128' }, sysOn).url, 'http://10.0.0.2:3128');
    assert.strictEqual(proxyLib.resolveProxy({ proxyMode: 'manual', proxy: '' }, sysOn).url, '');

    const pacOnly = { enabled: true, server: '', pac: 'http://x/proxy.pac' };
    const pacResult = proxyLib.resolveProxy({ proxyMode: 'auto' }, pacOnly);
    assert.strictEqual(pacResult.url, '');
    assert.ok(pacResult.note.includes('PAC'));
  });

  await suite('limiter: 队满直接拒绝', async () => {
    const limiter = createLimiter({ limit: 1, maxQueue: 1, queueTimeoutMs: 5000 });
    const first = limiter.run(() => sleep(80));
    const second = limiter.run(() => sleep(10));
    await assert.rejects(limiter.run(() => sleep(10)), (error) => error.code === 'QUEUE_FULL');
    await Promise.all([first, second]);
  });

  await suite('models: 档位后缀自动分组 + effort 解析', async () => {
    const acp = new AcpRuntime({ getConfig: () => ({ modelCacheMs: 0, cwd: '.' }), log: () => {} });
    acp.discovery = {
      at: Date.now(),
      raw: [],
      groups: new Map([
        ['gemini-4-carbon', { base: 'gemini-4-carbon', names: ['Gemini 4 Carbon (Medium)'], levels: new Map([['low', 'gemini-4-carbon-low'], ['medium', 'gemini-4-carbon-medium'], ['high', 'gemini-4-carbon-high']]) }],
        ['solo-model', { base: 'solo-model', names: ['Solo'], levels: new Map() }],
      ]),
    };
    assert.strictEqual(acp.resolveModel('gemini-4-carbon', 'low'), 'gemini-4-carbon-low');
    assert.strictEqual(acp.resolveModel('gemini-4-carbon', 'high'), 'gemini-4-carbon-high');
    assert.strictEqual(acp.resolveModel('gemini-4-carbon', undefined), 'gemini-4-carbon-medium');
    assert.strictEqual(acp.resolveModel('solo-model', 'high'), 'solo-model');
    assert.strictEqual(acp.resolveModel('gemini-4-carbon-low', 'high'), 'gemini-4-carbon-high');
    assert.strictEqual(levelOfEffort('xhigh'), 'high');
    assert.strictEqual(levelOfEffort('minimal'), 'low');
  });

  await suite('messages: Chat 与 Responses 两种入参归一化', async () => {
    const pick = (arr) => arr.map(({ role, content }) => ({ role, content }));
    const chat = normalizeMessages({ messages: [{ role: 'user', content: 'hi' }] });
    assert.deepStrictEqual(pick(chat), [{ role: 'user', content: 'hi' }]);
    const responses = normalizeMessages({
      instructions: 'be brief',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
    }, { responses: true });
    assert.deepStrictEqual(pick(responses), [{ role: 'system', content: 'be brief' }, { role: 'user', content: 'hello' }]);
    const flat = normalizeMessages({ input: 'just text' }, { responses: true });
    assert.deepStrictEqual(pick(flat), [{ role: 'user', content: 'just text' }]);
  });

  await suite('images: data URL 透传成 ACP 图片块', async () => {
    const { buildPromptBlocks, normalizeMessages } = require(path.join(root, 'lib/server.js'));
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const messages = normalizeMessages({
      messages: [{
        role: 'user',
        content: [{ type: 'text', text: '这张图什么颜色' }, { type: 'image_url', image_url: { url: `data:image/png;base64,${png}` } }],
      }],
    });
    assert.strictEqual(messages[0].content, '这张图什么颜色');
    assert.strictEqual(messages[0].images.length, 1, '应收集到图片');
    const blocks = await buildPromptBlocks(messages[0].content, messages[0].images);
    assert.strictEqual(blocks[0].type, 'text');
    assert.strictEqual(blocks[1].type, 'image');
    assert.strictEqual(blocks[1].mimeType, 'image/png');
    assert.strictEqual(blocks[1].data, png);

    const inputImage = normalizeMessages({
      input: [{ role: 'user', content: [{ type: 'input_image', image_url: `data:image/jpeg;base64,${png}` }] }],
    }, { responses: true });
    assert.strictEqual(inputImage[0].images.length, 1, 'Responses 的 input_image 也要收集');
  });

  await suite('config: 只认数据目录一份配置，旧文件仅迁移一次', async () => {
    const base = tempDir('single-root');
    const dataDir = tempDir('single-data');

    // 旧版本：只有插件根目录有 config.json → 首次加载迁移到数据目录
    fs.writeFileSync(path.join(base, 'config.json'), JSON.stringify({ port: 42000 }), 'utf8');
    const first = configLib.loadConfig({ packageRoot: base, dataPath: dataDir });
    assert.strictEqual(first.port, 42000);
    assert.strictEqual(first.migratedFrom, path.join(dataDir, 'config.json'));
    assert.ok(fs.existsSync(path.join(dataDir, 'config.json')), '迁移后数据目录必须有配置');

    // 迁移之后再改根目录文件，不应再生效（本源只有一处）
    fs.writeFileSync(path.join(base, 'config.json'), JSON.stringify({ port: 49999 }), 'utf8');
    assert.strictEqual(configLib.loadConfig({ packageRoot: base, dataPath: dataDir }).port, 42000);

    // 面板保存只写数据目录
    const saved = configLib.savePanel({ packageRoot: base, dataPath: dataDir }, { port: '43001' }, null);
    assert.strictEqual(saved.ok, true);
    assert.strictEqual(saved.file, path.join(dataDir, 'config.json'));
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8')).port, 43001);
  });

  await suite('runtime: 清理运行时释放空间并回到 idle', async () => {
    const dir = tempDir('rt');
    const plugin = require(path.join(root, 'main.js'));
    globalThis.pi = {
      commands: { register() {}, unregister() {} },
      services: { register() {} },
      ui: { showToast: async () => {} },
      plugin: { getDataPath: async () => dir },
    };
    plugin._internals.setDataPath(dir);
    plugin._internals.reloadConfig();

    fs.mkdirSync(path.join(dir, 'runtime'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'runtime', 'agy_acp_server.exe'), Buffer.alloc(1024 * 1024));

    const before = plugin._internals.runtimeStatus();
    assert.ok(before.dirBytes >= 1024 * 1024, '应统计出已占用空间');
    assert.strictEqual(before.binExists, true, '数据目录里的运行时应被自动探测到');
    assert.strictEqual(before.busy, false);

    const result = plugin._internals.cleanupRuntime();
    assert.strictEqual(result.ok, true);
    assert.ok(result.freedBytes >= 1024 * 1024, '应报告释放的字节数');
    assert.strictEqual(plugin._internals.runtimeStatus().dirBytes, 0);
    assert.strictEqual(fs.existsSync(path.join(dir, 'runtime')), false);
  });

  const failed = results.filter((r) => !r.ok);
  console.log(`\n结果: ${results.length - failed.length}/${results.length} 通过`);
  if (failed.length > 0) process.exit(1);
}

main();
