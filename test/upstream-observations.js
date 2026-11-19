'use strict';
// 合成 upstream（内存 ACP）+ 真网关的两种协议回归：凭据头、只读观测端点、归属与隔离。
// 不调用真实上游；只在 fixture 的临时目录写日志/会话足迹。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createGateway } = require(process.env.PI_TEST_ACP_ROOT ? path.join(process.env.PI_TEST_ACP_ROOT, 'lib/server.js') : '../lib/server');
const {
  createObservationStore, isLoopbackAddress, isValidReceipt, nonNegativeSafeInteger, positiveSafeInteger,
} = require('../lib/observations.js');

const RECEIPT = /^[0-9a-f]{32}$/;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn, label = 'expected state') {
  for (let i = 0; i < 400; i += 1) { if (fn()) return; await delay(10); }
  throw new Error('fixture did not reach ' + label);
}
const sseFrames = (raw) => raw.split(/\r?\n\r?\n/)
  .map((frame) => /^data: (.+)$/m.exec(frame)?.[1])
  .filter((value) => value && value !== '[DONE]')
  .map((value) => JSON.parse(value));

/** 一个真网关 + 合成 ACP；script(ctx) 决定每次 session/prompt 做什么。 */
async function harness(script, cfgOverrides = {}) {
  const dir = fs.mkdtempSync(path.join(process.env.PI_SCRATCH_DIR || os.tmpdir(), 'obs-'));
  const cfg = {
    bind: '127.0.0.1', port: 0, source: path.join(dir, 'config.json'), defaultModel: 'm',
    bridgeTools: true, toolPolicy: 'all', promptTimeoutMs: 20000, promptIdleTimeoutMs: 20000,
    highContextThrottleMs: 0, maxSessions: 8, ...cfgOverrides,
  };
  const logs = [];
  const sessions = new Map();
  const prompts = [];
  const acp = {
    policyBySession: new Map(), start: async () => {}, discover: async () => {}, cwdFor: async () => dir,
    resolveModel: (model) => model, status: () => ({ ready: true }), notify() {},
    onNotification: null,
    async request(method, params) {
      if (method === 'session/new') {
        const sessionId = 'obs-' + (sessions.size + 1);
        sessions.set(sessionId, params);
        return { sessionId };
      }
      if (method !== 'session/prompt') return {};
      const sessionId = params.sessionId;
      // ACP 通知只有 SID；不要用 fixture 的 promptNo 或异步上下文标记来源。
      const emit = (update) => acp.onNotification({ method: 'session/update', params: { sessionId, update } });
      prompts.push({ sessionId, params });
      return script({
        emit, params, sessionId, dir, promptNo: prompts.length,
        mcpUrl: sessions.get(sessionId)?.mcpServers?.[0]?.url || '',
      });
    },
  };
  const gw = createGateway({ acp, limiter: { run: (fn) => fn(), stats: () => ({}) }, getConfig: () => cfg, log: (line) => logs.push(line) });
  const port = await gw.listen([0]);
  const cleanup = async () => { await gw.close(); fs.rmSync(dir, { recursive: true, force: true }); };
  return { port, gw, acp, cfg, dir, logs, prompts, sessions, cleanup };
}

