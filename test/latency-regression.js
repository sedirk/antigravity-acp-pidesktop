'use strict';
// Synthetic fixtures only. Real local HTTP/SSE, but no official runtime, credentials or host changes.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { normalize, validatePatch } = require('../lib/config.js');
const { createTurnDiagnostics } = require('../lib/diagnostics.js');
const { createGateway } = require('../lib/server.js');
const tests = [];
const test = (name, run) => tests.push({ name, run });
const decode = logs => logs.filter(s => s.startsWith('[acp-diag] ')).map(s => JSON.parse(s.slice(11)));
const ctx = { packageRoot: path.resolve(__dirname, '..'), dataPath: os.tmpdir() };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

test('default throttle is off; explicit saved values and zero survive normalization', () => {
  assert.equal(normalize({}, ctx).highContextThrottleMs, 0);
  assert.equal(normalize({ highContextThrottleMs: 2500 }, ctx).highContextThrottleMs, 2500);
  assert.equal(normalize({ highContextThrottleMs: 0 }, ctx).highContextThrottleMs, 0);
  assert.equal(validatePatch({ highContextThrottleMs: 0 }, ctx).patch.highContextThrottleMs, 0);
  assert.equal(normalize({}, ctx).rateLimitMaxRetries, 3, 'do not disable real 429 backoff');
});

test('timing separates host round trip, local resume, throttle and first model activity', () => {
  let time = 100; const logs = [];
  const d = createTurnDiagnostics(s => logs.push(s), { sessionId: 'PRIVATE_SESSION', key: 'PRIVATE_TOPIC', clock: () => time });
  d.dispatch(); time = 150; d.progress('usage_update'); d.progress('gateway_keepalive');
  time = 300; d.progress('agent_thought_chunk'); d.progress('agent_message_chunk');
  time = 400; d.park(300000, 1); time = 1400; const start = d.startResume();
  time = 1480; d.resume(start, 20, 1, 300100); time = 1630; d.progress('tool_call');
  time = 1640; d.end('complete'); d.end('complete');
  const events = decode(logs), progress = events.filter(e => e.event === 'first_progress');
  assert.deepEqual(progress.map(e => e.waitMs), [200, 150]);
  const resumed = events.find(e => e.event === 'resume');
  assert.equal(resumed.hostRoundTripMs, 1000); assert.equal(resumed.localResumeMs, 80);
  assert.equal(resumed.throttleMs, 20); assert.equal(resumed.step, 1);
  assert.equal(events.filter(e => e.event === 'end').length, 1);
  assert.ok(!logs.join('').includes('PRIVATE_'));
});

test('raw, normalized, dropped and ignored zero context values remain distinguishable', () => {
  const logs = [], d = createTurnDiagnostics(s => logs.push(s));
  const emit = (rawUsed, beforeUsed, reportedUsed, accepted = true) => d.context({ rawUsed, rawSize: 1048576, beforeUsed, pendingBefore: 5, reportedUsed, pendingAfter: 0, accepted });
  emit(300000, 0, 300000); emit(600000, 300000, 300000); emit(25000, 300000, 25000); emit(0, 25000, 25000, false);
  d.final({ rawInputTokens: 2400000, rawCachedReadTokens: 1000000, beforeUsed: 25000, pendingBefore: 0, reportedUsed: 25000, alignedFromStep: true });
  const events = decode(logs);
  assert.equal(events[1].rawUsed, 600000); assert.equal(events[1].reportedUsed, 300000); assert.equal(events[1].normalized, true);
  assert.equal(events[2].rawDrop, true); assert.equal(events[2].reportedDrop, true);
  assert.equal(events[3].accepted, false); assert.equal(events[3].previousRawUsed, 25000);
  assert.equal(events[4].rawInputTokens, 2400000); assert.equal(events[4].reportedUsed, 25000);
});

