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
const { createLimiter, levelOfEffort, AcpRuntime, permissionOutcome } = require(path.join(root, 'lib/core.js'));
const { normalizeMessages } = require(path.join(root, 'lib/server.js'));
const bridgeLib = require(path.join(root, 'lib/bridge.js'));
const { createMcpServer } = require(path.join(root, 'lib/mcp.js'));
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

  await suite('manifest: 不声明 provider（端点由用户自配，更自由）+ 工具回交默认开启', async () => {
    assert.strictEqual((manifest.contributes && manifest.contributes.providers) || undefined, undefined, '2.0.0 起不再声明 provider，改回自定义端点');
    assert.ok(!manifest.permissions.includes('provider.register'), '不再需要 provider.register');
    assert.ok(manifest.permissions.includes('background.service') && manifest.permissions.includes('ui.panel'));
  });

  await suite('config: 默认值、钳制与校验', async () => {
    const dir = tempDir('cfg');
    const cfg = configLib.loadConfig({ packageRoot: dir, dataPath: dir });
    assert.strictEqual(cfg.port, 41910);
    assert.strictEqual(cfg.bridgeTools, true, '工具回交默认开启，否则日志显示 true 但实际不生效');
    assert.strictEqual(configLib.loadConfig({ packageRoot: dir, dataPath: dir }).bridgeTools, true, '归一化必须保留 bridgeTools');
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
      raw: [
        { id: 'gemini-4-carbon-low' }, { id: 'gemini-4-carbon-medium' }, { id: 'gemini-4-carbon-high' },
        { id: 'solo-model' },
      ],
      groups: new Map([
        ['gemini-4-carbon', { base: 'gemini-4-carbon', names: ['Gemini 4 Carbon (Medium)'], levels: new Map([['low', 'gemini-4-carbon-low'], ['medium', 'gemini-4-carbon-medium'], ['high', 'gemini-4-carbon-high']]) }],
        ['solo-model', { base: 'solo-model', names: ['Solo'], levels: new Map() }],
      ]),
    };
    assert.strictEqual(await acp.resolveModel('gemini-4-carbon', 'low'), 'gemini-4-carbon-low');
    assert.strictEqual(await acp.resolveModel('gemini-4-carbon', 'high'), 'gemini-4-carbon-high');
    assert.strictEqual(await acp.resolveModel('gemini-4-carbon', undefined), 'gemini-4-carbon-medium');
    assert.strictEqual(await acp.resolveModel('solo-model', 'high'), 'solo-model');
    assert.strictEqual(await acp.resolveModel('gemini-4-carbon-low', 'high'), 'gemini-4-carbon-high');

    // 回归：模型发现缓存是空的（运行时重启过 / 预热失败）时，也绝不能把裸虚拟名发给运行时。
    // 运行时只认带档位后缀的 id：Rejecting model gemini-4-carbon: not available under the active auth method.
    const blind = new AcpRuntime({ getConfig: () => ({ modelCacheMs: 0, cwd: '.' }), log: () => {} });
    blind.discovery = { at: 0, raw: [], groups: new Map() };
    blind.discover = async () => { throw new Error('runtime not ready'); };
    assert.strictEqual(await blind.resolveModel('gemini-4-carbon', 'high'), 'gemini-4-carbon-high');
    // 列表已知但没有这个模型：明确报错（附可用列表）。绝不能静默换个模型冒充。
    await assert.rejects(() => acp.resolveModel('no-such-model', 'high'), /当前不可用/);
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

  await suite('documents: input_file / file / document → resource_link', async () => {
    const { collectDocuments, documentBlock, buildPromptBlocks } = require(path.join(root, 'lib/server.js'));
    const dir = tempDir('attach');
    const bytes = Buffer.from('%PDF-1.4\nfake pdf for tests\n');
    const dataUrl = `data:application/pdf;base64,${bytes.toString('base64')}`;

    const chatDoc = collectDocuments([{ type: 'file', file: { filename: 'a.pdf', file_data: dataUrl } }]);
    assert.strictEqual(chatDoc.length, 1);
    assert.strictEqual(chatDoc[0].name, 'a.pdf');
    const respDoc = collectDocuments([{ type: 'input_file', filename: 'b.pdf', file_data: dataUrl }]);
    assert.strictEqual(respDoc.length, 1);
    assert.strictEqual(respDoc[0].name, 'b.pdf');
    const claudeDoc = collectDocuments([{ type: 'document', name: 'c.pdf', source: { type: 'base64', media_type: 'application/pdf', data: bytes.toString('base64') } }]);
    assert.strictEqual(claudeDoc.length, 1);
    assert.strictEqual(claudeDoc[0].name, 'c.pdf');
    assert.deepStrictEqual(collectDocuments([{ type: 'file', file: { filename: 'x.pdf', file_id: 'file-123' } }])[0].unsupported, 'file_id');

    const { block } = await documentBlock(chatDoc[0], dir);
    assert.strictEqual(block.type, 'resource_link');
    assert.strictEqual(block.mimeType, 'application/pdf');
    assert.strictEqual(block.name, 'a.pdf');
    assert.ok(block.uri.startsWith('file:///'), '必须是 file:// URI，运行时只认这个');
    const saved = fs.readdirSync(dir).filter((name) => name.endsWith('.pdf'));
    assert.strictEqual(saved.length, 1, '附件应落盘为一个 PDF');
    assert.strictEqual(fs.statSync(path.join(dir, saved[0])).size, bytes.length);

    const blocks = await buildPromptBlocks('看附件', [], chatDoc, dir);
    assert.strictEqual(blocks[0].type, 'text');
    assert.strictEqual(blocks[1].type, 'resource_link');
    const textDoc = await buildPromptBlocks('看附件', [], [{ name: 'note.txt', inlineText: 'hello' }], dir);
    assert.ok(textDoc[1].text.includes('hello'), '纯文本文档应内联成文本');
  });

  await suite('tools: 权限策略决定 search_web 能不能跑', async () => {
    const params = {
      sessionId: 's1',
      toolCall: { toolCallId: 't1', title: 'Run search_web?', kind: 'search', status: 'pending' },
      options: [
        { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'allow-always', name: 'Always allow', kind: 'allow_always' },
        { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
      ],
    };
    const allowed = permissionOutcome('search', params);
    assert.strictEqual(allowed.decision, 'allow');
    assert.deepStrictEqual(allowed.outcome, { outcome: 'selected', optionId: 'allow-once' });
    assert.strictEqual(permissionOutcome('none', params).outcome.optionId, 'reject');
    assert.strictEqual(permissionOutcome('all', params).decision, 'allow');
    const edit = { ...params, toolCall: { toolCallId: 't2', title: 'Run run_command?', kind: 'execute' } };
    assert.strictEqual(permissionOutcome('search', edit).decision, 'reject');
    assert.strictEqual(permissionOutcome('all', edit).decision, 'allow');
    const bare = { toolCall: { kind: 'search' }, options: [] };
    assert.deepStrictEqual(permissionOutcome('search', bare).outcome, { outcome: 'cancelled' });
  });

  await suite('config: toolPolicy 校验与默认值', async () => {
    const ctx = { packageRoot: root, dataPath: fs.mkdtempSync(path.join(os.tmpdir(), 'agy-policy-')) };
    assert.strictEqual(configLib.validatePatch({ toolPolicy: 'all' }, ctx).patch.toolPolicy, 'all');
    assert.ok(configLib.validatePatch({ toolPolicy: 'yes' }, ctx).errors.some((e) => e.includes('工具权限')));
    const saved = configLib.savePanel(ctx, { toolPolicy: 'none' }, null);
    assert.strictEqual(saved.ok, true);
    assert.strictEqual(configLib.loadConfig(ctx).toolPolicy, 'none');
    assert.strictEqual(configLib.loadConfig({ packageRoot: root, dataPath: fs.mkdtempSync(path.join(os.tmpdir(), 'agy-policy2-')) }).toolPolicy, 'all', '默认不设防：本插件不再当第三道防火墙');
  });

  await suite('session: 会话键跨轮稳定（否则每轮都退化成新会话）', async () => {
    const { keyFor } = require(path.join(root, 'lib/server.js'));
    const a = [{ role: 'system', content: '你是助手' }, { role: 'user', content: '甲' }];
    const b = [{ role: 'system', content: '你是助手' }, { role: 'user', content: '乙' }];
    assert.notStrictEqual(keyFor('m', a), keyFor('m', b), '不同开场白不能撞进同一个会话');
    const turn2 = [...a, { role: 'assistant', content: '收到' }, { role: 'user', content: '继续' }];
    const turn3 = [...turn2, { role: 'assistant', content: '好' }, { role: 'user', content: '再继续' }];
    assert.strictEqual(keyFor('m', a), keyFor('m', turn2), '同一对话第 2 轮必须命中第 1 轮的 key');
    assert.strictEqual(keyFor('m', a), keyFor('m', turn3), '同一对话第 3 轮同样命中');
    assert.notStrictEqual(keyFor('m', turn2), keyFor('n', turn2), '换模型必须换 key');
    // 宿主给了会话标识时以宿主为准（同一标识、不同内容也视为同一会话）
    assert.strictEqual(
      keyFor('m', a, { prompt_cache_key: 'conv-1' }),
      keyFor('m', b, { prompt_cache_key: 'conv-1' }),
      'prompt_cache_key 优先',
    );
    assert.notStrictEqual(
      keyFor('m', a, { prompt_cache_key: 'conv-1' }),
      keyFor('m', a, { prompt_cache_key: 'conv-2' }),
      '不同会话标识必须分开',
    );
    assert.strictEqual(
      keyFor('m', a, { metadata: { conversation_id: 'x' } }),
      keyFor('m', b, { metadata: { conversation_id: 'x' } }),
      'metadata.conversation_id 同样生效',
    );
  });

  await suite('config: 会话空闲回收与断开即停的默认值', async () => {
    const ctx = { packageRoot: root, dataPath: fs.mkdtempSync(path.join(os.tmpdir(), 'agy-idle-')) };
    const cfg = configLib.loadConfig(ctx);
    assert.strictEqual(cfg.idleSessionMinutes, 10);
    assert.strictEqual(cfg.cancelOnDisconnect, true);
    const saved = configLib.savePanel(ctx, { idleSessionMinutes: 3, cancelOnDisconnect: 'false' }, null);
    assert.strictEqual(saved.ok, true);
    const reloaded = configLib.loadConfig(ctx);
    assert.strictEqual(reloaded.idleSessionMinutes, 3);
    assert.strictEqual(reloaded.cancelOnDisconnect, false);
    assert.ok(configLib.validatePatch({ idleSessionMinutes: 0 }, ctx).errors.some((e) => e.includes('会话空闲回收')));
  });

  await suite('config: 工作目录留空=跟随项目目录、显式值优先、非法值拒绝', async () => {
    const ctx = { packageRoot: root, dataPath: fs.mkdtempSync(path.join(os.tmpdir(), 'agy-cwd-')) };
    assert.strictEqual(configLib.loadConfig(ctx).cwd, '', '留空 = 跟随 PI-Desktop 当前项目目录');
    const target = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-cwd-target-'));
    assert.strictEqual(configLib.savePanel(ctx, { cwd: target }, null).ok, true);
    assert.strictEqual(configLib.loadConfig(ctx).cwd, target);
    assert.ok(configLib.validatePatch({ cwd: path.join(target, 'nope') }, ctx).errors.some((e) => e.includes('工作目录')));
    assert.strictEqual(configLib.validatePatch({ cwd: '' }, ctx).patch.cwd, '');
    assert.strictEqual(configLib.loadConfig(ctx).cwd, target, '清空只是待保存的补丁，不写盘就不生效');

    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-cwd-project-'));
    const makeAcp = (cfg, host) => new AcpRuntime({ getConfig: () => cfg, getCwd: host, log: () => {} });
    assert.strictEqual(await makeAcp({ cwd: target }, async () => project).cwdFor(), target, '面板填了就用面板的');
    assert.strictEqual(await makeAcp({ cwd: '' }, async () => project).cwdFor(), project, '留空跟随项目目录');
    assert.strictEqual(await makeAcp({ cwd: '' }, async () => '').cwdFor(), os.homedir(), '宿主没项目 → 用户主目录');
    assert.strictEqual(await makeAcp({ cwd: '' }, async () => path.join(project, 'nope')).cwdFor(), os.homedir(), '项目目录已消失 → 用户主目录');
  });

  await suite('tools: 请求级工具策略（tool_policy / web_search 声明）', async () => {
    const { policyForRequest, hasWebSearchTool } = require(path.join(root, 'lib/server.js'));
    assert.deepStrictEqual(policyForRequest('search', { tool_policy: 'none' }), { policy: 'none', reason: 'request.tool_policy' });
    assert.deepStrictEqual(policyForRequest('search', { tool_policy: 'shell' }), { policy: 'shell', reason: 'request.tool_policy' });
    assert.deepStrictEqual(policyForRequest('all', {}), { policy: 'all', reason: 'config' });
    assert.deepStrictEqual(policyForRequest('none', {}), { policy: 'none', reason: 'config' });
    assert.deepStrictEqual(policyForRequest('none', { tools: [{ type: 'web_search' }] }), { policy: 'search', reason: 'request.web_search' });
    assert.deepStrictEqual(policyForRequest('agent', { tools: [{ type: 'web_search' }] }), { policy: 'agent', reason: 'config' });
    assert.deepStrictEqual(policyForRequest('bogus', {}), { policy: 'all', reason: 'config' });
    assert.strictEqual(hasWebSearchTool({ tools: [{ type: 'web_search_preview' }] }), true);
    assert.strictEqual(hasWebSearchTool({ tools: [{ type: 'function' }] }), false);
    assert.strictEqual(hasWebSearchTool({}), false);
  });

  await suite('tools: shell 档放行 execute、仍挡住 edit', async () => {
    const base = {
      options: [
        { optionId: 'allow-once', kind: 'allow_once' },
        { optionId: 'reject', kind: 'reject_once' },
      ],
    };
    const exec = { ...base, toolCall: { kind: 'execute', title: 'Run echo ACP-OK' } };
    const edit = { ...base, toolCall: { kind: 'edit', title: 'Run write_to_file?' } };
    const search = { ...base, toolCall: { kind: 'search', title: 'Run search_web?' } };
    const other = { ...base, toolCall: { kind: 'other', title: 'Run invoke_subagent?' } };
    assert.strictEqual(permissionOutcome('shell', exec).decision, 'allow');
    assert.strictEqual(permissionOutcome('shell', search).decision, 'allow');
    assert.strictEqual(permissionOutcome('shell', other).decision, 'allow');
    assert.strictEqual(permissionOutcome('shell', edit).decision, 'reject');
    assert.strictEqual(permissionOutcome('agent', exec).decision, 'reject');
    assert.strictEqual(permissionOutcome('all', edit).decision, 'allow', 'all 档连写文件也放行');
    assert.strictEqual(permissionOutcome('none', search).decision, 'reject');
    const ctx = { packageRoot: root, dataPath: fs.mkdtempSync(path.join(os.tmpdir(), 'agy-shell-')) };
    assert.strictEqual(configLib.validatePatch({ toolPolicy: 'shell' }, ctx).patch.toolPolicy, 'shell');
  });

  await suite('usage: token 估算与「运行时不支持」参数识别', async () => {
    const { countTokens, usageFor, ignoredParams } = require(path.join(root, 'lib/server.js'));
    assert.strictEqual(countTokens('hello world'), 3);
    assert.strictEqual(countTokens('你好世界'), 4);
    assert.strictEqual(countTokens(''), 0);
    const usage = usageFor('你好', '世界', '');
    assert.strictEqual(usage.prompt_tokens, 2);
    assert.strictEqual(usage.completion_tokens, 2);
    assert.strictEqual(usage.total_tokens, 4);
    assert.strictEqual(usage.estimated, true);
    assert.deepStrictEqual(ignoredParams({ model: 'm', messages: [], temperature: 0.2, tools: [] }), ['temperature']);
    assert.deepStrictEqual(ignoredParams({ messages: [], max_tokens: 5, reasoning_effort: 'high' }), ['max_tokens']);
    assert.deepStrictEqual(ignoredParams({ messages: [], text: { format: { type: 'json_object' } } }), ['text.format']);
    const withContext = usageFor('你好', '世界', '', { contextUsed: 11643, contextSize: 1048576 });
    assert.strictEqual(withContext.context_used, 11643);
    assert.strictEqual(withContext.context_size, 1048576);
  });

  await suite('tools: agent 档放行 other、仍挡住写文件与执行命令', async () => {
    const base = {
      options: [
        { optionId: 'allow-once', kind: 'allow_once' },
        { optionId: 'reject', kind: 'reject_once' },
      ],
    };
    const other = { ...base, toolCall: { kind: 'other', title: 'Run invoke_subagent?' } };
    const edit = { ...base, toolCall: { kind: 'edit', title: 'Run write_to_file?' } };
    const exec = { ...base, toolCall: { kind: 'execute', title: 'Run run_command?' } };
    const search = { ...base, toolCall: { kind: 'search', title: 'Run search_web?' } };
    assert.strictEqual(permissionOutcome('agent', other).decision, 'allow');
    assert.strictEqual(permissionOutcome('agent', search).decision, 'allow');
    assert.strictEqual(permissionOutcome('agent', edit).decision, 'reject');
    assert.strictEqual(permissionOutcome('agent', exec).decision, 'reject');
    assert.strictEqual(permissionOutcome('search', other).decision, 'reject');
    assert.strictEqual(permissionOutcome('none', search).decision, 'reject');
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

  await suite('transport: agent 请求 id 撞上在途响应 id 时不得误当作结果', async () => {
    const writes = [];
    const rt = new AcpRuntime({ getConfig: () => ({ toolPolicy: 'all' }), log: () => {} });
    rt.child = { pid: 1, stdin: { write: (s) => writes.push(JSON.parse(s)) } };
    const pending = rt.request('session/prompt', { sessionId: 's1', prompt: [] }, 5000);
    const promptId = writes[0].id;

    // 运行时自己的请求计数器从 0 开始递增，很容易与客户端 id 相同。
    rt.handleLine(JSON.stringify({
      jsonrpc: '2.0', id: promptId, method: 'session/request_permission',
      params: { sessionId: 's1', toolCall: { kind: 'execute', title: 'run' }, options: [{ optionId: 'allow', kind: 'allow_once' }] },
    }));
    const answer = writes.find((w) => w.id === promptId && w.result);
    assert.ok(answer, '权限请求必须被回答');
    assert.strictEqual(answer.result.outcome.outcome, 'selected');

    let settled = false;
    pending.then(() => { settled = true; }, () => { settled = true; });
    await sleep(20);
    assert.strictEqual(settled, false, '权限请求不能把在途 prompt 提前结束');

    rt.handleLine(JSON.stringify({ jsonrpc: '2.0', id: promptId, result: { stopReason: 'end_turn' } }));
    const result = await pending;
    assert.strictEqual(result.stopReason, 'end_turn');
  });

  await suite('bridge: 工具目录投影与结果回填', async () => {
    const tools = bridgeLib.projectTools([
      { type: 'function', function: { name: 'Bash', description: 'run', parameters: { type: 'object', properties: { command: { type: 'string' } } } } },
      { type: 'function', function: { name: 'Read', parameters: { type: 'object', properties: {} } } },
      { type: 'function', function: { name: 'bad name!', parameters: {} } },
      { type: 'function', function: { name: 'Bash', parameters: {} } },
    ]);
    assert.deepStrictEqual(tools.map((t) => t.name), ['Bash', 'Read'], '非法名与重名要被过滤');
    assert.strictEqual(tools[0].inputSchema.properties.command.type, 'string');

    const calls = bridgeLib.toToolCalls({ toolCallId: 'call_1', name: 'Bash', args: { command: 'ls' } });
    assert.strictEqual(calls[0].id, 'call_1');
    assert.strictEqual(calls[0].type, 'function');
    assert.deepStrictEqual(JSON.parse(calls[0].function.arguments), { command: 'ls' });

    const found = bridgeLib.matchToolResult([
      { role: 'user', content: 'hi' },
      { role: 'tool', tool_call_id: 'call_1', content: 'out' },
    ], 'call_1');
    assert.strictEqual(bridgeLib.toolResultText(found), 'out');
    assert.strictEqual(bridgeLib.matchToolResult([], 'call_1'), null);
  });

  await suite('mcp: initialize / tools/list / tools/call 挂起后回填', async () => {
    let resolveCall;
    const mcp = createMcpServer({
      listTools: () => [{ name: 'Bash', description: 'run', inputSchema: { type: 'object', properties: {} } }],
      callTool: () => new Promise((resolve) => { resolveCall = resolve; }),
    });
    const info = await mcp.listen(0, '127.0.0.1');
    try {
      const post = async (body) => {
        const r = await fetch(info.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
        return { status: r.status, text: await r.text() };
      };
      const init = JSON.parse((await post({ jsonrpc: '2.0', id: 1, method: 'initialize' })).text);
      assert.strictEqual(init.result.protocolVersion, '2024-11-05');
      const list = JSON.parse((await post({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).text);
      assert.deepStrictEqual(list.result.tools.map((t) => t.name), ['Bash']);

      // tools/call：必须先拿到响应头，再等回填
      const pending = fetch(info.url, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'Bash', arguments: { command: 'ls' } } }),
      });
      const response = await pending;
      assert.strictEqual(response.status, 200, 'tools/call 必须先回响应头');
      assert.ok(String(response.headers.get('content-type')).includes('text/event-stream'));
      await sleep(30);
      resolveCall({ content: [{ type: 'text', text: 'file.txt' }] });
      const body = await response.text();
      assert.ok(body.includes('file.txt'), '回填结果要写进同一路 SSE');
    } finally {
      mcp.close();
    }
  });

  await suite('session-store: 足迹落盘、过期剔除、重启后重新列出', async () => {
    const { createSessionStore, MAX_AGE_MS } = require(path.join(root, 'lib/session-store.js'));
    const dir = tempDir('sessions');
    const file = path.join(dir, 'sessions.json');
    const store = createSessionStore({ file });
    assert.strictEqual(store.load(), 0, '没有文件时载入 0 条');
    store.set('k1', { sessionId: 'sess-1', model: 'gemini-4-carbon', bridgeUrl: 'http://127.0.0.1:1/mcp' });
    store.set('k2', { sessionId: 'sess-2' });
    store.flush();
    assert.ok(fs.existsSync(file), 'flush 必须真的写盘');
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.strictEqual(raw.version, 1);
    assert.strictEqual(raw.sessions.length, 2);
    assert.strictEqual(raw.sessions.find((s) => s.key === 'k1').sessionId, 'sess-1');

    // 「重启」：新建一个 store 读同一份文件
    const reopened = createSessionStore({ file });
    assert.strictEqual(reopened.load(), 2);
    assert.strictEqual(reopened.get('k1').bridgeUrl, 'http://127.0.0.1:1/mcp');
    reopened.remove('k2');
    reopened.flush();
    assert.strictEqual(createSessionStore({ file }).load(), 1, '删除要落盘');

    // 过期足迹必须被剔除，否则重启后会拿早就没了的 sessionId 去 load
    fs.writeFileSync(file, JSON.stringify({
      version: 1,
      sessions: [{ key: 'old', sessionId: 's', model: '', bridgeUrl: '', touched: Date.now() - MAX_AGE_MS - 1000 }],
    }), 'utf8');
    assert.strictEqual(createSessionStore({ file }).load(), 0, '超过一天没动的足迹直接丢');
  });

  await suite('session-store: 损坏文件不抛异常', async () => {
    const { createSessionStore } = require(path.join(root, 'lib/session-store.js'));
    const dir = tempDir('sessions-bad');
    const file = path.join(dir, 'sessions.json');
    fs.writeFileSync(file, '{ 这不是 JSON', 'utf8');
    const logs = [];
    const store = createSessionStore({ file, log: (m) => logs.push(m) });
    assert.strictEqual(store.load(), 0);
    assert.ok(logs.some((l) => l.includes('读取失败')), '要留下日志但不能崩');
    assert.strictEqual(store.size(), 0);
  });
  const failed = results.filter((r) => !r.ok);
  console.log(`\n结果: ${results.length - failed.length}/${results.length} 通过`);
  if (failed.length > 0) process.exit(1);
}

main();