function post(port, api, body, init = {}) {
  const route = api === 'responses' ? '/v1/responses' : '/v1/chat/completions';
  return fetch(`http://127.0.0.1:${port}${route}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body), ...init,
  });
}
const contextUrl = (port, receipt) => `http://127.0.0.1:${port}/v1/antigravity/context/${receipt}`;
async function readContext(port, receipt) {
  const res = await fetch(contextUrl(port, receipt));
  return { status: res.status, headers: res.headers, body: await res.json() };
}
const reqBody = (api, messages, extra = {}) => ({
  model: 'm', stream: false, prompt_cache_key: 'obs-lane',
  ...(api === 'responses' ? { input: messages } : { messages }), ...extra,
});
const receiptOf = (res) => res.headers.get('x-antigravity-acp-context-id');
const pending = (sample) => ({ version: 1, state: 'pending', ...(sample ? { observation: sample } : {}) });
const finished = (sample) => sample
  ? { version: 1, state: 'observed', observation: sample }
  : { version: 1, state: 'unavailable' };
const watermark = (emit, used, size) => emit({ sessionUpdate: 'usage_update', used, ...(size === undefined ? {} : { size }) });
const say = (emit, text) => emit({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
const officialUsage = { inputTokens: 20000, cachedReadTokens: 80000, outputTokens: 32000, thoughtTokens: 4000, totalTokens: 132000 };
const rateLimit = () => Object.assign(new Error('upstream 429 rate limit'), { code: 429 });
const retryCfg = { rateLimitMaxRetries: 1, rateLimitRetryBaseMs: 50 };
function gate() {
  let release;
  const promise = new Promise((resolve) => { release = resolve; });
  return { promise, release };
}
function wireUsages(api, raw, stream) {
  if (!stream) return [JSON.parse(raw).usage].filter(Boolean);
  return sseFrames(raw).map((frame) => api === 'responses' ? frame.response?.usage : frame.usage).filter(Boolean);
}
async function assertReport(h, api, res, raw, sample, stream = true) {
  assert.equal(res.status, 200);
  assert.match(receiptOf(res), RECEIPT);
  const ctx = await readContext(h.port, receiptOf(res));
  assert.equal(ctx.status, 200);
  assert.deepEqual(ctx.body, finished(sample));
  const usages = wireUsages(api, raw, stream);
  assert.ok(usages.length, 'wire must carry usage');
  const last = usages.at(-1);
  assert.deepEqual(last.acp_context, sample ? { source: 'acp.usage_update', ...sample } : undefined);
  assert.ok(usages.slice(0, -1).every((usage) => !Object.hasOwn(usage, 'acp_context')), 'no provisional acp_context on interim frames');
  return ctx;
}
function assertUnsplitUsageUnavailable(api, raw, stream, promptCount) {
  const usage = wireUsages(api, raw, stream).at(-1);
  assert.equal(usage.usage_status, 'unavailable');
  for (const field of ['prompt_tokens', 'completion_tokens', 'input_tokens', 'output_tokens', 'total_tokens',
    'input_tokens_details', 'output_tokens_details', 'prompt_tokens_details', 'completion_tokens_details']) {
    assert.equal(usage[field], undefined, field);
  }
  assert.deepEqual(usage.acp_turn_usage, { scope: 'prompt_aggregate', prompt_count: promptCount, ...officialUsage });
}
const readTool = { name: 'Read', parameters: { type: 'object', properties: { file: { type: 'string' } } } };
const bridgeBody = (api, messages) => reqBody(api, messages, {
  stream: true,
  tools: api === 'responses' ? [{ type: 'function', ...readTool }] : [{ type: 'function', function: readTool }],
});
function bridgeResult(api, raw) {
  const frames = sseFrames(raw);
  const calls = api === 'responses'
    ? frames.find((f) => f.type === 'response.completed')?.response.output.filter((item) => item.type === 'function_call')
    : frames.flatMap((f) => f.choices?.[0]?.delta?.tool_calls || []);
  assert.equal(calls?.length, 1, 'HTTP leg parked one real MCP call');
  const callId = api === 'responses' ? calls[0].call_id : calls[0].id;
  assert.ok(callId);
  return api === 'responses'
    ? { type: 'function_call_output', call_id: callId, output: 'fixture tool output' }
    : { role: 'tool', tool_call_id: callId, content: 'fixture tool output' };
}
async function awaitToolResult(mcpUrl) {
  assert.equal(new URL(mcpUrl).hostname, '127.0.0.1');
  const response = await fetch(mcpUrl, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'Read', arguments: { file: 'a.txt' } } }),
  });
  const [{ result }] = sseFrames(await response.text());
  assert.equal(response.status, 200);
  assert.equal(result.isError, false);
  assert.deepEqual(result.content, [{ type: 'text', text: 'fixture tool output' }]);
}

for (const api of ['chat', 'responses']) {
  for (const stream of [false, true]) {
    test(`${api} stream=${stream}: receipt header, observed watermarks and no CORS/no-store`, { timeout: 20000 }, async () => {
      const h = await harness(({ emit }) => {
        say(emit, 'hello');
        watermark(emit, 132000, 256000);
        return { stopReason: 'end_turn', usage: officialUsage };
      });
      try {
        const res = await post(h.port, api, reqBody(api, [{ role: 'user', content: 'SECRET-PROMPT-TEXT' }], { stream }));
        const raw = await res.text();
        const ctx = await assertReport(h, api, res, raw, { used: 132000, size: 256000 }, stream);
        const usage = wireUsages(api, raw, stream).at(-1);
        assert.equal(ctx.headers.get('cache-control'), 'no-store, max-age=0');
        assert.equal(ctx.headers.get('access-control-allow-origin'), null);
        assert.equal(ctx.headers.get('location'), null, 'no redirect is ever relayed');
        assert.doesNotMatch(JSON.stringify(ctx.body), /SECRET-PROMPT|obs-1/);
        assert.equal(usage.usage_status, 'measured');
        assert.equal(usage.prompt_tokens ?? usage.input_tokens, 100000);
        assert.equal(usage.completion_tokens ?? usage.output_tokens, 32000);
        assert.equal(usage.total_tokens, 132000);
        assert.equal((usage.prompt_tokens_details ?? usage.input_tokens_details).cached_tokens, 80000);
        assert.equal((usage.completion_tokens_details ?? usage.output_tokens_details).reasoning_tokens, 4000);
      } finally { await h.cleanup(); }
    });
  }
}

