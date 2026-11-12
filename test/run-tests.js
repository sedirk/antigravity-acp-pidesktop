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
    assert.notStrictEqual(keyFor(a), keyFor(b), '不同开场白不能撞进同一个会话');
    const turn2 = [...a, { role: 'assistant', content: '收到' }, { role: 'user', content: '继续' }];
    const turn3 = [...turn2, { role: 'assistant', content: '好' }, { role: 'user', content: '再继续' }];
    assert.strictEqual(keyFor(a), keyFor(turn2), '同一对话第 2 轮必须命中第 1 轮的 key');
    assert.strictEqual(keyFor(a), keyFor(turn3), '同一对话第 3 轮同样命中');
    assert.strictEqual(keyFor(turn2), keyFor(turn2), '同一对话多次计算必须稳定');
    // 宿主给了会话标识时以宿主为准（同一标识、不同内容也视为同一会话）
    assert.strictEqual(
      keyFor(a, { prompt_cache_key: 'conv-1' }),
      keyFor(b, { prompt_cache_key: 'conv-1' }),
      'prompt_cache_key 优先',
    );
    assert.notStrictEqual(
      keyFor(a, { prompt_cache_key: 'conv-1' }),
      keyFor(a, { prompt_cache_key: 'conv-2' }),
      '不同会话标识必须分开',
    );
    assert.strictEqual(
      keyFor(a, { metadata: { conversation_id: 'x' } }),
      keyFor(b, { metadata: { conversation_id: 'x' } }),
      'metadata.conversation_id 同样生效',
    );
  });

  await suite('session: 会话键不含模型（换档位/换模型都不换会话）', async () => {
    const { keyFor } = require(path.join(root, 'lib/server.js'));
    const req = { prompt_cache_key: 'same-chat' };
    const msgs = [{ role: 'user', content: 'hi' }];
    // 签名里已经没有模型参数（req 带默认值，所以 length === 1）：模型/档位不再参与会话身份
    assert.strictEqual(keyFor.length, 1, 'keyFor 不得再接收模型');
    assert.strictEqual(keyFor(msgs, req), keyFor(msgs, req), '同一对话稳定');
    assert.notStrictEqual(keyFor(msgs, { prompt_cache_key: 'other-chat' }), keyFor(msgs, req), '不同对话仍然分开');
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
    // 真实上下文用量（contextUsed / contextSize）跨重启保留；同 sessionId 更新元数据不冲掉旧值，换 sessionId 则重置
    const withUsage = createSessionStore({ file });
    withUsage.load();
    withUsage.set('k1', { sessionId: 'sess-1', model: 'gemini-4-carbon', bridgeUrl: 'http://127.0.0.1:1/mcp', contextUsed: 128945, contextSize: 1048576 });
    withUsage.set('k1', { sessionId: 'sess-1', model: 'gemini-4-carbon-high', bridgeUrl: 'http://127.0.0.1:1/mcp' });
    withUsage.flush();
    const usageReloaded = createSessionStore({ file });
    usageReloaded.load();
    assert.strictEqual(usageReloaded.get('k1').contextUsed, 128945, '同 sessionId 更新不应丢失已记录的 contextUsed');
    assert.strictEqual(usageReloaded.get('k1').contextSize, 1048576, '同 sessionId 更新不应丢失已记录的 contextSize');
    usageReloaded.set('k1', { sessionId: 'sess-new', model: 'gemini-4-carbon' });
    assert.strictEqual(usageReloaded.get('k1').contextUsed, undefined, '切换新 sessionId 时不应继承旧会话的 contextUsed');

    // 过期足迹必须被剔除，否则重启后会拿早就没了的 sessionId 去 load
    fs.writeFileSync(file, JSON.stringify({
      version: 1,
      sessions: [{ key: 'old', sessionId: 's', model: '', bridgeUrl: '', touched: Date.now() - MAX_AGE_MS - 1000 }],
    }), 'utf8');
    assert.strictEqual(createSessionStore({ file }).load(), 0, '超过 TTL 没动的足迹直接丢');

    // 但「运行时早回收了」不是丢弃的理由：实测 close 之后 load 仍能拿回历史，
    // 两天前的足迹留着才可能省下一次整段重放。
    fs.writeFileSync(file, JSON.stringify({
      version: 1,
      sessions: [{ key: 'two-days', sessionId: 's', model: '', bridgeUrl: '', touched: Date.now() - 2 * 24 * 60 * 60 * 1000 }],
    }), 'utf8');
    assert.strictEqual(createSessionStore({ file }).load(), 1, '两天前的足迹必须保留');
    // 兜底上限：超过 MAX_ENTRIES 时按最久未用淘汰，文件不能无限长
    const many = [];
    for (let i = 0; i < 520; i += 1) many.push({ key: `k${i}`, sessionId: `s${i}`, model: '', bridgeUrl: '', touched: Date.now() - i * 1000 });
    fs.writeFileSync(file, JSON.stringify({ version: 1, sessions: many }), 'utf8');
    const capped = createSessionStore({ file });
    assert.strictEqual(capped.load(), 520, 'load 不设上限（读多少算多少）');
    capped.touch('k0'); // 先弄脏，否则 flush 直接返回
    capped.flush();
    const saved = JSON.parse(fs.readFileSync(file, 'utf8')).sessions;
    assert.strictEqual(saved.length, 500, '落盘时截到上限');
    assert.ok(saved.some((s) => s.key === 'k0'), '保留最近用过的');
    assert.ok(!saved.some((s) => s.key === 'k519'), '丢掉最久未用的');
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

  await suite('runtime: 直连启动后发现代理只给一次重建信号（单向）', async () => {
    const { AcpRuntime } = require(path.join(root, 'lib/core.js'));
    let proxy = '';
    const rt = new AcpRuntime({ getConfig: () => ({ bin: 'x' }), getProxy: () => proxy, log: () => {} });
    assert.strictEqual(rt.proxyDrift(), '', '运行时没起来就不该有信号');
    rt.ready = true;
    rt.child = { pid: 1 };
    rt.spawnProxy = '';
    assert.strictEqual(rt.proxyDrift(), '', '一直直连就没有信号');
    proxy = 'http://127.0.0.1:10808';
    assert.strictEqual(rt.proxyDrift(), proxy, '直连起、现在有代理 → 必须重建（否则联网全 Internal error）');
    rt.spawnProxy = proxy;
    proxy = '';
    assert.strictEqual(rt.proxyDrift(), '', '反向（代理→直连）不重启，免得开关 VPN 反复重建');
    assert.strictEqual(rt.status().proxy, 'http://127.0.0.1:10808', 'status 要暴露运行时实际用的网络路径');

    // childEnv 是唯一把代理交给运行时的地方：它必须同时记下本次真正的值
    rt.spawnProxy = '';
    proxy = 'http://127.0.0.1:9999';
    const env = rt.childEnv();
    assert.strictEqual(env.HTTPS_PROXY, proxy);
    assert.strictEqual(rt.spawnProxy, proxy, 'spawnProxy 要跟上真正传出去的值');
    proxy = '';
    const env2 = rt.childEnv();
    assert.strictEqual(env2.HTTPS_PROXY, undefined, '直连时必须把代理环境变量删干净');
    assert.strictEqual(rt.spawnProxy, '', 'spawnProxy 要跟着清空');
  });

  await suite('runtime/config: 单轮硬上限可以关掉（0 = 不设上限）', async () => {
    const { AcpRuntime } = require(path.join(root, 'lib/core.js'));
    const cfgLib = require(path.join(root, 'lib/config.js'));
    const ctx = { packageRoot: root, dataPath: root };
    assert.strictEqual(cfgLib.normalize({ promptTimeoutMs: 0 }, ctx).promptTimeoutMs, 0, '0 不能被夹回 1 分钟');
    assert.strictEqual(cfgLib.normalize({}, ctx).promptTimeoutMs, 0, '默认就是不设上限');
    assert.strictEqual(cfgLib.normalize({ promptTimeoutMs: 600000 }, ctx).promptTimeoutMs, 600000, '显式设置仍生效');
    const { patch, errors } = cfgLib.validatePatch({ promptTimeoutMinutes: 0 }, ctx);
    assert.deepStrictEqual(errors, [], '面板填 0 分钟不该报错');
    assert.strictEqual(patch.promptTimeoutMs, 0);

    // 关键：timeoutMs=0 必须真的「永不超时」，不能变成 setTimeout(..., 0) 的立刻超时
    const rt = new AcpRuntime({ getConfig: () => ({ toolPolicy: 'all' }), log: () => {} });
    rt.child = { stdin: { write: () => {} }, on: () => {}, kill: () => {} };
    const id = rt.nextId;
    const waiting = rt.request('session/prompt', {}, 0);
    await new Promise((r) => setTimeout(r, 60));
    assert.strictEqual(rt.pending.size, 1, 'timeoutMs=0 不能在几十毫秒后自己超时');
    rt.handleLine(JSON.stringify({ jsonrpc: '2.0', id, result: { ok: 1 } }));
    assert.deepStrictEqual(await waiting, { ok: 1 }, '结果要能正常回填');
    const timed = rt.request('session/prompt', {}, 40);
    await timed.then(
      () => { throw new Error('设了上限就该超时'); },
      (error) => assert.strictEqual(error.code, 'ACP_TIMEOUT'),
    );
  });

  await suite('runtime: 重启后旧子进程异步 exit 不得冲掉新进程与在途请求', async () => {
    const { EventEmitter } = require('node:events');
    const cp = require('node:child_process');
    const corePath = path.join(root, 'lib/core.js');
    const origSpawn = cp.spawn;
    const spawned = [];
    cp.spawn = () => {
      const proc = new EventEmitter();
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.killed = false;
      proc.kill = () => { proc.killed = true; };
      proc.stdin = {
        write(chunk) {
          const msg = JSON.parse(String(chunk).trim());
          if (msg.method === 'initialize') {
            setImmediate(() => {
              proc.stdout.emit('data', `${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { agentInfo: { gen: spawned.length } } })}\n`);
            });
          }
        },
      };
      spawned.push(proc);
      return proc;
    };
    delete require.cache[require.resolve(corePath)];
    try {
      const { AcpRuntime: FreshRuntime } = require(corePath);
      const rt = new FreshRuntime({
        getConfig: () => ({ bin: process.execPath, toolPolicy: 'all' }),
        log: () => {},
      });
      await rt.start();
      assert.strictEqual(spawned.length, 1);
      const oldChild = spawned[0];
      rt.restart();
      await rt.start();
      assert.strictEqual(spawned.length, 2);
      const newChild = spawned[1];
      assert.strictEqual(rt.child, newChild);
      assert.strictEqual(rt.ready, true);

      const reqId = rt.nextId;
      const inflight = rt.request('session/prompt', { sessionId: 's-new' }, 0);
      // 模拟旧进程在 Windows 下延迟触发 exit / error / stdout
      oldChild.stdout.emit('data', `${JSON.stringify({ jsonrpc: '2.0', id: reqId, error: { message: 'wrong child' } })}\n`);
      oldChild.emit('error', new Error('old EPIPE'));
      oldChild.emit('exit', 0, 'SIGTERM');

      assert.strictEqual(rt.ready, true, '旧进程 exit 不能把新运行时的 ready 清掉');
      assert.strictEqual(rt.child, newChild, '旧进程 exit 不能把新 child 置空');
      assert.strictEqual(rt.pending.size, 1, '新进程上的在途请求不能被旧进程 exit 拒绝');

      newChild.stdout.emit('data', `${JSON.stringify({ jsonrpc: '2.0', id: reqId, result: { stopReason: 'end_turn' } })}\n`);
      assert.deepStrictEqual(await inflight, { stopReason: 'end_turn' });
    } finally {
      cp.spawn = origSpawn;
      delete require.cache[require.resolve(corePath)];
    }
  });

  await suite('runtime: abandon 支持按 sessionId 精确放弃，不误伤其它会话', async () => {
    const rt = new AcpRuntime({ getConfig: () => ({ toolPolicy: 'all' }), log: () => {} });
    rt.child = { stdin: { write: () => {} }, on: () => {}, kill: () => {} };
    const idA = rt.nextId;
    const reqA = rt.request('session/prompt', { sessionId: 'sess-a' }, 0);
    const idB = rt.nextId;
    const reqB = rt.request('session/prompt', { sessionId: 'sess-b' }, 0);
    assert.strictEqual(rt.abandon('session/prompt', '会话 A 已取消', 'sess-a'), 1);
    await assert.rejects(reqA, (err) => err.code === 'ACP_ABANDONED' && err.message.includes('会话 A'));
    assert.strictEqual(rt.pending.size, 1, '会话 B 的在途请求必须保留');
    assert.strictEqual(idA !== idB, true);
    rt.handleLine(JSON.stringify({ jsonrpc: '2.0', id: idB, result: { stopReason: 'end_turn' } }));
    assert.deepStrictEqual(await reqB, { stopReason: 'end_turn' });
  });

  await suite('config: 面板可清空可选字段，且默认桥接提示词不会冻结进 config.json', async () => {
    const dir = tempDir('panel-clear');
    const ctx = { packageRoot: root, dataPath: dir };
    const s1 = configLib.savePanel(ctx, {
      cwd: root,
      clientName: 'custom-client',
      proxy: 'http://127.0.0.1:7890',
    });
    assert.strictEqual(s1.ok, true);
    const panel1 = configLib.readPanel(ctx, configLib.loadConfig(ctx));
    assert.strictEqual(panel1.cwd, root);
    assert.strictEqual(panel1.clientName, 'custom-client');
    assert.strictEqual(panel1.proxy, 'http://127.0.0.1:7890');
    assert.strictEqual(panel1.bridgeGuidance, '', '未自定义时 readPanel 应返空串，由 placeholder 展示内置默认');
    assert.strictEqual(panel1.bridgeGuidanceDefault, configLib.BUILTIN_BRIDGE_GUIDANCE);

    // 用户清空字段，或误把默认提示词原样提交：都应落回空串而不冻结旧文案
    const s2 = configLib.savePanel(ctx, {
      cwd: '',
      clientName: '',
      proxy: '',
      bridgeGuidance: configLib.BUILTIN_BRIDGE_GUIDANCE,
    });
    assert.strictEqual(s2.ok, true);
    const rawSaved = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
    assert.strictEqual(rawSaved.cwd, '');
    assert.strictEqual(rawSaved.clientName, '');
    assert.strictEqual(rawSaved.proxy, '');
    assert.strictEqual(rawSaved.bridgeGuidance, '', '与内置默认一致的提示词不能写死进 config.json');
    const loaded = configLib.loadConfig(ctx);
    assert.strictEqual(loaded.bridgeGuidance, '');
  });

  await suite('bridge/mcp: 并行工具批量映射与 MCP 连接中断自动清理挂起项', async () => {
    const batch = bridgeLib.toToolCalls([
      { toolCallId: 'c1', name: 'Read', args: { path: 'a.js' } },
      { toolCallId: 'c2', name: 'Grep', args: { pattern: 'foo' } },
    ]);
    assert.strictEqual(batch.length, 2);
    assert.deepStrictEqual(batch.map((x) => [x.index, x.id, x.function.name]), [
      [0, 'c1', 'Read'],
      [1, 'c2', 'Grep'],
    ]);

    let cancelled = 0;
    const mcp = createMcpServer({
      listTools: () => [],
      callTool: ({ registerCancel }) => new Promise(() => {
        registerCancel(() => { cancelled += 1; });
      }),
    });
    const { port } = await mcp.listen(0, '127.0.0.1');
    try {
      const http = require('node:http');
      await new Promise((resolve, reject) => {
        const req = http.request({
          host: '127.0.0.1', port, path: '/mcp?k=1', method: 'POST',
          headers: { 'content-type': 'application/json' },
        }, (res) => {
          res.once('data', () => {
            req.destroy();
            resolve();
          });
        });
        req.on('error', (err) => { if (err.code !== 'ECONNRESET') reject(err); });
        req.end(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'Read', arguments: {} } }));
      });
      await sleep(40);
      assert.strictEqual(cancelled, 1, 'MCP HTTP 流断开时必须触发 registerCancel 清理挂起状态');
    } finally {
      mcp.close();
    }
  });

  await suite('models: 导出的虚拟模型必须包含 canSteer 与 steering 能力元数据', async () => {
    const rt = new AcpRuntime({ getConfig: () => ({ virtualModels: true }), log: () => {} });
    rt.discovery = {
      raw: [{ id: 'gemini-2.5-pro-high', name: 'Gemini 2.5 Pro (high)' }],
      groups: new Map([
        ['gemini-2.5-pro', { base: 'gemini-2.5-pro', names: ['Gemini 2.5 Pro'], levels: new Map([['high', 'gemini-2.5-pro-high']]) }],
      ]),
    };
    rt.discover = async () => rt.discovery;
    const list = await rt.modelsForApi();
    assert.ok(list.length > 0);
    const m = list[0];
    assert.strictEqual(m.canSteer, true, '应声明 canSteer: true');
    assert.strictEqual(m.supports_steering, true, '应声明 supports_steering: true');
    assert.ok(m.capabilities.includes('steer'), 'capabilities 列表中应包含 steer');
  });

  await suite('panel: onPanelInvoke 对 config:get 与 config:save 双向兼容', async () => {
    const plugin = require('../main.js');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-panel-'));
    plugin._internals.setDataPath(dir);
    plugin._internals.reloadConfig();
    const cfg = await plugin.onPanelInvoke('config:get');
    assert.ok(cfg && typeof cfg === 'object', 'config:get 应能正常读取配置');
    const saveRes = await plugin.onPanelInvoke('config:save', { port: 41910 });
    assert.strictEqual(saveRes.ok, true, 'config:save 应能成功写入');
  });
  const failed = results.filter((r) => !r.ok);
  console.log(`\n结果: ${results.length - failed.length}/${results.length} 通过`);
  if (failed.length > 0) process.exit(1);
}

main();
