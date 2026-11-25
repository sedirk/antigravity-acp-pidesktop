'use strict';
// Context fidelity regressions. Synthetic fixtures only; no account or host mutation.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { normalizeMessages, flatten, flattenSummarization, extractLatestCompaction } = require('../lib/server.js');
const { createSessionStore } = require('../lib/session-store.js');
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const user = content => ({ role: 'user', content });
const assistant = content => ({ role: 'assistant', content });
const callback = report => `The following subagents have finished. Integrate their reports and continue the user's original task.\n\n## reviewer-gpt — completed\n${report}`;
const checkpoint = text => `The conversation history before this point was compacted into the following summary:\n<summary>\n${text}\n</summary>`;

test('Responses preserves tool call identity, arguments and paired output', () => {
  const messages = normalizeMessages({ input: [
    user('Review the patch'),
    { type: 'function_call', call_id: 'review-1', name: 'Task', arguments: '{"agent":"reviewer-gpt","task":"CHECK_BOUNDARY"}' },
    { type: 'function_call_output', call_id: 'review-1', output: 'REVIEW_RESULT: P1 fix required' },
    user('Continue the original task'),
  ] }, { responses: true });
  const text = flatten(messages);
  assert.ok(text.includes('CHECK_BOUNDARY'), 'the call arguments must survive normalization');
  assert.ok(text.includes('review-1'), 'call id links the result to its invocation');
  assert.ok(text.includes('REVIEW_RESULT'));
});

test('Chat tool_calls retain arguments and infer the result tool name', () => {
  const messages = normalizeMessages({ messages: [
    user('inspect'),
    { role: 'assistant', content: null, tool_calls: [{ id: 'read-1', type: 'function', function: { name: 'Read', arguments: '{"path":"src/anchor.js"}' } }] },
    { role: 'tool', tool_call_id: 'read-1', content: 'FILE_ANCHOR' },
    user('continue'),
  ] });
  const text = flatten(messages);
  assert.ok(text.includes('src/anchor.js'));
  assert.equal(messages.find(m => m.role === 'tool').toolName, 'Read');
});

test('two completed reviewer reports survive long history without becoming user goals', () => {
  const report1 = `REPORT_ONE_START\n${'review details\n'.repeat(700)}P1_MIDDLE_FINDING\n${'evidence\n'.repeat(400)}REPORT_ONE_END`;
  const report2 = `REPORT_TWO_START\n${'second review\n'.repeat(750)}REPORT_TWO_END`;
  const messages = [user('ORIGINAL_GOAL: audit then publish'), user(callback(report1)), user(callback(report2))];
  for (let i = 0; i < 45; i++) messages.push(assistant(`routine step ${i} ${'log '.repeat(300)}`));
  messages.push(user('continue'));
  const text = flatten(messages);
  assert.ok(text.includes(report1), 'first full report must not be reduced to a prompt index');
  assert.ok(text.includes(report2), 'second report must not be evicted by the recent-message window');
  const index = text.split('=== 用户历史提问脉络与意图索引')[1]?.split('\n\n===')[0] || '';
  assert.ok(!index.includes('The following subagents have finished'), 'host callbacks are not human requests');
});

test('first user goal and differing long instructions survive store reload', () => {
  const dir = fs.mkdtempSync(path.join(process.env.PI_SCRATCH_DIR || os.tmpdir(), 'context-store-'));
  try {
    const file = path.join(dir, 'sessions.json');
    const timeline = ['ROOT_GOAL: review then publish', ...Array.from({ length: 72 }, (_, i) => `followup-${i}`)];
    const store = createSessionStore({ file });
    store.set('topic', { sessionId: 'sid', userTimeline: timeline }); store.flush();
    const restored = createSessionStore({ file }); restored.load();
    assert.equal(restored.get('topic').userTimeline[0], timeline[0]);
    const common = 'same context '.repeat(25);
    const text = flatten([user(common + 'DO_NOT_PUBLISH'), user(common + 'PUBLISH_AFTER_REVIEW'), user('continue')]);
    assert.ok(text.includes('DO_NOT_PUBLISH') && text.includes('PUBLISH_AFTER_REVIEW'), 'do not deduplicate by a shared 180-character prefix');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('summary file lists cannot evict the goal and modified project files', () => {
  const noise = Array.from({ length: 750 }, (_, i) => `C:\\Users\\fixture\\.gemini\\antigravity-acp\\brain\\sid\\.system_generated\\steps\\${i}\\output.txt`).join('\n');
  const summary = checkpoint(`GOAL_KEEP\n<read-files>\n${noise}\nD:/project/src/input.js\n</read-files>\nTASK_STATE_IN_MIDDLE: publish only after review\n<modified-files>\nD:/project/src/fix.js\n</modified-files>`);
  const messages = [{ role: 'system', content: 'Primary root: D:/project' }, user(summary), user('continue')];
  const text = flatten(messages);
  assert.ok(text.includes('TASK_STATE_IN_MIDDLE'));
  assert.ok(text.includes('D:/project/src/fix.js'));
  assert.ok(!text.includes('.system_generated'));
  const summarization = flattenSummarization(messages);
  assert.ok(!summarization.includes('.system_generated'), 'filter before the summarizer also');
});

test('recent history retains complete call/result groups under window pressure', () => {
  const input = [user('ORIGINAL_GOAL')];
  for (let i = 0; i < 30; i++) input.push(
    { type: 'function_call', call_id: `c${i}`, name: 'Bash', arguments: JSON.stringify({ command: `COMMAND_${i}_UNIQUE` }) },
    { type: 'function_call_output', call_id: `c${i}`, output: `RESULT_${i}_UNIQUE ${'x'.repeat(3000)}` },
  );
  input.push(user('continue'));
  const text = flatten(normalizeMessages({ input }, { responses: true }));
  assert.ok(text.includes('RESULT_29_UNIQUE'));
  for (let i = 0; i < 30; i++) if (text.includes(`RESULT_${i}_UNIQUE`)) assert.ok(text.includes(`COMMAND_${i}_UNIQUE`), `orphaned result ${i}`);
});

test('single packed compaction input protects user instructions instead of blind middle cutting', () => {
  const transcript = `<conversation>\n[User]: FIRST_GOAL\n[Tool result]: ${'A'.repeat(90000)}\n[User]: KEY_MIDDLE_CORRECTION_DO_NOT_SHIP\n[Tool result]: ${'B'.repeat(90000)}\n[Assistant]: CURRENT_PROGRESS\n</conversation>\nSummarize the conversation.`;
  const text = flattenSummarization([{ role: 'system', content: 'You are a context summarization assistant.' }, user(transcript)]);
  assert.ok(text.includes('KEY_MIDDLE_CORRECTION_DO_NOT_SHIP'));
  assert.ok(text.includes('FIRST_GOAL') && text.includes('CURRENT_PROGRESS'));
  assert.ok(text.length <= 108000 && Buffer.byteLength(text) <= 116000);
});


test('UTF-8 limits terminate on tiny budgets and preserve valid emoji', () => {
  const { clipText, canonicalizeText, boundUserTimeline } = require('../lib/context.js');
  assert.equal(canonicalizeText('goal 🚀 complete'), 'goal 🚀 complete');
  for (const bytes of [0, 1, 8, 64, 128, 1024]) {
    const text = clipText('中文😀'.repeat(1000), 1000, bytes);
    assert.ok(Buffer.byteLength(text) <= bytes);
    assert.equal(text.isWellFormed(), true);
  }
  const timeline = boundUserTimeline(['ROOT', callback('not a human instruction'), ...Array.from({ length: 100 }, (_, i) => 'turn-' + i)]);
  assert.equal(timeline[0], 'ROOT'); assert.ok(timeline.includes('turn-99'));
  assert.ok(!timeline.some(t => t.includes('subagents have finished')));
});

test('report persistence stays complete, bounded and explicit on overflow', () => {
  const { collectDeliveries, boundDeliveries } = require('../lib/context.js');
  const report = callback('A'.repeat(10000) + 'MIDDLE_FINDING' + 'B'.repeat(9000));
  const deliveries = collectDeliveries([user(report)]);
  assert.deepEqual(collectDeliveries([user(report)], deliveries), deliveries, 'repeated requests must not duplicate reports');
  const text = flatten([user(checkpoint('summary without report')), user('continue')], { persistedTimeline: ['ORIGINAL_GOAL'], persistedDeliveries: deliveries });
  assert.ok(text.includes(report)); assert.ok(text.includes('ORIGINAL_GOAL'));
  const clipped120k = boundDeliveries(['HEAD_120K_' + 'x'.repeat(120000) + '_TAIL_120K']);
  assert.equal(clipped120k.length, 1);
  assert.ok(clipped120k[0].includes('HEAD_120K_') && clipped120k[0].includes('_TAIL_120K') && clipped120k[0].includes('省略'), 'oversized single delivery must clip head+tail cleanly without throwing CONTEXT_BUDGET_EXCEEDED');
});

test('file-list filtering is scoped, bounded and does not rewrite user prose', () => {
  const { filterSummaryFiles } = require('../lib/context.js');
  const prose = 'User explicitly asked to inspect C:/Users/test/.pi-desktop/scratch/example.txt';
  const text = filterSummaryFiles(prose + '\n<read-files>\nC:/Users/test/.pi-desktop/scratch/example.txt\nD:/project/src/main.js\nD:/other/secret.js\n' + Array.from({length:100}, (_,i) => 'D:/project/src/file'+i+'.js').join('\n') + '\n</read-files>', ['d:/project']);
  assert.ok(text.startsWith(prose)); assert.ok(text.includes('D:/project/src/main.js'));
  assert.ok(!text.includes('D:/other/secret.js')); assert.ok(text.length < 4500);
});

test('HTTP compaction, restart and branch revision retain only the correct lane memory', async () => {
  const { createGateway } = require('../lib/server.js');
  const net = require('node:net');
  const dir = fs.mkdtempSync(path.join(process.env.PI_SCRATCH_DIR || os.tmpdir(), 'context-http-'));
  let serial = 0, gateway, port; const prompts = [];
  const config = { bind:'127.0.0.1', port:0, defaultModel:'test', toolPolicy:'none', bridgeTools:false, promptTimeoutMs:2000, promptIdleTimeoutMs:2000, maxSessions:20, source:path.join(dir,'config.json') };
  const acp = {
    policyBySession:new Map(), start:async()=>{}, discover:async()=>{}, cwdFor:async()=>dir, resolveModel:x=>x, status:()=>({ready:true}), notify:()=>{},
    request:async(method, params)=>{
      if(method==='session/new') return {sessionId:'ctx-'+ ++serial};
      if(method==='session/prompt') {
        prompts.push(params.prompt.map(p=>p.text||'').join('\n'));
        acp.onNotification({method:'session/update',params:{sessionId:params.sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'ack'}}}});
        return {stopReason:'end_turn'};
      }
      return {};
    },
  };
  async function start() {
    gateway=createGateway({acp,limiter:{run:f=>f(),stats:()=>({})},getConfig:()=>config,log:()=>{}});
    const probe=net.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));port=probe.address().port;await new Promise(r=>probe.close(r));
    await gateway.listen([port]);
  }
  async function send(key,input) {
    const r=await fetch('http://127.0.0.1:'+port+'/v1/responses',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:'test',prompt_cache_key:key,input})});
    const body=await r.text();assert.equal(r.status,200,body);
    return prompts[prompts.length-1];
  }
  try {
    await start();
    const goal='ROOT_GOAL_REVIEW_THEN_PUBLISH', report=callback('REVIEW_START\n'+'evidence '.repeat(1700)+'P1_CRITICAL_MIDDLE\nREVIEW_END');
    await send('topic',[user(goal)]);
    await send('topic',[user(goal),assistant('review delegated'),user(report)]);
    let flat=await send('topic',[user(checkpoint('generation-one')),assistant('retained tail'),user('continue')]);
    assert.ok(flat.includes(goal) && flat.includes(report),'compaction reset must retain original goal and full report');
    await gateway.close();await start();
    flat=await send('topic',[user(checkpoint('generation-two')),assistant('tail'),user('continue again')]);
    assert.ok(flat.includes(goal) && flat.includes(report),'disk reload plus another compaction must retain memory');
    flat=await send('other',[user('UNRELATED_TOPIC')]);
    assert.ok(!flat.includes(goal) && !flat.includes(report),'no cross-topic memory');
    flat=await send('topic',[user('REVISED_BRANCH'),assistant('new branch response'),user('continue revised branch')]);
    assert.ok(!flat.includes(goal) && !flat.includes(report),'explicit branch revision must discard old reports and goals');
  } finally { if(gateway)await gateway.close();fs.rmSync(dir,{recursive:true,force:true}); }
});