test('receipts are unique per HTTP request and pending until the response ends', { timeout: 20000 }, async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let seen = 0;
  const h = await harness(async ({ emit }) => {
    seen += 1;
    const mine = seen;
    emit({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'x' } });
    if (mine === 1) emit({ sessionUpdate: 'usage_update', used: 42000, size: 256000 });
    await gate;
    if (mine === 1) emit({ sessionUpdate: 'usage_update', used: 43000, size: 256000 });
    return { stopReason: 'end_turn' };
  });
  try {
    // 头部在首帧之前就发出来了：此刻响应尚未结束，必须是 pending。
    const res = await post(h.port, 'chat', reqBody('chat', [{ role: 'user', content: 'one' }], { stream: true }));
    const receipt = res.headers.get('x-antigravity-acp-context-id');
    const pending = await readContext(h.port, receipt);
    // 进行中的凭据是 pending（可带本步已见到的水位），结束时才定状态。
    assert.equal(pending.body.state, 'pending');
    assert.deepEqual(pending.body.observation, { used: 42000, size: 256000 });

    release();
    const raw = await res.text();
    assert.match(raw, /x/);
    const after = await readContext(h.port, receipt);
    assert.deepEqual(after.body, { version: 1, state: 'observed', observation: { used: 43000, size: 256000 } });

    const second = await post(h.port, 'chat', reqBody('chat', [{ role: 'user', content: 'one' }], { stream: false }));
    const receipt2 = second.headers.get('x-antigravity-acp-context-id');
    await second.text();
    assert.notEqual(receipt2, receipt, 'one receipt per HTTP model request');
    assert.deepEqual((await readContext(h.port, receipt2)).body, { version: 1, state: 'unavailable' });
  } finally { release(); await h.cleanup(); }
});

test('no upstream sample means unavailable, never a fabricated zero', { timeout: 20000 }, async () => {
  const h = await harness(async ({ emit }) => {
    emit({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'no watermark' } });
    return { stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 } };
  });
  try {
    for (const api of ['chat', 'responses']) {
      for (const stream of [false, true]) {
        const res = await post(h.port, api, reqBody(api, [{ role: 'user', content: 'q' }], { stream }));
        const receipt = res.headers.get('x-antigravity-acp-context-id');
        const raw = await res.text();
        const ctx = await readContext(h.port, receipt);
        assert.deepEqual(ctx.body, { version: 1, state: 'unavailable' });
        assert.equal(ctx.body.observation, undefined);
        assert.doesNotMatch(raw, /acp_context/, 'no ACP sample must not appear as acp_context');
      }
    }
  } finally { await h.cleanup(); }
});

test('strict safe integers: fractions/unsafe/negative rejected, zero and contraction kept', { timeout: 60000 }, async () => {
  const big = Number.MAX_SAFE_INTEGER;              // 9007199254740991，安全
  const unsafe = Number.MAX_SAFE_INTEGER + 2;       // 9007199254740992，非安全整数
  const scripted = [
    { used: 0, size: 0 },                           // 0 合法；size 0 不是“正”整数 → 不带 size
    { used: 256844 },
    { used: 25328 },                                // 真实回落保留
    { used: -1, size: -3 },
    { used: -0.5 },                                 // 负数小分数：不是整数
    { used: 1234.6, size: 256000 },                 // 小数 used 不允许四舍五入
    { used: Number.NaN },
    { used: Number.POSITIVE_INFINITY },
    { used: '12000' },
    { used: null },
    { used: big },
    { used: unsafe },                               // 超出安全整数范围
    { used: 1234, size: 256000.5 },                 // 小数 size 不合法 → 不带 size
    { used: 1235, size: unsafe },                   // 非安全 size → 不带 size
    { used: 1236, size: '256000' },                 // 字符串 size → 不带 size
    { used: 1237, size: -256000 },
  ];
  let index = 0;
  const h = await harness(async ({ emit }) => {
    const step = scripted[index++];
    emit({ sessionUpdate: 'usage_update', used: step.used, ...(step.size !== undefined ? { size: step.size } : {}) });
    emit({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'y' } });
    return { stopReason: 'end_turn' };
  });
  try {
    const expectations = [
      { version: 1, state: 'observed', observation: { used: 0 } },
      { version: 1, state: 'observed', observation: { used: 256844 } },
      { version: 1, state: 'observed', observation: { used: 25328 } },
      { version: 1, state: 'unavailable' },
      { version: 1, state: 'unavailable' },
      { version: 1, state: 'unavailable' },
      { version: 1, state: 'unavailable' },
      { version: 1, state: 'unavailable' },
      { version: 1, state: 'unavailable' },
      { version: 1, state: 'unavailable' },
      { version: 1, state: 'observed', observation: { used: big } },
      { version: 1, state: 'unavailable' },
      { version: 1, state: 'observed', observation: { used: 1234 } },
      { version: 1, state: 'observed', observation: { used: 1235 } },
      { version: 1, state: 'observed', observation: { used: 1236 } },
      { version: 1, state: 'observed', observation: { used: 1237 } },
    ];
    for (const expected of expectations) {
      const res = await post(h.port, 'chat', reqBody('chat', [{ role: 'user', content: 'z' }]));
      const receipt = res.headers.get('x-antigravity-acp-context-id');
      await res.text();
      assert.deepEqual((await readContext(h.port, receipt)).body, expected);
    }
  } finally { await h.cleanup(); }
});

