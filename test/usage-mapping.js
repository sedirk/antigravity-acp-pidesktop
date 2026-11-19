'use strict';
// Offline usage-contract regression. No official runtime, credentials or host changes.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createGateway, usageFor, normalizeTurnUsage, mergeTurnUsage } = require('../lib/server');
let passed = 0, failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log('PASS ' + name); }
  catch (error) { failed++; console.error('FAIL ' + name + '\n' + error.stack); }
}
const rawUsage = (input = 100000, output = 32000, cache = 80000) => ({ inputTokens: input - cache, cachedReadTokens: cache, cachedWriteTokens: 0, outputTokens: output, thoughtTokens: 8000, totalTokens: input + output });
const measuredStats = raw => ({ usagePromptCount: 1, turnUsage: normalizeTurnUsage(raw), contextUsed: raw.totalTokens });
function unavailable(usage) {
  for (const key of ['prompt_tokens', 'completion_tokens', 'input_tokens', 'output_tokens', 'total_tokens', 'prompt_tokens_details', 'input_tokens_details', 'completion_tokens_details', 'output_tokens_details']) {
    assert.equal(usage[key], undefined, key + ' must be absent, not a fabricated zero or estimate');
  }
  assert.equal(usage.usage_status, 'unavailable');
}
function frames(text) {
  return text.split(/\r?\n\r?\n/).map(frame => /^data: (.+)$/m.exec(frame)?.[1]).filter(x => x && x !== '[DONE]').map(JSON.parse);
}
async function fixture(api, { bridge = false, watermarks = [132000], terminal = rawUsage(), fragments = false, late = false, parallel = false, partial = false, nativeTool = false, nudge = false, handoff = false, noFinalText = false, steer = false } = {}) {
  const dir = fs.mkdtempSync(path.join(process.env.PI_SCRATCH_DIR || os.tmpdir(), 'usage-contract-'));
  const logs = [], responses = [], emitted = [], texts = [], deltas = [];
  let emitBetween;
  let bridgeUrl, prompts = 0, sessions = 0, cancelled = 0;
  const cfg = { bind: '127.0.0.1', port: 0, source: path.join(dir, 'config.json'), defaultModel: 'test', bridgeTools: bridge, toolPolicy: 'all', highContextThrottleMs: 0, promptTimeoutMs: 10000, promptIdleTimeoutMs: 10000, maxSessions: 5 };
  const acp = {
    policyBySession: new Map(), start: async () => {}, discover: async () => {}, cwdFor: async () => dir,
    resolveModel: x => x, status: () => ({ ready: true }), notify: method => { if (method === 'session/cancel') cancelled++; },
    request: async (method, p) => {
      if (method === 'session/new') { sessions++; bridgeUrl = p.mcpServers?.[0]?.url; return { sessionId: 'usage-contract-' + sessions }; }
      if (method !== 'session/prompt') return {};
      prompts++;
      const emit = update => { emitted.push(update); acp.onNotification({ method: 'session/update', params: { sessionId: p.sessionId, update } }); };
      const watermark = used => { if (used !== null && used !== undefined) emit({ sessionUpdate: 'usage_update', used, size: 256000 }); };
      const text = (kind, value) => {
        if (fragments) { for (const piece of value.match(/.{1,13}/gs) || []) emit({ sessionUpdate: kind, content: { type: 'text', text: piece } }); }
        else emit({ sessionUpdate: kind, content: { type: 'text', text: value } });
      };
      emitBetween = value => text('agent_message_chunk', value);
      if (steer && prompts > 1) { text('agent_message_chunk', 'NEW'); return { stopReason: 'end_turn', usage: terminal }; }
      if (nudge && prompts === 1) return { stopReason: 'end_turn', usage: rawUsage(10000, 10, 1000) };
      if (nativeTool) emit({ sessionUpdate: 'tool_call', toolCallId: 'native', kind: 'read', title: 'native read' });
      const tool = async (i, j = 0) => {
        const r = await fetch(bridgeUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: i * 10 + j, method: 'tools/call', params: { name: 'Read', arguments: { path: `fixture-${i}-${j}.txt` } } }) });
        assert.equal(r.status, 200); await r.text();
      };
      if (!bridge) {
        text('agent_message_chunk', 'a'.repeat(96000));
        text('agent_thought_chunk', 't'.repeat(32000));
        for (const used of watermarks) watermark(used);
      } else {
        for (let i = 0; i < watermarks.length; i++) {
          text('agent_message_chunk', handoff ? (i === 0 ? 'FIRST' : 'NEXT') : 'a'.repeat(80));
          text('agent_thought_chunk', 't'.repeat(40));
          if (!late) watermark(watermarks[i]);
          const cancelBefore = cancelled;
          if (parallel) await Promise.all([tool(i, 0), tool(i, 1)]);
          else await tool(i);
          if (cancelled !== cancelBefore) { text('agent_message_chunk', 'STALE_'); return { stopReason: 'cancelled' }; }
          if (late) watermark(watermarks[i]);
        }
        if (!noFinalText) text('agent_message_chunk', handoff ? 'DONE' : 'done');
      }
      return { stopReason: 'end_turn', ...(terminal === null ? {} : { usage: terminal }) };
    },
  };
  const gateway = createGateway({ acp, limiter: { run: fn => fn(), stats: () => ({}) }, getConfig: () => cfg, log: line => logs.push(line) });
  const tool = { name: 'Read', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } };
  let history = [{ role: 'user', content: 'request content' }], deferred = [];
  try {
    const port = await gateway.listen([0]);
    for (let step = 0; step < 20; step++) {
      const req = { model: 'test', stream: true, prompt_cache_key: 'usage-contract', ...(api === 'responses' ? { input: history } : { messages: history }) };
      if (bridge) req.tools = api === 'responses' ? [{ type: 'function', ...tool }] : [{ type: 'function', function: tool }];
      const r = await fetch(`http://127.0.0.1:${port}/v1/${api === 'responses' ? 'responses' : 'chat/completions'}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(req) });
      const body = await r.text(); assert.equal(r.status, 200, body.slice(-1000));
      const events = frames(body); let calls, usage;
      if (api === 'responses') {
        const final = events.find(e => e.type === 'response.completed')?.response; assert.ok(final, body.slice(-1000));
        usage = final.usage; calls = final.output.filter(x => x.type === 'function_call');
        history.push(...final.output);
      } else {
        usage = events.findLast(e => e.usage)?.usage;
        calls = events.flatMap(e => e.choices?.[0]?.delta?.tool_calls || []).filter(x => x.id);
        history.push({ role: 'assistant', content: events.map(e => e.choices?.[0]?.delta?.content || '').join(''), ...(calls.length ? { tool_calls: calls } : {}) });
      }
      assert.ok(usage); responses.push(usage);
      texts.push(api === 'chat' ? events.map(e => e.choices?.[0]?.delta?.content || '').join('') : events.find(e => e.type === 'response.completed').response.output.filter(x => x.type === 'message').flatMap(x => x.content).map(x => x.text).join(''));
      deltas.push(api === 'chat' ? events.map(e => e.choices?.[0]?.delta?.content || '').join('') : events.filter(e => e.type === 'response.output_text.delta').map(e => e.delta).join(''));
      if (!calls.length) break;
      if (handoff && step === 0) emitBetween('BETWEEN_');
      if (handoff && partial && step === 1) emitBetween('PARTIAL_');
      if (steer && step === 0) { history.push({ role: 'user', content: 'new direction' }); continue; }
      const results = calls.map(call => api === 'responses' ? { type: 'function_call_output', call_id: call.call_id, output: 'r'.repeat(400) } : { role: 'tool', tool_call_id: call.id, content: 'r'.repeat(400) });
      if (partial && results.length === 2 && deferred.length === 0) { deferred = results.slice(1); history.push(results[0]); }
      else if (deferred.length) { history.push(...deferred); deferred = []; }
      else history.push(...results);
    }
    assert.ok(responses.length < 20, 'fixture must terminate');
    return { responses, texts, deltas, logs, prompts, sessions, cancelled, emitted };
  } finally { await gateway.close(); fs.rmSync(dir, { recursive: true, force: true }); }
}
(async () => {
  await check('single unsplit terminal maps input plus cache, not post-output watermark', () => {
    const raw = rawUsage(); const u = usageFor('', '', '', measuredStats(raw));
    assert.equal(u.prompt_tokens, 100000); assert.equal(u.completion_tokens, 32000); assert.equal(u.total_tokens, 132000);
    assert.deepEqual(u.prompt_tokens_details, { cached_tokens: 80000 }); assert.deepEqual(u.completion_tokens_details, { reasoning_tokens: 8000 });
    assert.equal(u.context_used, 132000); assert.equal(u.usage_status, 'measured');
  });
  await check('context occupancy and pending output are never standard input', () => {
    const u = usageFor('prompt', 'answer', 'thought', { contextUsed: 100000, pendingDeltaTokens: 32000, estimateContext: 999999 });
    unavailable(u); assert.equal(u.context_used, 132000); assert.ok(u.observed_output_tokens > 0);
  });
  await check('park and cumulative terminal usage cannot be split or cache-scaled', () => {
    for (const terminal of [null, rawUsage(900000, 90000, 800000)]) {
      const u = usageFor('', '', '', { usagePromptCount: 1, isBridgedTurn: true, parkedBatches: 3, contextUsed: 25328, legOutputTokens: 12.5, legThoughtTokens: 2.5, reportedOutputTokens: 80000, turnUsage: terminal });
      unavailable(u); assert.equal(u.observed_output_tokens, 16); assert.equal(u.context_used, 25328);
      if (terminal) assert.equal(u.acp_turn_usage.cachedReadTokens, 800000);
    }
  });
  await check('normalization distinguishes absence, invalid and explicit zero', () => {
    const absent = normalizeTurnUsage({ outputTokens: 10 }); assert.equal(absent.inputTokens, undefined);
    const zero = normalizeTurnUsage({ input_tokens: 0, output_tokens: 0, cached_read_tokens: 0, total_tokens: 0 });
    assert.equal(zero.inputTokens, 0); assert.equal(zero.outputTokens, 0);
    for (const value of [null, -1, Infinity, NaN, true]) assert.equal(normalizeTurnUsage({ inputTokens: value, outputTokens: 10 }).inputTokens, undefined);
    unavailable(usageFor('', '', '', measuredStats(zero)));
  });
  await check('missing input/cache/output/total never yields a partial standard usage anchor', () => {
    for (const key of ['inputTokens', 'cachedReadTokens', 'outputTokens', 'totalTokens']) {
      const raw = rawUsage(); delete raw[key]; unavailable(usageFor('', '', '', measuredStats(raw)));
    }
  });
  await check('aggregate counters add across nudges without inventing missing buckets', () => {
    const a = normalizeTurnUsage(rawUsage(1000, 100, 500)), b = normalizeTurnUsage(rawUsage(2000, 200, 800));
    const combined = mergeTurnUsage(a, b); assert.equal(combined.inputTokens, 1700); assert.equal(combined.cachedReadTokens, 1300); assert.equal(combined.outputTokens, 300);
    assert.equal(combined.totalTokens, 3300);
    assert.equal(mergeTurnUsage(a, normalizeTurnUsage({ outputTokens: 10 })).inputTokens, undefined);
    unavailable(usageFor('', '', '', { ...measuredStats(rawUsage()), usagePromptCount: 2 }));
  });
  await check('tool activity, mismatched watermark, cancellation and inconsistent totals fail closed', () => {
    for (const extra of [{ usageHasTools: true }, { usageWatermark: 900000 }, { usageMultipleUpdates: true }, { task: { cancelled: true } }]) unavailable(usageFor('', '', '', { ...measuredStats(rawUsage()), ...extra }));
    const raw = rawUsage(); raw.totalTokens++; unavailable(usageFor('', '', '', measuredStats(raw)));
  });
  await check('explicit zero uncached input with positive cached input remains valid', () => {
    const u = usageFor('', '', '', measuredStats(rawUsage(80000, 32000, 80000))); assert.equal(u.prompt_tokens, 80000); assert.equal(u.prompt_tokens_details.cached_tokens, 80000);
  });
  await check('Chat park emits streamed text once, including fragmented output and partial parallel refill', async () => {
    const f = await fixture('chat', { bridge: true, watermarks: [132000], fragments: true, parallel: true, partial: true });
    assert.deepEqual(f.texts, ['a'.repeat(80), '', 'done']);
  });
  for (const api of ['responses', 'chat']) {
    await check(api + ': late text precedes new output and a second park without loss or duplication', async () => {
      const f = await fixture(api, { bridge: true, handoff: true, watermarks: [132000, 140000] });
      assert.deepEqual(f.texts, ['FIRST', 'BETWEEN_NEXT', 'DONE']); assert.deepEqual(f.deltas, f.texts);
    });
    await check(api + ': late text is delivered even when resume finishes without a new chunk', async () => {
      const f = await fixture(api, { bridge: true, handoff: true, noFinalText: true });
      assert.deepEqual(f.texts, ['FIRST', 'BETWEEN_']); assert.deepEqual(f.deltas, f.texts);
    });
    await check(api + ': partial parallel refill retains late text until the accepted full resume', async () => {
      const f = await fixture(api, { bridge: true, handoff: true, parallel: true, partial: true });
      assert.deepEqual(f.texts, ['FIRST', '', 'BETWEEN_PARTIAL_DONE']); assert.deepEqual(f.deltas, f.texts);
    });
    await check(api + ': cancelling a parked generation never leaks buffered or obsolete text into steering', async () => {
      const f = await fixture(api, { bridge: true, handoff: true, steer: true });
      assert.deepEqual(f.texts, ['FIRST', 'NEW']); assert.deepEqual(f.deltas, f.texts); assert.ok(f.cancelled >= 1); assert.equal(f.prompts, 2);
    });
    await check(`${api}: exact terminal wire input excludes output, cache and reasoning retained`, async () => {
      const f = await fixture(api); const u = f.responses[0]; assert.equal(u.input_tokens ?? u.prompt_tokens, 100000); assert.equal(u.output_tokens ?? u.completion_tokens, 32000); assert.equal(u.total_tokens, 132000); assert.equal(f.prompts, 1);
    });
    await check(`${api}: no-watermark terminal still uses complete unsplit counters`, async () => {
      const f = await fixture(api, { watermarks: [] }); assert.equal(f.responses[0].input_tokens ?? f.responses[0].prompt_tokens, 100000);
    });
    await check(`${api}: missing terminal keeps watermark diagnostic-only`, async () => {
      const f = await fixture(api, { terminal: null }); unavailable(f.responses[0]); assert.equal(f.responses[0].context_used, 132000);
    });
    await check(`${api}: duplicate watermark is harmless, genuine contraction is preserved`, async () => {
      const duplicate = await fixture(api, { watermarks: [132000, 132000] }); assert.equal(duplicate.responses[0].usage_status, 'measured');
      const drop = await fixture(api, { watermarks: [256844, 25328] }); unavailable(drop.responses[0]); assert.equal(drop.responses[0].context_used, 25328); assert.equal(drop.sessions, 1);
    });
    await check(`${api}: native tools and multiple prompt nudges do not masquerade as one call`, async () => {
      const native = await fixture(api, { nativeTool: true }); unavailable(native.responses[0]);
      const nudge = await fixture(api, { nudge: true }); unavailable(nudge.responses[0]); assert.equal(nudge.prompts, 2); assert.equal(nudge.responses[0].acp_turn_usage.prompt_count, 2);
    });
    for (const late of [false, true]) await check(`${api}: multi-leg ${late ? 'late' : 'current'} watermarks and cumulative terminal`, async () => {
      const f = await fixture(api, { bridge: true, watermarks: [184000, 192000, 25328], terminal: rawUsage(900000, 90000, 800000), late, fragments: true });
      assert.equal(f.responses.length, 4); assert.equal(f.prompts, 1); assert.equal(f.sessions, 1);
      for (const u of f.responses) { unavailable(u); assert.ok(Number.isFinite(u.observed_output_tokens)); }
      assert.equal(f.responses.at(-1).acp_turn_usage.cachedReadTokens, 800000);
      assert.equal(f.responses.at(-1).observed_output_tokens, 1);
    });
    await check(`${api}: parallel tools with partial refill do not emit duplicate standard counts`, async () => {
      const f = await fixture(api, { bridge: true, watermarks: [132000], parallel: true, partial: true }); assert.equal(f.responses.length, 3);
      for (const u of f.responses) unavailable(u);
    });
  }
  console.log(`Usage mapping: ${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
})().catch(error => { console.error(error); process.exitCode = 1; });