test('bridged tool usage includes observed thought and arguments without rebilling final cumulative output', async () => {
  const { createGateway } = require('../lib/server.js');
  const net=require('node:net');
  const dir=fs.mkdtempSync(path.join(process.env.PI_SCRATCH_DIR||os.tmpdir(),'context-usage-'));
  let bridgeUrl=''; const logs=[];
  const cfg={bind:'127.0.0.1',port:0,defaultModel:'test',toolPolicy:'all',bridgeTools:true,promptTimeoutMs:3000,promptIdleTimeoutMs:3000,maxSessions:10,source:path.join(dir,'config.json')};
  const acp={policyBySession:new Map(),start:async()=>{},discover:async()=>{},cwdFor:async()=>dir,resolveModel:x=>x,status:()=>({ready:true}),notify:()=>{},
    request:async(method,p)=>{
      if(method==='session/new'){bridgeUrl=p.mcpServers[0].url;return {sessionId:'usage-session'};}
      if(method==='session/prompt'){
        const emit=update=>acp.onNotification({method:'session/update',params:{sessionId:p.sessionId,update}});
        emit({sessionUpdate:'usage_update',used:256844,size:1048576});
        emit({sessionUpdate:'agent_thought_chunk',content:{type:'text',text:'observable reasoning '.repeat(20)}});
        await fetch(bridgeUrl,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'Read',arguments:{path:'src/fixture-for-output-counting.js'}}})}).then(r => r.text());
        emit({sessionUpdate:'usage_update',used:25328,size:1048576});
        emit({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'done'}});
        return {stopReason:'end_turn',usage:{inputTokens:25328,outputTokens:1000,thoughtTokens:0,totalTokens:26328}};
      }
      return {};
    }};
  const gateway=createGateway({acp,limiter:{run:f=>f(),stats:()=>({})},getConfig:()=>cfg,log:s=>logs.push(s)});
  const probe=net.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
  const tools=[{type:'function',name:'Read',parameters:{type:'object',properties:{path:{type:'string'}},required:['path']}}];
  async function send(input) {
    const r = await fetch('http://127.0.0.1:' + port + '/v1/responses', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'test', stream: true, prompt_cache_key: 'usage-topic', input, tools }),
    });
    const body = await r.text(); assert.equal(r.status, 200, body);
    const events = body.split('\n\n').map(block => /^data: (.+)$/m.exec(block)?.[1]).filter(Boolean).map(data => JSON.parse(data));
    const completed = events.find(event => event.type === 'response.completed');
    assert.ok(completed, body);
    return completed.response;
  }
  try{
    await gateway.listen([port]);
    const first=await send([user('read a fixture')]);
    assert.equal(first.usage.usage_status,'unavailable');
    assert.equal(first.usage.input_tokens,undefined);
    assert.equal(first.usage.output_tokens,undefined);
    assert.equal(first.usage.output_tokens_details,undefined);
    assert.ok(first.usage.observed_output_tokens>0,'tool-only park must report observed output');
    assert.ok(first.usage.observed_reasoning_tokens>0,'received thought chunks must be observed');
    assert.equal(first.usage.output_estimated,true);
    assert.ok(first.usage.context_used>=256844);
    const call=first.output.find(x=>x.type==='function_call');assert.ok(call);
    const final=await send([user('read a fixture'),call,{type:'function_call_output',call_id:call.call_id,output:'fixture content'}]);
    assert.equal(final.usage.usage_status,'unavailable');
    assert.equal(final.usage.input_tokens,undefined);
    assert.equal(final.usage.output_tokens,undefined);
    assert.equal(final.usage.observed_output_tokens,1,'final leg only counts its own visible output without rebilling or subtracting parked estimate');
    assert.equal(final.usage.acp_turn_usage.scope,'prompt_aggregate');
    assert.equal(final.usage.acp_turn_usage.outputTokens,1000,'cumulative official output stays unsubtracted in acp_turn_usage');
    assert.ok(final.usage.context_used>=25328 && final.usage.context_used<100000,'authoritative runtime shrink must not be frozen by a monotonic clamp');
    assert.ok(logs.some(s=>s.includes('上下文水位回落')));
  }finally{await gateway.close();fs.rmSync(dir,{recursive:true,force:true});}
});