test('size only from the same update: missing or overwritten size is not borrowed', { timeout: 30000 }, async () => {
  const sequences = [
    [{ used: 100, size: 256000 }, { used: 200 }],
    [{ used: 100, size: 256000 }, { used: 200, size: 0 }],
    [{ used: 100, size: 256000 }, { used: 200, size: 256000.5 }],
    [{ used: 100, size: 256000 }, { used: 200, size: -1 }],
    [{ used: 100 }, { used: 200, size: 1048576 }],
  ];
  let seqIndex = 0;
  const h = await harness(async ({ emit }) => {
    // 同一次 session/prompt 里连发两条 usage_update：后一条才是“最新样本”。
    for (const sample of sequences[seqIndex]) {
      emit({ sessionUpdate: 'usage_update', used: sample.used, ...(sample.size !== undefined ? { size: sample.size } : {}) });
    }
    emit({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 's' } });
    return { stopReason: 'end_turn' };
  });
  try {
    const expected = [
      { version: 1, state: 'observed', observation: { used: 200 } },                       // 后一条没 size：不借用 256000
      { version: 1, state: 'observed', observation: { used: 200 } },                       // size 0 不是正数
      { version: 1, state: 'observed', observation: { used: 200 } },                       // 小数 size 不合法
      { version: 1, state: 'observed', observation: { used: 200 } },                       // 负数 size 不合法
      { version: 1, state: 'observed', observation: { used: 200, size: 1048576 } },
    ];
    for (let i = 0; i < expected.length; i += 1) {
      seqIndex = i;
      const res = await post(h.port, 'chat', reqBody('chat', [{ role: 'user', content: 'size-' + i }]));
      const receipt = res.headers.get('x-antigravity-acp-context-id');
      await res.text();
      assert.deepEqual((await readContext(h.port, receipt)).body, expected[i], 'sequence ' + i);
    }
  } finally { await h.cleanup(); }
});

for (const api of ['chat', 'responses']) {
  for (const fresh of [false, true]) {
    test(`${api}: HTTP arrival/roots wait is not ACP refill (fresh sample: ${fresh})`, { timeout: 20000 }, async () => {
      let emitFirst;
      let toolFed = false;
      let checkingRoots = false;
      const roots = gate();
      const endRefill = gate();
      const h = await harness(async ({ emit, mcpUrl }) => {
        emitFirst = emit;
        watermark(emit, 111, 8192);
        await awaitToolResult(mcpUrl);
        toolFed = true;
        if (fresh) watermark(emit, 42); // real decrease, no window on this update
        await endRefill.promise;
        if (fresh) watermark(emit, 0);  // zero is not absent and never borrows 8192
        say(emit, 'after refill');
        return { stopReason: 'end_turn', usage: officialUsage };
      });
      const first = { used: 111, size: 8192 };
      const history = [{ role: 'user', content: 'read a.txt' }];
      try {
        const leg1 = await post(h.port, api, bridgeBody(api, history));
        const raw1 = await leg1.text();
        const tool = bridgeResult(api, raw1);
        await assertReport(h, api, leg1, raw1, first);
        watermark(emitFirst, 999, 8192); // late while parked, no new HTTP leg yet
        const cwdFor = h.acp.cwdFor;
        h.acp.cwdFor = async () => {
          checkingRoots = true;
          await roots.promise;
          return cwdFor();
        };
        const leg2 = await post(h.port, api, bridgeBody(api, [...history, tool]));
        assert.notEqual(receiptOf(leg1), receiptOf(leg2));
        await until(() => checkingRoots, 'getAllowedRoots waiting');
        assert.equal(toolFed, false);
        watermark(emitFirst, 777, 8192);
        assert.deepEqual((await readContext(h.port, receiptOf(leg2))).body, pending(), '777 cannot reach the arriving leg before actual refill');

        roots.release();
        await until(() => toolFed, 'ACP consumed the MCP result');
        assert.deepEqual((await readContext(h.port, receiptOf(leg2))).body, pending(fresh ? { used: 42 } : undefined));
        endRefill.release();
        const raw2 = await leg2.text();
        assert.match(raw2, /after refill/);
        await assertReport(h, api, leg2, raw2, fresh ? { used: 0 } : undefined);
        assertUnsplitUsageUnavailable(api, raw2, true, 1);
        assert.deepEqual((await readContext(h.port, receiptOf(leg1))).body, finished(first));
        assert.equal(h.prompts.length, 1, 'a normal refill continues the original ACP prompt');
        assert.equal(h.sessions.size, 1);
      } finally { roots.release(); endRefill.release(); await h.cleanup(); }
    });
  }

  for (const salvage of [false, true]) {
    test(`${api}: failed refill clears its own sample; ${salvage ? 'new SID salvage owns its sample' : 'same-SID retry publishes nothing'}`, { timeout: 20000 }, async () => {
      let emitFirst;
      let refillReported = false;
      const failRefill = gate();
      const endRetry = gate();
      const filterError = () => new Error('content filter blocked fixture response');
      const h = await harness(async ({ emit, mcpUrl, promptNo }) => {
        if (promptNo === 1) {
          emitFirst = emit;
          watermark(emit, 111, 8192);
          await awaitToolResult(mcpUrl);
          watermark(emit, 222, 8192);
          refillReported = true;
          await failRefill.promise;
          throw salvage ? filterError() : rateLimit();
        }
        if (salvage && promptNo === 2) throw filterError(); // existing recovery will switch to a fresh SID
        if (salvage) watermark(emitFirst, 888, 8192); // late on the old SID, distinguishable
        watermark(emit, 333, 8192); // no per-prompt tag, even when genuinely from the new attempt
        await endRetry.promise;
        say(emit, 'retry answer');
        return { stopReason: 'end_turn', usage: officialUsage };
      }, { ...retryCfg, contentFilterMaxRetries: 2 });
      const history = [{ role: 'user', content: 'read a.txt' }];
      const first = { used: 111, size: 8192 };
      const sample = salvage ? { used: 333, size: 8192 } : undefined;
      const count = salvage ? 3 : 2;
      try {
        const leg1 = await post(h.port, api, bridgeBody(api, history));
        const raw1 = await leg1.text();
        const tool = bridgeResult(api, raw1);
        await assertReport(h, api, leg1, raw1, first);
        const leg2 = await post(h.port, api, bridgeBody(api, [...history, tool]));
        assert.notEqual(receiptOf(leg1), receiptOf(leg2));
        await until(() => refillReported, 'unsettled refill emitted 222');
        assert.deepEqual((await readContext(h.port, receiptOf(leg2))).body, pending({ used: 222, size: 8192 }));
        failRefill.release();
        await until(() => h.prompts.length === count, 'existing retry dispatch');
        assert.deepEqual((await readContext(h.port, receiptOf(leg2))).body, pending(sample), 'failed sample is gone; untagged same-SID updates stay unavailable');
        endRetry.release();
        const raw2 = await leg2.text();
        assert.match(raw2, /retry answer/);
        await assertReport(h, api, leg2, raw2, sample);
        assertUnsplitUsageUnavailable(api, raw2, true, count);
        assert.deepEqual((await readContext(h.port, receiptOf(leg1))).body, finished(first));
        const sid = h.prompts[0].sessionId;
        assert.equal(h.prompts.length, count);
        assert.equal(h.prompts[1].sessionId, sid);
        assert.equal(h.sessions.size, salvage ? 2 : 1, 'no session creation for observation');
        if (salvage) assert.notEqual(h.prompts[2].sessionId, sid);
        else assert.ok(h.logs.some((line) => line.includes('网关层冷却等待')), 'existing 429 backoff still runs');
      } finally { failRefill.release(); endRetry.release(); await h.cleanup(); }
    });
  }
}