test('diagnostic payloads are bounded, numeric-only and cannot break requests', () => {
  const logs = [], d = createTurnDiagnostics(s => logs.push(s));
  const sample = { rawUsed: 400000, rawSize: 1048576, beforeUsed: 400000, pendingBefore: 0, reportedUsed: 400000, pendingAfter: 0, accepted: true };
  for (let i = 0; i < 1000; i++) d.context(sample);
  assert.ok(logs.length <= 2, 'duplicate observations must not flood logs');
  d.context({ rawUsed: 'SECRET_PAYLOAD', rawSize: Infinity, beforeUsed: -1, pendingBefore: {}, reportedUsed: NaN, pendingAfter: [], accepted: false });
  d.end('SECRET_PAYLOAD');
  assert.ok(!logs.join('').includes('SECRET_PAYLOAD'));
  assert.ok(logs.every(s => s.length < 1200));
  const broken = createTurnDiagnostics(() => { throw new Error('disk unavailable'); });
  assert.doesNotThrow(() => { broken.dispatch(); broken.progress('tool_call'); broken.context(sample); broken.end('complete'); });
});

test('concurrent lane and turn diagnostics cannot inherit another turn watermark', () => {
  const logs = [], a = createTurnDiagnostics(s => logs.push(s), { sessionId: 'sid-a', key: 'topic-a' });
  const b = createTurnDiagnostics(s => logs.push(s), { sessionId: 'sid-b', key: 'topic-b' });
  a.dispatch(); b.dispatch();
  a.context({ rawUsed: 800000, rawSize: 1048576, beforeUsed: 0, reportedUsed: 800000, accepted: true });
  b.context({ rawUsed: 10000, rawSize: 1048576, beforeUsed: 0, reportedUsed: 10000, accepted: true });
  const events = decode(logs), ca = events.find(e => e.rawUsed === 800000), cb = events.find(e => e.rawUsed === 10000);
  assert.notEqual(ca.trace, cb.trace); assert.notEqual(ca.lane, cb.lane); assert.notEqual(ca.session, cb.session);
  assert.equal(cb.previousRawUsed, null); assert.equal(cb.rawDrop, false);
});

test('cancellation without progress is explicit and cannot invent model activity', () => {
  let time = 0; const logs = [], d = createTurnDiagnostics(s => logs.push(s), { clock: () => time });
  d.dispatch(); time = 150; d.progress('gateway_keepalive'); d.end('cancelled');
  const events = decode(logs);
  assert.equal(events.length, 2); assert.equal(events[1].waitingForProgress, true);
  assert.equal(events[1].waitMs, 150); assert.equal(events[1].status, 'cancelled');
});