// Targeted regressions from the single independent review.
async function withMockGateway(options, run) {
  const { createGateway } = require('../lib/server.js');
  const dir = fs.mkdtempSync(path.join(process.env.PI_SCRATCH_DIR || os.tmpdir(), 'context-review-'));
  const config = { bind: '127.0.0.1', port: 0, defaultModel: 'test', toolPolicy: options.bridge ? 'all' : 'none', bridgeTools: !!options.bridge, promptTimeoutMs: 3000, promptIdleTimeoutMs: 3000, maxSessions: 10, source: path.join(dir, 'config.json') };
  let gateway, port, serial = 0, bridgeUrl = '';
  const prompts = [], requests = [];
  const acp = {
    policyBySession: new Map(), start: async () => {}, discover: async () => {}, cwdFor: async () => dir,
    resolveModel: model => model, status: () => ({ ready: true }), notify: () => {},
    request: async (method, params) => {
      requests.push(method);
      if (method === 'session/new') { bridgeUrl = params.mcpServers?.[0]?.url || ''; return { sessionId: 'review-' + ++serial }; }
      if (method === 'session/load' && options.failLoad) throw new Error('SYNTHETIC_SESSION_NOT_FOUND');
      if (method === 'session/prompt') {
        prompts.push(params.prompt.map(p => p.text || '').join('\n'));
        const emit = update => acp.onNotification({ method: 'session/update', params: { sessionId: params.sessionId, update } });
        if (options.prompt) return options.prompt(emit, bridgeUrl);
        emit({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ack' } });
        return { stopReason: 'end_turn' };
      }
      return {};
    },
  };
  async function start() {
    gateway = createGateway({ acp, limiter: { run: f => f(), stats: () => ({}) }, getConfig: () => config, log: () => {} });
    port = await gateway.listen([0]);
  }
  async function send(input, extra = {}) {
    const response = await fetch('http://127.0.0.1:' + port + '/v1/responses', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'test', prompt_cache_key: 'review-topic', input, ...extra }),
    });
    const raw = await response.text(); assert.equal(response.status, 200, raw);
    let body;
    if (extra.stream) {
      const events = raw.split('\n\n').map(block => /^data: (.+)$/m.exec(block)?.[1]).filter(Boolean).map(JSON.parse);
      body = events.find(event => event.type === 'response.completed')?.response;
      assert.ok(body, raw);
    } else body = JSON.parse(raw);
    return { body, prompt: prompts.at(-1) };
  }
  try { await start(); await run({ send, prompts, requests, restart: async () => { await gateway.close(); await start(); } }); }
  finally { if (gateway) await gateway.close(); fs.rmSync(dir, { recursive: true, force: true }); }
}

const largeWrite = length => [
  { type: 'function_call', call_id: 'write-large', name: 'Write', arguments: JSON.stringify({ path: 'src/fixture.js', content: 'a'.repeat(length) }) },
  { type: 'function_call_output', call_id: 'write-large', output: 'WRITE_SUCCESS_ANCHOR' },
];

test('large tool arguments retain the latest causal group in replay and summarization', () => {
  const messages = normalizeMessages({ input: [user('ROOT_GOAL'), assistant('EARLIER_PROGRESS'), ...largeWrite(120000), user('continue')] }, { responses: true });
  for (const serialize of [flatten, flattenSummarization]) {
    const text = serialize(messages);
    for (const anchor of ['write-large', 'WRITE_SUCCESS_ANCHOR', 'EARLIER_PROGRESS', '省略']) assert.ok(text.includes(anchor), anchor);
  }
  const { recentContext } = require('../lib/context.js');
  assert.equal(recentContext(messages.slice(2, 4), 1, 1), '', 'tiny recentContext budget must return empty string gracefully instead of throwing');
  assert.throws(() => recentContext(messages.slice(2, 4), 1, 1, 18, 8000, 17600, false), { code: 'CONTEXT_BUDGET_EXCEEDED' });
});

test('HTTP replay keeps a large trailing tool call paired with its short result', async () => {
  await withMockGateway({}, async ({ send }) => {
    const { prompt } = await send([user('ROOT_GOAL'), ...largeWrite(30000)]);
    for (const anchor of ['write-large', 'WRITE_SUCCESS_ANCHOR', '省略']) assert.ok(prompt.includes(anchor), anchor);
  });
});

test('restart with unchanged summary and failed session/load preserves local goal and reports', async () => {
  const options = {};
  await withMockGateway(options, async ({ send, restart, requests }) => {
    const goal = 'ORIGINAL_ROOT_GOAL', report = callback('REPORT_RECOVER_START\n' + 'detail '.repeat(2000) + 'P1_RECOVER_MIDDLE');
    await send([user(goal), assistant('delegated'), user(report)]);
    const compacted = [user(checkpoint('D:/project/src')), assistant('retained tail'), user('continue')];
    const before = await send(compacted);
    assert.ok(before.prompt.includes(goal) && before.prompt.includes(report));
    await restart(); options.failLoad = true;
    const after = await send([...compacted, assistant('ack'), user('finish')]);
    assert.ok(requests.includes('session/load'), 'must actually attempt restoration, not reset for a new summary');
    assert.ok(after.prompt.includes(goal) && after.prompt.includes(report), 'failed upstream load must not destroy local memory');
  });
});

test('explicit history revision takes precedence over simultaneous system changes', async () => {
  await withMockGateway({}, async ({ send }) => {
    await send([user('COMMON_ROOT'), assistant('ack'), user('OLD_BRANCH_SPEC'), assistant('delegated'), user(callback('STALE_BRANCH_REPORT_P1'))], { instructions: 'persona version A' });
    const { prompt } = await send([user('COMMON_ROOT'), assistant('ack'), user('REVISED_BRANCH_SPEC'), assistant('new answer'), user('continue revised')], { instructions: 'persona version B' });
    assert.ok(prompt.includes('REVISED_BRANCH_SPEC'));
    assert.ok(!prompt.includes('OLD_BRANCH_SPEC') && !prompt.includes('STALE_BRANCH_REPORT_P1'), 'old branch must not revive with a system update');
  });
});

test('minimal and xhigh survive config validation, panel save and reload', () => {
  const config = require('../lib/config.js');
  const dir = fs.mkdtempSync(path.join(process.env.PI_SCRATCH_DIR || os.tmpdir(), 'context-effort-'));
  const ctx = { packageRoot: dir, dataPath: dir };
  try {
    for (const effort of ['minimal', 'xhigh']) {
      assert.deepEqual(config.validatePatch({ defaultEffort: effort }, ctx).errors, []);
      const saved = config.savePanel(ctx, { defaultEffort: effort }); assert.equal(saved.ok, true);
      assert.equal(config.normalize(config.readRaw(saved.file), ctx).defaultEffort, effort);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Chat custom calls retain their names, input and result identity', () => {
  const messages = normalizeMessages({ messages: [user('apply the fixture'),
    { role: 'assistant', content: null, tool_calls: [{ type: 'custom', id: 'patch1', custom: { name: 'apply_patch', input: 'PATCH_PAYLOAD' } }] },
    { role: 'tool', tool_call_id: 'patch1', content: 'PATCH_DONE' },
  ] });
  const text = flatten(messages);
  assert.ok(text.includes('PATCH_PAYLOAD') && text.includes('PATCH_DONE'));
  assert.equal(messages.find(m => m.role === 'tool').toolName, 'apply_patch');
});

test('estimated output and reasoning are independent of streaming chunk boundaries', async () => {
  const { countTokens } = require('../lib/server.js');
  const tools = [{ type: 'function', name: 'Read', parameters: { type: 'object', properties: { path: { type: 'string' } } } }];
  const args = { path: 'fixture.js' }, totals = [];
  for (const fragmented of [false, true]) {
    const usages = [];
    await withMockGateway({ bridge: true, prompt: async (emit, bridgeUrl) => {
      for (let leg = 0; leg < 4; leg++) {
        for (const [kind, text] of [['agent_thought_chunk', 'b'.repeat(80)], ['agent_message_chunk', 'a'.repeat(160)]]) {
          for (const piece of fragmented ? [...text] : [text]) emit({ sessionUpdate: kind, content: { type: 'text', text: piece } });
        }
        if (leg < 3) await fetch(bridgeUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: leg + 1, method: 'tools/call', params: { name: 'Read', arguments: args } }) }).then(r => r.text());
      }
      return { stopReason: 'end_turn' };
    } }, async ({ send }) => {
      const input = [user('read fixtures')];
      for (let leg = 0; leg < 4; leg++) {
        const { body } = await send(input, { tools, stream: true }); usages.push(body.usage);
        assert.equal(body.usage.usage_status, 'unavailable');
        assert.equal(body.usage.output_tokens, undefined);
        assert.equal(body.usage.output_tokens_details, undefined);
        assert.equal(body.usage.output_estimated, true);
        const call = body.output.find(item => item.type === 'function_call');
        if (leg < 3) {
          assert.ok(call); input.push(...body.output, { type: 'function_call_output', call_id: call.call_id, output: 'fixture content' });
        } else assert.equal(call, undefined);
      }
    });
    const total = usages.reduce((sum, usage) => ({ output: sum.output + usage.observed_output_tokens, reasoning: sum.reasoning + (usage.observed_reasoning_tokens || 0) }), { output: 0, reasoning: 0 });
    assert.deepEqual(total, { output: 240 + 3 * countTokens(JSON.stringify(args)), reasoning: 80 });
    totals.push(total);
  }
  assert.deepEqual(totals[0], totals[1]);
});