for (const api of ['chat', 'responses']) {
  test(`${api}: cancelled and watchdog-stalled legs never publish late watermarks`, { timeout: 30000 }, async () => {
    // 上流在「网关已发出 session/cancel」之后才吐的水位与正文，都不属于这个 HTTP 步。
    let cancelWaiters = [];
    let late = 0;
    let calls = 0;
    const h = await harness(async ({ emit }) => {
      calls += 1;
      const mine = calls;
      emit({ sessionUpdate: 'usage_update', used: 45000, size: 256000 });
      await new Promise((resolve) => { cancelWaiters.push(resolve); });
      cancelWaiters = [];
      emit({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'AFTER_CANCEL' } });
      emit({ sessionUpdate: 'usage_update', used: 199999, size: 256000 });
      late += 1;
      return { stopReason: mine === 1 ? 'cancelled' : 'end_turn' };
    }, { promptIdleTimeoutMs: 1200 });
    h.acp.notify = (method) => {
      if (method !== 'session/cancel') return;
      for (const wake of cancelWaiters.splice(0)) wake();
    };
    try {
      // (1) 客户端中断
      const controller = new AbortController();
      const res = await post(h.port, api, reqBody(api, [{ role: 'user', content: 'a' }], { stream: true }), { signal: controller.signal });
      const receipt = res.headers.get('x-antigravity-acp-context-id');
      await until(() => calls === 1, 'first prompt in flight');
      controller.abort();
      try { await res.text(); } catch { /* aborted */ }
      await until(() => late === 1, 'late post-cancel update');
      await delay(80);
      const afterAbort = await readContext(h.port, receipt);
      assert.equal(afterAbort.body.state, 'observed');
      assert.equal(afterAbort.body.observation.used, 45000, 'the post-cancel watermark must not be adopted');

      // (2) 看门狗取消
      const res2 = await post(h.port, api, reqBody(api, [{ role: 'user', content: 'b' }], { stream: true }));
      const receipt2 = res2.headers.get('x-antigravity-acp-context-id');
      await until(() => calls === 2, 'second prompt in flight');
      const wire = await res2.text();
      assert.match(wire, /ACP_IDLE_TIMEOUT/);
      assert.doesNotMatch(wire, /AFTER_CANCEL/);
      await until(() => late === 2, 'late post-stall update');
      await delay(80);
      const afterStall = await readContext(h.port, receipt2);
      assert.equal(afterStall.body.state, 'observed');
      assert.equal(afterStall.body.observation.used, 45000);
      assert.ok(!JSON.stringify(afterStall.body).includes('199999'));
    } finally {
      for (const wake of cancelWaiters.splice(0)) wake();
      await h.cleanup();
    }
  });
}

