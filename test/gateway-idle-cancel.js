'use strict';
// A watchdog cancellation is terminal even when the upstream answers *after* cancel.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createGateway } = require(process.env.PI_TEST_ACP_ROOT ? path.join(process.env.PI_TEST_ACP_ROOT, 'lib/server.js') : '../lib/server');
for (const api of ['chat', 'responses']) test(`${api}: gateway idle cancel fences late frames and terminal result`, { timeout: 10000 }, async () => {
  const tmp = fs.mkdtempSync(path.join(process.env.PI_SCRATCH_DIR || os.tmpdir(), 'gw-stall-'));
  const logs = []; let calls = 0, stops = 0, settle;
  const acp = { policyBySession: new Map(), start: async () => {}, discover: async () => {}, cwdFor: async () => tmp, resolveModel: x => x,
    notify(method) { if (method === 'session/cancel') { stops++; settle?.(); } },
    async request(method, {sessionId}) {
      if (method === 'session/new') return {sessionId:'stall'};
      if (method !== 'session/prompt') return {};
      calls++;
      const emit = update => acp.onNotification({method:'session/update', params:{sessionId, update}});
      emit({sessionUpdate:'usage_update', used:45000, size:256000});
      if (calls === 1) await new Promise(r => { settle = r; });
      emit({sessionUpdate:'agent_message_chunk', content:{type:'text', text:'AFTER_WATCHDOG_CANCEL'}});
      emit({sessionUpdate:'usage_update', used:199999, size:256000});
      if (api === 'responses') throw Object.assign(new Error('upstream 429 rate limit'), {code:429});
      return {stopReason:'end_turn', usage:{inputTokens:190000, outputTokens:9999, totalTokens:199999}};
    }};
  const cfg = {source:path.join(tmp,'cfg.json'),bind:'127.0.0.1',bridgeTools:false,toolPolicy:'all',promptTimeoutMs:0,promptIdleTimeoutMs:2000,rateLimitMaxRetries:1,rateLimitRetryBaseMs:50};
  const gw = createGateway({acp,getConfig:()=>cfg,limiter:{run:f=>f(),stats:()=>({})},log:m=>logs.push(m)});
  try {
    const port = await gw.listen([0]), h = [{role:'user',content:'test'}];
    const res = await fetch(`http://127.0.0.1:${port}/v1/${api === 'chat' ? 'chat/completions' : 'responses'}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:'m',stream:true,prompt_cache_key:'stall',...(api === 'chat'?{messages:h}:{input:h})}),signal:AbortSignal.timeout(8000)});
    const wire = await res.text(); assert.equal(res.status,200);
    assert.match(wire,/ACP_IDLE_TIMEOUT/); assert.doesNotMatch(wire,/AFTER_WATCHDOG_CANCEL/);
    assert.equal(calls,1); assert.equal(stops,1);
    const events = logs.filter(x=>x.startsWith('[acp-diag] ')).map(x=>JSON.parse(x.slice(11)));
    assert.deepEqual(events.filter(x=>Number.isFinite(x.rawUsed)).map(x=>x.rawUsed),[45000]);
    assert.equal(events.find(x=>x.event==='end').status,'error');
  } finally { settle?.(); await gw.close(); fs.rmSync(tmp,{recursive:true,force:true}); }
});