test('branch summary vs compaction separation, chronological dedup before eviction, multi-Task oversized guard, UTF-8 byte caps, and sessionStore SID isolation', () => {
  const { isCompactionSummary, isBranchSummary, boundDeliveries, collectDeliveries } = require('../lib/context.js');
  const branchSummary = 'The following is a summary of a branch that this conversation came back from:\n\n<summary>\nBRANCH_CHECKPOINT_STATE\n</summary>';
  assert.equal(isCompactionSummary(branchSummary), false, 'branch_summary must not be treated as a mainline truncating compaction');
  assert.equal(isBranchSummary(branchSummary), true, 'PI-Desktop BRANCH_SUMMARY_PREFIX must be recognized as a branch summary');
  const flatBranch = flatten([
    user('ROOT_INTENT'),
    assistant('SHARED_PREFIX_RESULT'),
    user(checkpoint('MAINLINE_SUMMARY')),
    assistant('POST_CHECKPOINT_SHARED'),
    user(branchSummary),
    user('continue branch'),
  ]);
  assert.ok(flatBranch.includes('=== 历史阶段压缩摘要 (Compaction Summary) ===') && flatBranch.includes('MAINLINE_SUMMARY'), 'mainline compaction summary must remain intact');
  assert.ok(flatBranch.includes('POST_CHECKPOINT_SHARED'), 'branch_summary must not truncate shared post-checkpoint history');
  assert.ok(flatBranch.includes('Branch summary:') && flatBranch.includes('BRANCH_CHECKPOINT_STATE'), 'branch summary content must survive in context');
  const timelineSlice = flatBranch.split('=== 用户历史提问脉络与意图索引')[1]?.split('\n\n===')[0] || '';
  assert.ok(!timelineSlice.includes('summary of a branch'), 'branch summary must not pollute human user timeline');
  const flatTrailingBranch = flatten([
    user('ROOT_INTENT'),
    user(checkpoint('MAINLINE_SUMMARY')),
    assistant('POST_CHECKPOINT_SHARED'),
    user(branchSummary),
  ]);
  assert.ok(flatTrailingBranch.includes('MAINLINE_SUMMARY') && flatTrailingBranch.includes('POST_CHECKPOINT_SHARED') && flatTrailingBranch.includes('BRANCH_CHECKPOINT_STATE'));

  // Two active 55KB reports across turns must keep the NEWER report even when bigOld was already persisted
  const bigOld = callback('OLD_55K_' + 'x'.repeat(54000));
  const bigNew = callback('NEW_55K_' + 'y'.repeat(54000));
  const pair = boundDeliveries([bigOld, bigNew]);
  assert.equal(pair.length, 1);
  assert.ok(pair[0].includes('NEW_55K_'));
  const flat55 = flatten([user('GOAL_55'), user(bigNew), user('next')], { persistedDeliveries: [bigOld] });
  assert.ok(flat55.includes('NEW_55K_') && !flat55.includes('OLD_55K_'), 'HTTP rebuild with persisted 55KB delivery must keep newer 55KB delivery');
  const sameTurnPair = collectDeliveries([user('GOAL_55'), user(bigNew)], [bigOld], { turnDeliveries: [bigOld] });
  assert.equal(sameTurnPair.length, 2, 'sequential 55KB + 55KB deliveries within the same human turn must both survive via proportional head+tail clipping');
  assert.ok(sameTurnPair[0].includes('OLD_55K_') && sameTurnPair[1].includes('NEW_55K_'));

  // Pre-checkpoint report A (~14.5KB) + post-checkpoint report B (~14.5KB): duplicate A before checkpoint or B after checkpoint must never flip [A, B] order
  const repA = callback('PRE_A_' + 'a'.repeat(14500));
  const repB = callback('POST_B_' + 'b'.repeat(14500));
  const keptAB = collectDeliveries([user(checkpoint('compacted state')), user(repB), user('continue')], [repA, repB]);
  assert.equal(keptAB.length, 2, 'both ~14.5KB pre- and post-checkpoint reports fit within 32KB/48KB caps when deduplicated before eviction');
  assert.ok(keptAB[0].includes('PRE_A_') && keptAB[1].includes('POST_B_'), 'chronological [A, B] order must be preserved');
  const keptPreReplayA = collectDeliveries([user(repA), user(checkpoint('compacted state')), user('continue')], [repA, repB]);
  assert.equal(keptPreReplayA.length, 2);
  assert.ok(keptPreReplayA[0].includes('PRE_A_') && keptPreReplayA[1].includes('POST_B_'), 'replaying already-completed A before checkpoint must not invert [A, B] into [B, A]');
  // Multiple Task outputs in the same turn where the first exceeds 96KB/112KB must reject with CONTEXT_BUDGET_EXCEEDED instead of silently evicting task 1
  const multiTaskMsgs = normalizeMessages({
    input: [
      user('audit'),
      { type: 'function_call', call_id: 'tk-1', name: 'Task', arguments: '{"agent":"reviewer-gpt","task":"t1"}' },
      { type: 'function_call', call_id: 'tk-2', name: 'Task', arguments: '{"agent":"explore","task":"t2"}' },
      { type: 'function_call_output', call_id: 'tk-1', output: 'OVERSIZED_FIRST_' + 'x'.repeat(125000) },
      { type: 'function_call_output', call_id: 'tk-2', output: 'TINY_SECOND_OK' },
      user('continue'),
    ],
  }, { responses: true });
  const multiTaskDelivs = collectDeliveries(multiTaskMsgs);
  assert.equal(multiTaskDelivs.length, 2, 'oversized first Task + tiny second Task must both survive without throwing CONTEXT_BUDGET_EXCEEDED');
  assert.ok(multiTaskDelivs[0].includes('OVERSIZED_FIRST_') && multiTaskDelivs[1].includes('TINY_SECOND_OK'));
  const flatMultiTask = flatten(multiTaskMsgs);
  assert.ok(flatMultiTask.includes('OVERSIZED_FIRST_') && flatMultiTask.includes('TINY_SECOND_OK'));

  // Repeated Task + Still-running TaskWait polling (>10 polls over 20m) must NOT count as completed subagent deliveries or overflow budget
  const pollHistory = [
    user('resume firmware probe'),
    { type: 'function_call', call_id: 'tk-launch', name: 'Task', arguments: '{"agent":"nuaa-zxh","task":"unicorn probe"}' },
    { type: 'function_call_output', call_id: 'tk-launch', output: 'Delegation del-1 started: the nuaa-zxh subagent is working in the background (unicorn probe). Continue your own independent work, then call TaskWait with this delegationId to converge, or TaskStop to stop it. Job reference: {"kind":"delegation","id":"del-1"}.' },
    { type: 'function_call', call_id: 'tk-json', name: 'Task', arguments: '{"agent":"local-free","task":"quick check"}' },
    { type: 'function_call_output', call_id: 'tk-json', output: '{"delegationId":"del-2","job":"job-2","agent":"local-free","status":"running","startedAt":"2026-11-26T00:00:00Z"}' },
  ];
  for (let pIdx = 1; pIdx <= 12; pIdx++) {
    pollHistory.push(
      { type: 'function_call', call_id: `tw-poll-${pIdx}`, name: 'TaskWait', arguments: '{"delegationIds":["del-1"],"timeoutSeconds":90}' },
      { type: 'function_call_output', call_id: `tw-poll-${pIdx}`, output: `Still running after ${pIdx * 90}s: 0/1 finished. This is not a failure — unfinished delegates keep working.\nnuaa-zxh (del-1), ${pIdx * 90}s, ${pIdx * 4} tool calls, last tool Bash\n\n## nuaa-zxh (del-1) — running\nnuaa-zxh (del-1), ${pIdx * 90}s, ${pIdx * 4} tool calls, last tool Bash` },
    );
  }
  pollHistory.push(
    { type: 'function_call', call_id: 'tw-done', name: 'TaskWait', arguments: '{"delegationIds":["del-1"],"timeoutSeconds":90}' },
    { type: 'function_call_output', call_id: 'tw-done', output: '## nuaa-zxh (del-1) — completed\nFINAL_FIRMWARE_PROBE_OK' },
  );
  const normalizedPolls = normalizeMessages({ input: pollHistory }, { responses: true });
  const pollDeliveries = collectDeliveries(normalizedPolls);
  assert.equal(pollDeliveries.length, 1, 'launch receipt and 12 Still-running TaskWait polls must be excluded from completed subagent deliveries');
  assert.ok(pollDeliveries[0].includes('FINAL_FIRMWARE_PROBE_OK') && !pollDeliveries[0].includes('0/1 finished'));
  // Post-compaction carry-over must prune 8 stale reports / oversized pre-compaction dumps so rebuilt sessions start lean
  const staleMany = Array.from({ length: 6 }, (_, i) => `Subagent completion:\nSTALE_${i}_${'z'.repeat(11000)}`);
  const staleOversized = `Subagent completion:\nHUGE_DUMP_${'w'.repeat(45000)}`;
  const recentCompactable = `Subagent completion:\nKEEP_LATEST_REVIEW_${'r'.repeat(8000)}`;
  const compacted = collectDeliveries([user(checkpoint('compacted state')), user('next')], [...staleMany, staleOversized, recentCompactable]);
  assert.ok(compacted.some(x => x.includes('KEEP_LATEST_REVIEW_')), 'recent compact report must survive');
  assert.ok(!compacted.some(x => x.includes('HUGE_DUMP_') || x.includes('STALE_0_')), 'oversized/old pre-compaction dumps must not bloat rebuilt session');
  assert.ok(Buffer.byteLength(compacted.join('\n\n'), 'utf8') <= 38000, 'post-compaction pre-carried deliveries must stay within lean byte cap');

  // Multi-byte UTF-8 CJK context must stay within byte budget in flatten()
  const cjkMsgs = [user('原始目标：确保多字节中文上下文不会突破字节预算')];
  for (let i = 0; i < 12; i++) cjkMsgs.push(assistant(`第${i}轮审计输出：` + '中文日志内容审计记录'.repeat(2200)));
  cjkMsgs.push(user('当前指令：' + '汉'.repeat(28000)));
  const flatCjk = flatten(cjkMsgs);
  assert.ok(flatCjk.includes('原始目标：确保多字节中文上下文不会突破字节预算'));
  assert.ok(Buffer.byteLength(flatCjk, 'utf8') <= 384000, 'multi-byte UTF-8 flatten output must respect byte ceilings');
  const clipped85kCjk = flatten([user('首锚_' + '汉'.repeat(140000) + '_尾锚')]);
  assert.ok(clipped85kCjk.includes('首锚_') && clipped85kCjk.includes('_尾锚') && Buffer.byteLength(clipped85kCjk, 'utf8') <= 384000, 'oversized CJK input must clip head+tail within REPLAY_MAX_BYTES without throwing CONTEXT_BUDGET_EXCEEDED');
  // sessionStore.set retains sig/timeline on same SID, but isolates state when switching to a new SID on the same key
  const dir = fs.mkdtempSync(path.join(process.env.PI_SCRATCH_DIR || os.tmpdir(), 'sig-retain-'));
  try {
    const file = path.join(dir, 'sessions.json');
    const store = createSessionStore({ file });
    store.set('k1', { sessionId: 'sid-1', model: 'm1', userTimeline: ['GOAL_1'], compactionSig: 'csig-abc', systemSig: 'ssig-def' });
    store.set('k1', { sessionId: 'sid-1', model: 'm2', compactionSig: '', systemSig: '', userTimeline: [] });
    store.flush();
    const reloaded = createSessionStore({ file });
    reloaded.load();
    const entry = reloaded.get('k1');
    assert.equal(entry.model, 'm2');
    assert.equal(entry.compactionSig, 'csig-abc', 'partial update on same sid must not wipe compactionSig');
    assert.equal(entry.systemSig, 'ssig-def', 'partial update on same sid must not wipe systemSig');
    assert.deepEqual(entry.userTimeline, ['GOAL_1'], 'empty userTimeline on partial update must not wipe persisted timeline');

    reloaded.set('k1', { sessionId: 'sid-2', model: 'm3', userTimeline: [] });
    reloaded.flush();
    const reloaded2 = createSessionStore({ file });
    reloaded2.load();
    const entry2 = reloaded2.get('k1');
    assert.equal(entry2.sessionId, 'sid-2');
    assert.deepEqual(entry2.userTimeline || [], [], 'new sessionId on same key must not inherit stale userTimeline when empty array is passed');
    assert.equal(entry2.compactionSig || '', '', 'new sessionId on same key must not inherit stale compactionSig');
    assert.equal(entry2.systemSig || '', '', 'new sessionId on same key must not inherit stale systemSig');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('v2.4.0 Round 2 P1 context & sessionStore boundaries: CJK UTF-8 caps, completion-order TaskWait deliveries, branch summary separation, invalidated footprints', () => {
  const ctxLib = require('../lib/context.js');
  // 1. Multi-byte CJK summarization (~50K-char CJK Task delivery = 150KB <= 192KB + timeline <= 324KB SUMMARY_BYTES) succeeds, while oversized >192KB delivery or >196K replay throws CONTEXT_BUDGET_EXCEEDED
  const cjkSumInput = normalizeMessages({
    input: [
      user('原始任务目标：验证多字节中文在摘要与交付双预算下不误杀'),
      { type: 'function_call', call_id: 'cjk-sum-tk', name: 'Task', arguments: '{"agent":"reviewer-gpt","task":"cjk"}' },
      { type: 'function_call_output', call_id: 'cjk-sum-tk', output: '果'.repeat(50000) },
      user('Summarize the entire conversation above.'),
    ],
  }, { responses: true });
  const cjkSummaryFlat = flattenSummarization(cjkSumInput);
  assert.ok(cjkSummaryFlat.includes('原始任务目标') && Buffer.byteLength(cjkSummaryFlat, 'utf8') <= 324000, '50K-char CJK delivery (150KB) must fit within 108K char / 324KB SUMMARY_BYTES');
  const clipped165k = flatten([{ role: 'system', content: 'SYS_KEEP_OK' }, user('头_' + '超'.repeat(165000) + '_尾')]);
  assert.ok(clipped165k.includes('SYS_KEEP_OK') && clipped165k.includes('头_') && clipped165k.includes('_尾') && Buffer.byteLength(clipped165k, 'utf8') <= 384000, '165K-char CJK replay must adaptively clip current request while keeping system instructions and head/tail');
  const cjkDeliveryMsgs = normalizeMessages({
    input: [
      user('run CJK subagent'),
      { type: 'function_call', call_id: 'cjk-tk', name: 'pi-bridge_TaskWait', arguments: '{"job":"j1"}' },
      { type: 'function_call_output', call_id: 'cjk-tk', output: '审'.repeat(50000) },
      user('proceed'),
    ],
  }, { responses: true });
  const cjkDeliveries = ctxLib.collectDeliveries(cjkDeliveryMsgs);
  assert.equal(cjkDeliveries.length, 1, 'prefixed pi-bridge_TaskWait 50K-char CJK delivery (150KB) must be captured within 64K/192KB budget');

  // 2. Completion-order sorting & eviction when parallel Task/TaskWait calls complete out of call order
  const outOfOrderMsgs = normalizeMessages({
    input: [
      user('parallel subagents'),
      { type: 'function_call', call_id: 'call-first', name: 'Task', arguments: '{"agent":"a1","task":"slow"}' },
      { type: 'function_call', call_id: 'call-second', name: 'Task', arguments: '{"agent":"a2","task":"fast"}' },
      { type: 'function_call_output', call_id: 'call-second', output: 'COMPLETED_FIRST_FAST' },
      { type: 'function_call_output', call_id: 'call-first', output: 'COMPLETED_SECOND_SLOW' },
      user('merge results'),
    ],
  }, { responses: true });
  const orderedDelivs = ctxLib.collectDeliveries(outOfOrderMsgs);
  assert.equal(orderedDelivs.length, 2);
  assert.ok(
    orderedDelivs[0].includes('COMPLETED_FIRST_FAST') && orderedDelivs[1].includes('COMPLETED_SECOND_SLOW'),
    'deliveries must be ordered by completion position rather than invocation position',
  );

  // 3. Branch summary must remain distinct from compaction summary and never slice shared pre-branch history
  const branchMsg = 'The following is a summary of a branch that this conversation came back from:\n<summary>\nExplored option B\n</summary>';
  assert.equal(ctxLib.isBranchSummary(branchMsg), true);
  assert.equal(ctxLib.isCompactionSummary(branchMsg), false);
  assert.equal(extractLatestCompaction([user('PRE_BRANCH_ROOT_FACT'), assistant('ok'), user(branchMsg), user('continue on main')]), '');
  const branchFlat = flatten([user('PRE_BRANCH_ROOT_FACT'), assistant('ACK_PRE_BRANCH'), user(branchMsg), user('continue on main')]);
  assert.ok(branchFlat.includes('ACK_PRE_BRANCH') && branchFlat.includes('Explored option B'), 'branch summary must not slice pre-branch history');

  // 4. Invalidated session footprint retains recoverable memory across reload and carryRecoverable set(), while remove() wipes on branch reset
  const invDir = fs.mkdtempSync(path.join(process.env.PI_SCRATCH_DIR || os.tmpdir(), 'inv-store-'));
  try {
    const file = path.join(invDir, 'sessions.json');
    const s1 = createSessionStore({ file });
    s1.invalidate('k-inv', {
      sessionId: '__invalidated__',
      model: 'gemini-3-flash',
      explicitHostKey: 'host-explicit-99',
      userTimeline: ['SURVIVING_TIMELINE_GOAL'],
      recentDeliveries: ['Subagent completion:\nSURVIVING_DELIVERY_99'],
    });
    s1.flush();
    const s2 = createSessionStore({ file });
    s2.load();
    const invRec = s2.get('k-inv');
    assert.ok(invRec && invRec.invalidated === true, 'invalidated flag must survive disk reload');
    assert.equal(invRec.explicitHostKey, 'host-explicit-99');
    assert.deepEqual(invRec.userTimeline, ['SURVIVING_TIMELINE_GOAL']);
    assert.deepEqual(invRec.recentDeliveries, ['Subagent completion:\nSURVIVING_DELIVERY_99']);
    s2.set('k-inv', { sessionId: 'fresh-sid-100', model: 'gemini-3-flash' });
    const carried = s2.get('k-inv');
    assert.equal(Boolean(carried.invalidated), false);
    assert.equal(carried.explicitHostKey, 'host-explicit-99', 'carryRecoverable must preserve explicitHostKey across invalidated rebuild');
    assert.deepEqual(carried.userTimeline, ['SURVIVING_TIMELINE_GOAL'], 'carryRecoverable must preserve userTimeline across invalidated rebuild');
    assert.deepEqual(carried.recentDeliveries, ['Subagent completion:\nSURVIVING_DELIVERY_99'], 'carryRecoverable must preserve recentDeliveries across invalidated rebuild');
    s2.remove('k-inv');
    assert.equal(s2.get('k-inv'), null, 'branch reset remove() must completely wipe entry');
  } finally {
    fs.rmSync(invDir, { recursive: true, force: true });
  }
});

test('per-turn compaction round accumulator tracks consecutive compactions, survives mid-turn steer and restart, and resets on a new user turn', async () => {
  const { createGateway } = require('../lib/server.js');
  const net = require('node:net');
  const dir = fs.mkdtempSync(path.join(process.env.PI_SCRATCH_DIR || os.tmpdir(), 'turn-compact-acc-'));
  let serial = 0;
  let bridgeUrl = '';
  let mode = 'park';
  let gateway = null;
  let port = 0;
  const prompts = [];
  const cfg = {
    bind: '127.0.0.1',
    port: 0,
    defaultModel: 'test',
    toolPolicy: 'all',
    bridgeTools: true,
    promptTimeoutMs: 3000,
    promptIdleTimeoutMs: 3000,
    maxSessions: 10,
    source: path.join(dir, 'config.json'),
  };
  const acp = {
    policyBySession: new Map(),
    start: async () => {},
    discover: async () => {},
    cwdFor: async () => dir,
    resolveModel: (x) => x,
    status: () => ({ ready: true }),
    notify: () => {},
    request: async (method, p) => {
      if (method === 'session/load' || method === 'session/resume') {
        throw new Error('force clean replay on reload');
      }
      if (method === 'session/new') {
        bridgeUrl = p.mcpServers && p.mcpServers[0] ? p.mcpServers[0].url : '';
        return { sessionId: `acc-sid-${++serial}` };
      }
      if (method === 'session/prompt') {
        prompts.push(p.prompt.map((item) => item.text || '').join('\n'));
        const emit = (update) => acp.onNotification({ method: 'session/update', params: { sessionId: p.sessionId, update } });
        if (mode === 'park' && bridgeUrl) {
          await fetch(bridgeUrl, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: serial,
              method: 'tools/call',
              params: { name: 'Read', arguments: { path: `src/step-${serial}.js` } },
            }),
          }).then((r) => r.text());
        }
        emit({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'turn-complete-ack' } });
        return { stopReason: 'end_turn' };
      }
      return {};
    },
  };
  const tools = [{ type: 'function', name: 'Read', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }];
  async function start() {
    gateway = createGateway({ acp, limiter: { run: (f) => f(), stats: () => ({}) }, getConfig: () => cfg, log: () => {} });
    const probe = net.createServer();
    await new Promise((r) => probe.listen(0, '127.0.0.1', r));
    port = probe.address().port;
    await new Promise((r) => probe.close(r));
    await gateway.listen([port]);
  }
  async function send(input) {
    const r = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'test', stream: true, prompt_cache_key: 'acc-topic', input, tools }),
    });
    const body = await r.text();
    assert.equal(r.status, 200, body);
    const events = body.split('\n\n').map((b) => /^data: (.+)$/m.exec(b)?.[1]).filter(Boolean).map((d) => JSON.parse(d));
    const completed = events.find((e) => e.type === 'response.completed');
    assert.ok(completed, body);
    const fc = (completed.response.output || []).find((item) => item.type === 'function_call');
    return { callId: fc ? fc.call_id : '', prompt: prompts[prompts.length - 1] || '' };
  }
  try {
    await start();
    const sys = (s) => ({ role: 'system', content: s });
    const goal1 = 'TURN_1_ROOT_GOAL: adapt 1.5.2 without reviewer loop';
    // 1. Start Turn 1 (parks on Read -> turnOpen remains true)
    mode = 'park';
    await send([sys('SYS_V1'), user(goal1)]);

    // 2. Mid-turn Compaction #1 -> round 1 (silent native continuation, zero workflow/tool lecture)
    const c1 = await send([sys('SYS_V1'), user(checkpoint('COMPACT_GEN_1')), user(goal1)]);
    assert.ok(!c1.prompt.includes('上下文检查点提示') && !c1.prompt.includes('压缩态势') && !c1.prompt.includes('TodoWrite') && !c1.prompt.includes('scratch'), 'round 1 compaction must stay 100% silent without coupled tool/workflow hints');
    assert.ok(c1.callId, 'turn 1 remains open on parked tool');

    // 3. Mid-turn user steer + system nudge rebuild (not a new compaction, not a new turn) -> stays round 1 (silent)
    const steer = await send([
      sys('SYS_V1_NUDGE'),
      user(checkpoint('COMPACT_GEN_1')),
      user(goal1),
      { type: 'function_call', call_id: c1.callId, name: 'Read', arguments: '{"path":"src/step.js"}' },
      { type: 'function_call_output', call_id: c1.callId, output: '[tool call was interrupted before a result was recorded]' },
      user('MID_TURN_STEER: 顺便不要调用 reviewer-gpt'),
    ]);
    assert.ok(!steer.prompt.includes('上下文检查点提示') && !steer.prompt.includes('压缩态势'), 'mid-turn steer + system rebuild must preserve round 1 silently without double-counting');

    // 4. Gateway restart + Mid-turn Compaction #2 (keep turn open) -> round 2 (still silent)
    await gateway.close();
    gateway = null;
    await start();
    mode = 'park';
    const c2 = await send([
      sys('SYS_V1_NUDGE'),
      user(checkpoint('COMPACT_GEN_2')),
      user(goal1),
      user('MID_TURN_STEER: 顺便不要调用 reviewer-gpt'),
    ]);
    assert.ok(!c2.prompt.includes('上下文检查点提示') && !c2.prompt.includes('TodoWrite'), 'round 2 compaction after gateway restart must still stay silent');
    assert.ok(c2.callId, 'turn 1 remains open for round 3 check');

    // 5. Mid-turn Compaction #3 in same open turn -> round 3 emits neutral tool-agnostic checkpoint note, then completes cleanly
    mode = 'finish';
    const c3 = await send([
      sys('SYS_V1_NUDGE'),
      user(checkpoint('COMPACT_GEN_2B')),
      user(goal1),
      user('MID_TURN_STEER: 顺便不要调用 reviewer-gpt'),
    ]);
    assert.ok(c3.prompt.includes('同一用户请求轮次内已连续触发第 3 次上下文压缩'), '3rd consecutive compaction in same turn must emit neutral loop safeguard');
    assert.ok(!c3.prompt.includes('TodoWrite') && !c3.prompt.includes('scratch') && !c3.prompt.includes('子智能体'), 'safeguard note must remain completely decoupled from specific tools or AGENTS.md');
    assert.equal(c3.callId, '', 'turn 1 completed cleanly with final assistant message');

    // 6. Fresh Turn 2 after Turn 1 completed (force replay via SYS_V2, historical COMPACT_GEN_2B unchanged) -> round 0 (silent)
    const goal2 = 'TURN_2_FRESH_GOAL: 整理一键最小补丁包';
    const t2Start = await send([
      sys('SYS_V2'),
      user(checkpoint('COMPACT_GEN_2B')),
      user(goal1),
      user('MID_TURN_STEER: 顺便不要调用 reviewer-gpt'),
      assistant('turn-complete-ack'),
      user(goal2),
    ]);
    assert.ok(t2Start.prompt.includes('COMPACT_GEN_2B'), 'historical summary stays intact on Turn 2');
    assert.ok(!t2Start.prompt.includes('上下文检查点提示'), 'fresh Turn 2 before any new compaction must reset counter to 0');

    // 7. Compaction #1 inside Turn 2 -> starts fresh at round 1 (silent, NOT round 4)
    const t2Compact = await send([
      sys('SYS_V2'),
      user(checkpoint('COMPACT_GEN_3')),
      user(goal2),
    ]);
    assert.ok(!t2Compact.prompt.includes('上下文检查点提示'), 'first compaction inside Turn 2 must reset to round 1 (silent) rather than carrying over round 3+');
  } finally {
    if (gateway) await gateway.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('v2.4.1 flattenSummarization survives >8 subagent callbacks, 130K single report, YAML colons, and tight recent budget without throwing CONTEXT_BUDGET_EXCEEDED', () => {
  const manyReports = Array.from({ length: 11 }, (_, i) =>
    `[User]: ${callback(`SUBAGENT_BATCH_${i}_HEAD\n${'finding line '.repeat(900)}\nSUBAGENT_BATCH_${i}_TAIL`)}`
  ).join('\n');
  const hugeSingle = `[User]: ${callback(`HUGE_SUBAGENT_HEAD_${'Z'.repeat(130000)}_HUGE_SUBAGENT_TAIL`)}`;
  const yamlCodeBlock = `[Assistant thinking]: checking config\n[Assistant]: \`\`\`yaml\nuser: admin\nsystem: windows\ntool: powershell\n\`\`\`\nYAML_ANCHOR_SURVIVES`;
  const packed = `<conversation>\n[User]: ORIGINAL_COMPACTION_GOAL_106\n${manyReports}\n${hugeSingle}\n${yamlCodeBlock}\n[Tool result]: ${'T'.repeat(80000)}\n</conversation>\n\n<previous-summary>\n## Goal\nKeep shipping v2.4.1 cleanly.\n${'prior detail '.repeat(1400)}\n</previous-summary>\n\nUpdate the summary based on the new messages.`;
  const flat = flattenSummarization([
    { role: 'system', content: 'You are a context summarization assistant. ONLY output the structured summary.' },
    user(packed),
  ]);
  assert.ok(flat.includes('Pure Summarization Mode'), 'anti-tool summarization guardrail must be injected');
  assert.ok(flat.includes('ORIGINAL_COMPACTION_GOAL_106'), 'original user goal must survive');
  assert.ok(flat.includes('YAML_ANCHOR_SURVIVES'), 'bracketed transcript unpacking must not mis-split YAML user:/system: lines');
  assert.ok(flat.includes('HUGE_SUBAGENT_HEAD_') && flat.includes('HUGE_SUBAGENT_TAIL'), '130K report head and tail must survive via non-throwing clip');
  assert.ok(flat.length <= 108000 && Buffer.byteLength(flat, 'utf8') <= 324000, 'must strictly fit SUMMARY_CHARS and SUMMARY_BYTES');
});

test('v2.4.1 compactionModel/compactionEffort config validation, routing, fallback, ephemeral salvage, limiter bypass, and post-compaction calibration isolation', async () => {
  const configLib = require('../lib/config.js');
  const { createGateway } = require('../lib/server.js');
  const { createLimiter } = require('../lib/core.js');
  const net = require('node:net');
  const dir = fs.mkdtempSync(path.join(process.env.PI_SCRATCH_DIR || os.tmpdir(), 'v241-compaction-'));
  try {
    // 1. Config normalization, validation, and panel persistence
    const ctx = { packageRoot: dir, dataPath: dir };
    const defNorm = configLib.normalize({}, ctx);
    assert.equal(defNorm.compactionModel, '');
    assert.equal(defNorm.compactionEffort, '');
    for (const eff of ['', 'omit', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']) {
      assert.deepEqual(configLib.validatePatch({ compactionModel: 'antigravity-acp/gemini-3.8-flash', compactionEffort: eff }, ctx).errors, []);
    }
    assert.ok(configLib.validatePatch({ compactionEffort: 'ultra' }, ctx).errors.length > 0);
    assert.ok(configLib.validatePatch({ compactionModel: 'bad model spaces!' }, ctx).errors.length > 0);
    const saved = configLib.savePanel(ctx, { compactionModel: 'antigravity-acp/gemini-3.8-flash', compactionEffort: 'omit' });
    assert.equal(saved.ok, true);
    const reloadedCfg = configLib.normalize(configLib.readRaw(saved.file), ctx);
    assert.equal(reloadedCfg.compactionModel, 'gemini-3.8-flash', 'provider prefix must be normalized cleanly');
    assert.equal(reloadedCfg.compactionEffort, 'omit');
    const panelView = configLib.readPanel(ctx, reloadedCfg);
    assert.equal(panelView.compactionModel, 'gemini-3.8-flash');
    assert.equal(panelView.compactionEffort, 'omit');

    // 2. Gateway routing, stale model fallback, ephemeral salvage, limiter bypass & calibration isolation
    let sidSeq = 0;
    const closedSids = [];
    const resolvedCalls = [];
    const promptCalls = [];
    let summarizeFailMode = '';
    let summarizeFailCount = 0;
    const liveCfg = {
      bind: '127.0.0.1',
      port: 0,
      defaultModel: 'gemini-4-neon',
      defaultEffort: 'high',
      compactionModel: '',
      compactionEffort: '',
      toolPolicy: 'all',
      bridgeTools: false,
      concurrency: 1,
      queueTimeoutMs: 600,
      contentFilterMaxRetries: 0,
      promptTimeoutMs: 5000,
      promptIdleTimeoutMs: 5000,
      maxSessions: 12,
      source: path.join(dir, 'config.json'),
    };
    const limiter = createLimiter({ getLimit: () => liveCfg.concurrency, getTimeoutMs: () => liveCfg.queueTimeoutMs, getMaxQueue: () => 8 });
    const acp = {
      agentCapabilities: { _meta: { antigravity: { version: '1.5.2' } } },
      policyBySession: new Map(),
      start: async () => {},
      discover: async () => {},
      cwdFor: async () => dir,
      status: () => ({ ready: true }),
      notify: () => {},
      resolveModel: async (m, eff) => {
        resolvedCalls.push({ model: m, effort: eff });
        if (m === 'stale-retired-model') {
          throw Object.assign(new Error('model retired'), { code: 'MODEL_UNAVAILABLE' });
        }
        return `${m}::${eff === undefined ? 'NONE' : eff}`;
      },
      request: async (method, params) => {
        if (method === 'session/new') {
          const sessionId = `s241-${++sidSeq}`;
          return { sessionId, models: { currentModelId: 'default-init', availableModels: [] } };
        }
        if (method === 'session/set_model') {
          return {};
        }
        if (method === 'session/close') {
          closedSids.push(params.sessionId);
          return {};
        }
        if (method === 'session/prompt') {
          const text = params.prompt.map(p => p.text || '').join('\n');
          promptCalls.push({ sessionId: params.sessionId, text });
          if (summarizeFailMode && summarizeFailCount > 0 && (text.includes('Pure Summarization Mode') || text.includes('上一轮未输出摘要正文'))) {
            summarizeFailCount -= 1;
            if (summarizeFailMode === 'filter') {
              throw new Error('Request rejected: Content blocked by safety filters');
            }
            if (summarizeFailMode === 'empty') {
              return { stopReason: 'end_turn' };
            }
            if (summarizeFailMode === 'lost') {
              acp.onNotification({
                method: 'session/update',
                params: {
                  sessionId: params.sessionId,
                  update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Agent connection was lost and could not be re-established: upstream reset' } },
                },
              });
              return { stopReason: 'end_turn' };
            }
          }
          acp.onNotification({
            method: 'session/update',
            params: { sessionId: params.sessionId, update: { sessionUpdate: 'usage_update', used: 42050, size: 256000 } },
          });
          acp.onNotification({
            method: 'session/update',
            params: { sessionId: params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '## Goal\nSummary OK' } } },
          });
          return {
            stopReason: 'end_turn',
            usage: { inputTokens: 12000, cachedReadTokens: 30000, outputTokens: 50, thoughtTokens: 10, totalTokens: 42050 },
          };
        }
        return {};
      },
    };
    const gw = createGateway({ acp, limiter, getConfig: () => liveCfg, log: () => {} });
    const probe = net.createServer();
    await new Promise(r => probe.listen(0, '127.0.0.1', r));
    const port = probe.address().port;
    await new Promise(r => probe.close(r));
    await gw.listen([port]);

    const postResp = async (body) => {
      const r = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const txt = await r.text();
      assert.equal(r.status, 200, txt);
      if (body.stream) {
        const events = txt.split('\n\n').map(b => /^data: (.+)$/m.exec(b)?.[1]).filter(Boolean).map(d => JSON.parse(d));
        const done = events.find(e => e.type === 'response.completed');
        assert.ok(done, txt);
        return done.response;
      }
      return JSON.parse(txt);
    };

    try {
      // 2a. Default ("", ""): summarization inherits session model & reasoning.effort; bypasses occupied limiter; usage_status stays 'unavailable'
      let releaseBlocker;
      const blockerRunning = new Promise(resolve => {
        limiter.run(() => new Promise(r => { releaseBlocker = r; resolve(); }));
      });
      await blockerRunning;
      resolvedCalls.length = 0;
      const sumInherit = await postResp({
        model: 'gemini-4-neon',
        stream: true,
        reasoning: { effort: 'xhigh' },
        instructions: 'You are a context summarization assistant.',
        input: [user('<conversation>\n[User]: build feature\n[Assistant]: done\n</conversation>\nSummarize the conversation.')],
      });
      releaseBlocker();
      assert.equal(sumInherit.model, 'gemini-4-neon');
      assert.deepEqual(resolvedCalls[0], { model: 'gemini-4-neon', effort: 'xhigh' }, 'default empty config must inherit session model and effort');
      assert.equal(sumInherit.usage.usage_status, 'unavailable', 'summarization side-channel must not emit measured calibration tokens');

      // 2b. Custom compactionModel + compactionEffort ('low', 'omit', 'off') & stale model fallback
      liveCfg.compactionModel = 'gemini-3.8-flash';
      liveCfg.compactionEffort = 'low';
      resolvedCalls.length = 0;
      const sumCustom = await postResp({
        model: 'claude-opus-4-6-thinking',
        stream: false,
        reasoning: { effort: 'xhigh' },
        instructions: 'You are a context summarization assistant.',
        input: [user('Summarize the entire conversation.')],
      });
      assert.equal(sumCustom.model, 'claude-opus-4-6-thinking', 'response envelope keeps requested model id');
      assert.deepEqual(resolvedCalls[0], { model: 'gemini-3.8-flash', effort: 'low' });

      liveCfg.compactionEffort = 'omit';
      resolvedCalls.length = 0;
      await postResp({
        model: 'claude-opus-4-6-thinking',
        stream: false,
        reasoning: { effort: 'xhigh' },
        instructions: 'You are a context summarization assistant.',
        input: [user('Summarize the entire conversation.')],
      });
      assert.deepEqual(resolvedCalls[0], { model: 'gemini-3.8-flash', effort: undefined }, 'omit must strip effort');

      liveCfg.compactionEffort = 'off';
      resolvedCalls.length = 0;
      await postResp({
        model: 'claude-opus-4-6-thinking',
        stream: false,
        instructions: 'You are a context summarization assistant.',
        input: [user('Summarize the entire conversation.')],
      });
      assert.deepEqual(resolvedCalls[0], { model: 'gemini-3.8-flash', effort: 'minimal' }, 'off maps to minimal tier');

      liveCfg.compactionModel = 'stale-retired-model';
      liveCfg.compactionEffort = 'low';
      resolvedCalls.length = 0;
      const sumFallback = await postResp({
        model: 'gemini-4-neon',
        stream: false,
        reasoning: { effort: 'medium' },
        instructions: 'You are a context summarization assistant.',
        input: [user('Summarize the entire conversation.')],
      });
      assert.equal(sumFallback.status, 'completed');
      assert.deepEqual(resolvedCalls, [
        { model: 'stale-retired-model', effort: 'low' },
        { model: 'gemini-4-neon', effort: 'medium' },
      ], 'unavailable compactionModel must fall back cleanly to session model');
      liveCfg.compactionModel = '';
      liveCfg.compactionEffort = '';

      // 2c. Summarization ephemeral fresh-session salvage on safety filter false positive, EMPTY_RESPONSE (after nudges), and ACP_CONNECTION_LOST
      for (const [mode, failTimes] of [['filter', 1], ['empty', 3], ['lost', 1]]) {
        const createdBefore = sidSeq;
        const closedBefore = closedSids.length;
        summarizeFailMode = mode;
        summarizeFailCount = failTimes;
        const salvaged = await postResp({
          model: 'gemini-3.8-flash',
          stream: true,
          instructions: 'You are a context summarization assistant.',
          input: [user('<conversation>\n[User]: debug taskkill /F /PID 1234 crash\n</conversation>\nSummarize the conversation.')],
        });
        summarizeFailMode = '';
        assert.equal(salvaged.status, 'completed', `summarize salvage must succeed for mode=${mode}`);
        assert.ok(salvaged.output[0].content[0].text.includes('Summary OK'));
        assert.equal(sidSeq - createdBefore, 2, `salvage must rotate to a single fresh ephemeral session for mode=${mode}`);
        const uniqueClosed = new Set(closedSids.slice(closedBefore));
        assert.ok(uniqueClosed.has(`s241-${createdBefore + 1}`) && uniqueClosed.has(`s241-${createdBefore + 2}`), `both failed and salvaged ephemeral sessions must be closed for mode=${mode}`);
      }

      // 2d. Post-compaction carryover calibration isolation (Turn 1 normal = measured; post-compaction Turn 2 fresh & Turn 3 resumed = unavailable)
      const t1 = await postResp({
        model: 'gemini-4-neon',
        stream: false,
        prompt_cache_key: 'cal-iso',
        input: [user('PRE_COMPACT_ROOT_GOAL'), assistant('delegated'), user(callback('SUBAGENT_CARRYOVER_REPORT'))],
      });
      assert.equal(t1.usage.usage_status, 'measured', 'normal uncompacted turn still reports measured usage');
      assert.equal(t1.usage.input_tokens, 42000);

      const t2PostCompact = await postResp({
        model: 'gemini-4-neon',
        stream: false,
        prompt_cache_key: 'cal-iso',
        input: [user(checkpoint('COMPACTED_CHECKPOINT_V1')), user('post-compact turn 1')],
      });
      assert.equal(t2PostCompact.usage.usage_status, 'unavailable', 'post-compaction turn with injected carryover must not skew host calibration');
      assert.equal(t2PostCompact.usage.input_tokens, undefined);
      assert.equal(t2PostCompact.usage.acp_context.used, 42050, 'live ACP context observation remains intact');

      const t3PostCompactResumed = await postResp({
        model: 'gemini-4-neon',
        stream: false,
        prompt_cache_key: 'cal-iso',
        input: [
          user(checkpoint('COMPACTED_CHECKPOINT_V1')),
          user('post-compact turn 1'),
          assistant('## Goal\nSummary OK'),
          user('post-compact turn 2 resumed'),
        ],
      });
      assert.equal(t3PostCompactResumed.usage.usage_status, 'unavailable', 'subsequent resumed turns on carryover-injected session must also isolate calibration');
      assert.equal(t3PostCompactResumed.usage.input_tokens, undefined);
      assert.equal(t3PostCompactResumed.usage.acp_context.used, 42050);
    } finally {
      await gw.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

(async () => {
  let passed = 0;
  for (const { name, fn } of tests) {
    try { await fn(); console.log(`PASS ${name}`); passed++; }
    catch (error) { console.error(`FAIL ${name}\n${error.stack}`); }
  }
  console.log(`${passed}/${tests.length} context regressions passed`);
  if (passed !== tests.length) process.exitCode = 1;
})();
