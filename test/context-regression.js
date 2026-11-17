'use strict';
// Context fidelity regressions. Synthetic fixtures only; no account or host mutation.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { normalizeMessages, flatten, flattenSummarization } = require('../lib/server.js');
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
  assert.throws(() => boundDeliveries(['x'.repeat(120000)]), { code: 'CONTEXT_BUDGET_EXCEEDED' });
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
    assert.ok(first.usage.output_tokens>0,'tool-only park must report output');
    assert.ok(first.usage.output_tokens_details.reasoning_tokens>0,'received thought chunks must be estimated');
    assert.equal(first.usage.output_estimated,true);
    const call=first.output.find(x=>x.type==='function_call');assert.ok(call);
    const final=await send([user('read a fixture'),call,{type:'function_call_output',call_id:call.call_id,output:'fixture content'}]);
    assert.equal(first.usage.output_tokens+final.usage.output_tokens,1000,'final usage is cumulative, not another 1000 tokens');
    assert.ok(final.usage.input_tokens<100000,'authoritative runtime shrink must not be frozen by a monotonic clamp');
    assert.ok(logs.some(s=>s.includes('官方上下文水位回落')));
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
  assert.throws(() => recentContext(messages.slice(2, 4), 1, 1), { code: 'CONTEXT_BUDGET_EXCEEDED' });
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
        assert.equal(body.usage.output_estimated, true);
        const call = body.output.find(item => item.type === 'function_call');
        if (leg < 3) {
          assert.ok(call); input.push(...body.output, { type: 'function_call_output', call_id: call.call_id, output: 'fixture content' });
        } else assert.equal(call, undefined);
      }
    });
    const total = usages.reduce((sum, usage) => ({ output: sum.output + usage.output_tokens, reasoning: sum.reasoning + (usage.output_tokens_details?.reasoning_tokens || 0) }), { output: 0, reasoning: 0 });
    assert.deepEqual(total, { output: 240 + 3 * countTokens(JSON.stringify(args)), reasoning: 80 });
    totals.push(total);
  }
  assert.deepEqual(totals[0], totals[1]);
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
