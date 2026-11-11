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
  // 每轮测试从干净的会话足迹开始：否则上一轮留下的 sessions.json 会让首个请求走 session/load。
  try { fs.rmSync(path.join(path.dirname(config.source), 'sessions.json'), { force: true }); } catch { /* ignore */ }
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

    await check('session created without the bridge is remounted, not rebuilt, when bridging turns on', async () => {
      plan.push({ updates: [text('plain')], result: { stopReason: 'end_turn' } });
      const plain = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'test', stream: true, messages: [{ role: 'user', content: 'no tools here' }], prompt_cache_key: 'no-bridge-key' }),
      });
      await plain.text();
      const before = serial;
      const mark = calls.length;
      plan.push({ updates: [text('with bridge')], result: { stopReason: 'end_turn' } });
      const bridged = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'test', stream: true,
          messages: [{ role: 'user', content: 'now with tools' }],
          tools: [{ type: 'function', function: { name: 'Bash', parameters: { type: 'object', properties: {} } } }],
          prompt_cache_key: 'no-bridge-key',
        }),
      });
      await bridged.text();
      const during = calls.slice(mark);
      // 关 worker 是对的（旧会话没挂 MCP），但必须用 session/load 重新挂载把历史接回来：
      // 重建 = 整段历史重放一遍，服务端前缀缓存全灭。
      assert.ok(during.filter((c) => c[0] === 'session/close').length >= 1, '旧 worker 应先关掉');
      const remount = during.filter((c) => c[0] === 'session/load');
      assert.equal(remount.length, 1, '应通过 session/load 重新挂载工具桥');
      const remountUrl = String((remount[0][1].mcpServers || [{}])[0].url || '');
      assert.ok(/^http:\/\/127\.0\.0\.1:\d+/.test(remountUrl), '重新挂载必须带上桥接地址: ' + remountUrl);
      assert.equal(during.filter((c) => c[0] === 'session/new').length, 0, '不得新建会话（会重放历史）');
      assert.equal(serial, before, '不得新建会话（sessionId 不应变化）');
    });

    await check('cancelled stream preserves partial answer as incomplete',async()=>{plan.push({updates:[text('partial')],result:{stopReason:'cancelled'}});const events=await request('a',true);assert.ok(events.some(e=>e.type==='response.incomplete'));assert.ok(!events.some(e=>e.type==='response.completed'));});

    // 重启还原：网关自己把「键 → sessionId」落盘，重启后先试 session/load；
    // 成功则只发本轮增量，绝不重放历史（重放会让运行时再吃一遍上下文）。
    await check('restart restores the same session through session/load', async () => {
      const dataDir = path.dirname(config.source);
      try { fs.rmSync(path.join(dataDir, 'sessions.json'), { force: true }); } catch { /* ignore */ }

      plan.push({ updates: [text('before restart')], result: { stopReason: 'end_turn' } });
      const first = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'test', stream: true, prompt_cache_key: 'restart-key', messages: [{ role: 'user', content: 'before restart' }] }),
      });
      await first.text();
      assert.equal(calls.filter((c) => c[0] === 'session/new').length > 0, true);

      // 关掉第一个实例：close() 会把足迹立刻落盘，等价于真实重启。
      gateway.close();
      await new Promise((r) => setTimeout(r, 50));
      assert.ok(fs.existsSync(path.join(dataDir, 'sessions.json')), '重启前必须留下会话足迹');

      const calls2 = [];
      let serial2 = 0;
      const plan2 = [];
      const acp2 = {
        policyBySession: new Map(),
        start: async () => {},
        discover: async () => {},
        resolveModel: (m) => m,
        cwdFor: async () => process.env.PI_SCRATCH_DIR || process.cwd(),
        status: () => ({ ready: true }),
        notify: () => {},
        request: async (method, params) => {
          calls2.push([method, params]);
          if (method === 'session/new') return { sessionId: `n${++serial2}` };
          if (method === 'session/prompt') {
            const current = plan2.shift();
            for (const update of (current && current.updates) || []) {
              acp2.onNotification({ method: 'session/update', params: { sessionId: params.sessionId, update } });
            }
            return { stopReason: 'end_turn' };
          }
          return {};
        },
      };
      const gateway2 = createGateway({ acp: acp2, limiter: { run: (f) => f(), stats: () => ({}) }, getConfig: () => config, log: () => {} });
      try {
        await gateway2.listen([port]);
        plan2.push({ updates: [text('after restart')] });
        const second = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: 'test', stream: true, prompt_cache_key: 'restart-key',
            messages: [
              { role: 'system', content: 'HISTORY-MARKER-不得重放' },
              { role: 'user', content: 'before restart' },
              { role: 'assistant', content: 'before restart' },
              { role: 'user', content: 'second question' },
            ],
          }),
        });
        await second.text();
        assert.equal(calls2.filter((c) => c[0] === 'session/load').length, 1, '重启后应 session/load 一次');
        assert.equal(calls2.filter((c) => c[0] === 'session/new').length, 0, 'load 成功就不该新建会话');
        const loadCall = calls2.find((c) => c[0] === 'session/load');
        assert.equal(loadCall[1].sessionId.startsWith('s'), true, 'load 用重启前那个 sessionId');
        const sent = JSON.stringify(calls2.find((c) => c[0] === 'session/prompt')[1].prompt);
        assert.ok(!sent.includes('HISTORY-MARKER'), `load 之后不能重放历史：${sent.slice(0, 120)}`);
        assert.ok(sent.includes('second question'), '只发本轮增量');
      } finally {
        gateway2.close();
      }
    });

    await check('session/load failure falls back to a new session', async () => {
      const dataDir = path.dirname(config.source);
      // 宿主给了会话键时 keyFor 不依赖历史内容，直接算出真实键，伪造一条「重启前的足迹」。
      const { keyFor } = require(process.env.AGY_SERVER || '../lib/server.js');
      const staleKey = keyFor([], { prompt_cache_key: 'stale-key' });
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(path.join(dataDir, 'sessions.json'), JSON.stringify({
        version: 1,
        sessions: [{ key: staleKey, sessionId: 'stale-session', model: 'test', bridgeUrl: '', touched: Date.now() }],
      }), 'utf8');
      const calls3 = [];
      const acp3 = {
        policyBySession: new Map(), start: async () => {}, notify: () => {}, discover: async () => {}, resolveModel: (m) => m,
        cwdFor: async () => process.env.PI_SCRATCH_DIR || process.cwd(),
        status: () => ({ ready: true }),
        request: async (method, params) => {
          calls3.push([method, params]);
          if (method === 'session/load') throw new Error('unknown session');
          if (method === 'session/new') return { sessionId: 'fresh-session' };
          if (method === 'session/prompt') {
            acp3.onNotification({ method: 'session/update', params: { sessionId: params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'recovered' } } } });
            return { stopReason: 'end_turn' };
          }
          return {};
        },
      };
      const gateway3 = createGateway({ acp: acp3, limiter: { run: (f) => f(), stats: () => ({}) }, getConfig: () => config, log: () => {} });
      try {
        await gateway3.listen([port]);
        const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'test', stream: true, prompt_cache_key: 'stale-key', messages: [{ role: 'user', content: 'hello' }] }),
        });
        const raw = await res.text();
        assert.ok(raw.includes('recovered'), raw.slice(0, 200));
        assert.equal(calls3.filter((c) => c[0] === 'session/new').length, 1, 'load 失败必须回落到新建');
      } finally {
        gateway3.close();
      }
    });


    // 运行时被外部杀掉 / 崩溃后，旧实现会一直返 502「ACP 运行时未启动」直到用户重启网关。
    // 现在下一轮就该自己拉起运行时并正常回答。
    await check('crashed runtime is relaunched on the next turn', async () => {
      const state = { running: true, starts: 0 };
      const acp4 = {
        policyBySession: new Map(), notify: () => {},
        discover: async () => {}, resolveModel: (m) => m,
        cwdFor: async () => process.env.PI_SCRATCH_DIR || process.cwd(),
        start: async () => { state.starts += 1; state.running = true; },
        status: () => ({ running: state.running }),
        request: async (method, params) => {
          if (method === 'session/new') return { sessionId: 'revived' };
          if (method === 'session/prompt') {
            acp4.onNotification({ method: 'session/update', params: { sessionId: params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'alive again' } } } });
            return { stopReason: 'end_turn' };
          }
          return {};
        },
      };
      const gateway4 = createGateway({ acp: acp4, limiter: { run: (f) => f(), stats: () => ({}) }, getConfig: () => config, log: () => {} });
      try {
        await gateway4.listen([port]);
        state.running = false; // 运行时被杀
        const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'test', stream: true, prompt_cache_key: 'crash-key', messages: [{ role: 'user', content: 'still there?' }] }),
        });
        const raw = await res.text();
        assert.ok(raw.includes('alive again'), raw.slice(0, 200));
        assert.equal(state.starts, 1, '应该按需重新拉起一次运行时');
      } finally {
        gateway4.close();
      }
    });

    // 首字迟迟不来时不能再静默：前 3 次按 heartbeatMs 发提示，但**不**推迟无进展判定。
    await check('silent first token emits progress heartbeats without deferring the stall check', async () => {
      const slowCfg = { ...config, promptIdleTimeoutMs: 2400 }; // heartbeatMs = max(1000, 2400/6) = 1000
      let notified = 0;
      const acp5 = {
        policyBySession: new Map(), notify: () => { notified += 1; }, discover: async () => {}, resolveModel: (m) => m,
        cwdFor: async () => process.env.PI_SCRATCH_DIR || process.cwd(),
        start: async () => {}, status: () => ({ running: true }),
        request: async (method) => {
          if (method === 'session/new') return { sessionId: 'slow' };
          if (method === 'session/prompt') return new Promise(() => {}); // 永不出字
          return {};
        },
      };
      const gateway5 = createGateway({ acp: acp5, limiter: { run: (f) => f(), stats: () => ({}) }, getConfig: () => slowCfg, log: () => {} });
      const controller = new AbortController();
      try {
        await gateway5.listen([port]);
        const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'test', stream: true, prompt_cache_key: 'slow-key', messages: [{ role: 'user', content: 'slow' }] }),
          signal: controller.signal,
        });
        // 边读边收：心跳在 idleMs 之前就到，无进展判定在 idleMs 处触发
        const reader = res.body.getReader();
        let buf = '';
        const deadline = Date.now() + 3200;
        while (Date.now() < deadline) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += Buffer.from(value).toString('utf8');
        }
        controller.abort();
        assert.ok(buf.includes('仍在等待模型首个响应'), `应发出等待提示，实际：${buf.slice(0, 400)}`);
        assert.ok(notified >= 1, '心跳之后仍必须按 idleMs 触发 session/cancel（说明心跳没有推迟判定）');
      } finally {
        gateway5.close();
      }
    });

    // 缓存相关最要紧的一条：只要足迹还在，就不能重放整段历史（重放会让服务端前缀缓存全灭）。
    await check('a dropped session mapping still restores via session/load instead of replaying', async () => {
      const dataDir = path.dirname(config.source);
      try { fs.rmSync(path.join(dataDir, 'sessions.json'), { force: true }); } catch { /* ignore */ }
      const calls6 = [];
      let promptPayload = '';
      const acp6 = {
        policyBySession: new Map(), notify: () => {}, discover: async () => {}, resolveModel: (m) => m,
        cwdFor: async () => process.env.PI_SCRATCH_DIR || process.cwd(),
        start: async () => {}, status: () => ({ running: true }),
        request: async (method, params) => {
          calls6.push(method);
          if (method === 'session/new') return { sessionId: 'mapped' };
          if (method === 'session/load') return {};
          if (method === 'session/prompt') {
            promptPayload = JSON.stringify(params.prompt);
            acp6.onNotification({ method: 'session/update', params: { sessionId: params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ok' } } } });
            return { stopReason: 'end_turn' };
          }
          return {};
        },
      };
      const send = (text) => fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'test', stream: true, prompt_cache_key: 'drop-key', messages: [{ role: 'user', content: text }] }),
      }).then((r) => r.text());

      const gateway6 = createGateway({ acp: acp6, limiter: { run: (f) => f(), stats: () => ({}) }, getConfig: () => config, log: () => {} });
      await gateway6.listen([port]);
      await send('first');
      assert.equal(calls6.filter((m) => m === 'session/new').length, 1, '第一轮应建会话');

      // 模拟「内存映射丢了，但 sessions.json 足迹还在」：新实例读同一份足迹
      gateway6.close();
      await new Promise((r) => setTimeout(r, 80));
      const gateway7 = createGateway({ acp: acp6, limiter: { run: (f) => f(), stats: () => ({}) }, getConfig: () => config, log: () => {} });
      try {
        await gateway7.listen([port]);
        calls6.length = 0;
        await send('second');
        assert.equal(calls6.filter((m) => m === 'session/load').length, 1, '应通过 session/load 接回');
        assert.equal(calls6.filter((m) => m === 'session/new').length, 0, '不得新建会话（会重放整段历史）');
        assert.ok(!promptPayload.includes('first'), `不得重放历史，实际：${promptPayload.slice(0, 160)}`);
        assert.ok(promptPayload.includes('second'), '只发本轮增量');
      } finally {
        gateway7.close();
      }
    });


    // 还原出来的会话带着上次的模型：本轮换档位必须 set_model，而不是重建（重建要重放历史）。
    await check('restored session applies the requested model instead of rebuilding', async () => {
      const dataDir2 = path.dirname(config.source);
      try { fs.rmSync(path.join(dataDir2, 'sessions.json'), { force: true }); } catch { /* ignore */ }
      const calls8 = [];
      const models = [];
      const acp8 = {
        policyBySession: new Map(), notify: () => {}, discover: async () => {}, resolveModel: (m) => m,
        cwdFor: async () => process.env.PI_SCRATCH_DIR || process.cwd(),
        start: async () => {}, status: () => ({ running: true }),
        request: async (method, params) => {
          calls8.push(method);
          if (method === 'session/new') return { sessionId: 'kept' };
          if (method === 'session/load') return {};
          if (method === 'session/set_model') { models.push(params.modelId); return {}; }
          if (method === 'session/prompt') {
            acp8.onNotification({ method: 'session/update', params: { sessionId: params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ok' } } } });
            return { stopReason: 'end_turn' };
          }
          return {};
        },
      };
      const send8 = (model) => fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model, stream: true, prompt_cache_key: 'model-key', messages: [{ role: 'user', content: 'hi' }] }),
      }).then((r) => r.text());
      const gateway8 = createGateway({ acp: acp8, limiter: { run: (f) => f(), stats: () => ({}) }, getConfig: () => config, log: () => {} });
      await gateway8.listen([port]);
      await send8('old-model');
      gateway8.close();
      await new Promise((r) => setTimeout(r, 80));
      // 新实例：内存映射为空，只剩足迹 → 走 session/load
      const gateway9 = createGateway({ acp: acp8, limiter: { run: (f) => f(), stats: () => ({}) }, getConfig: () => config, log: () => {} });
      try {
        await gateway9.listen([port]);
        calls8.length = 0;
        await send8('new-model');
        assert.equal(calls8.filter((m) => m === 'session/load').length, 1, '应先 session/load 还原');
        assert.deepEqual(models, ['new-model'], '还原后必须把会话切到本轮模型');
        assert.equal(calls8.filter((m) => m === 'session/new').length, 0, '换档位不得重建会话');
      } finally {
        gateway9.close();
      }
    });

    // 开机时 VPN 比 PI-Desktop 起得晚：运行时会按直连拉起来，之后永远连不上网。
    // 网关发现「直连起、现在有代理」要自己重建一次，而不是一直拿坏运行时打 Internal error。
    await check('runtime started direct is rebuilt once a proxy shows up', async () => {
      let restarted = 0;
      const calls11 = [];
      const acp11 = {
        policyBySession: new Map(), notify: () => {}, discover: async () => {}, resolveModel: (m) => m,
        cwdFor: async () => process.env.PI_SCRATCH_DIR || process.cwd(),
        start: async () => {}, status: () => ({ running: true }),
        restart: async () => { restarted += 1; },
        proxyDrift: () => (restarted ? '' : 'http://127.0.0.1:10808'),
        request: async (method, params) => {
          calls11.push(method);
          if (method === 'session/new') return { sessionId: 'proxied' };
          if (method === 'session/prompt') {
            acp11.onNotification({ method: 'session/update', params: { sessionId: params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ok' } } } });
            return { stopReason: 'end_turn' };
          }
          return {};
        },
      };
      const gatewayC = createGateway({ acp: acp11, limiter: { run: (f) => f(), stats: () => ({}) }, getConfig: () => config, log: () => {} });
      await gatewayC.listen([port]);
      try {
        const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'test', stream: true, prompt_cache_key: 'proxy-key', messages: [{ role: 'user', content: 'hi' }] }),
        });
        await res.text();
        assert.equal(res.status, 200, '重建运行时这一轮仍要正常回答');
        assert.equal(restarted, 1, '发现代理后应重建一次运行时');
        assert.ok(calls11.includes('session/prompt'), '重建后本轮必须继续，而不是直接失败');
      } finally {
        gatewayC.close();
      }
    });
    console.log(`${passed}/${passed} behavioral tests passed`);
  } finally { gateway.close(); }
}
main().catch(e=>{console.error(e);process.exitCode=1;});