async function bridgeFixture({ values = [160001, 256844, 300000, 403536, 800000, 900000, 25328], override = {}, api = 'responses', cancel = false, finalUsage } = {}) {
  const dir = fs.mkdtempSync(path.join(process.env.PI_SCRATCH_DIR || os.tmpdir(), 'latency-234-'));
  const logs = [], bodies = []; let bridgeUrl = '', serial = 0, cancelled = false, abort = null;
  const cfg = { ...normalize(override, { packageRoot: ctx.packageRoot, dataPath: dir }), bind: '127.0.0.1', port: 0, defaultModel: 'test', source: path.join(dir, 'config.json'), promptTimeoutMs: 15000, promptIdleTimeoutMs: 10000, toolPolicy: 'all', bridgeTools: true };
  const acp = {
    policyBySession: new Map(), start: async () => {}, discover: async () => {}, cwdFor: async () => dir,
    resolveModel: x => x, status: () => ({ ready: true }), notify: method => { if (method === 'session/cancel') cancelled = true; },
    request: async (method, p) => {
      if (method === 'session/new') { bridgeUrl = p.mcpServers[0].url; return { sessionId: 'latency-' + ++serial }; }
      if (method !== 'session/prompt') return {};
      const emit = update => acp.onNotification({ method: 'session/update', params: { sessionId: p.sessionId, update } });
      emit({ sessionUpdate: 'usage_update', used: values[0], size: 1048576 });
      for (let i = 0; i < values.length - 1; i++) {
        emit({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'PRIVATE_THOUGHT' } });
        await fetch(bridgeUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: i + 1, method: 'tools/call', params: { name: 'Read', arguments: { path: 'PRIVATE_ARGUMENT' } } }) }).then(r => r.text());
        if (cancelled) return { stopReason: 'cancelled' };
        await delay(8);
        emit({ sessionUpdate: 'usage_update', used: values[i + 1], size: 1048576 });
      }
      emit({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'PRIVATE_REPLY' } });
      return { stopReason: 'end_turn', usage: finalUsage === undefined ? { inputTokens: values.at(-1), cachedReadTokens: 0, outputTokens: 10000, totalTokens: values.at(-1) + 10000 } : finalUsage };
    },
  };
  const gateway = createGateway({ acp, limiter: { run: f => f(), stats: () => ({}) }, getConfig: () => cfg, log: s => {
    logs.push(s);
    if (cancel && s.includes('桥接微节流') && abort) setTimeout(() => abort.abort(), 10);
  } });
  const tool = { name: 'Read', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } };
  let history = [{ role: 'user', content: 'PRIVATE_PROMPT' }];
  try {
    const port = await gateway.listen([0]);
    for (let i = 0; i < values.length; i++) {
      abort = new AbortController();
      const req = api === 'responses'
        ? { model: 'test', stream: true, prompt_cache_key: 'PRIVATE_TOPIC', input: history, tools: [{ type: 'function', ...tool }] }
        : { model: 'test', stream: true, prompt_cache_key: 'PRIVATE_TOPIC', messages: history, tools: [{ type: 'function', function: tool }] };
      let raw;
      try {
        const r = await fetch(`http://127.0.0.1:${port}/v1/${api === 'responses' ? 'responses' : 'chat/completions'}`, { method: 'POST', headers: { 'content-type': 'application/json' }, signal: abort.signal, body: JSON.stringify(req) });
        raw = await r.text(); assert.equal(r.status, 200, raw);
      } catch (error) {
        if (!cancel || !abort.signal.aborted) throw error;
        await delay(100);
        return { events: decode(logs), logs, bodies, cancelled, serial };
      }
      const events = raw.split('\n\n').map(s => /^data: (.+)$/m.exec(s)?.[1]).filter(s => s && s !== '[DONE]').map(JSON.parse);
      if (api === 'responses') {
        const body = events.find(e => e.type === 'response.completed')?.response;
        assert.ok(body, raw); bodies.push(body);
        const call = body.output.find(x => x.type === 'function_call');
        if (!call) break;
        history = [...history, call, { type: 'function_call_output', call_id: call.call_id, output: 'PRIVATE_RESULT' }];
      } else {
        const calls = events.flatMap(e => e.choices?.[0]?.delta?.tool_calls || []);
        const usage = events.findLast(e => e.usage)?.usage;
        assert.ok(usage, raw); bodies.push({ usage });
        if (!calls.length) break;
        const call = calls.find(c => c.id && c.function?.name);
        assert.ok(call, raw);
        history = [...history, { role: 'assistant', content: '', tool_calls: [call] }, { role: 'tool', tool_call_id: call.id, content: 'PRIVATE_RESULT' }];
      }
    }
    await delay(10);
    return { events: decode(logs), logs, bodies, cancelled, serial };
  } finally { await gateway.close(); fs.rmSync(dir, { recursive: true, force: true }); }
}

