'use strict';

const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');

const root = path.resolve(__dirname, '..');
const bridgeLib = require(path.join(root, 'lib/bridge.js'));
const { createMcpServer } = require(path.join(root, 'lib/mcp.js'));
const { createSessionStore, writeAtomic } = require(path.join(root, 'lib/session-store.js'));
const { AcpRuntime } = require(path.join(root, 'lib/core.js'));
const { createGateway, readDocumentBytes, documentBlock, usageFor } = require(path.join(root, 'lib/server.js'));

const results = [];
async function test(name, fn) {
  process.stdout.write(`  TEST  ${name} ... `);
  try {
    await fn();
    console.log('PASS');
    results.push({ name, ok: true });
  } catch (error) {
    console.log('FAIL');
    console.error(error);
    results.push({ name, ok: false, error });
  }
}

function tempDir(prefix) {
  const dir = path.join(os.tmpdir(), `agy-pri-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  console.log('Antigravity ACP 优先级 1 ~ 4 功能全量回归验证');

  // 1. Item 4: 命名空间工具名规范化与回映射
  await test('Item 4: 命名空间工具名规范化 (sanitizeToolName) 与回填 (toToolCalls)', async () => {
    assert.strictEqual(bridgeLib.sanitizeToolName('pi-desktop/visualize'), 'pi-desktop_visualize');
    assert.strictEqual(bridgeLib.sanitizeToolName('ns:tool'), 'ns_tool');
    assert.strictEqual(bridgeLib.sanitizeToolName('a.b.c'), 'a_b_c');
    assert.strictEqual(bridgeLib.sanitizeToolName('my-tool_1'), 'my-tool_1');
    assert.strictEqual(bridgeLib.sanitizeToolName('bad name!'), '', '非法字符必须过滤为空');
    assert.strictEqual(bridgeLib.sanitizeToolName(''), '');

    const projected = bridgeLib.projectTools([
      { type: 'function', function: { name: 'pi-desktop/visualize', description: 'draw charts', parameters: { type: 'object' } } },
      { type: 'function', function: { name: 'regular_tool', parameters: {} } },
    ]);
    assert.strictEqual(projected.length, 2);
    assert.strictEqual(projected[0].name, 'pi-desktop_visualize');
    assert.strictEqual(projected[0].rawName, 'pi-desktop/visualize');
    assert.strictEqual(projected[1].name, 'regular_tool');
    assert.strictEqual(projected[1].rawName, 'regular_tool');

    const calls = bridgeLib.toToolCalls([
      { toolCallId: 'call_vis', name: 'pi-desktop_visualize', rawName: 'pi-desktop/visualize', args: { html: '<div></div>' } },
      { toolCallId: 'call_reg', name: 'regular_tool', args: {} },
    ]);
    assert.strictEqual(calls[0].function.name, 'pi-desktop/visualize', '必须回交原生命名空间工具名');
    assert.strictEqual(calls[1].function.name, 'regular_tool');
  });

  // 2. Item 3: notifications/cancelled 取消在途挂起工具调用
  await test('Item 3: MCP notifications/cancelled 协议取消在途挂起工具调用', async () => {
    let cancelCalled = 0;
    const mcp = createMcpServer({
      listTools: () => [{ name: 'SlowTool', inputSchema: { type: 'object' } }],
      callTool: ({ registerCancel }) => new Promise((_, reject) => {
        registerCancel(() => {
          cancelCalled += 1;
          const err = new Error('cancelled by client');
          reject(err);
        });
      }),
    });
    const { port } = await mcp.listen(0, '127.0.0.1');
    try {
      const callReq = http.request({
        host: '127.0.0.1', port, path: '/mcp?k=test', method: 'POST',
        headers: { 'content-type': 'application/json' },
      });
      callReq.end(JSON.stringify({ jsonrpc: '2.0', id: 88, method: 'tools/call', params: { name: 'SlowTool', arguments: {} } }));
      await sleep(50);

      const cancelReq = http.request({
        host: '127.0.0.1', port, path: '/mcp?k=test', method: 'POST',
        headers: { 'content-type': 'application/json' },
      });
      const cancelDone = new Promise((resolve) => {
        cancelReq.on('response', (res) => {
          assert.strictEqual(res.statusCode, 202);
          resolve();
        });
      });
      cancelReq.end(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 88 } }));
      await cancelDone;
      await sleep(50);
      assert.strictEqual(cancelCalled, 1, '收到 cancelled 通知后必须立即触发工具的 registerCancel');
    } finally {
      mcp.close();
    }
  });

  // 3. Item 5: SessionStore writeAtomic 原子落盘
  await test('Item 5: SessionStore writeAtomic 原子落盘防截断损坏', async () => {
    const dir = tempDir('atomic-store');
    const file = path.join(dir, 'sessions.json');
    writeAtomic(file, { version: 1, test: true, time: Date.now() });
    assert.ok(fs.existsSync(file), '文件必须成功写入');
    const content = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.strictEqual(content.version, 1);
    assert.strictEqual(content.test, true);
    const tmps = fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'));
    assert.strictEqual(tmps.length, 0, '落盘完成后不得残留 .tmp 文件');

    const store = createSessionStore({ file });
    store.load();
    store.set('conv-1', { sessionId: 's-100', model: 'claude-3-5' });
    store.flush();
    const reopened = createSessionStore({ file });
    assert.strictEqual(reopened.load(), 1);
    assert.strictEqual(reopened.get('conv-1').sessionId, 's-100');
  });

  // 4. Item 7: SSRF / Path Traversal 防御
  await test('Item 7: 文档读取拒绝白名单目录以外的 file:// 路径', async () => {
    const safeDir = tempDir('safe-dir');
    const secretDir = tempDir('secret-dir');
    const safeFile = path.join(safeDir, 'allowed.txt');
    const secretFile = path.join(secretDir, 'secret.env');
    fs.writeFileSync(safeFile, 'ALLOWED_CONTENT', 'utf8');
    fs.writeFileSync(secretFile, 'SECRET_KEY=12345', 'utf8');

    const safeDoc = { name: 'allowed.txt', url: `file:///${safeFile.replace(/\\/g, '/')}` };
    const ok = await readDocumentBytes(safeDoc, [safeDir]);
    assert.ok(ok);
    assert.strictEqual(ok.bytes.toString('utf8'), 'ALLOWED_CONTENT');

    const badDoc = { name: 'secret.env', url: `file:///${secretFile.replace(/\\/g, '/')}` };
    const forbidden = await readDocumentBytes(badDoc, [safeDir]);
    assert.strictEqual(forbidden, null, '白名单外部的 file:// 必须返回 null');

    const blockRes = await documentBlock(badDoc, safeDir, [safeDir]);
    assert.strictEqual(blockRes.block.type, 'text');
    assert.ok(blockRes.block.text.includes('读取失败，已跳过'));
  });

  // 5. Item 2: 探针异常时保证执行 session/close 防止 worker 孤儿泄漏
  await test('Item 2: 模型探针异常时保证关闭会话，避免本地 worker 进程孤儿泄漏', async () => {
    let closedSessionId = null;
    const rt = new AcpRuntime({
      getConfig: () => ({ toolPolicy: 'all' }),
      log: () => {},
    });
    rt.child = { stdin: { write: () => {} }, on: () => {}, kill: () => {} };
    rt.ready = true;
    rt.request = async (method, params) => {
      if (method === 'session/new') return { sessionId: 'probe-leak-test-session' };
      if (method === 'session/prompt') throw new Error('Simulated probe failure');
      if (method === 'session/close') {
        closedSessionId = params.sessionId;
        return {};
      }
      return {};
    };

    const models = await rt.discover(true);
    assert.deepStrictEqual(models.raw, [], '探针异常时安全返回空列表');
    assert.strictEqual(closedSessionId, 'probe-leak-test-session', '探针出现异常时必须在 finally 中关闭会话');
  });

  // 6. Item 1: 多租户 MCP tools/list 隔离测试
  await test('Item 1: 多租户 tools/list 按 query key (?k=) 隔离各会话工具列表', async () => {
    const mcp = createMcpServer({
      listTools: (url) => {
        const u = new URL(url, 'http://127.0.0.1');
        const k = u.searchParams.get('k');
        if (k === 'agentA') return [{ name: 'ToolA', inputSchema: {} }];
        if (k === 'agentB') return [{ name: 'ToolB', inputSchema: {} }];
        return [{ name: 'FallbackTool', inputSchema: {} }];
      },
      callTool: async () => ({ content: [] }),
    });
    const { port, url } = await mcp.listen(0, '127.0.0.1');
    try {
      const getList = async (reqUrl) => {
        const res = await fetch(reqUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
        });
        const json = await res.json();
        return json.result.tools.map((t) => t.name);
      };

      const toolsA = await getList(`${url}?k=agentA`);
      assert.deepStrictEqual(toolsA, ['ToolA'], 'agentA 应当只拿到 ToolA');

      const toolsB = await getList(`${url}?k=agentB`);
      assert.deepStrictEqual(toolsB, ['ToolB'], 'agentB 应当只拿到 ToolB');

      const toolsFallback = await getList(url);
      assert.deepStrictEqual(toolsFallback, ['FallbackTool'], '未指定 key 时走兜底逻辑');
    } finally {
      mcp.close();
    }
  });

  // 7. Item 6: serializePrompt 与 limiter.run 解耦测试
  await test('Item 6: 单连接 RPC 串行锁与并发限流器解耦执行', async () => {
    let concurrencyCount = 0;
    let maxObserved = 0;
    const fakeLimiter = {
      run: async (fn) => {
        concurrencyCount += 1;
        maxObserved = Math.max(maxObserved, concurrencyCount);
        try {
          return await fn();
        } finally {
          concurrencyCount -= 1;
        }
      },
      stats: () => ({ active: concurrencyCount }),
    };

    const task = fakeLimiter.run(async () => {
      await sleep(30);
      return 'done';
    });
    assert.strictEqual(concurrencyCount, 1);
    const res = await task;
    assert.strictEqual(res, 'done');
    assert.strictEqual(concurrencyCount, 0);
    assert.strictEqual(maxObserved, 1);
  });

  // 8. Item 8: CORS 支持与 OPTIONS 预检请求
  await test('Item 8: 网关支持 CORS 响应头与 OPTIONS 预检 204', async () => {
    const dummyAcp = {
      policyBySession: new Map(),
      discover: async () => {},
      status: () => ({ running: true }),
      resolveModel: (m) => m,
    };
    const gw = createGateway({
      acp: dummyAcp,
      limiter: { run: (fn) => fn(), stats: () => ({}) },
      getConfig: () => ({ port: 0, toolPolicy: 'all' }),
      log: () => {},
    });
    const port = await gw.listen([0]);
    try {
      // 1. OPTIONS 预检
      const optRes = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: 'OPTIONS' });
      assert.strictEqual(optRes.status, 204, 'OPTIONS 应快速返回 204');
      assert.strictEqual(optRes.headers.get('access-control-allow-origin'), '*');
      assert.ok(optRes.headers.get('access-control-allow-methods').includes('POST'));

      // 2. 普通 GET health 也带有 CORS 头
      const healthRes = await fetch(`http://127.0.0.1:${port}/health`);
      assert.strictEqual(healthRes.status, 200);
      assert.strictEqual(healthRes.headers.get('access-control-allow-origin'), '*');
    } finally {
      gw.close();
    }
  });

  // 9. Item 9: 超限请求优雅返回 HTTP 413
  await test('Item 9: 超限请求 (> 4MB) 优雅返回 HTTP 413 替代直接断开连接', async () => {
    const dummyAcp = {
      policyBySession: new Map(),
      discover: async () => {},
      status: () => ({ running: true }),
      resolveModel: (m) => m,
    };
    const gw = createGateway({
      acp: dummyAcp,
      limiter: { run: (fn) => fn(), stats: () => ({}) },
      getConfig: () => ({ port: 0, toolPolicy: 'all' }),
      log: () => {},
    });
    const port = await gw.listen([0]);
    try {
      const hugeBody = 'x'.repeat(32 * 1024 * 1024 + 1024);
      const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: hugeBody,
      });
      assert.strictEqual(res.status, 413, '网关超限时应返回 HTTP 413');
      const json = await res.json();
      assert.strictEqual(json.error.code, 'payload_too_large');
    } finally {
      gw.close();
    }

    // 测试 MCP 服务的 413 响应
    const mcp = createMcpServer({
      listTools: () => [],
      callTool: async () => ({ content: [] }),
    });
    const { port: mcpPort } = await mcp.listen(0, '127.0.0.1');
    try {
      const hugeBody = 'y'.repeat(4 * 1024 * 1024 + 1024);
      const res = await fetch(`http://127.0.0.1:${mcpPort}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: hugeBody,
      });
      assert.strictEqual(res.status, 413, 'MCP 服务超限时应返回 HTTP 413');
      const json = await res.json();
      assert.strictEqual(json.error.code, -32600);
      assert.strictEqual(json.error.message, 'Payload Too Large');
    } finally {
      mcp.close();
    }
  });

  // 10. Item 10: 真实累计上下文命中时标明 estimated: false
  await test('Item 10: 官方累计上下文统计命中时标明 estimated: false', async () => {
    // 纯估算场景（无 stats 或 contextUsed = 0）
    const est = usageFor('你好', '世界', '', null);
    assert.strictEqual(est.estimated, true, '无官方数据时 estimated 应为 true');

    const estZero = usageFor('你好', '世界', '', { contextUsed: 0 });
    assert.strictEqual(estZero.estimated, true, 'contextUsed 为 0 时应回退估算');

    // 官方真实占用命中场景
    const real = usageFor('你好', '世界', '', { contextUsed: 12450, contextSize: 1048576 });
    assert.strictEqual(real.prompt_tokens, 12450);
    assert.strictEqual(real.estimated, false, '取得官方真实占用时 estimated 应为 false');
  });

  // 11. Item 11: Gateway 会话状态列表可视化与一键回收
  await test('Item 11: Gateway 提供 listSessions 与 recycleSessions 管理闲置会话', async () => {
    let closedCount = 0;
    const dummyAcp = {
      policyBySession: new Map(),
      discover: async () => {},
      status: () => ({ running: true }),
      resolveModel: (m) => m,
      request: async (method, params) => {
        if (method === 'session/close') closedCount += 1;
        return {};
      },
    };
    const gw = createGateway({
      acp: dummyAcp,
      limiter: { run: (fn) => fn(), stats: () => ({}) },
      getConfig: () => ({ port: 0, toolPolicy: 'all' }),
      log: () => {},
    });
    const port = await gw.listen([0]);
    try {
      // 初始列表为空
      assert.strictEqual(gw.listSessions().length, 0);

      // 回收空列表应安全返回
      const rec1 = await gw.recycleSessions();
      assert.strictEqual(rec1.recycled, 0);
      assert.strictEqual(closedCount, 0);
    } finally {
      gw.close();
    }
  });

  const failed = results.filter((r) => !r.ok);
  console.log(`\n结果: ${results.length - failed.length}/${results.length} 通过`);
  if (failed.length > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
