'use strict';
// Behavioral HTTP tests, no official runtime or network account required.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createGateway } = require(process.env.AGY_SERVER || '../lib/server.js');
async function main() {
  const calls = []; let lastMcpServers = null; let serial = 0; let plan = []; const logs = [];
  const acp = {
    policyBySession: new Map(), start: async () => {}, discover: async () => {},
    cwdFor: async () => process.env.PI_SCRATCH_DIR || process.cwd(), resolveModel: x => x,
    status: () => ({ ready: true }), notify: (...args) => calls.push(args),
    request: async (method, params) => {
      calls.push([method, params]);
      if (method === 'session/new') { lastMcpServers = params.mcpServers; return { sessionId: 's' + ++serial }; }
      if (method === 'session/prompt') {
        const current = plan.shift(); assert.ok(current, 'unexpected automatic prompt');
        for (const update of current.updates) acp.onNotification({ method: 'session/update', params: { sessionId: params.sessionId, update } });
        if (current.before) await current.before(params);
        return current.result || {};
      }
      return {};
    },
  };
  const config = { bind:'127.0.0.1', port:0, defaultModel:'test', toolPolicy:'all', maxSessions:20, promptTimeoutMs:2000, promptIdleTimeoutMs:2000, bridgeTools:true,
    source:path.join(process.env.PI_SCRATCH_DIR || process.cwd(),'gateway-regression-data','config.json') };
  const gateway = createGateway({ acp, limiter: { run: f => f(), stats: () => ({}) }, getConfig: () => config, log:x=>logs.push(x) });
  // Find a free port without relying on gateway's port=0 reporting.
  const net = require('node:net');
  const probe = net.createServer(); await new Promise(r=>probe.listen(0,'127.0.0.1',r));
  const port = probe.address().port; await new Promise(r=>probe.close(r));
  const text = value => ({sessionUpdate:'agent_message_chunk',content:{type:'text',text:value}});
  const tool = {sessionUpdate:'tool_call', toolCallId:'t1', kind:'read', title:'read fixture'};
  const usage = {sessionUpdate:'usage_update',used:12345,size:1048576};
  let passed = 0;
  async function check(name, fn) { await fn(); console.log('PASS '+name); passed++; }
  async function request(key, stream=false) {
    const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:'test',input:'read fixture',prompt_cache_key:key,stream})});
    if (!stream) return {status:response.status, body:await response.json()};
    const raw = await response.text(); return raw.split('\n').filter(x=>x.startsWith('data: ')).map(x=>JSON.parse(x.slice(6)));
  }
  try {
    await check('listen and health',async()=>{assert.equal(await gateway.listen([port]),port);const h=await (await fetch(`http://127.0.0.1:${port}/health`)).json(); assert.equal(h.port,port);assert.equal(gateway.status().port,port);});
    await check('text plus tool does not replay or replace session',async()=>{plan.push({updates:[tool,text('final answer'),usage]});const r=await request('a');assert.equal(r.status,200);assert.equal(r.body.output[0].content[0].text,'final answer');assert.equal(serial,1);assert.equal(calls.filter(c=>c[0]==='session/prompt').length,1);assert.ok(logs.some(x=>x.includes('正文 12 字')));assert.equal(r.body.usage.input_tokens,12345);assert.equal(r.body.usage.estimated,true);});
    await check('same conversation retains context',async()=>{plan.push({updates:[text('next')]});const r=await request('a');assert.equal(serial,1);assert.equal(r.body.usage.input_tokens,12345);});
    await check('different conversation cannot inherit usage',async()=>{plan.push({updates:[text('other')]});const r=await request('b');assert.equal(serial,2);assert.notEqual(r.body.usage.input_tokens,12345);});
    await check('empty tool turn is nudged in the same session, then reported empty',async()=>{plan.push({updates:[tool]},{updates:[tool]},{updates:[tool]});const before=calls.length;const r=await request('a');const prompts=calls.slice(before).filter(c=>c[0]==='session/prompt');assert.equal(r.status,502);assert.equal(r.body.error.code,'EMPTY_RESPONSE');assert.equal(prompts.length,3,'one turn plus two same-session nudges');assert.equal(calls.slice(before).filter(c=>c[0]==='session/new').length,0,'must not switch session');assert.equal(calls.slice(before).filter(c=>c[0]==='session/close').length,0,'must not close the session');assert.ok(prompts.slice(1).every(p=>JSON.stringify(p[1].prompt).includes('没有输出正文')),'nudge text sent in same session');});
    await check('nudge recovers a final answer without replaying tools',async()=>{plan.push({updates:[tool]},{updates:[text('recovered answer'),usage]});const before=calls.length;const r=await request('a');assert.equal(r.status,200);assert.equal(r.body.output[0].content[0].text,'recovered answer');assert.equal(calls.slice(before).filter(c=>c[0]==='session/prompt').length,2);assert.equal(calls.slice(before).filter(c=>c[0]==='session/new').length,0);});
    await check('stream delta and final reasoning agree; output indexes agree',async()=>{plan.push({updates:[text('before'),tool,text('after'),usage]});const events=await request('a',true);const final=events.find(e=>e.type==='response.completed').response;const reasoning=events.filter(e=>e.type==='response.reasoning_summary_text.delta').map(e=>e.delta).join('');assert.equal(final.output[1].summary[0].text,reasoning);for(const e of events.filter(e=>e.type==='response.output_item.added'))assert.equal(final.output[e.output_index].id,e.item.id);assert.equal(final.output[0].content[0].text,'before\n\nafter');});
    await check('tool progress reports each call once and stays short',async()=>{
      const long='[Codex] • 运行命令: utf8 = [System.Text.Encoding]::UTF8; Console::OutputEncoding = $utf8; Get-ChildItem -Recurse';
      plan.push({updates:[
        {sessionUpdate:'tool_call',toolCallId:'c1',kind:'execute',title:long,status:'pending'},
        {sessionUpdate:'tool_call_update',toolCallId:'c1',kind:'execute',title:long+' more',status:'completed'},
        {sessionUpdate:'tool_call',toolCallId:'c2',kind:'read',title:'view_file step-01.txt',status:'pending'},
        {sessionUpdate:'tool_call_update',toolCallId:'c2',kind:'read',status:'failed'},
        text('done')]});
      const events=await request('a',true);
      const lines=events.filter(e=>e.type==='response.reasoning_summary_text.delta').map(e=>e.delta).join('');
      assert.ok(!lines.includes('[Codex]'),`prefix stripped: ${JSON.stringify(lines)}`);
      const rows=lines.split('\n').filter(Boolean);
      assert.equal(rows.length,3,'one line per call plus one failure line');
      assert.ok(rows[0].startsWith('· 运行命令：utf8 = [System.Text.Encoding]::UTF8'),rows[0]);
      assert.ok(rows[0].endsWith('…'),'long command truncated');
      assert.equal(rows[1],'· 读文件：view_file step-01.txt');
      assert.equal(rows[2],'✖ 失败：读文件');
    });
    await check('repeated identical actions collapse into one line plus a count',async()=>{
      const same={sessionUpdate:'tool_call',toolCallId:'r1',kind:'execute',title:'运行命令: Get-Content a.txt'};
      plan.push({updates:[same,{...same,toolCallId:'r2'},{...same,toolCallId:'r3'},{...same,toolCallId:'r4'},
        {sessionUpdate:'tool_call',toolCallId:'r5',kind:'read',title:'view_file b.txt'},text('ok')]});
      const events=await request('a',true);
      const lines=events.filter(e=>e.type==='response.reasoning_summary_text.delta').map(e=>e.delta).join('');
      assert.equal(lines,'· 运行命令：Get-Content a.txt\n  ↳ 上一步重复 3 次\n· 读文件：view_file b.txt\n');
    });



    await check('Chat streaming publishes usage before finish',async()=>{
      plan.push({updates:[usage,text('live')]});
      const r=await fetch(`http://127.0.0.1:${port}/v1/chat/completions`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:'test',messages:[{role:'user',content:'test'}],stream:true})});
      const chunks=(await r.text()).split('\n').filter(x=>x.startsWith('data: {')).map(x=>JSON.parse(x.slice(6)));
      assert.ok(chunks.some(x=>x.usage?.prompt_tokens===12345 && x.choices[0].finish_reason===null));
    });
    await check('disconnected queued request neither executes nor cancels active turn',async()=>{
      let release; let began; const started=new Promise(r=>began=r); const gate=new Promise(r=>release=r);
      plan.push({updates:[text('owned answer')],before:async()=>{began();await gate;}});
      const active=request('a',true); await started;
      const abort=new AbortController(); const before=calls.filter(c=>c[0]==='session/prompt').length;
      const queued=await fetch(`http://127.0.0.1:${port}/v1/responses`,{method:'POST',signal:abort.signal,headers:{'content-type':'application/json'},body:JSON.stringify({model:'test',input:'queued',prompt_cache_key:'a',stream:true})});
      const reading=queued.text().catch(()=>{}); await new Promise(r=>setTimeout(r,40)); abort.abort(); await reading;
      await new Promise(r=>setTimeout(r,40));
      assert.equal(calls.filter(c=>c[0]==='session/cancel').length,0);
      release(); await active; await new Promise(r=>setTimeout(r,40));
      assert.equal(calls.filter(c=>c[0]==='session/prompt').length,before);
    });
    await check('background subagent is not cancelled by the idle watchdog',async()=>{
      plan.push({updates:[{sessionUpdate:'tool_call',toolCallId:'bg1',kind:'other',title:'invoke_subagent research'}],
        before:async()=>{ await new Promise(r=>setTimeout(r,2600)); },
        result:{stopReason:'end_turn'}});
      plan.push({updates:[text('subagent done')]});
      const before=calls.length;
      const events=await request('a',true);
      assert.equal(calls.slice(before).filter(c=>c[0]==='session/cancel').length,0,'must not cancel while a subagent runs');
      const notes=events.filter(e=>e.type==='response.reasoning_summary_text.delta').map(e=>e.delta).join('');
      assert.ok(notes.includes('后台子任务仍在运行'),'emits background heartbeat: '+notes);
      const final=events.find(e=>e.type==='response.completed').response;
      assert.ok(final.output[0].content[0].text.includes('subagent done'));
    });

    await check('bridged: runtime tool call becomes tool_calls, result feeds back, stream continues', async () => {
      const seen = {};
      plan.push({
        updates: [],
        before: async (params) => {
            const url = lastMcpServers?.[0]?.url;
            assert.ok(url, 'session/new 必须带上回环 MCP 地址');
            const r = await fetch(url, {
              method: 'POST', headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ jsonrpc: '2.0', id: 77, method: 'tools/call', params: { name: 'Bash', arguments: { command: 'echo hi' } } }),
            });
            seen.status = r.status;
            seen.body = await r.text();
            // 运行时拿到工具结果后，在同一轮里继续输出
            acp.onNotification({ method: 'session/update', params: { sessionId: params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'tool said hi' } } } });
        },
        result: { stopReason: 'end_turn' },
      });
      const first = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'test', stream: true,
          messages: [{ role: 'user', content: 'run echo' }],
          tools: [{ type: 'function', function: { name: 'Bash', parameters: { type: 'object', properties: { command: { type: 'string' } } } } }],
          prompt_cache_key: 'bridge-key',
        }),
      });
      const firstRaw = await first.text();
      const events = firstRaw.split('\n').filter((x) => x.startsWith('data: {')).map((x) => JSON.parse(x.slice(6)));
      const call = events.flatMap((e) => e.choices?.[0]?.delta?.tool_calls || [])[0];
      assert.ok(call, '必须发出 tool_calls: ' + firstRaw.slice(0, 200));
      assert.equal(call.function.name, 'Bash');
      assert.deepStrictEqual(JSON.parse(call.function.arguments), { command: 'echo hi' });
      assert.equal(events.find((e) => e.choices?.[0]?.finish_reason === 'tool_calls') !== undefined, true, 'finish_reason 应为 tool_calls');

      const second = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'test', stream: true,
          messages: [
            { role: 'user', content: 'run echo' },
            { role: 'assistant', content: '', tool_calls: [{ id: call.id, type: 'function', function: call.function }] },
            { role: 'tool', tool_call_id: call.id, content: 'echo hi output' },
          ],
          tools: [{ type: 'function', function: { name: 'Bash', parameters: { type: 'object', properties: { command: { type: 'string' } } } } }],
          prompt_cache_key: 'bridge-key',
        }),
      });
      const secondText = (await second.text()).split('\n').filter((x) => x.startsWith('data: {')).map((x) => JSON.parse(x.slice(6)))
        .map((e) => e.choices?.[0]?.delta?.content || '').join('');
      assert.ok(secondText.includes('tool said hi'), '回填后应继续输出: ' + secondText);
      assert.equal(seen.status, 200);
      assert.ok(seen.body.includes('echo hi output'), 'MCP 调用应拿到 PI 的执行结果');
    });

    await check('cancelled stream preserves partial answer as incomplete',async()=>{plan.push({updates:[text('partial')],result:{stopReason:'cancelled'}});const events=await request('a',true);assert.ok(events.some(e=>e.type==='response.incomplete'));assert.ok(!events.some(e=>e.type==='response.completed'));});
    console.log(`${passed}/${passed} behavioral tests passed`);
  } finally { gateway.close(); }
}
main().catch(e=>{console.error(e);process.exitCode=1;});