test('Responses crosses 256K through 900K without default delay and preserves a raw drop', async () => {
  const { events, logs, bodies, serial } = await bridgeFixture();
  const resumed = events.filter(e => e.event === 'resume');
  assert.equal(resumed.length, 6); assert.ok(resumed.every(e => e.throttleMs === 0));
  assert.ok(!logs.some(s => s.includes('桥接微节流')));
  for (const value of [256844, 300000, 403536, 800000, 900000, 25328]) {
    const event = events.find(e => e.event === 'context' && e.rawUsed === value);
    assert.ok(event, 'missing raw context ' + value); assert.equal(event.reportedUsed, value);
  }
  const drop = events.find(e => e.event === 'context' && e.rawUsed === 25328);
  assert.equal(drop.rawDrop, true); assert.equal(drop.reportedDrop, true);
  assert.equal(bodies.at(-1).usage.input_tokens, 25328); assert.equal(serial, 1, 'do not rebuild on a watermark drop');
  assert.equal(new Set(events.map(e => e.trace)).size, 1, 'continuations stay in one diagnostic turn');
  assert.equal(events.filter(e => e.event === 'first_progress').length, 7);
  assert.equal(events.find(e => e.event === 'context_final').rawInputTokens, 25328);
  assert.ok(!JSON.stringify(events).includes('PRIVATE_'), 'new diagnostics must not leak payloads');
});

test('final diagnostic input fields distinguish missing values from explicit zero', async () => {
  const missing = await bridgeFixture({ values: [300000], finalUsage: { outputTokens: 10 } });
  const zero = await bridgeFixture({ values: [300000], finalUsage: { input_tokens: 0, cached_read_tokens: 0, output_tokens: 10 } });
  const a = missing.events.find(e => e.event === 'context_final'), b = zero.events.find(e => e.event === 'context_final');
  assert.equal(a.rawInputTokens, null); assert.equal(a.rawCachedReadTokens, null);
  assert.equal(b.rawInputTokens, 0); assert.equal(b.rawCachedReadTokens, 0);
  assert.equal(a.reportedUsed, 300000); assert.equal(b.reportedUsed, 300000);
});

test('Chat bridge shares the same zero-delay diagnostics beyond 256K', async () => {
  const { events, bodies } = await bridgeFixture({ api: 'chat', values: [200000, 260000, 300000, 350000, 400000] });
  assert.equal(events.filter(e => e.event === 'resume').length, 4);
  assert.ok(events.filter(e => e.event === 'resume').every(e => e.throttleMs === 0));
  assert.equal(bodies.at(-1).usage.prompt_tokens, 400000);
});

test('explicit throttle still applies only from the fourth high-context continuation', async () => {
  const { events } = await bridgeFixture({ override: { highContextThrottleMs: 200 }, values: [200000, 210000, 220000, 230000, 240000, 250000] });
  const resumed = events.filter(e => e.event === 'resume');
  assert.equal(resumed.length, 5); assert.ok(resumed.slice(0, 3).every(e => e.throttleMs === 0));
  assert.ok(resumed.slice(3).every(e => e.throttleMs >= 180));
  assert.ok(resumed.every(e => e.localResumeMs + 1 >= e.throttleMs));
});

test('disabling the context threshold disables explicit throttle too', async () => {
  const { events } = await bridgeFixture({ override: { highContextThrottleMs: 200, highContextThrottleTokens: 0 }, values: [300000, 310000, 320000, 330000, 340000] });
  assert.equal(events.filter(e => e.event === 'resume').length, 4);
  assert.ok(events.filter(e => e.event === 'resume').every(e => e.throttleMs === 0));
});

test('client cancellation interrupts explicit throttle without another model step', async () => {
  const { events, cancelled } = await bridgeFixture({ override: { highContextThrottleMs: 2000 }, values: [200000, 210000, 220000, 230000, 240000], cancel: true });
  assert.equal(cancelled, true);
  assert.equal(events.filter(e => e.event === 'resume').length, 3);
  assert.equal(events.find(e => e.event === 'end')?.status, 'cancelled');
});

(async () => {
  let passed = 0;
  for (const { name, run } of tests) {
    try { await run(); passed++; console.log('PASS ' + name); }
    catch (error) { console.error('FAIL ' + name + '\n' + error.stack); }
  }
  console.log(`${passed}/${tests.length} latency regressions passed`);
  if (passed !== tests.length) process.exitCode = 1;
})().catch(error => { console.error(error); process.exitCode = 1; });