test('concurrent sessions keep separate receipts and watermarks', { timeout: 20000 }, async () => {
  const h = await harness(async ({ emit, params }) => {
    const marker = JSON.stringify(params.prompt);
    const used = marker.includes('lane-A') ? 11111 : 22222;
    emit({ sessionUpdate: 'usage_update', used, size: 256000 });
    await delay(30);
    emit({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ok' } });
    return { stopReason: 'end_turn' };
  });
  try {
    const mk = (lane) => post(h.port, 'chat', {
      model: 'm', stream: true, prompt_cache_key: 'lane-' + lane,
      messages: [{ role: 'user', content: 'lane-' + lane }],
    });
    const [a, b] = await Promise.all([mk('A'), mk('B')]);
    const ra = a.headers.get('x-antigravity-acp-context-id');
    const rb = b.headers.get('x-antigravity-acp-context-id');
    assert.notEqual(ra, rb);
    await Promise.all([a.text(), b.text()]);
    assert.equal((await readContext(h.port, ra)).body.observation.used, 11111);
    assert.equal((await readContext(h.port, rb)).body.observation.used, 22222);
  } finally { await h.cleanup(); }
});

test('endpoint refuses unknown/malformed receipts, non-GET and never enumerates', { timeout: 20000 }, async () => {
  const h = await harness(async ({ emit }) => {
    emit({ sessionUpdate: 'usage_update', used: 1000 });
    return { stopReason: 'end_turn' };
  });
  try {
    const res = await post(h.port, 'chat', reqBody('chat', [{ role: 'user', content: 'k' }]));
    const receipt = res.headers.get('x-antigravity-acp-context-id');
    await res.text();
    assert.ok(isValidReceipt(receipt));

    // 网关对任何路由都没有 Authorization 校验（没有 PI 密钥这回事），所以这里不存在
    // 需要开洞的鉴权：带不带 Authorization 都必须命中同一份数值，且不多返回任何东西。
    const withAuth = await fetch(contextUrl(h.port, receipt), { headers: { authorization: 'Bearer irrelevant' } });
    assert.equal(withAuth.status, 200);
    assert.deepEqual(await withAuth.json(), {
      version: 1, state: 'observed', observation: { used: 1000 },
    });
    const noAuth = await readContext(h.port, receipt);
    assert.deepEqual(noAuth.body, { version: 1, state: 'observed', observation: { used: 1000 } });

    const unknown = await readContext(h.port, 'f'.repeat(32));
    assert.equal(unknown.status, 404);
    assert.equal(unknown.headers.get('location'), null);
    assert.equal(unknown.headers.get('access-control-allow-origin'), null);
    assert.equal(unknown.body.error.code, 'not_found');

    for (const bad of ['ABCDEF0123456789ABCDEF0123456789', 'abc', 'f'.repeat(33), 'g'.repeat(32), '%E0%A4%A']) {
      const badRes = await fetch(`http://127.0.0.1:${h.port}/v1/antigravity/context/${bad}`);
      assert.equal(badRes.status, 404, 'malformed receipt ' + bad);
      await badRes.text();
    }
    const postRes = await fetch(contextUrl(h.port, receipt), { method: 'POST' });
    assert.equal(postRes.status, 405);
    assert.equal(postRes.headers.get('allow'), 'GET');
    await postRes.text();
    const optionsRes = await fetch(contextUrl(h.port, receipt), { method: 'OPTIONS' });
    assert.equal(optionsRes.status, 405, 'no CORS preflight path for the receipt endpoint');
    assert.equal(optionsRes.headers.get('access-control-allow-origin'), null);
    assert.equal(optionsRes.headers.get('access-control-allow-methods'), null);
    await optionsRes.text();
    const listRes = await fetch(`http://127.0.0.1:${h.port}/v1/antigravity/context`);
    assert.ok(listRes.status >= 400, 'no listing endpoint');
    await listRes.text();
  } finally { await h.cleanup(); }
});

test('store: strict integers, attempt epochs, TTL, size cap, loopback gate, no text', () => {
  let clock = 1_000_000;
  const store = createObservationStore({ ttlMs: 5000, maxEntries: 3, now: () => clock });
  const first = store.issue();
  assert.ok(isValidReceipt(first.receipt));
  assert.equal(store.read(first.receipt).state, 'pending');
  assert.equal(store.beginAttempt(first.observation), true);
  assert.equal(store.note(first.observation, 7000, 256000), true);
  assert.equal(store.note(first.observation, -5), false, 'negative watermark rejected');
  assert.deepEqual(store.read(first.receipt).observation, { used: 7000, size: 256000 });
  // 小数/非安全整数不是样本：这一条被忽略，也不会把上一条的 size 借过来。
  for (const bad of [1234.6, -0.5, Number.MAX_SAFE_INTEGER + 2, Number.NaN, Infinity, '7000', null, undefined]) {
    assert.equal(store.note(first.observation, bad), false, 'invalid used ' + String(bad));
  }
  assert.deepEqual(store.read(first.receipt).observation, { used: 7000, size: 256000 });
  // 新的派发清掉旧样本；本次没报就是没报。
  assert.equal(store.beginAttempt(first.observation), true);
  assert.deepEqual(store.read(first.receipt), { version: 1, state: 'pending' });
  assert.equal(store.note(first.observation, 9000), true);
  assert.equal(store.note(first.observation, 9100, 256000.5), true, 'used 合法、size 非法 → 只记 used');
  assert.deepEqual(store.read(first.receipt).observation, { used: 9100 });
  store.finish(first.observation);
  assert.deepEqual(store.read(first.receipt), { version: 1, state: 'observed', observation: { used: 9100 } });
  assert.deepEqual(store.inspect(first.receipt), {
    state: 'observed', used: 9100, size: null, attempt: 2,
    createdAt: clock, expiresAt: clock + 5000, finalized: true, seq: 1,
  }, 'only numbers/state are kept: no prompt, session text, model or credentials');
  assert.equal(store.note(first.observation, 900000), false, 'finish freezes the record');
  assert.equal(store.beginAttempt(first.observation), false, 'a finished receipt is never resurrected');

  clock += 5001;
  assert.equal(store.read(first.receipt), null, 'expired receipts are indistinguishable from unknown ones');
  assert.equal(store.size(), 0);

  const a = store.issue(); const b = store.issue(); const c = store.issue(); const d = store.issue();
  assert.equal(store.size(), 3, 'hard cap on entries');
  assert.equal(store.read(a.receipt), null, 'oldest evicted');
  for (const entry of [b, c, d]) assert.ok(store.read(entry.receipt));
  store.clear();
  assert.equal(store.size(), 0);

  for (const address of ['127.0.0.1', '127.5.6.7', '::1', '::ffff:127.0.0.1']) assert.equal(isLoopbackAddress(address), true, address);
  for (const address of ['10.0.0.5', '192.168.1.1', '128.0.0.1', '0.0.0.0', '::2', '::ffff:10.0.0.1', '', null, undefined]) {
    assert.equal(isLoopbackAddress(address), false, String(address));
  }
  assert.equal(nonNegativeSafeInteger(0), 0);
  assert.equal(nonNegativeSafeInteger(-0), 0);
  assert.equal(nonNegativeSafeInteger(-1), null);
  assert.equal(nonNegativeSafeInteger(-0.5), null);
  assert.equal(nonNegativeSafeInteger(1.5), null);
  assert.equal(nonNegativeSafeInteger(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER);
  assert.equal(nonNegativeSafeInteger(Number.MAX_SAFE_INTEGER + 2), null);
  assert.equal(positiveSafeInteger(0), null);
  assert.equal(positiveSafeInteger(1), 1);
  assert.equal(positiveSafeInteger(1.5), null);
  assert.equal(positiveSafeInteger(Number.MAX_SAFE_INTEGER + 2), null);
});

test('rejected model requests still carry a receipt and stay unavailable', { timeout: 20000 }, async () => {
  const h = await harness(async ({ emit }) => {
    emit({ sessionUpdate: 'usage_update', used: 5000 });
    return { stopReason: 'end_turn' };
  });
  try {
    for (const api of ['chat', 'responses']) {
      const route = api === 'responses' ? '/v1/responses' : '/v1/chat/completions';
      const bad = await fetch(`http://127.0.0.1:${h.port}${route}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{not json',
      });
      const receipt = bad.headers.get('x-antigravity-acp-context-id');
      assert.match(receipt, RECEIPT, api + ' invalid-JSON request still gets a receipt');
      assert.equal(bad.status, 400);
      await bad.text();
      assert.deepEqual((await readContext(h.port, receipt)).body, { version: 1, state: 'unavailable' });

      const empty = await post(h.port, api, reqBody(api, []));
      const receipt2 = empty.headers.get('x-antigravity-acp-context-id');
      assert.match(receipt2, RECEIPT);
      assert.equal(empty.status, 400);
      await empty.text();
      assert.deepEqual((await readContext(h.port, receipt2)).body, { version: 1, state: 'unavailable' });
    }
  } finally { await h.cleanup(); }
});

for (const api of ['chat', 'responses']) {
  for (const stream of [false, true]) {
    test(`${api} stream=${stream}: late old callback cannot claim same-SID 429 retry`, { timeout: 20000 }, async () => {
      let emitOld;
      const h = await harness(({ emit, promptNo }) => {
        if (promptNo === 1) {
          emitOld = emit;
          watermark(emit, 5000, 8192);
          throw rateLimit();
        }
        // The retry itself emits no usage_update. No production field can tell
        // this old callback apart from another notification for this SID.
        watermark(emitOld, 888, 8192);
        say(emit, 'retry answer');
        return { stopReason: 'end_turn', usage: officialUsage };
      }, retryCfg);
      const history = [{ role: 'user', content: 'first' }, { role: 'assistant', content: 'ok' }, { role: 'user', content: 'next' }];
      try {
        const res = await post(h.port, api, reqBody(api, history, { stream }));
        const raw = await res.text();
        assert.match(raw, /retry answer/);
        await assertReport(h, api, res, raw, undefined, stream);
        assertUnsplitUsageUnavailable(api, raw, stream, 2);
        assert.equal(h.prompts.length, 2);
        assert.ok(h.logs.some((line) => line.includes('网关层冷却等待')));

        const later = await post(h.port, api, reqBody(api, [
          ...history, { role: 'assistant', content: 'retry answer' }, { role: 'user', content: 'continue' },
        ], { stream }));
        await assertReport(h, api, later, await later.text(), undefined, stream);
        assert.notEqual(receiptOf(later), receiptOf(res));
        assert.equal(h.prompts.length, 3);
        assert.equal(h.sessions.size, 1);
        assert.ok(h.prompts.every(({ sessionId }) => sessionId === h.prompts[0].sessionId), 'reused SID remains ambiguous across HTTP responses');
      } finally { await h.cleanup(); }
    });
  }
}

test('helper/auto-summary sub-session numbers never reach the main step', { timeout: 30000 }, async () => {
  // 辅助请求（标题生成 / 下一步预测）与上下文摘要在本网关里是**独立的 HTTP 请求**，
  // 走 acquireAuxiliarySession / isSideChannelRequest（server.js:3225-3230），各自一张凭据。
  // 主请求的凭据只认本步在该会话上登记的活腿，因此同名的 helper 子会话更新一律落空。
  let calls = 0;
  const h = await harness(async ({ emit, sessionId, params }) => {
    calls += 1;
    const text = JSON.stringify(params.prompt);
    if (text.includes('Generate a concise title')) {
      emit({ sessionUpdate: 'usage_update', used: 4444, size: 256000 });
      emit({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Title' } });
      return { stopReason: 'end_turn' };
    }
    if (calls === 1) {
      // 主步在途时冒出一条别的会话（helper 子会话）的水位：不属于本步。
      h.acp.onNotification({ method: 'session/update', params: { sessionId: 'helper-sub-session', update: { sessionUpdate: 'usage_update', used: 999999, size: 1048576 } } });
      emit({ sessionUpdate: 'usage_update', used: 33333, size: 256000 });
      emit({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'main answer' } });
      return { stopReason: 'end_turn' };
    }
    // 第二次主步只留下 helper 的水位，自己不报 → 必须 unavailable。
    h.acp.onNotification({ method: 'session/update', params: { sessionId: 'helper-sub-session', update: { sessionUpdate: 'usage_update', used: 999999, size: 1048576 } } });
    emit({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'main answer 2' } });
    return { stopReason: 'end_turn' };
  });
  try {
    // 主对话：多个非 system 消息 + prompt_cache_key → 不走 isAuxiliaryUiRequest 的
    // 单条 user 快捷判定（server.js:3119-3127、3147），因此这是真正的主模型步。
    const mainHistory = [
      { role: 'user', content: 'summarize my day' },
      { role: 'assistant', content: 'sure' },
      { role: 'user', content: 'and tomorrow' },
    ];
    const main = await post(h.port, 'chat', reqBody('chat', mainHistory));
    const mainReceipt = main.headers.get('x-antigravity-acp-context-id');
    await main.text();
    assert.deepEqual((await readContext(h.port, mainReceipt)).body,
      { version: 1, state: 'observed', observation: { used: 33333, size: 256000 } },
      'a foreign helper session must not be adopted as the main context');

    const second = await post(h.port, 'chat', reqBody('chat', [
      ...mainHistory,
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: 'second main turn' },
    ]));
    const secondReceipt = second.headers.get('x-antigravity-acp-context-id');
    await second.text();
    assert.deepEqual((await readContext(h.port, secondReceipt)).body, { version: 1, state: 'unavailable' });

    // 真正的辅助 HTTP 请求有自己的凭据：只反映它自己的辅助会话，绝不改动主凭据。
    const aux = await post(h.port, 'chat', {
      model: 'm', stream: false,
      messages: [
        { role: 'system', content: 'Generate a concise title for the conversation' },
        { role: 'user', content: 'hello there' },
      ],
    });
    const auxReceipt = aux.headers.get('x-antigravity-acp-context-id');
    await aux.text();
    assert.notEqual(auxReceipt, mainReceipt);
    assert.deepEqual((await readContext(h.port, auxReceipt)).body,
      { version: 1, state: 'observed', observation: { used: 4444, size: 256000 } },
      'the helper request reports its own ACP session under its own receipt');
    assert.deepEqual((await readContext(h.port, mainReceipt)).body,
      { version: 1, state: 'observed', observation: { used: 33333, size: 256000 } },
      'the main receipt is unchanged by the helper request');
  } finally { await h.cleanup(); }
});
