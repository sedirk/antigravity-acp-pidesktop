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
    await check('text plus tool does not replay or replace session',async()=>{plan.push({updates:[tool,text('final answer'),usage]});const r=await request('a');assert.equal(r.status,200);assert.equal(r.body.output[0].content[0].text,'final answer');assert.equal(serial,1);assert.equal(calls.filter(c=>c[0]==='session/prompt').length,1);assert.ok(logs.some(x=>x.includes('正文 12 字')));assert.equal(r.body.usage.input_tokens,12345);assert.equal(r.body.usage.estimated,false);});
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
      assert.ok(notes.includes('invoke_subagent research') || logs.some(l=>l.includes('后台子任务仍在运行')),'tracks background subagent without cancelling: '+notes);
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

    await check('bridged: a parked tool call is not treated as a stall', async () => {
      const prevIdle = config.promptIdleTimeoutMs;
      const prevCap = config.promptTimeoutMs;
      config.promptIdleTimeoutMs = 2500;
      config.promptTimeoutMs = 0; // 关掉墙钟硬上限，单独验证「无进展」判定
      try {
        plan.push({
          updates: [],
          before: async () => {
            const url = lastMcpServers?.[0]?.url;
            assert.ok(url, '需要桥接地址');
            // 宿主「执行中」：tools/call 一直挂着，不返回结果
            const holdMcp = await fetch(url, {
              method: 'POST', headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ jsonrpc: '2.0', id: 91, method: 'tools/call', params: { name: 'Bash', arguments: { command: 'sleep 300' } } }),
            }).catch(() => null);
            await new Promise((r) => setTimeout(r, 4200));
            holdMcp?.body?.cancel?.().catch(() => {});
          },
          result: { stopReason: 'end_turn' },
        });
        const before = calls.length;
        const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: 'test', stream: true,
            messages: [{ role: 'user', content: 'run a slow tool' }],
            tools: [{ type: 'function', function: { name: 'Bash', parameters: { type: 'object', properties: { command: { type: 'string' } } } } }],
            prompt_cache_key: 'parked-key',
          }),
        });
        await res.text();
        await new Promise((r) => setTimeout(r, 5000));
        const during = calls.slice(before);
        assert.equal(during.filter((c) => c[0] === 'session/cancel').length, 0, '等待宿主执行工具时不能发 session/cancel: ' + JSON.stringify(during));
        assert.equal(during.filter((c) => c[0] === 'session/prompt').length, 1, '同一轮只能发一次 prompt');
      } finally {
        config.promptIdleTimeoutMs = prevIdle;
        config.promptTimeoutMs = prevCap;
      }
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
      const p5 = await (async () => { const s = net.createServer(); await new Promise((r) => s.listen(0, '127.0.0.1', r)); const pt = s.address().port; await new Promise((r) => s.close(r)); return pt; })();
      const gateway5 = createGateway({ acp: acp5, limiter: { run: (f) => f(), stats: () => ({}) }, getConfig: () => slowCfg, log: () => {} });
      const controller = new AbortController();
      try {
        await gateway5.listen([p5]);
        const res = await fetch(`http://127.0.0.1:${p5}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'test', stream: true, prompt_cache_key: 'slow-key', messages: [{ role: 'user', content: 'slow' }] }),
          signal: controller.signal,
        });
        const reader = res.body.getReader();
        let buf = '';
        const { value } = await reader.read();
        if (value) buf += Buffer.from(value).toString('utf8');
        await new Promise((r) => setTimeout(r, 3200));
        controller.abort();
        assert.ok(buf.includes('"role":"assistant"'), `首帧必须立即下发避免客户端连接超时，实际：${buf.slice(0, 400)}`);
        assert.ok(!buf.includes('仍在等待模型首个响应'), 'v2.2.1+ 心跳去噪后不应污染 reasoning_content 正文流');
        assert.ok(notified >= 1, '无进展时仍必须按 idleMs 准时触发 session/cancel');
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

    await check('bridged mode forwards image and document attachments into session/prompt', async () => {
      let seenPrompt = null;
      let seenMcp = null;
      const acpImg = {
        policyBySession: new Map(), notify: () => {}, discover: async () => {}, resolveModel: (m) => m,
        cwdFor: async () => process.env.PI_SCRATCH_DIR || process.cwd(),
        start: async () => {}, status: () => ({ running: true }),
        request: async (method, params) => {
          if (method === 'session/new') { seenMcp = params.mcpServers; return { sessionId: 'bridged-media' }; }
          if (method === 'session/prompt') {
            seenPrompt = params.prompt;
            acpImg.onNotification({ method: 'session/update', params: { sessionId: params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'saw attachments' } } } });
            return { stopReason: 'end_turn' };
          }
          return {};
        },
      };
      const gw = createGateway({ acp: acpImg, limiter: { run: (f) => f(), stats: () => ({}) }, getConfig: () => config, log: () => {} });
      await gw.listen([port]);
      try {
        const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: 'test', stream: true, prompt_cache_key: 'media-bridge-key',
            tools: [{ type: 'function', function: { name: 'Read', parameters: { type: 'object', properties: {} } } }],
            messages: [{
              role: 'user',
              content: [
                { type: 'text', text: 'inspect both attachments' },
                { type: 'image_url', image_url: { url: 'data:image/png;base64,aGVsbG8=' } },
                { type: 'input_file', filename: 'spec.pdf', file_data: 'data:application/pdf;base64,cGRmLWJvZHk=' },
              ],
            }],
          }),
        });
        const raw = await res.text();
        assert.equal(res.status, 200);
        assert.ok(Array.isArray(seenMcp) && seenMcp.length === 1, '必须走带 MCP 工具桥的流式路径');
        assert.ok(raw.includes('saw attachments'), raw.slice(0, 200));
        assert.ok(Array.isArray(seenPrompt), 'session/prompt 应收到数组块');
        const imgBlock = seenPrompt.find((b) => b.type === 'image');
        const docBlock = seenPrompt.find((b) => b.type === 'resource_link');
        assert.ok(imgBlock && imgBlock.mimeType === 'image/png' && imgBlock.data === 'aGVsbG8=', '桥接模式不能丢弃图片块');
        assert.ok(docBlock && docBlock.name === 'spec.pdf' && String(docBlock.uri || '').endsWith('.pdf'), '桥接模式不能丢弃文档附件');
      } finally {
        gw.close();
      }
    });

    await check('bridged mode coalesces parallel MCP calls and recovers when user interrupts parked tools', async () => {
      let mcpUrl = '';
      let promptCount = 0;
      const cancelledSessions = [];
      const mcpResults = [];
      const acpPar = {
        policyBySession: new Map(), discover: async () => {}, resolveModel: (m) => m,
        cwdFor: async () => process.env.PI_SCRATCH_DIR || process.cwd(),
        start: async () => {}, status: () => ({ running: true }),
        notify: (method, params) => { if (method === 'session/cancel') cancelledSessions.push(params.sessionId); },
        abandon: () => 1,
        request: async (method, params) => {
          if (method === 'session/new') { mcpUrl = params.mcpServers[0].url; return { sessionId: 'par-sess' }; }
          if (method === 'session/prompt') {
            promptCount += 1;
            if (promptCount === 1) {
              // 并发发起两个 MCP tools/call
              const callOne = (id, file) => fetch(mcpUrl, {
                method: 'POST', headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'Read', arguments: { path: file } } }),
              }).then((r) => r.text()).then((t) => mcpResults.push(t));
              await Promise.all([callOne(201, 'one.js'), callOne(202, 'two.js')]);
              return { stopReason: 'cancelled' };
            }
            acpPar.onNotification({ method: 'session/update', params: { sessionId: params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'switched to new question' } } } });
            return { stopReason: 'end_turn' };
          }
          return {};
        },
      };
      const gw = createGateway({ acp: acpPar, limiter: { run: (f) => f(), stats: () => ({}) }, getConfig: () => config, log: () => {} });
      await gw.listen([port]);
      const tools = [{ type: 'function', function: { name: 'Read', parameters: { type: 'object', properties: { path: { type: 'string' } } } } }];
      try {
        const parseChatSse = async (r) => (await r.text()).split('\n').filter((x) => x.startsWith('data: {')).map((x) => JSON.parse(x.slice(6)));
        const first = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'test', stream: true, prompt_cache_key: 'par-key', tools, messages: [{ role: 'user', content: 'read both files' }] }),
        });
        assert.equal(first.status, 200);
        const firstFrames = await parseChatSse(first);
        const toolFrame = firstFrames.find((f) => f.choices?.[0]?.finish_reason === 'tool_calls');
        assert.ok(toolFrame, '第一轮应以 tool_calls 挂起');
        assert.equal(toolFrame.choices[0].delta.tool_calls.length, 2, '并发 MCP 工具调用应合并进同一轮 tool_calls');

        // 用户没有回填 tool_result，而是中断并发送新问题
        const second = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: 'test', stream: true, prompt_cache_key: 'par-key', tools,
            messages: [
              { role: 'user', content: 'read both files' },
              { role: 'user', content: 'stop and answer new question instead' },
            ],
          }),
        });
        assert.equal(second.status, 200);
        const secondFrames = await parseChatSse(second);
        assert.ok(secondFrames.some((f) => f.choices?.[0]?.finish_reason === 'stop'), '用户插话后不能死循环重发旧 tool_calls');
        const secondText = secondFrames.map((f) => f.choices?.[0]?.delta?.content || '').join('');
        assert.equal(secondText, 'switched to new question');
        assert.ok(cancelledSessions.includes('par-sess'), '放弃旧挂起工具时应通知 session/cancel');
        await new Promise((r) => setTimeout(r, 30));
        assert.equal(mcpResults.length, 2, '被取消的两个挂起 MCP 请求都应收到错误结束帧');
        assert.ok(mcpResults.every((t) => t.includes('"isError":true')), mcpResults.join('\n'));
      } finally {
        gw.close();
      }
    });

    await check('bridged /v1/responses emits valid reasoning item and non-colliding output_index', async () => {
      let mcpUrl = '';
      let releasePrompt = null;
      const acpResp = {
        policyBySession: new Map(), notify: () => {}, discover: async () => {}, resolveModel: (m) => m,
        cwdFor: async () => process.env.PI_SCRATCH_DIR || process.cwd(),
        start: async () => {}, status: () => ({ running: true }),
        request: async (method, params) => {
          if (method === 'session/new') { mcpUrl = params.mcpServers[0].url; return { sessionId: 'resp-idx-sess' }; }
          if (method === 'session/prompt') {
            acpResp.onNotification({ method: 'session/update', params: { sessionId: params.sessionId, update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking first' } } } });
            acpResp.onNotification({ method: 'session/update', params: { sessionId: params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'checking file' } } } });
            fetch(mcpUrl, {
              method: 'POST', headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ jsonrpc: '2.0', id: 301, method: 'tools/call', params: { name: 'Read', arguments: { path: 'x.js' } } }),
            }).catch(() => {});
            await new Promise((r) => { releasePrompt = r; });
            return { stopReason: 'end_turn' };
          }
          return {};
        },
      };
      const gw = createGateway({ acp: acpResp, limiter: { run: (f) => f(), stats: () => ({}) }, getConfig: () => config, log: () => {} });
      await gw.listen([port]);
      try {
        const res = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: 'test', stream: true, prompt_cache_key: 'resp-idx-key',
            tools: [{ type: 'function', name: 'Read', parameters: { type: 'object', properties: { path: { type: 'string' } } } }],
            input: 'inspect x.js',
          }),
        });
        const raw = await res.text();
        const events = raw.split('\n').filter((x) => x.startsWith('data: ')).map((x) => JSON.parse(x.slice(6)));
        const added = events.filter((e) => e.type === 'response.output_item.added');
        assert.deepEqual(added.map((e) => [e.output_index, e.item.type]), [
          [0, 'reasoning'],
          [1, 'message'],
          [2, 'function_call'],
        ], 'reasoning、message、function_call 的 output_index 必须严格递增且不碰撞');
        const thoughtDelta = events.find((e) => e.type === 'response.reasoning_summary_text.delta');
        assert.ok(thoughtDelta && thoughtDelta.item_id === added[0].item.id && thoughtDelta.output_index === 0, 'thought delta 必须挂在已声明的 reasoning item 上');
        const completed = events.find((e) => e.type === 'response.completed').response;
        for (const e of added) {
          assert.equal(completed.output[e.output_index].id, e.item.id, 'completed.output 顺序必须与 output_item.added 一致');
        }
      } finally {
        if (releasePrompt) releasePrompt();
        gw.close();
      }
    });

    await check('timed-out session is purged from sessions.json and proxy drift restarts before discover', async () => {
      const tmpData = path.join(process.env.PI_SCRATCH_DIR || process.cwd(), `gw-purge-${Date.now()}`);
      const fastCfg = { ...config, promptTimeoutMs: 80, source: path.join(tmpData, 'config.json') };
      const order = [];
      let drifted = true;
      let turn = 0;
      const acpPurge = {
        policyBySession: new Map(), notify: () => {},
        start: async () => {}, status: () => ({ running: true }),
        proxyDrift: () => (drifted ? 'http://127.0.0.1:10809' : ''),
        restart: async () => { order.push('restart'); drifted = false; },
        discover: async () => { order.push('discover'); },
        resolveModel: (m) => { order.push('resolveModel'); return m; },
        cwdFor: async () => process.env.PI_SCRATCH_DIR || process.cwd(),
        request: async (method, params) => {
          if (method === 'session/new') return { sessionId: 'doomed-sess' };
          if (method === 'session/prompt') {
            turn += 1;
            if (turn === 1) {
              acpPurge.onNotification({ method: 'session/update', params: { sessionId: params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'first ok' } } } });
              return { stopReason: 'end_turn' };
            }
            const err = new Error('ACP session/prompt 超时');
            err.code = 'ACP_TIMEOUT';
            throw err;
          }
          return {};
        },
      };
      const gw = createGateway({ acp: acpPurge, limiter: { run: (f) => f(), stats: () => ({}) }, getConfig: () => fastCfg, log: () => {} });
      await gw.listen([port]);
      try {
        // 第一轮非桥接 /v1/responses：验证 proxyDrift 重启发生在 discover / resolveModel 之前，并把会话写入 sessions.json
        const r1 = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'test', stream: false, prompt_cache_key: 'purge-key', input: 'hi' }),
        });
        assert.equal(r1.status, 200);
        assert.equal(order[0], 'restart', `proxyDrift 重启必须在 discover/resolveModel 之前: ${order.join('->')}`);

        // 第二轮触发 ACP_TIMEOUT：必须同时从内存和 sessions.json 移除坏会话
        const r2 = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'test', stream: false, prompt_cache_key: 'purge-key', input: 'hang' }),
        });
        assert.equal(r2.status, 502);
      } finally {
        gw.close();
      }
      const saved = JSON.parse(fs.readFileSync(path.join(tmpData, 'sessions.json'), 'utf8'));
      assert.equal(saved.sessions.length, 0, '超时失联的坏会话必须从 sessions.json 一并清除，避免重启后继续 load 死会话');
    });

    // 复现 bf876a46 死锁现场：
    // 1) 多步桥接续流（第 2+ 次 park）不能丢失运行时真实 contextUsed，退化成按整段历史估算虚高 token；
    // 2) 桥接工具挂起期间，宿主插队发来同 prompt_cache_key、无 tools 的自动压缩请求时，必须立刻释放挂起轮次（不死锁），
    //    且压缩请求走独立临时会话（policy=none、跑完即 session/close），不污染原业务会话；
    // 3) 压缩结束后宿主续跑时，原业务会话仍可正常复用，且能收到挂起期间宿主已跑完的尾部 tool 输出。
    await check('mid-turn context compaction preempts parked bridge without deadlock, isolates summary session, and preserves real contextUsed across parks', async () => {
      const tmpData = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'ag-compact-'));
      const compactCfg = { ...config, source: path.join(tmpData, 'config.json') };
      let mcpUrl = '';
      let newCount = 0;
      const closedSessions = [];
      const cancelledSessions = [];
      const sessionPrompts = [];
      const policiesSeen = new Map();
      const acpCompact = {
        policyBySession: new Map(),
        discover: async () => {},
        resolveModel: (m) => m,
        cwdFor: async () => process.env.PI_SCRATCH_DIR || process.cwd(),
        start: async () => {},
        status: () => ({ running: true }),
        notify: (method, params) => {
          if (method === 'session/cancel') cancelledSessions.push(params.sessionId);
        },
        abandon: () => 0,
        request: async (method, params) => {
          if (method === 'session/new') {
            newCount += 1;
            if (params.mcpServers && params.mcpServers.length > 0) {
              mcpUrl = params.mcpServers[0].url;
              return { sessionId: 'main-bridged-sess' };
            }
            return { sessionId: `ephemeral-compact-${newCount}` };
          }
          if (method === 'session/close') {
            closedSessions.push(params.sessionId);
            return {};
          }
          if (method === 'session/prompt') {
            const sid = params.sessionId;
            const promptText = params.prompt.map((b) => b.text || '').join('\n');
            sessionPrompts.push({ sid, promptText });
            policiesSeen.set(sid, acpCompact.policyBySession.get(sid));
            if (sid.startsWith('ephemeral-compact-')) {
              acpCompact.onNotification({
                method: 'session/update',
                params: { sessionId: sid, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '<summary>compacted ok</summary>' } } },
              });
              return { stopReason: 'end_turn' };
            }
            if (sessionPrompts.filter((p) => p.sid === 'main-bridged-sess').length === 1) {
              // 第 1 次调 Read → 回填后第 2 次调 Read（此时宿主不回填，改发自动压缩请求）
              acpCompact.onNotification({
                method: 'session/update',
                params: { sessionId: sid, update: { sessionUpdate: 'usage_update', used: 128945, size: 1048576 } },
              });
              const callMcpRead = (id, file) => fetch(mcpUrl, {
                method: 'POST', headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'Read', arguments: { path: file } } }),
              }).then((r) => r.text());
              const r1 = await callMcpRead(1, 'first.js');
              assert.ok(!r1.includes('"isError":true') && r1.includes('first file content'), `第一次 Read 应正常拿到回填结果: ${r1}`);
              const r2 = await callMcpRead(2, 'second.js');
              assert.ok(r2.includes('"isError":true'), `第二次挂起被自动压缩抢占时应收到 isError=true: ${r2}`);
              return { stopReason: 'cancelled' };
            }
            acpCompact.onNotification({
              method: 'session/update',
              params: { sessionId: sid, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'resumed cleanly after compaction' } } },
            });
            return { stopReason: 'end_turn' };
          }
          return {};
        },
      };
      const gw = createGateway({ acp: acpCompact, limiter: { run: (f) => f(), stats: () => ({}) }, getConfig: () => compactCfg, log: () => {} });
      const p = await gw.listen([0]);
      const tools = [{ type: 'function', name: 'Read', parameters: { type: 'object', properties: { path: { type: 'string' } } } }];
      const parseRespSse = async (r) => {
        const raw = await r.text();
        return raw.split('\n\n').filter(Boolean).map((blk) => {
          const ev = /^event: (.+)$/m.exec(blk)?.[1];
          const d = /^data: (.+)$/m.exec(blk)?.[1];
          return ev && d ? { type: ev, data: JSON.parse(d) } : null;
        }).filter(Boolean);
      };
      try {
        // Step 1: 发起首轮桥接请求，进入第一次 park
        const turn1 = await parseRespSse(await fetch(`http://127.0.0.1:${p}/v1/responses`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'test', stream: true, prompt_cache_key: 'bf876a46', tools, input: [{ role: 'user', content: 'inspect logs' }] }),
        }));
        const done1 = turn1.find((e) => e.type === 'response.completed');
        const fc1 = done1.data.response.output.find((o) => o.type === 'function_call');
        assert.ok(fc1, '首轮应挂起返回第一个 function_call');
        assert.equal(done1.data.response.usage.input_tokens, 128945);
        assert.equal(done1.data.response.usage.estimated, false);

        // Step 2: 回填第一个工具结果，同时携带膨胀的本地历史文本，进入第二次 park
        const bloatedHistory = 'x'.repeat(240000);
        const turn2 = await parseRespSse(await fetch(`http://127.0.0.1:${p}/v1/responses`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: 'test', stream: true, prompt_cache_key: 'bf876a46', tools,
            input: [
              { role: 'user', content: bloatedHistory },
              { type: 'function_call', call_id: fc1.call_id, name: 'Read', arguments: fc1.arguments },
              { type: 'function_call_output', call_id: fc1.call_id, output: 'first file content' },
            ],
          }),
        }));
        const done2 = turn2.find((e) => e.type === 'response.completed');
        assert.ok(done2, `续流轮应正常 completed，实际事件: ${JSON.stringify(turn2)}`);
        const fc2 = done2.data.response.output.find((o) => o.type === 'function_call');
        assert.ok(fc2, '续流轮应挂起返回第二个 function_call');
        assert.ok(done2.data.response.usage.input_tokens > 128945 && done2.data.response.usage.input_tokens < 129100, `第 2+ 次 park 应在真实 contextUsed(128945) 基础上叠加无放大工具步增量，绝不退化成虚高本地估算（实际: ${done2.data.response.usage.input_tokens}）`);
        assert.equal(done2.data.response.usage.estimated, false);

        // Step 3: 此时 main-bridged-sess 正挂在第二个 Read 上！
        // 真实模拟 PI-Desktop 发起的自动压缩请求（带 previous_response_id、instructions、完整历史多条消息、无 tools）：不得死锁！
        const compactEvents = await parseRespSse(await fetch(`http://127.0.0.1:${p}/v1/responses`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: 'test', stream: true, prompt_cache_key: 'bf876a46',
            previous_response_id: 'resp_real_world_turn2',
            instructions: 'You are a context summarization assistant. Your task is to read a conversation between a user and an AI assistant, then produce a structured summary following the exact format specified.\n\nDo NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.',
            input: [
              { role: 'user', content: 'hello' },
              { role: 'assistant', content: 'hi' },
              { role: 'user', content: 'Summarize the entire conversation above.' },
            ],
          }),
        }));
        const compactDone = compactEvents.find((e) => e.type === 'response.completed');
        assert.ok(compactDone, '自动压缩请求必须顺利完成，不得卡在 serializePrompt 死锁');
        const summaryText = compactDone.data.response.output.find((o) => o.type === 'message').content[0].text;
        assert.equal(summaryText, '<summary>compacted ok</summary>');
        assert.ok(cancelledSessions.includes('main-bridged-sess'), '抢占挂起桥接轮次时必须发送 session/cancel');
        assert.ok(closedSessions.some((s) => s.startsWith('ephemeral-compact-')), '压缩临时会话结束后必须立即 session/close 释放 worker');
        assert.ok(!closedSessions.includes('main-bridged-sess'), '原业务会话不应被误关或销毁');
        const ephemId = [...policiesSeen.keys()].find((s) => s.startsWith('ephemeral-compact-'));
        assert.equal(policiesSeen.get(ephemId), 'none', '旁路压缩会话应强制使用 policy=none 禁止调内置工具');
        assert.ok(
          !sessionPrompts.some((p) => p.sid === 'main-bridged-sess' && p.promptText.includes('Summarize the entire conversation')),
          '压缩提示词绝不能发进原业务会话污染上下文',
        );

        // Step 4: 压缩完成后宿主带着摘要与刚才本地已执行完的第二个 Read 结果继续提问
        const turn3 = await parseRespSse(await fetch(`http://127.0.0.1:${p}/v1/responses`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: 'test', stream: true, prompt_cache_key: 'bf876a46', tools,
            input: [
              { role: 'user', content: '<context_summary>compacted</context_summary>' },
              { type: 'function_call', call_id: fc2.call_id, name: 'Read', arguments: fc2.arguments },
              { type: 'function_call_output', call_id: fc2.call_id, output: 'second file content after compaction' },
            ],
          }),
        }));
        const done3 = turn3.find((e) => e.type === 'response.completed');
        assert.ok(done3, '压缩后业务会话应正常恢复回答');
        const finalMsg = done3.data.response.output.find((o) => o.type === 'message').content[0].text;
        assert.equal(finalMsg, 'resumed cleanly after compaction');
        const resumedMainPrompts = sessionPrompts.filter((p) => p.sid === 'main-bridged-sess');
        assert.equal(resumedMainPrompts.length, 2, '压缩后应继续复用原 main-bridged-sess 会话');
        assert.ok(resumedMainPrompts[1].promptText.includes('second file content after compaction'), '被抢占期间宿主已完成的尾部工具结果应补进续跑提示词');
      } finally {
        gw.close();
      }
    });

    await check('mid-turn steering: new user prompt while assistant is generating cancels previous turn and answers immediately', async () => {
      const p = 43100 + Math.floor(Math.random() * 500);
      const cancelled = [];
      let slowPromptResolve;
      let firstTurnStarted = false;
      const acpMock = {
        policyBySession: new Map(), discover: async () => {}, resolveModel: (m) => m,
        cwdFor: async () => process.cwd(),
        start: async () => {}, status: () => ({ running: true }),
        notify: (method, params) => { if (method === 'session/cancel') cancelled.push(params.sessionId); },
        abandon: () => 1,
        request: async (method, params) => {
          if (method === 'session/new') return { sessionId: 'steer-sess' };
          if (method === 'session/prompt') {
            if (!firstTurnStarted) {
              firstTurnStarted = true;
              await new Promise((r) => { slowPromptResolve = r; });
              return { stopReason: 'cancelled' };
            }
            acpMock.onNotification({ method: 'session/update', params: { sessionId: params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'steered answer' } } } });
            return { stopReason: 'end_turn' };
          }
          return {};
        },
      };
      const gw = createGateway({ acp: acpMock, limiter: { run: (f) => f(), stats: () => ({}) }, getConfig: () => config, log: () => {} });
      await gw.listen([p]);
      const tools = [{ type: 'function', function: { name: 'Read', parameters: { type: 'object', properties: { path: { type: 'string' } } } } }];
      try {
        const parseChatSse = async (r) => (await r.text()).split('\n').filter((x) => x.startsWith('data: {')).map((x) => JSON.parse(x.slice(6)));
        fetch(`http://127.0.0.1:${p}/v1/chat/completions`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'test', stream: true, prompt_cache_key: 'steer-key', tools, messages: [{ role: 'user', content: 'turn 1' }] }),
        }).catch(() => {});
        await new Promise((r) => setTimeout(r, 40));

        const req2Promise = fetch(`http://127.0.0.1:${p}/v1/chat/completions`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: 'test', stream: true, prompt_cache_key: 'steer-key', tools,
            messages: [{ role: 'user', content: 'turn 1' }, { role: 'user', content: 'steer: change direction' }],
          }),
        });

        await new Promise((r) => setTimeout(r, 40));
        assert.ok(cancelled.includes('steer-sess'), '第一轮正在生成时发起 steering 必须向会话发送 session/cancel');
        if (slowPromptResolve) slowPromptResolve();

        const res2 = await req2Promise;
        assert.equal(res2.status, 200);
        const frames2 = await parseChatSse(res2);
        const text2 = frames2.map((f) => f.choices?.[0]?.delta?.content || '').join('');
        assert.equal(text2, 'steered answer', '新方向的回答应顺利输出');
        assert.ok(frames2.some((f) => f.choices?.[0]?.finish_reason === 'stop'), '新方向轮次应正常以 stop 收尾');
      } finally {
        if (slowPromptResolve) slowPromptResolve();
        gw.close();
      }
    });
    await check('edit and retry: stopping then editing user turn resets session and feeds new content (version 2/2)', async () => {
      const p = 43700 + Math.floor(Math.random() * 500);
      let sessSeq = 0;
      const createdSessions = [];
      const closedSessions = [];
      const promptsReceived = [];
      const acpMock = {
        policyBySession: new Map(),
        modelsForApi: async () => [{ id: 'test', name: 'Test' }],
        resolveModel: async () => 'test',
        discover: async () => ({ raw: [{ id: 'test' }], groups: new Map() }),
        cwdFor: async () => require('node:os').tmpdir(),
        start: async () => {}, status: () => ({ running: true }),
        notify: (method, params) => {},
        request: async (method, params) => {
          if (method === 'session/new') {
            const sid = `sess-edit-${++sessSeq}`;
            createdSessions.push(sid);
            return { sessionId: sid, models: { currentModelId: 'test' } };
          }
          if (method === 'session/close') {
            closedSessions.push(params.sessionId);
            return {};
          }
          if (method === 'session/prompt') {
            promptsReceived.push({ sid: params.sessionId, prompt: params.prompt });
            const pStr = typeof params.prompt === 'string' ? params.prompt : JSON.stringify(params.prompt);
            if (pStr.includes('v1 question')) {
              // 模拟第一轮较长生成
              await new Promise((r) => setTimeout(r, 200));
            } else if (pStr.includes('v2 modified with details')) {
              acpMock.onNotification({ method: 'session/update', params: { sessionId: params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'version 2 answer' } } } });
            }
            return { stopReason: 'end_turn' };
          }
          return {};
        },
      };
      const gw = createGateway({ acp: acpMock, limiter: { run: (f) => f(), stats: () => ({}) }, getConfig: () => config, log: () => {} });
      await gw.listen([p]);
      const tools = [{ type: 'function', function: { name: 'Read', parameters: { type: 'object', properties: { path: { type: 'string' } } } } }];
      try {
        const parseChatSse = async (r) => (await r.text()).split('\n').filter((x) => x.startsWith('data: {')).map((x) => JSON.parse(x.slice(6)));
        // 1. 发起第 1 轮
        const ac1 = new AbortController();
        const req1 = fetch(`http://127.0.0.1:${p}/v1/chat/completions`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, signal: ac1.signal,
          body: JSON.stringify({ model: 'test', stream: true, prompt_cache_key: 'edit-cache-key', tools, messages: [{ role: 'user', content: 'v1 question' }] }),
        }).catch(() => {});
        await new Promise((r) => setTimeout(r, 30));
        // 用户点击停止（Abort）
        ac1.abort();
        await new Promise((r) => setTimeout(r, 50));

        // 2. 用户在客户端修改上一轮提问，重新发送（生成版本 2/2）
        const res2 = await fetch(`http://127.0.0.1:${p}/v1/chat/completions`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: 'test', stream: true, prompt_cache_key: 'edit-cache-key', tools,
            messages: [{ role: 'user', content: 'v2 modified with details' }],
          }),
        });
        assert.equal(res2.status, 200);
        const frames2 = await parseChatSse(res2);
        const text2 = frames2.map((f) => f.choices?.[0]?.delta?.content || '').join('');
        assert.equal(text2, 'version 2 answer', '修改后的内容必须正确生成版本 2 回答');
        assert.ok(createdSessions.length >= 2, '检测到历史修改时必须创建全新会话以重新生成');
        assert.ok(closedSessions.includes('sess-edit-1'), '旧会话必须被安全 close 避免脏状态污染');
        const v2Prompt = promptsReceived.find((p) => p.sid === createdSessions[1]);
        assert.ok(v2Prompt && JSON.stringify(v2Prompt.prompt).includes('v2 modified with details'), '新会话必须完整收到修改补充后的提示词');
      } finally {
        gw.close();
      }
    });

    await check('auxiliary UI follow-up predictions reuse 1 shared worker and never evict business sessions', async () => {
      const createdSids = [];
      const auxPrompts = [];
      const p = await (async () => { const s = net.createServer(); await new Promise((r) => s.listen(0, '127.0.0.1', r)); const pt = s.address().port; await new Promise((r) => s.close(r)); return pt; })();
      const auxDataDir = path.join(process.env.PI_SCRATCH_DIR || process.cwd(), `gateway-aux-${Date.now()}`);
      const auxCfg = { ...config, maxSessions: 2, source: path.join(auxDataDir, 'config.json') };
      const acpMock = {
        policyBySession: new Map(), start: async () => {}, discover: async () => {},
        cwdFor: async () => process.cwd(), resolveModel: (m) => m, status: () => ({ running: true, ready: true }),
        notify: () => {},
        request: async (method, params) => {
          if (method === 'session/new') {
            const sid = `aux-or-biz-${createdSids.length + 1}`;
            createdSids.push(sid);
            return { sessionId: sid, models: { currentModelId: 'test', availableModels: [{ modelId: 'test', name: 'Test' }] } };
          }
          if (method === 'session/prompt') {
            auxPrompts.push({ sid: params.sessionId, text: params.prompt?.[0]?.text || '' });
            acpMock.onNotification({ method: 'session/update', params: { sessionId: params.sessionId, update: text('predicted follow-up') } });
            return { stopReason: 'end_turn' };
          }
          return {};
        },
      };
      const gw = createGateway({ acp: acpMock, limiter: { run: (f) => f(), stats: () => ({}) }, getConfig: () => auxCfg, log: () => {} });
      await gw.listen([p]);
      try {
        // 先创建 2 个真实业务会话（占满 maxSessions = 2）
        for (const key of ['biz-1', 'biz-2']) {
          const r = await fetch(`http://127.0.0.1:${p}/v1/responses`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ model: 'test', stream: false, prompt_cache_key: key, input: `work on ${key}` }),
          });
          assert.equal(r.status, 200);
        }
        assert.equal(gw.sessions(), 2, '2 个真实业务会话在位');
        // 连续发起 5 次无状态追问预测（每次内容不同、无 prompt_cache_key、带 developer 角色）
        for (let i = 0; i < 5; i++) {
          const r = await fetch(`http://127.0.0.1:${p}/v1/responses`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              model: 'test', stream: false,
              input: [
                { role: 'developer', content: "You predict the user's next message, not the assistant's answer." },
                { role: 'user', content: `Conversation snippet #${i}` },
              ],
            }),
          });
          assert.equal(r.status, 200);
        }
        assert.equal(createdSids.length, 3, '2 个业务会话 + 5 次追问预测总共只应创建 3 个底层会话（5 次预测共享 1 个辅助 worker）');
        assert.equal(gw.sessions(), 2, '辅助请求绝不能写入业务 sessions 映射或挤出真实会话');
        assert.ok(auxPrompts.slice(-5).every((x) => x.text.includes('=== 系统指令 (System Instructions) ===')), 'developer 提示词应被正确识别为系统指令');
      } finally {
        gw.close();
        try { fs.rmSync(auxDataDir, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    });

    await check('responsesBridged preserves namespaced rawName in function_call output', async () => {
      const p = await (async () => { const s = net.createServer(); await new Promise((r) => s.listen(0, '127.0.0.1', r)); const pt = s.address().port; await new Promise((r) => s.close(r)); return pt; })();
      let mcpUrlSeen = '';
      const acpMock = {
        policyBySession: new Map(), start: async () => {}, discover: async () => {},
        cwdFor: async () => process.cwd(), resolveModel: (m) => m, status: () => ({ running: true, ready: true }),
        notify: () => {},
        request: async (method, params) => {
          if (method === 'session/new') {
            mcpUrlSeen = params.mcpServers?.[0]?.url || '';
            return { sessionId: 'ns-sess-1', models: { currentModelId: 'test', availableModels: [] } };
          }
          if (method === 'session/prompt') {
            const mcpRes = await fetch(mcpUrlSeen, {
              method: 'POST', headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'pi-desktop_visualize', arguments: { chart: 'bar' } } }),
            }).catch(() => null);
            await new Promise((r) => setTimeout(r, 60));
            mcpRes?.body?.cancel?.().catch(() => {});
            return { stopReason: 'end_turn' };
          }
          return {};
        },
      };
      const nsDir = path.join(process.env.PI_SCRATCH_DIR || process.cwd(), `gateway-ns-${Date.now()}`);
      const gw = createGateway({ acp: acpMock, limiter: { run: (f) => f(), stats: () => ({}) }, getConfig: () => ({ ...config, source: path.join(nsDir, 'config.json') }), log: () => {} });
      await gw.listen([p]);
      try {
        const res = await fetch(`http://127.0.0.1:${p}/v1/responses`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: 'test', stream: true, prompt_cache_key: 'ns-conv',
            tools: [{ type: 'function', name: 'pi-desktop/visualize', parameters: { type: 'object', properties: {} } }],
            input: [{ role: 'user', content: 'draw chart' }],
          }),
        });
        const rawSse = await res.text();
        assert.ok(rawSse.includes('"name":"pi-desktop/visualize"'), `Responses 桥接必须还原原始命名空间工具名 pi-desktop/visualize，实际: ${rawSse}`);
      } finally {
        gw.close();
        try { fs.rmSync(nsDir, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    });

    await check('gateway retries transient 429 with reasoning keepalive and lightweight continuation', async () => {
      const p = await (async () => { const s = net.createServer(); await new Promise((r) => s.listen(0, '127.0.0.1', r)); const pt = s.address().port; await new Promise((r) => s.close(r)); return pt; })();
      const seenPrompts = [];
      let acpRef;
      const acpMock = {
        policyBySession: new Map(), start: async () => {}, discover: async () => {},
        cwdFor: async () => process.env.PI_SCRATCH_DIR || process.cwd(),
        resolveModel: (m) => m, status: () => ({ running: true, ready: true }),
        notify: () => {},
        request: async (method, params) => {
          if (method === 'session/new') {
            return { sessionId: 'rl-sess-1', models: { currentModelId: 'test', availableModels: [] } };
          }
          if (method === 'session/prompt') {
            seenPrompts.push(params.prompt);
            if (seenPrompts.length <= 2) {
              throw Object.assign(new Error('429 RESOURCE_EXHAUSTED: TPM rate limit exceeded'), { acp: { code: 429 } });
            }
            acpRef.onNotification({
              method: 'session/update',
              params: { sessionId: 'rl-sess-1', update: { sessionUpdate: 'agent_message_chunk', content: { text: '冷却重试后成功输出' } } },
            });
            return { stopReason: 'end_turn' };
          }
          return {};
        },
      };
      acpRef = acpMock;
      const rlDir = path.join(process.env.PI_SCRATCH_DIR || process.cwd(), `gateway-rl-${Date.now()}`);
      const rlCfg = { ...config, rateLimitMaxRetries: 3, rateLimitRetryBaseMs: 80, source: path.join(rlDir, 'config.json') };
      const gw = createGateway({ acp: acpMock, limiter: { run: (f) => f(), stats: () => ({}) }, getConfig: () => rlCfg, log: () => {} });
      await gw.listen([p]);
      try {
        const res = await fetch(`http://127.0.0.1:${p}/v1/responses`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: 'test', stream: true, prompt_cache_key: 'rl-conv-1',
            tools: [{ type: 'function', name: 'Read', parameters: { type: 'object', properties: {} } }],
            input: [{ role: 'user', content: [{ type: 'input_text', text: '分析超长矩阵讲义 ' + 'X'.repeat(500) }, { type: 'input_image', image_url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=' }] }],
          }),
        });
        const rawSse = await res.text();
        assert.equal(seenPrompts.length, 3, '连续两次 429 后第 3 次重试成功');
        assert.ok(seenPrompts[0].some((b) => b.type === 'image'), '首次尝试携带原始图片与完整请求');
        assert.equal(seenPrompts[1].length, 1, '同会话内部 429 重试转为单块轻量续推，绝不重复灌入大图');
        assert.ok(!seenPrompts[1][0].text.includes('XXXX'), '重试块不再重复长正文');
        assert.ok(rawSse.includes('触发上游速率限制（429）'), 'SSE 思考流向前端推送了真实的 429 冷却提示保活帧');
        assert.ok(rawSse.includes('冷却重试后成功输出'), '最终正常返回完整输出，无需宿主断流重连');
        assert.ok(!rawSse.includes('response.failed'), '内部重试成功后不发 response.failed');
      } finally {
        gw.close();
        try { fs.rmSync(rlDir, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    });

    await check('host retry after interrupted turn deduplicates identical prompt and images', async () => {
      const p = await (async () => { const s = net.createServer(); await new Promise((r) => s.listen(0, '127.0.0.1', r)); const pt = s.address().port; await new Promise((r) => s.close(r)); return pt; })();
      const seenPrompts = [];
      let acpRef;
      const acpMock = {
        policyBySession: new Map(), start: async () => {}, discover: async () => {},
        cwdFor: async () => process.env.PI_SCRATCH_DIR || process.cwd(),
        resolveModel: (m) => m, status: () => ({ running: true, ready: true }),
        notify: () => {},
        request: async (method, params) => {
          if (method === 'session/new') {
            return { sessionId: 'dedup-sess-1', models: { currentModelId: 'test', availableModels: [] } };
          }
          if (method === 'session/prompt') {
            seenPrompts.push(params.prompt);
            if (seenPrompts.length === 1) {
              throw new Error('upstream transient socket reset');
            }
            acpRef.onNotification({
              method: 'session/update',
              params: { sessionId: 'dedup-sess-1', update: { sessionUpdate: 'agent_message_chunk', content: { text: '宿主重连后秒回' } } },
            });
            return { stopReason: 'end_turn' };
          }
          return {};
        },
      };
      acpRef = acpMock;
      const ddDir = path.join(process.env.PI_SCRATCH_DIR || process.cwd(), `gateway-dd-${Date.now()}`);
      const ddCfg = { ...config, rateLimitMaxRetries: 0, source: path.join(ddDir, 'config.json') };
      const gw = createGateway({ acp: acpMock, limiter: { run: (f) => f(), stats: () => ({}) }, getConfig: () => ddCfg, log: () => {} });
      await gw.listen([p]);
      const payload = {
        model: 'test', stream: true, prompt_cache_key: 'dd-conv-1',
        tools: [{ type: 'function', name: 'Read', parameters: { type: 'object', properties: {} } }],
        input: [{ role: 'user', content: [{ type: 'input_text', text: '请检查这张图里的公式推导 ' + 'M'.repeat(600) }, { type: 'input_image', image_url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=' }] }],
      };
      try {
        const res1 = await fetch(`http://127.0.0.1:${p}/v1/responses`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const sse1 = await res1.text();
        assert.ok(sse1.includes('response.failed'), '首轮遇到非 429 网络异常正常失败');

        // 模拟宿主自动用完全相同的消息 + 图片重发重试
        const res2 = await fetch(`http://127.0.0.1:${p}/v1/responses`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const sse2 = await res2.text();
        assert.ok(sse2.includes('宿主重连后秒回'), '第二次宿主重试正常完成');
        assert.equal(seenPrompts.length, 2);
        assert.ok(seenPrompts[0].some((b) => b.type === 'image'), '第一轮发送了图片与完整正文');
        assert.ok(!seenPrompts[1].some((b) => b.type === 'image'), '第二轮宿主重发同一失败轮次时自动剥离重复图片');
        assert.ok(!seenPrompts[1][0].text.includes('MMMM'), '第二轮自动转为轻量续推指令，不再把 600 字正文重复塞进 ACP 会话');
      } finally {
        gw.close();
        try { fs.rmSync(ddDir, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    });

    await check('high-context consecutive tool bursts complete immediately without deadlocks or artificial stalls', async () => {
      const p = await (async () => { const s = net.createServer(); await new Promise((r) => s.listen(0, '127.0.0.1', r)); const pt = s.address().port; await new Promise((r) => s.close(r)); return pt; })();
      let mcpUrlSeen = '';
      let acpRef;
      const logs = [];
      const acpMock = {
        policyBySession: new Map(), start: async () => {}, discover: async () => {},
        cwdFor: async () => process.env.PI_SCRATCH_DIR || process.cwd(),
        resolveModel: (m) => m, status: () => ({ running: true, ready: true }),
        notify: () => {},
        request: async (method, params) => {
          if (method === 'session/new') {
            mcpUrlSeen = params.mcpServers?.[0]?.url || '';
            return { sessionId: 'pace-sess-1', models: { currentModelId: 'test', availableModels: [] } };
          }
          if (method === 'session/prompt') {
            acpRef.onNotification({
              method: 'session/update',
              params: { sessionId: 'pace-sess-1', update: { sessionUpdate: 'usage_update', used: 220000, size: 1048576 } },
            });
            for (let i = 1; i <= 4; i += 1) {
              const toolResp = await fetch(mcpUrlSeen, {
                method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
                body: JSON.stringify({ jsonrpc: '2.0', id: i, method: 'tools/call', params: { name: 'Read', arguments: { step: i } } }),
              });
              await toolResp.text();
            }
            acpRef.onNotification({
              method: 'session/update',
              params: { sessionId: 'pace-sess-1', update: { sessionUpdate: 'agent_message_chunk', content: { text: '四轮工具微节流完成' } } },
            });
            return { stopReason: 'end_turn' };
          }
          return {};
        },
      };
      acpRef = acpMock;
      const pcDir = path.join(process.env.PI_SCRATCH_DIR || process.cwd(), `gateway-pc-${Date.now()}`);
      const pcCfg = { ...config, promptTimeoutMs: 15000, promptIdleTimeoutMs: 15000, highContextThrottleTokens: 160000, highContextThrottleMs: 260, source: path.join(pcDir, 'config.json') };
      const gw = createGateway({ acp: acpMock, limiter: { run: (f) => f(), stats: () => ({}) }, getConfig: () => pcCfg, log: (m) => logs.push(m) });
      await gw.listen([p]);
      try {
        const input = [{ role: 'user', content: '连续调用工具测试' }];
        const tools = [{ type: 'function', name: 'Read', parameters: { type: 'object', properties: {} } }];
        for (let round = 0; round < 5; round += 1) {
          const r = await fetch(`http://127.0.0.1:${p}/v1/responses`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ model: 'test', stream: true, prompt_cache_key: 'pace-conv', tools, input }),
          });
          const sse = await r.text();
          if (round < 4) {
            const matches = [...sse.matchAll(/"call_id":"([^"]+)"/g)];
            assert.ok(matches.length > 0, `第 ${round + 1} 轮应返回 function_call，实际: ${sse.slice(-300)}`);
            const cid = matches[matches.length - 1][1];
            input.push({ type: 'function_call', call_id: cid, name: 'Read', arguments: '{}' });
            input.push({ type: 'function_call_output', call_id: cid, output: `ok-${round + 1}` });
          } else {
            assert.ok(sse.includes('四轮工具微节流完成'), '最终轮正常输出汇总文本');
          }
        }
        assert.ok(!logs.some((l) => l.includes('QUEUE_TIMEOUT')), '运行过程中不得出现队列超时');
      } finally {
        gw.close();
        try { fs.rmSync(pcDir, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    });

    await check('bridged multi-tool burst recovers from post-tool 429 via cooldown and lightweight continuation', async () => {
      const p = await (async () => { const s = net.createServer(); await new Promise((r) => s.listen(0, '127.0.0.1', r)); const pt = s.address().port; await new Promise((r) => s.close(r)); return pt; })();
      let mcpUrlSeen = '';
      let acpRef;
      const seenPrompts = [];
      const acpMock = {
        policyBySession: new Map(), start: async () => {}, discover: async () => {},
        cwdFor: async () => process.env.PI_SCRATCH_DIR || process.cwd(),
        resolveModel: (m) => m, status: () => ({ running: true, ready: true }),
        notify: () => {},
        request: async (method, params) => {
          if (method === 'session/new') {
            mcpUrlSeen = params.mcpServers?.[0]?.url || '';
            return { sessionId: 'post-tool-429', models: { currentModelId: 'test', availableModels: [] } };
          }
          if (method === 'session/prompt') {
            seenPrompts.push(params.prompt);
            if (seenPrompts.length === 1) {
              acpRef.onNotification({
                method: 'session/update',
                params: { sessionId: 'post-tool-429', update: { sessionUpdate: 'agent_message_chunk', content: { text: '先读取文件排查' } } },
              });
              for (let i = 1; i <= 5; i += 1) {
                acpRef.onNotification({
                  method: 'session/update',
                  params: { sessionId: 'post-tool-429', update: { sessionUpdate: 'tool_call', toolCallId: `tc-${i}`, kind: 'read', title: `Read ${i}` } },
                });
                const r = await fetch(mcpUrlSeen, {
                  method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
                  body: JSON.stringify({ jsonrpc: '2.0', id: i, method: 'tools/call', params: { name: 'Read', arguments: { step: i } } }),
                });
                await r.text();
              }
              throw Object.assign(new Error('429 RESOURCE_EXHAUSTED: tokens per minute exceeded'), { acp: { code: 429 } });
            }
            acpRef.onNotification({
              method: 'session/update',
              params: { sessionId: 'post-tool-429', update: { sessionUpdate: 'agent_message_chunk', content: { text: '五轮工具后冷却恢复完成' } } },
            });
            return { stopReason: 'end_turn' };
          }
          return {};
        },
      };
      acpRef = acpMock;
      const dir = path.join(process.env.PI_SCRATCH_DIR || process.cwd(), `gateway-pt429-${Date.now()}`);
      const cfgPt = { ...config, rateLimitMaxRetries: 2, rateLimitRetryBaseMs: 80, highContextThrottleTokens: 0, source: path.join(dir, 'config.json') };
      const gw = createGateway({ acp: acpMock, limiter: { run: (f) => f(), stats: () => ({}) }, getConfig: () => cfgPt, log: () => {} });
      await gw.listen([p]);
      try {
        const input = [{ role: 'user', content: '执行五步连续读取' }];
        const tools = [{ type: 'function', name: 'Read', parameters: { type: 'object', properties: {} } }];
        let finalSse = '';
        for (let round = 0; round < 6; round += 1) {
          const r = await fetch(`http://127.0.0.1:${p}/v1/responses`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ model: 'test', stream: true, prompt_cache_key: 'pt429-conv', tools, input }),
          });
          const sse = await r.text();
          if (round < 5) {
            const matches = [...sse.matchAll(/"call_id":"([^"]+)"/g)];
            assert.ok(matches.length > 0, `round ${round + 1} expected tool call, got: ${sse.slice(-300)}`);
            const cid = matches[matches.length - 1][1];
            input.push({ type: 'function_call', call_id: cid, name: 'Read', arguments: '{}' });
            input.push({ type: 'function_call_output', call_id: cid, output: `res-${round + 1}` });
          } else {
            finalSse = sse;
          }
        }
        assert.equal(seenPrompts.length, 2, '5 次工具回填后撞 429 必须进入冷却并自动续推');
        assert.ok(finalSse.includes('触发上游速率限制（429）'), '续流 HTTP 响应包含 429 冷却提示');
        assert.ok(finalSse.includes('五轮工具后冷却恢复完成'), '冷却重试后正常返回最终答案');
        assert.ok(!finalSse.includes('response.failed'), '不应向宿主输出 response.failed');
      } finally {
        gw.close();
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    });

    await check('deduplication preserves state across stopReason=cancelled and revokes state on pre-dispatch queue cancel', async () => {
      const p = await (async () => { const s = net.createServer(); await new Promise((r) => s.listen(0, '127.0.0.1', r)); const pt = s.address().port; await new Promise((r) => s.close(r)); return pt; })();
      const seenPrompts = [];
      let releaseBlocker;
      const blockerGate = new Promise((r) => { releaseBlocker = r; });
      let blockerEntered;
      const blockerStarted = new Promise((r) => { blockerEntered = r; });
      let cancelResolve;
      let acpRef;
      const acpMock = {
        policyBySession: new Map(), start: async () => {}, discover: async () => {},
        cwdFor: async () => process.env.PI_SCRATCH_DIR || process.cwd(),
        resolveModel: (m) => m, status: () => ({ running: true, ready: true }),
        notify: (method) => {
          if (method === 'session/cancel' && cancelResolve) cancelResolve();
        },
        request: async (method, params) => {
          if (method === 'session/new') {
            return { sessionId: `s-${Math.random().toString(36).slice(2, 8)}`, models: { currentModelId: 'test', availableModels: [] } };
          }
          if (method === 'session/prompt') {
            const text0 = params.prompt?.[0]?.text || '';
            if (text0.includes('BLOCKER_TURN')) {
              blockerEntered();
              await blockerGate;
              acpRef.onNotification({ method: 'session/update', params: { sessionId: params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { text: 'ok' } } } });
              return { stopReason: 'end_turn' };
            }
            seenPrompts.push({ sid: params.sessionId, prompt: params.prompt });
            if (text0.includes('CANCEL_RESOLVE_TEST') && seenPrompts.filter((x) => x.sid === params.sessionId).length === 1) {
              await new Promise((r) => { cancelResolve = r; });
              return { stopReason: 'cancelled' };
            }
            acpRef.onNotification({ method: 'session/update', params: { sessionId: params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { text: 'done' } } } });
            return { stopReason: 'end_turn' };
          }
          return {};
        },
      };
      acpRef = acpMock;
      // 串行限流器（concurrency = 1）验证排队中取消不会误标已投递
      let chain = Promise.resolve();
      const serialLimiter = {
        run: (fn) => {
          const next = chain.then(() => fn());
          chain = next.catch(() => {});
          return next;
        },
        stats: () => ({ active: 1 }),
      };
      const dir = path.join(process.env.PI_SCRATCH_DIR || process.cwd(), `gateway-qcancel-${Date.now()}`);
      const gw = createGateway({ acp: acpMock, limiter: serialLimiter, getConfig: () => ({ ...config, source: path.join(dir, 'config.json') }), log: () => {} });
      await gw.listen([p]);
      const imgUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
      try {
        // 1) 排队期间被取消（ACP 收到 0 次该请求的 prompt）→ 重试时必须发完整正文与图片
        const bReq = fetch(`http://127.0.0.1:${p}/v1/responses`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'test', stream: true, prompt_cache_key: 'blocker-k', input: 'BLOCKER_TURN' }),
        }).then((r) => r.text());
        await blockerStarted;
        const qAbort = new AbortController();
        const qBody = {
          model: 'test', stream: true, prompt_cache_key: 'queued-conv',
          input: [{ role: 'user', content: [{ type: 'input_text', text: 'QUEUED_ORIGINAL_BODY_' + 'Q'.repeat(200) }, { type: 'input_image', image_url: imgUrl }] }],
        };
        const qResp = await fetch(`http://127.0.0.1:${p}/v1/responses`, {
          method: 'POST', signal: qAbort.signal, headers: { 'content-type': 'application/json' },
          body: JSON.stringify(qBody),
        });
        const qReading = qResp.text().catch(() => {});
        await new Promise((r) => setTimeout(r, 50));
        qAbort.abort();
        await qReading;
        await new Promise((r) => setTimeout(r, 60));
        releaseBlocker();
        await bReq;
        await new Promise((r) => setTimeout(r, 50));
        assert.equal(seenPrompts.length, 0, '排队取消的请求不应向 ACP 发送任何 prompt');

        const retryQueued = await fetch(`http://127.0.0.1:${p}/v1/responses`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify(qBody),
        }).then((r) => r.text());
        assert.ok(retryQueued.includes('done'));
        assert.equal(seenPrompts.length, 1);
        assert.ok(seenPrompts[0].prompt.some((b) => b.type === 'image'), '排队取消后重试必须完整发送原始图片');
        assert.ok(seenPrompts[0].prompt.some((b) => (b.text || '').includes('QUEUED_ORIGINAL_BODY_')), '排队取消后重试必须完整发送原始正文');

        // 2) HTTP 断连 → session/cancel → ACP 正常 resolve { stopReason: 'cancelled' } → 宿主原样重试必须去重
        const cBody = {
          model: 'test', stream: true, prompt_cache_key: 'cancel-resolve-conv',
          input: [{ role: 'user', content: [{ type: 'input_text', text: 'CANCEL_RESOLVE_TEST_' + 'C'.repeat(200) }, { type: 'input_image', image_url: imgUrl }] }],
        };
        const cAbort = new AbortController();
        const cFetch = fetch(`http://127.0.0.1:${p}/v1/responses`, {
          method: 'POST', signal: cAbort.signal, headers: { 'content-type': 'application/json' },
          body: JSON.stringify(cBody),
        }).then((r) => r.text()).catch(() => {});
        await new Promise((r) => setTimeout(r, 60));
        cAbort.abort();
        await cFetch;
        await new Promise((r) => setTimeout(r, 60));

        const cRetry = await fetch(`http://127.0.0.1:${p}/v1/responses`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify(cBody),
        }).then((r) => r.text());
        assert.ok(cRetry.includes('done'));
        const cancelPrompts = seenPrompts.slice(1);
        assert.equal(cancelPrompts.length, 2);
        assert.ok(cancelPrompts[0].prompt.some((b) => b.type === 'image'), '首次尝试携带图片');
        assert.ok(!cancelPrompts[1].prompt.some((b) => b.type === 'image'), 'stopReason=cancelled 后原样重试必须剥离重复图片');
        assert.ok(!(cancelPrompts[1].prompt[0].text || '').includes('CCCC'), 'stopReason=cancelled 后原样重试必须转为轻量续推');
      } finally {
        gw.close();
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    });

    await check('steering during 429 cooldown and disconnect during micro-throttle abort immediately without stale execution', async () => {
      const p = await (async () => { const s = net.createServer(); await new Promise((r) => s.listen(0, '127.0.0.1', r)); const pt = s.address().port; await new Promise((r) => s.close(r)); return pt; })();
      let mcpUrlSeen = '';
      let acpRef;
      const callOrder = [];
      const cancelledSids = [];
      let modelContinuedAfterThrottleAbort = false;
      const acpMock = {
        policyBySession: new Map(), start: async () => {}, discover: async () => {},
        cwdFor: async () => process.env.PI_SCRATCH_DIR || process.cwd(),
        resolveModel: (m) => m, status: () => ({ running: true, ready: true }),
        notify: (method, params) => {
          if (method === 'session/cancel' && params?.sessionId) cancelledSids.push(params.sessionId);
        },
        request: async (method, params) => {
          if (method === 'session/new') {
            mcpUrlSeen = params.mcpServers?.[0]?.url || '';
            return { sessionId: `st-${callOrder.length + 1}`, models: { currentModelId: 'test', availableModels: [] } };
          }
          if (method === 'session/prompt') {
            const txt = params.prompt?.map((b) => b.text || '').join('') || '';
            callOrder.push(txt);
            if (txt.includes('OLD_429_REQUEST')) {
              throw Object.assign(new Error('429 rate limit exceeded, retry after 3s'), { acp: { code: 429 } });
            }
            if (txt.includes('THROTTLE_ABORT_TEST')) {
              acpRef.onNotification({
                method: 'session/update',
                params: { sessionId: params.sessionId, update: { sessionUpdate: 'usage_update', used: 220000, size: 1048576 } },
              });
              for (let i = 1; i <= 4; i += 1) {
                const r = await fetch(mcpUrlSeen, {
                  method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
                  body: JSON.stringify({ jsonrpc: '2.0', id: i, method: 'tools/call', params: { name: 'Read', arguments: { step: i } } }),
                });
                const raw = await r.text();
                if (i === 4 && raw.includes('"result"') && !raw.includes('"isError":true')) {
                  modelContinuedAfterThrottleAbort = true;
                }
              }
              return { stopReason: 'cancelled' };
            }
            acpRef.onNotification({
              method: 'session/update',
              params: { sessionId: params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { text: 'NEW_STEER_OK' } } },
            });
            return { stopReason: 'end_turn' };
          }
          return {};
        },
      };
      acpRef = acpMock;
      const dir = path.join(process.env.PI_SCRATCH_DIR || process.cwd(), `gateway-steer-cool-${Date.now()}`);
      const cfgSc = { ...config, rateLimitMaxRetries: 3, rateLimitRetryBaseMs: 3000, highContextThrottleTokens: 160000, highContextThrottleMs: 1200, source: path.join(dir, 'config.json') };
      const gw = createGateway({ acp: acpMock, limiter: { run: (f) => f(), stats: () => ({}) }, getConfig: () => cfgSc, log: () => {} });
      await gw.listen([p]);
      const tools = [{ type: 'function', name: 'Read', parameters: { type: 'object', properties: {} } }];
      try {
        // A) 429 冷却等待期间发来新 Steering 指令：必须立即打断旧冷却，绝不能先跑「请继续完成上一条请求」
        const oldReq = fetch(`http://127.0.0.1:${p}/v1/responses`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'test', stream: true, prompt_cache_key: 'steer-cool-1', tools, input: [{ role: 'user', content: 'OLD_429_REQUEST' }] }),
        }).then((r) => r.text()).catch(() => '');
        await new Promise((r) => setTimeout(r, 120));
        const t0 = Date.now();
        const steerRes = await fetch(`http://127.0.0.1:${p}/v1/responses`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'test', stream: true, prompt_cache_key: 'steer-cool-1', tools, input: [{ role: 'user', content: 'OLD_429_REQUEST' }, { role: 'user', content: 'NEW_STEER_DIRECTIVE' }] }),
        }).then((r) => r.text());
        const steerElapsed = Date.now() - t0;
        await oldReq;
        assert.ok(steerRes.includes('NEW_STEER_OK'), 'Steering 新请求正常完成');
        assert.ok(steerElapsed < 1500, `Steering 必须立即唤醒并终止 3s 冷却，实际耗时 ${steerElapsed}ms`);
        assert.equal(callOrder.length, 2, `上游调用顺序只能是 [旧请求, 新请求]，不能出现旧请求续推: ${JSON.stringify(callOrder)}`);
        assert.ok(callOrder[1].includes('NEW_STEER_DIRECTIVE'));

        // B) 第 4 轮高上下文工具回填进入 1.2s 微节流期间客户端点击停止：不得回填结果继续模型，且必须下发 session/cancel
        const tInput = [{ role: 'user', content: 'THROTTLE_ABORT_TEST' }];
        for (let round = 0; round < 3; round += 1) {
          const r = await fetch(`http://127.0.0.1:${p}/v1/responses`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ model: 'test', stream: true, prompt_cache_key: 'throttle-abort-conv', tools, input: tInput }),
          });
          const sse = await r.text();
          const cid = [...sse.matchAll(/"call_id":"([^"]+)"/g)].pop()[1];
          tInput.push({ type: 'function_call', call_id: cid, name: 'Read', arguments: '{}' });
          tInput.push({ type: 'function_call_output', call_id: cid, output: `r-${round + 1}` });
        }
        // 第 4 轮刚收到第 4 个 tool_call，现回填第 4 个结果并在微节流期间断开
        const r4 = await fetch(`http://127.0.0.1:${p}/v1/responses`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'test', stream: true, prompt_cache_key: 'throttle-abort-conv', tools, input: tInput }),
        });
        const sse4 = await r4.text();
        const cid4 = [...sse4.matchAll(/"call_id":"([^"]+)"/g)].pop()[1];
        tInput.push({ type: 'function_call', call_id: cid4, name: 'Read', arguments: '{}' });
        tInput.push({ type: 'function_call_output', call_id: cid4, output: 'r-4-should-not-resolve' });

        cancelledSids.length = 0;
        const abort4 = new AbortController();
        const resume4 = fetch(`http://127.0.0.1:${p}/v1/responses`, {
          method: 'POST', signal: abort4.signal, headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'test', stream: true, prompt_cache_key: 'throttle-abort-conv', tools, input: tInput }),
        }).then((r) => r.text()).catch(() => {});
        await new Promise((r) => setTimeout(r, 90));
        abort4.abort();
        await resume4;
        await new Promise((r) => setTimeout(r, 80));
        assert.equal(modelContinuedAfterThrottleAbort, false, '微节流期间断连绝不能把工具结果正常 resolve 给模型继续跑');
        assert.ok(cancelledSids.length >= 1, '微节流期间断连必须向 ACP 发送 session/cancel');
      } finally {
        gw.close();
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    });

    await check('modified inline document after failure is not misclassified as duplicate and config panel binds all new fields', async () => {
      const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'config.html'), 'utf8');
      for (const fieldId of ['rateLimitMaxRetries', 'rateLimitRetryBaseSeconds', 'highContextThrottleTokens', 'highContextThrottleMs']) {
        assert.ok(html.includes(`id="${fieldId}"`), `config.html 缺少控件 #${fieldId}`);
        assert.ok(html.includes(`'${fieldId}'`), `config.html 读写 ids 列表缺少 ${fieldId}`);
      }
      assert.ok(html.includes('默认 300'), 'config.html 应更新无进展判定默认值为 300 秒');

      const p = await (async () => { const s = net.createServer(); await new Promise((r) => s.listen(0, '127.0.0.1', r)); const pt = s.address().port; await new Promise((r) => s.close(r)); return pt; })();
      const seenBlocks = [];
      let acpRef;
      const acpMock = {
        policyBySession: new Map(), start: async () => {}, discover: async () => {},
        cwdFor: async () => process.env.PI_SCRATCH_DIR || process.cwd(),
        resolveModel: (m) => m, status: () => ({ running: true, ready: true }),
        notify: () => {},
        request: async (method, params) => {
          if (method === 'session/new') return { sessionId: `doc-s-${seenBlocks.length + 1}`, models: { currentModelId: 'test', availableModels: [] } };
          if (method === 'session/prompt') {
            seenBlocks.push(params.prompt);
            if (seenBlocks.length === 1) throw new Error('network glitch');
            acpRef.onNotification({ method: 'session/update', params: { sessionId: params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { text: 'updated doc read' } } } });
            return { stopReason: 'end_turn' };
          }
          return {};
        },
      };
      acpRef = acpMock;
      const dir = path.join(process.env.PI_SCRATCH_DIR || process.cwd(), `gateway-docfp-${Date.now()}`);
      const gw = createGateway({ acp: acpMock, limiter: { run: (f) => f(), stats: () => ({}) }, getConfig: () => ({ ...config, source: path.join(dir, 'config.json') }), log: () => {} });
      await gw.listen([p]);
      try {
        const sendDoc = (inlineContent) => fetch(`http://127.0.0.1:${p}/v1/responses`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: 'test', stream: true, prompt_cache_key: 'doc-edit-conv',
            input: [{
              role: 'user',
              content: [
                { type: 'input_text', text: '请审阅这份同名规范' },
                { type: 'input_file', filename: 'spec.md', file_data: `data:text/markdown;base64,${Buffer.from(inlineContent, 'utf8').toString('base64')}` },
              ],
            }],
          }),
        }).then((r) => r.text());
        const r1 = await sendDoc('版本一内容：旧阈值 100');
        assert.ok(r1.includes('response.failed'));
        const r2 = await sendDoc('版本二内容：新阈值 999');
        assert.ok(r2.includes('updated doc read'));
        assert.equal(seenBlocks.length, 2);
        const secondAllText = JSON.stringify(seenBlocks[1]);
        assert.ok(!secondAllText.includes('请继续完成上一条请求'), '修改同名内联文档内容后绝不能误判为相同请求去重');
        assert.ok(seenBlocks[1].some((b) => b.type === 'resource_link' || (b.text || '').includes('版本二内容')), `修改后的文档必须实际投递给 ACP，实际 blocks: ${secondAllText}`);
      } finally {
        gw.close();
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    });

    await check('SSE protocol keepalive continues emitting data frames after partial text without masking real stalls', async () => {
      const p = await (async () => { const s = net.createServer(); await new Promise((r) => s.listen(0, '127.0.0.1', r)); const pt = s.address().port; await new Promise((r) => s.close(r)); return pt; })();
      let acpRef;
      const acpMock = {
        policyBySession: new Map(), start: async () => {}, discover: async () => {},
        cwdFor: async () => process.env.PI_SCRATCH_DIR || process.cwd(),
        resolveModel: (m) => m, status: () => ({ running: true, ready: true }),
        notify: () => {},
        request: async (method, params) => {
          if (method === 'session/new') return { sessionId: `ka-s-${Math.random().toString(36).slice(2, 7)}`, models: { currentModelId: 'test', availableModels: [] } };
          if (method === 'session/prompt') {
            acpRef.onNotification({ method: 'session/update', params: { sessionId: params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { text: '先说半句…' } } } });
            await new Promise((r) => setTimeout(r, 230));
            acpRef.onNotification({ method: 'session/update', params: { sessionId: params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { text: '后半句完成' } } } });
            return { stopReason: 'end_turn' };
          }
          return {};
        },
      };
      acpRef = acpMock;
      const dir = path.join(process.env.PI_SCRATCH_DIR || process.cwd(), `gateway-pka-${Date.now()}`);
      const gw = createGateway({ acp: acpMock, limiter: { run: (f) => f(), stats: () => ({}) }, getConfig: () => ({ ...config, protocolKeepaliveMs: 80, source: path.join(dir, 'config.json') }), log: () => {} });
      await gw.listen([p]);
      try {
        const respSse = await fetch(`http://127.0.0.1:${p}/v1/responses`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'test', stream: true, prompt_cache_key: 'pka-resp', input: '测 responses 半途静默保活' }),
        }).then((r) => r.text());
        const inProgCount = [...respSse.matchAll(/event:\s*response\.in_progress/g)].length;
        assert.ok(inProgCount >= 2, `吐过正文后静默期仍应持续下发 response.in_progress 协议帧，实际次数=${inProgCount}`);
        assert.ok(respSse.includes('后半句完成'));

        const chatSse = await fetch(`http://127.0.0.1:${p}/v1/chat/completions`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'test', stream: true, user: 'pka-chat', messages: [{ role: 'user', content: '测 chat 半途静默保活' }] }),
        }).then((r) => r.text());
        const emptyDeltaCount = [...chatSse.matchAll(/"delta":\{\},"finish_reason":null/g)].length;
        assert.ok(emptyDeltaCount >= 1, `Chat 流吐过正文后静默期应下发空 delta 协议保活帧，实际次数=${emptyDeltaCount}`);
        assert.ok(chatSse.includes('后半句完成'));
      } finally {
        gw.close();
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    });

    await check('compaction resets session and re-injects full system instructions and compaction summary', async () => {
      const p = await (async () => { const s = net.createServer(); await new Promise((r) => s.listen(0, '127.0.0.1', r)); const pt = s.address().port; await new Promise((r) => s.close(r)); return pt; })();
      const seenSids = [];
      const seenPrompts = [];
      let acpRef;
      const acpMock = {
        policyBySession: new Map(), start: async () => {}, discover: async () => {},
        cwdFor: async () => process.env.PI_SCRATCH_DIR || process.cwd(),
        resolveModel: (m) => m, status: () => ({ running: true, ready: true }),
        notify: () => {},
        request: async (method, params) => {
          if (method === 'session/new') {
            const sid = `comp-s-${seenSids.length + 1}`;
            seenSids.push(sid);
            return { sessionId: sid, models: { currentModelId: 'test', availableModels: [] } };
          }
          if (method === 'session/prompt') {
            seenPrompts.push({ sid: params.sessionId, prompt: params.prompt });
            acpRef.onNotification({ method: 'session/update', params: { sessionId: params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { text: `resp-${seenPrompts.length}` } } } });
            return { stopReason: 'end_turn' };
          }
          return {};
        },
      };
      acpRef = acpMock;
      const dir = path.join(process.env.PI_SCRATCH_DIR || process.cwd(), `gateway-comp-${Date.now()}`);
      const gw = createGateway({ acp: acpMock, limiter: { run: (f) => f(), stats: () => ({}) }, getConfig: () => ({ ...config, source: path.join(dir, 'config.json') }), log: () => {} });
      await gw.listen([p]);
      try {
        const sys = '## System Instructions\nYou are PI-Desktop. Available subagents: research, reviewer-gpt.';
        // Round 1: 初次提问，必须包含完整系统指令
        const r1 = await fetch(`http://127.0.0.1:${p}/v1/responses`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'test', stream: true, prompt_cache_key: 'comp-conv', instructions: sys, input: 'Round 1 question' }),
        }).then((r) => r.text());
        assert.ok(r1.includes('resp-1'));
        assert.equal(seenSids.length, 1);
        const p1Text = JSON.stringify(seenPrompts[0].prompt);
        assert.ok(p1Text.includes('System Instructions'), '第一轮必须注入系统指令');
        assert.ok(p1Text.includes('reviewer-gpt'), '第一轮必须包含子 Agent 说明');

        // Round 2: 宿主发生 Compaction 压缩，带上 <summary> 块并保留系统指令
        const compSummary = 'The conversation history before this point was compacted into the following summary:\n\n<summary>\nRound 1 was about testing system prompt retention.\n</summary>';
        const r2 = await fetch(`http://127.0.0.1:${p}/v1/responses`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: 'test', stream: true, prompt_cache_key: 'comp-conv', instructions: sys,
            input: [
              { role: 'user', content: compSummary },
              { role: 'user', content: 'Round 2 question after compact' },
            ],
          }),
        }).then((r) => r.text());
        assert.ok(r2.includes('resp-2'));
        // 关键断言：检测到 Compaction 后必须重置底层会话（新建 session/new，不污染旧会话）
        assert.equal(seenSids.length, 2, '压缩后必须新建会话重置底层状态');
        assert.notEqual(seenPrompts[1].sid, seenPrompts[0].sid, '压缩后的新轮次必须使用全新 session ID');
        const p2Text = JSON.stringify(seenPrompts[1].prompt);
        assert.ok(p2Text.includes('System Instructions'), '压缩后必须重新注入完整系统指令');
        assert.ok(p2Text.includes('reviewer-gpt'), '压缩后必须重新注入子 Agent 说明');
        assert.ok(p2Text.includes('Compaction Summary'), '压缩后必须包含压缩摘要专段');
        assert.ok(p2Text.includes('Round 1 was about testing'), '压缩后必须包含具体摘要内容');
        assert.ok(p2Text.includes('Round 2 question after compact'), '压缩后必须包含当前提问');

        // Round 3: 系统指令变更（如动态启用新 Skill/Agent），必须再次重置会话并刷新指令
        const updatedSys = '## System Instructions V2\nUpdated subagent: security-auditor.';
        const r3 = await fetch(`http://127.0.0.1:${p}/v1/responses`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: 'test', stream: true, prompt_cache_key: 'comp-conv', instructions: updatedSys,
            input: [
              { role: 'user', content: compSummary },
              { role: 'user', content: 'Round 3 question with new system' },
            ],
          }),
        }).then((r) => r.text());
        assert.ok(r3.includes('resp-3'));
        assert.equal(seenSids.length, 3, '系统指令变更后必须重新建会话');
        const p3Text = JSON.stringify(seenPrompts[2].prompt);
        assert.ok(p3Text.includes('security-auditor'), '系统指令变更后必须注入新指令');
      } finally {
        gw.close();
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    });

    await check('reportedContextWindow regulates context_window in modelsForApi and binds to config panel', async () => {
      const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'config.html'), 'utf8');
      assert.ok(html.includes('id="reportedContextWindow"'), 'config.html 必须包含 #reportedContextWindow 控件');
      assert.ok(html.includes("'reportedContextWindow'"), 'config.html ids 数组必须包含 reportedContextWindow');

      const { AcpRuntime } = require('../lib/core.js');
      const rt1 = new AcpRuntime({ getConfig: () => ({ reportedContextWindow: 200000, virtualModels: true }) });
      rt1.ingestModels([
        { modelId: 'gemini-4-carbon-high', name: 'gemini-4-carbon (high)' },
      ]);
      rt1.discover = async () => rt1.discovery;
      const list1 = await rt1.modelsForApi();
      const m1 = list1.find((x) => x.id === 'gemini-4-carbon');
      assert.ok(m1, '找到 gemini-4-carbon');
      assert.equal(m1.context_window, 200000, '必须正确返回上报的 200000 context_window');

      const rt2 = new AcpRuntime({ getConfig: () => ({ reportedContextWindow: 0, virtualModels: true }) });
      rt2.ingestModels([
        { modelId: 'gemini-4-carbon-high', name: 'gemini-4-carbon (high)' },
      ]);
      rt2.discover = async () => rt2.discovery;
      const list2 = await rt2.modelsForApi();
      const m2 = list2.find((x) => x.id === 'gemini-4-carbon');
      assert.equal(m2.context_window, 1048576, '配置为 0 时回退原生 1048576 context_window');
    });

    await check('MUTATION_RETRY_BUDGET_EXHAUSTED: parked tool error + user continuation coalesces without cancel and never deadlocks concurrency=1 compaction', async () => {
      const p = await (async () => { const s = net.createServer(); await new Promise((r) => s.listen(0, '127.0.0.1', r)); const pt = s.address().port; await new Promise((r) => s.close(r)); return pt; })();
      const dir = path.join(process.env.PI_SCRATCH_DIR || process.cwd(), `gw-mut-budget-${Date.now()}`);
      const { createLimiter } = require('../lib/core.js');
      const lim = createLimiter({ limit: 1, maxQueue: 4, queueTimeoutMs: 350 });
      const createdSids = [];
      const cancelsSent = [];
      const promptCalls = [];
      const mcpToolOutputs = [];
      let acpRef;
      const acpMock = {
        policyBySession: new Map(), start: async () => {}, discover: async () => {},
        cwdFor: async () => process.env.PI_SCRATCH_DIR || process.cwd(),
        resolveModel: (m) => m, status: () => ({ running: true, ready: true }),
        notify: (method, params) => {
          if (method === 'session/cancel') cancelsSent.push(params.sessionId);
        },
        request: async (method, params) => {
          if (method === 'session/new') {
            const sid = `mut-sid-${createdSids.length + 1}`;
            createdSids.push({ sid, mcpUrl: params.mcpServers?.[0]?.url || '' });
            return { sessionId: sid, models: { currentModelId: 'test', availableModels: [] } };
          }
          if (method === 'session/close') return {};
          if (method === 'session/prompt') {
            const sid = params.sessionId;
            promptCalls.push({ sid, prompt: params.prompt });
            const entry = createdSids.find((x) => x.sid === sid);
            const pText = JSON.stringify(params.prompt);
            if (pText.includes('context summarization assistant') || pText.includes('Summarize the entire conversation')) {
              acpRef.onNotification({
                method: 'session/update',
                params: { sessionId: sid, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '## Goal\nRefactor limiter safely' } } },
              });
              return { stopReason: 'end_turn' };
            }
            if (entry && entry.mcpUrl && promptCalls.filter((x) => x.sid === sid).length === 1) {
              const sseRes = await fetch(entry.mcpUrl, {
                method: 'POST', headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'Edit', arguments: { path: 'lib/core.js', tag: 'DEAD', ops: 'PUT 1.=1:\n+x' } } }),
              });
              const rawToolReply = await sseRes.text();
              mcpToolOutputs.push({ sid, rawToolReply });
              if (rawToolReply.includes('继续修复')) {
                acpRef.onNotification({
                  method: 'session/update',
                  params: { sessionId: sid, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '已重新读取并使用窄锚点修复成功' } } },
                });
              }
              return { stopReason: 'end_turn' };
            }
            acpRef.onNotification({
              method: 'session/update',
              params: { sessionId: sid, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '后续轮次正常续接' } } },
            });
            return { stopReason: 'end_turn' };
          }
          return {};
        },
      };
      acpRef = acpMock;
      const gw = createGateway({
        acp: acpMock, limiter: lim,
        getConfig: () => ({ ...config, concurrency: 1, source: path.join(dir, 'config.json') }),
        log: () => {},
      });
      await gw.listen([p]);
      const tools = [{
        type: 'function', name: 'Edit',
        parameters: { type: 'object', required: ['path', 'tag', 'ops'], properties: { path: { type: 'string' }, tag: { type: 'string' }, ops: { type: 'string' } } },
      }];
      try {
        // 场景 A：第 3 次 Edit 失败触发宿主本地中止（MUTATION_RETRY_BUDGET_EXHAUSTED），用户点击「继续」
        const r1 = await fetch(`http://127.0.0.1:${p}/v1/responses`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'test', stream: true, prompt_cache_key: 'mut-key-a', tools, input: [{ role: 'user', content: '修改 core.js' }] }),
        }).then((r) => r.text());
        const callIdMatch = /"call_id":"(call_[^"]+)"/.exec(r1);
        assert.ok(callIdMatch, `首轮应挂起并返回 Edit function_call，实际: ${r1}`);
        const callId1 = callIdMatch[1];
        assert.equal(lim.stats().active, 0, '挂起等待宿主期间必须释放 limiter 并发槽位');

        // 宿主附带本地失败的 tool_output + 用户「继续修复」消息发起新一轮请求
        const r2 = await fetch(`http://127.0.0.1:${p}/v1/responses`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: 'test', stream: true, prompt_cache_key: 'mut-key-a', tools,
            input: [
              { role: 'user', content: '修改 core.js' },
              { type: 'function_call', call_id: callId1, name: 'Edit', arguments: '{"path":"lib/core.js"}' },
              { type: 'function_call_output', call_id: callId1, output: 'Stopped after 3 failed Edit attempts on D:/tools/antigravity-acp/lib/core.js. Last error: INVALID_ARGUMENT.' },
              { role: 'user', content: '继续修复' },
            ],
          }),
        }).then((r) => r.text());
        assert.ok(r2.includes('已重新读取并使用窄锚点修复成功'), `合并续推应直接返回模型修复结果，实际: ${r2}`);
        assert.equal(cancelsSent.length, 0, '无损合并续推不得发送 session/cancel');
        assert.equal(createdSids.length, 1, '合并续推应复用同一在途会话');
        assert.ok(mcpToolOutputs[0].rawToolReply.includes('INVALID_ARGUMENT') && mcpToolOutputs[0].rawToolReply.includes('继续修复'), '底层 MCP 工具响应必须同时携带报错详情与用户继续指令');

        // 紧接着下一轮普通提问，验证 userHistory 已同步，不会误判为历史篡改重建会话
        const r3 = await fetch(`http://127.0.0.1:${p}/v1/responses`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: 'test', stream: true, prompt_cache_key: 'mut-key-a', tools,
            input: [
              { role: 'user', content: '修改 core.js' },
              { type: 'function_call', call_id: callId1, name: 'Edit', arguments: '{"path":"lib/core.js"}' },
              { type: 'function_call_output', call_id: callId1, output: 'Stopped after 3 failed Edit attempts' },
              { role: 'user', content: '继续修复' },
              { role: 'assistant', content: '已重新读取并使用窄锚点修复成功' },
              { role: 'user', content: '再确认一下状态' },
            ],
          }),
        }).then((r) => r.text());
        assert.ok(r3.includes('后续轮次正常续接'));
        assert.equal(createdSids.length, 1, '后续提问不得误触发分支重置');

        // 场景 B：单并发（limit=1）下挂起后触发阈值自动压缩（且压缩请求未携带 prompt_cache_key），绝不死锁报 AGENT_BUSY
        const rb1 = await fetch(`http://127.0.0.1:${p}/v1/responses`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'test', stream: true, prompt_cache_key: 'mut-key-b', tools, input: [{ role: 'user', content: 'refactor core limiter lease safely' }] }),
        }).then((r) => r.text());
        assert.ok(rb1.includes('"call_id":"call_'), '会话 B 挂起在工具调用上');
        assert.equal(lim.stats().active, 0, '会话 B 挂起时单并发槽位必须空闲');

        const compactRes = await fetch(`http://127.0.0.1:${p}/v1/responses`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: 'test', stream: false,
            instructions: 'You are a context summarization assistant.',
            input: [{ role: 'user', content: 'Summarize the entire conversation:\nUser: refactor core limiter lease safely\nAssistant: Edit failed 3 times' }],
          }),
        });
        assert.equal(compactRes.status, 200, '单并发下挂起期间发起自动压缩绝不能排队超时或死锁');
        const compactJson = await compactRes.json();
        assert.ok(JSON.stringify(compactJson).includes('Refactor limiter safely'));
        assert.equal(lim.stats().active, 0);
      } finally {
        gw.close();
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    });

    await check('orphaned parked turn watchdog releases lock and Concurrent receive_steps self-heals via cancel and session/load', async () => {
      const p = await (async () => { const s = net.createServer(); await new Promise((r) => s.listen(0, '127.0.0.1', r)); const pt = s.address().port; await new Promise((r) => s.close(r)); return pt; })();
      const dir = path.join(process.env.PI_SCRATCH_DIR || process.cwd(), `gw-orphan-recv-${Date.now()}`);
      const { createLimiter } = require('../lib/core.js');
      const lim = createLimiter({ limit: 1, maxQueue: 4, queueTimeoutMs: 2000 });
      let acpRef;
      let mcpUrlOrphan = '';
      let orphanCancelled = false;
      let recvConflictCount = 0;
      let loadCalled = 0;
      let closeCalled = 0;
      const acpMock = {
        policyBySession: new Map(), start: async () => {}, discover: async () => {},
        cwdFor: async () => process.env.PI_SCRATCH_DIR || process.cwd(),
        resolveModel: (m) => m, status: () => ({ running: true, ready: true }),
        notify: (method, params) => {
          if (method === 'session/cancel' && params.sessionId === 'orphan-sid') orphanCancelled = true;
        },
        request: async (method, params) => {
          if (method === 'session/new') {
            if (!mcpUrlOrphan && params.mcpServers?.[0]?.url) {
              mcpUrlOrphan = params.mcpServers[0].url;
              return { sessionId: 'orphan-sid', models: { currentModelId: 'test', availableModels: [] } };
            }
            return { sessionId: 'recv-sid', models: { currentModelId: 'test', availableModels: [] } };
          }
          if (method === 'session/close') { closeCalled += 1; return {}; }
          if (method === 'session/load') {
            loadCalled += 1;
            // 模拟 ACP session/load 重放历史正文：不得泄漏污染当前回答
            acpRef.onNotification({
              method: 'session/update',
              params: { sessionId: params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'OLD_HISTORY_NOT_CURRENT_ANSWER' } } },
            });
            return { models: { currentModelId: 'test' } };
          }
          if (method === 'session/set_model') return {};
          if (method === 'session/prompt') {
            if (params.sessionId === 'orphan-sid') {
              const sseRes = await fetch(mcpUrlOrphan, {
                method: 'POST', headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'Bash', arguments: { command: 'echo hi' } } }),
              });
              await sseRes.text();
              return { stopReason: 'cancelled' };
            }
            if (params.sessionId === 'recv-sid') {
              if (recvConflictCount < 2) {
                recvConflictCount += 1;
                throw new Error('Concurrent receive_steps() calls are not supported on this connection');
              }
              acpRef.onNotification({
                method: 'session/update',
                params: { sessionId: 'recv-sid', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'recovered from receive_steps conflict' } } },
              });
              return { stopReason: 'end_turn' };
            }
          }
          return {};
        },
      };
      acpRef = acpMock;
      const gw = createGateway({
        acp: acpMock, limiter: lim,
        getConfig: () => ({ ...config, parkedTimeoutMs: 140, promptIdleTimeoutMs: 4000, source: path.join(dir, 'config.json') }),
        log: () => {},
      });
      await gw.listen([p]);
      try {
        // 1. 孤儿挂起自动超时释放锁
        const rOrphan = await fetch(`http://127.0.0.1:${p}/v1/chat/completions`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: 'test', stream: true, prompt_cache_key: 'orphan-conv',
            tools: [{ type: 'function', function: { name: 'Bash', parameters: { type: 'object', properties: { command: { type: 'string' } } } } }],
            messages: [{ role: 'user', content: 'run bash' }],
          }),
        }).then((r) => r.text());
        assert.ok(rOrphan.includes('Bash'));
        assert.equal(gw.listSessions().find((s) => s.sessionId === 'orphan-sid')?.inflight, 1, '刚挂起时会话处于在途等待态');
        await new Promise((r) => setTimeout(r, 340));
        assert.equal(orphanCancelled, true, '超过 parkedTimeoutMs 未回填必须自动发送 session/cancel');
        assert.equal(gw.listSessions().find((s) => s.sessionId === 'orphan-sid')?.inflight, 0, '孤儿挂起回收后必须彻底释放在途计数与会话锁');

        // 2. Concurrent receive_steps 二阶自愈（第 1 次 cancel 等待重试，第 2 次 close + session/load 热重载恢复）
        const rRecv = await fetch(`http://127.0.0.1:${p}/v1/responses`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'test', stream: false, prompt_cache_key: 'recv-conv', input: 'hello after race' }),
        });
        assert.equal(rRecv.status, 200);
        const jRecv = await rRecv.json();
        const outText = JSON.stringify(jRecv);
        assert.ok(outText.includes('recovered from receive_steps conflict'));
        assert.ok(!outText.includes('OLD_HISTORY_NOT_CURRENT_ANSWER'), 'session/load 热重载期间重放的旧历史绝不能污染当前回答');
        assert.equal(recvConflictCount, 2);
        assert.equal(closeCalled, 1, '二次冲突应自动 close 旧 worker');
        assert.equal(loadCalled, 1, '二次冲突应自动 session/load 原地热重载会话');
      } finally {
        gw.close();
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    });

    await check('parked resume guards against duplicate concurrent resume, underlying crash slot leak, and multi-user trailing attachments', async () => {
      const p = await (async () => { const s = net.createServer(); await new Promise((r) => s.listen(0, '127.0.0.1', r)); const pt = s.address().port; await new Promise((r) => s.close(r)); return pt; })();
      const dir = path.join(process.env.PI_SCRATCH_DIR || process.cwd(), `gw-p1-guards-${Date.now()}`);
      const { createLimiter } = require('../lib/core.js');
      const lim = createLimiter({ limit: 1, maxQueue: 6, queueTimeoutMs: 400 });
      let acpRef;
      const sids = [];
      const promptsSeen = [];
      let rejectCrashSession = null;
      const acpMock = {
        policyBySession: new Map(), start: async () => {}, discover: async () => {},
        cwdFor: async () => process.env.PI_SCRATCH_DIR || process.cwd(),
        resolveModel: (m) => m, status: () => ({ running: true, ready: true }),
        notify: () => {},
        request: async (method, params) => {
          if (method === 'session/new') {
            const sid = `guard-sid-${sids.length + 1}`;
            sids.push({ sid, mcpUrl: params.mcpServers?.[0]?.url || '' });
            return { sessionId: sid, models: { currentModelId: 'test', availableModels: [] } };
          }
          if (method === 'session/close') return {};
          if (method === 'session/prompt') {
            const sid = params.sessionId;
            promptsSeen.push({ sid, prompt: params.prompt });
            const entry = sids.find((x) => x.sid === sid);
            if (sid === 'guard-sid-1') {
              const sseRes = await fetch(entry.mcpUrl, {
                method: 'POST', headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'Read', arguments: { path: 'a.txt' } } }),
              });
              await sseRes.text();
              acpRef.onNotification({
                method: 'session/update',
                params: { sessionId: sid, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'dup-safe-ok' } } },
              });
              return { stopReason: 'end_turn' };
            }
            if (sid === 'guard-sid-2') {
              const hold = await fetch(entry.mcpUrl, {
                method: 'POST', headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'Read', arguments: { path: 'b.txt' } } }),
              }).catch(() => null);
              await new Promise((_, rej) => { rejectCrashSession = rej; });
              hold?.body?.cancel?.().catch(() => {});
              return { stopReason: 'end_turn' };
            }
            if (sid === 'guard-sid-3') {
              if (promptsSeen.filter((x) => x.sid === sid).length === 1) {
                const sseRes = await fetch(entry.mcpUrl, {
                  method: 'POST', headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'Edit', arguments: { path: 'c.js' } } }),
                });
                await sseRes.text();
                return { stopReason: 'cancelled' };
              }
              acpRef.onNotification({
                method: 'session/update',
                params: { sessionId: sid, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'doc-preserved-ok' } } },
              });
              return { stopReason: 'end_turn' };
            }
            return { stopReason: 'end_turn' };
          }
          return {};
        },
      };
      acpRef = acpMock;
      const gw = createGateway({
        acp: acpMock, limiter: lim,
        getConfig: () => ({ ...config, concurrency: 1, source: path.join(dir, 'config.json') }),
        log: () => {},
      });
      await gw.listen([p]);
      const tools = [{ type: 'function', name: 'Read', parameters: { type: 'object', properties: { path: { type: 'string' } } } },
                     { type: 'function', name: 'Edit', parameters: { type: 'object', properties: { path: { type: 'string' } } } }];
      try {
        // 1. 同一挂起工具并发收到两个重复回填请求（且并发槽暂时被占）：绝不泄漏槽位、绝不挂死 HTTP 流
        const g1 = await fetch(`http://127.0.0.1:${p}/v1/responses`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'test', stream: true, prompt_cache_key: 'dup-k1', tools, input: [{ role: 'user', content: 'r1' }] }),
        }).then((r) => r.text());
        const cid1 = /"call_id":"(call_[^"]+)"/.exec(g1)[1];
        let releaseSlot1;
        const hold1 = lim.run(() => new Promise((r) => { releaseSlot1 = r; }));
        await new Promise((r) => setTimeout(r, 15));
        const resumeBody1 = JSON.stringify({
          model: 'test', stream: true, prompt_cache_key: 'dup-k1', tools,
          input: [
            { role: 'user', content: 'r1' },
            { type: 'function_call', call_id: cid1, name: 'Read', arguments: '{"path":"a.txt"}' },
            { type: 'function_call_output', call_id: cid1, output: 'file-a' },
          ],
        });
        const dupReqA = fetch(`http://127.0.0.1:${p}/v1/responses`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: resumeBody1 }).then((r) => r.text());
        await new Promise((r) => setTimeout(r, 20));
        const dupReqB = fetch(`http://127.0.0.1:${p}/v1/responses`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: resumeBody1 }).then((r) => r.text());
        await new Promise((r) => setTimeout(r, 20));
        releaseSlot1();
        const [outA, outB] = await Promise.all([dupReqA, dupReqB, hold1]);
        assert.ok(outA.includes('dup-safe-ok') || outB.includes('dup-safe-ok'), '主恢复请求必须正常完成');
        assert.equal(lim.stats().active, 0, '重复并发回填后 active 必须归零');

        // 2. 回填请求排队等待并发槽期间，原底层 ACP prompt 异常退出：立即释放且 active=0
        const g2 = await fetch(`http://127.0.0.1:${p}/v1/responses`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'test', stream: true, prompt_cache_key: 'crash-k2', tools, input: [{ role: 'user', content: 'r2' }] }),
        }).then((r) => r.text());
        const cid2 = /"call_id":"(call_[^"]+)"/.exec(g2)[1];
        let releaseSlot2;
        const hold2 = lim.run(() => new Promise((r) => { releaseSlot2 = r; }));
        await new Promise((r) => setTimeout(r, 15));
        const crashResume = fetch(`http://127.0.0.1:${p}/v1/responses`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: 'test', stream: true, prompt_cache_key: 'crash-k2', tools,
            input: [
              { role: 'user', content: 'r2' },
              { type: 'function_call', call_id: cid2, name: 'Read', arguments: '{"path":"b.txt"}' },
              { type: 'function_call_output', call_id: cid2, output: 'file-b' },
            ],
          }),
        }).then((r) => r.text());
        await new Promise((r) => setTimeout(r, 25));
        rejectCrashSession(new Error('worker crashed unexpectedly'));
        await new Promise((r) => setTimeout(r, 25));
        releaseSlot2();
        await Promise.all([crashResume, hold2]);
        assert.equal(lim.stats().active, 0, '原 prompt 崩溃后并发槽位绝不能泄漏');

        // 3. 多条新增 user 消息中前一条含文档附件、末条为纯文本「继续」：不得误走纯文本合并而丢弃文档
        const g3 = await fetch(`http://127.0.0.1:${p}/v1/responses`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'test', stream: true, prompt_cache_key: 'doc-k3', tools, input: [{ role: 'user', content: 'edit c.js' }] }),
        }).then((r) => r.text());
        const cid3 = /"call_id":"(call_[^"]+)"/.exec(g3)[1];
        const docData = Buffer.from('spec-line-anchor-rules', 'utf8').toString('base64');
        const g3Cont = await fetch(`http://127.0.0.1:${p}/v1/responses`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: 'test', stream: true, prompt_cache_key: 'doc-k3', tools,
            input: [
              { role: 'user', content: 'edit c.js' },
              { type: 'function_call', call_id: cid3, name: 'Edit', arguments: '{"path":"c.js"}' },
              { type: 'function_call_output', call_id: cid3, output: 'INVALID_ARGUMENT' },
              { role: 'user', content: [{ type: 'input_text', text: '参考这份规范' }, { type: 'input_file', filename: 'spec.txt', file_data: `data:text/plain;base64,${docData}` }] },
              { role: 'user', content: '继续' },
            ],
          }),
        }).then((r) => r.text());
        assert.ok(g3Cont.includes('doc-preserved-ok'));
        const secondSid3Prompt = JSON.stringify(promptsSeen.filter((x) => x.sid === 'guard-sid-3')[1]?.prompt || '');
        assert.ok(secondSid3Prompt.includes('spec-line-anchor-rules') && secondSid3Prompt.includes('INVALID_ARGUMENT'), '多条新增用户消息含附件时必须走完整块发送并保留文档与工具结果');
      } finally {
        gw.close();
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    });

    await check('concurrent subagents sharing prompt_cache_key run in parallel lanes without steering collision', async () => {
      const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'ag-sublanes-'));
      const subCfg = { ...config, concurrency: 4, source: path.join(dir, 'config.json') };
      const mcpBySid = new Map();
      const cancels = [];
      let seq = 0;
      let activeInFlight = 0;
      let maxParallel = 0;
      let releaseBarrier;
      const allThreeEntered = new Promise((resolve) => { releaseBarrier = resolve; });
      let enteredCount = 0;

      const acpSub = {
        policyBySession: new Map(),
        discover: async () => {},
        resolveModel: (m) => m,
        cwdFor: async () => dir,
        start: async () => {},
        status: () => ({ running: true }),
        notify: (method, params) => {
          if (method === 'session/cancel') cancels.push(params.sessionId);
        },
        abandon: () => 0,
        request: async (method, params) => {
          if (method === 'session/new') {
            const sid = `sub-lane-${++seq}`;
            if (params.mcpServers && params.mcpServers[0]) mcpBySid.set(sid, params.mcpServers[0].url);
            return { sessionId: sid };
          }
          if (method === 'session/prompt') {
            const sid = params.sessionId;
            const txt = params.prompt.map((b) => b.text || '').join('\n');
            const matchIdx = /SUBTASK_#(\d+)/.exec(txt);
            const idx = matchIdx ? Number(matchIdx[1]) : 0;
            activeInFlight += 1;
            if (activeInFlight > maxParallel) maxParallel = activeInFlight;
            enteredCount += 1;
            if (enteredCount === 3) releaseBarrier();
            await allThreeEntered;
            try {
              const mcpUrl = mcpBySid.get(sid);
              const toolRes = await fetch(mcpUrl, {
                method: 'POST', headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ jsonrpc: '2.0', id: idx, method: 'tools/call', params: { name: 'Read', arguments: { path: `file-${idx}.txt` } } }),
              }).then(async (r) => { const raw = await r.text(); const dm = /^data:\s*(.+)$/m.exec(raw); return dm ? JSON.parse(dm[1]) : JSON.parse(raw); });
              const content = toolRes?.result?.content?.[0]?.text || '';
              assert.ok(!toolRes?.result?.isError, `子代理 #${idx} 工具调用不得被误判中断: ${JSON.stringify(toolRes)}`);
              acpSub.onNotification({
                method: 'session/update',
                params: { sessionId: sid, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `DONE_${idx}:${content}` } } },
              });
              return { stopReason: 'end_turn' };
            } finally {
              activeInFlight -= 1;
            }
          }
          return {};
        },
      };
      const gw = createGateway({ acp: acpSub, limiter: { run: (f) => f(), stats: () => ({ active: activeInFlight }) }, getConfig: () => subCfg, log: () => {} });
      const p = await gw.listen([0]);
      const subTools = [{ type: 'function', name: 'Read', parameters: { type: 'object', properties: { path: { type: 'string' } } } }];
      const parseSse = async (r) => {
        const raw = await r.text();
        return raw.split('\n\n').filter(Boolean).map((blk) => {
          const ev = /^event: (.+)$/m.exec(blk)?.[1];
          const d = /^data: (.+)$/m.exec(blk)?.[1];
          return ev && d ? { type: ev, data: JSON.parse(d) } : null;
        }).filter(Boolean);
      };
      try {
        const runOneSubagent = async (idx) => {
          const instructions = 'You are nuaa-zxh fast exploration subagent.';
          const userTask = `Investigate module for SUBTASK_#${idx}`;
          const ev1 = await parseSse(await fetch(`http://127.0.0.1:${p}/v1/responses`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              model: 'gemini-4-hydrogen', stream: true, prompt_cache_key: 'shared-workspace-cache-key',
              instructions, tools: subTools, input: [{ role: 'user', content: userTask }],
            }),
          }));
          const done1 = ev1.find((e) => e.type === 'response.completed');
          assert.ok(done1, `子代理 #${idx} 首轮必须正常返回 response.completed，不得被截断`);
          const fc = done1.data.response.output.find((o) => o.type === 'function_call');
          assert.ok(fc, `子代理 #${idx} 首轮应返回挂起的 Read function_call`);
          const ev2 = await parseSse(await fetch(`http://127.0.0.1:${p}/v1/responses`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              model: 'gemini-4-hydrogen', stream: true, prompt_cache_key: 'shared-workspace-cache-key',
              instructions, tools: subTools,
              input: [
                { role: 'user', content: userTask },
                { type: 'function_call', call_id: fc.call_id, name: 'Read', arguments: fc.arguments },
                { type: 'function_call_output', call_id: fc.call_id, output: `DATA_${idx}` },
              ],
            }),
          }));
          const done2 = ev2.find((e) => e.type === 'response.completed');
          assert.ok(done2, `子代理 #${idx} 续流轮必须返回 response.completed`);
          const msg = done2.data.response.output.find((o) => o.type === 'message')?.content?.[0]?.text || '';
          assert.equal(msg, `DONE_${idx}:DATA_${idx}`, `子代理 #${idx} 工具回填结果必须精确路由，不得串台`);
        };
        await Promise.all([runOneSubagent(1), runOneSubagent(2), runOneSubagent(3)]);
        assert.equal(seq, 3, '3 个同缓存键并发子代理应分配 3 个独立会话');
        assert.equal(maxParallel, 3, '3 个子代理应真正并发进入 session/prompt，前两个不得挂死等待');
        assert.equal(cancels.length, 0, '并发子代理不得相互触发 Steering 取消');
      } finally {
        gw.close();
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    });

    await check('parent parked on 30ms-staggered parallel Task batch stays intact while 3 shared-key subagents run', async () => {
      const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'ag-parent-sub-'));
      const psCfg = { ...config, concurrency: 4, source: path.join(dir, 'config.json') };
      const mcpBySid = new Map();
      const cancels = [];
      let seq = 0;

      const acpPs = {
        policyBySession: new Map(),
        discover: async () => {},
        resolveModel: (m) => m,
        cwdFor: async () => dir,
        start: async () => {},
        status: () => ({ running: true }),
        notify: (method, params) => {
          if (method === 'session/cancel') cancels.push(params.sessionId);
        },
        abandon: () => 0,
        request: async (method, params) => {
          if (method === 'session/new') {
            const sid = `ps-sess-${++seq}`;
            if (params.mcpServers && params.mcpServers[0]) mcpBySid.set(sid, params.mcpServers[0].url);
            return { sessionId: sid };
          }
          if (method === 'session/prompt') {
            const sid = params.sessionId;
            const mcpUrl = mcpBySid.get(sid);
            const txt = params.prompt.map((b) => b.text || '').join('\n');
            if (txt.includes('PARENT_DISPATCH_3_SUBAGENTS')) {
              const callTask = (i) => fetch(mcpUrl, {
                method: 'POST', headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ jsonrpc: '2.0', id: 100 + i, method: 'tools/call', params: { name: 'Task', arguments: { agent: 'nuaa-zxh', task: `sub-${i}` } } }),
              }).then(async (r) => { const raw = await r.text(); const dm = /^data:\s*(.+)$/m.exec(raw); return dm ? JSON.parse(dm[1]) : JSON.parse(raw); });
              // 模拟 agy_acp_server 逐个派发并行 MCP tools/call（每次间隔 30ms，旧版 20ms 窗口会被拆碎）
              const p1 = callTask(1);
              await new Promise((r) => setTimeout(r, 30));
              const p2 = callTask(2);
              await new Promise((r) => setTimeout(r, 30));
              const p3 = callTask(3);
              const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
              for (const r of [r1, r2, r3]) {
                assert.ok(!r?.result?.isError, `父会话挂起的 Task 工具不得被子代理抢占取消: ${JSON.stringify(r)}`);
              }
              const joined = [r1, r2, r3].map((r) => r.result.content[0].text).join('|');
              acpPs.onNotification({
                method: 'session/update',
                params: { sessionId: sid, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `PARENT_FINAL:${joined}` } } },
              });
              return { stopReason: 'end_turn' };
            }
            const m = /CHILD_WORK_(\d+)/.exec(txt);
            const cIdx = m ? m[1] : '0';
            acpPs.onNotification({
              method: 'session/update',
              params: { sessionId: sid, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `CHILD_OK_${cIdx}` } } },
            });
            return { stopReason: 'end_turn' };
          }
          return {};
        },
      };
      const gw = createGateway({ acp: acpPs, limiter: { run: (f) => f(), stats: () => ({}) }, getConfig: () => psCfg, log: () => {} });
      const p = await gw.listen([0]);
      const parentTools = [{ type: 'function', name: 'Task', parameters: { type: 'object', properties: { agent: { type: 'string' }, task: { type: 'string' } } } }];
      const childTools = [{ type: 'function', name: 'Read', parameters: { type: 'object', properties: { path: { type: 'string' } } } }];
      const parseSse = async (r) => {
        const raw = await r.text();
        return raw.split('\n\n').filter(Boolean).map((blk) => {
          const ev = /^event: (.+)$/m.exec(blk)?.[1];
          const d = /^data: (.+)$/m.exec(blk)?.[1];
          return ev && d ? { type: ev, data: JSON.parse(d) } : null;
        }).filter(Boolean);
      };
      try {
        const parentTurn1 = await parseSse(await fetch(`http://127.0.0.1:${p}/v1/responses`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: 'gemini-4-hydrogen', stream: true, prompt_cache_key: 'shared-parent-child-key',
            instructions: 'You are PI-Desktop main agent.', tools: parentTools,
            input: [{ role: 'user', content: 'PARENT_DISPATCH_3_SUBAGENTS' }],
          }),
        }));
        const pDone1 = parentTurn1.find((e) => e.type === 'response.completed');
        const fcs = pDone1.data.response.output.filter((o) => o.type === 'function_call');
        assert.equal(fcs.length, 3, '间隔 30ms 派发的 3 个并行 Task 调用必须合并在同一轮返回宿主');

        // 父会话挂起期间，3 个子代理带着完全相同的 prompt_cache_key 并发请求网关
        const childOutputs = await Promise.all([1, 2, 3].map(async (i) => {
          const cEv = await parseSse(await fetch(`http://127.0.0.1:${p}/v1/responses`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              model: 'gemini-4-hydrogen', stream: true, prompt_cache_key: 'shared-parent-child-key',
              instructions: 'You are nuaa-zxh subagent.', tools: childTools,
              input: [{ role: 'user', content: `CHILD_WORK_${i}` }],
            }),
          }));
          const cDone = cEv.find((e) => e.type === 'response.completed');
          assert.ok(cDone, `子代理 #${i} 应正常完成`);
          return cDone.data.response.output.find((o) => o.type === 'message').content[0].text;
        }));
        assert.deepEqual(childOutputs, ['CHILD_OK_1', 'CHILD_OK_2', 'CHILD_OK_3']);
        assert.equal(cancels.length, 0, '父子共享 prompt_cache_key 时绝不能互相发送 session/cancel');

        const parentTurn2 = await parseSse(await fetch(`http://127.0.0.1:${p}/v1/responses`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: 'gemini-4-hydrogen', stream: true, prompt_cache_key: 'shared-parent-child-key',
            instructions: 'You are PI-Desktop main agent.', tools: parentTools,
            input: [
              { role: 'user', content: 'PARENT_DISPATCH_3_SUBAGENTS' },
              ...fcs.map((fc) => ({ type: 'function_call', call_id: fc.call_id, name: fc.name, arguments: fc.arguments })),
              ...fcs.map((fc, idx) => ({ type: 'function_call_output', call_id: fc.call_id, output: childOutputs[idx] })),
            ],
          }),
        }));
        const pDone2 = parentTurn2.find((e) => e.type === 'response.completed');
        const finalMsg = pDone2.data.response.output.find((o) => o.type === 'message').content[0].text;
        assert.equal(finalMsg, 'PARENT_FINAL:CHILD_OK_1|CHILD_OK_2|CHILD_OK_3');
      } finally {
        gw.close();
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    });

    await check('preflight contract guard intercepts malformed Edit/Task in MCP without consuming host retry budget and auto-normalizes valid aliases', async () => {
      const p = await (async () => { const s = net.createServer(); await new Promise((r) => s.listen(0, '127.0.0.1', r)); const pt = s.address().port; await new Promise((r) => s.close(r)); return pt; })();
      const dir = path.join(process.env.PI_SCRATCH_DIR || process.cwd(), `gw-preflight-${Date.now()}`);
      const { createLimiter } = require('../lib/core.js');
      const lim = createLimiter({ limit: 2, maxQueue: 4, queueTimeoutMs: 2000 });
      const interceptedReplies = [];
      let acpRef;
      const acpMock = {
        policyBySession: new Map(), start: async () => {}, discover: async () => {},
        cwdFor: async () => process.env.PI_SCRATCH_DIR || process.cwd(),
        resolveModel: (m) => m, status: () => ({ running: true, ready: true }),
        notify: () => {},
        request: async (method, params) => {
          if (method === 'session/new') {
            return { sessionId: 'pf-sid-1', models: { currentModelId: 'test', availableModels: [], mcpUrl: params.mcpServers?.[0]?.url || '' }, _mcpUrl: params.mcpServers?.[0]?.url || '' };
          }
          if (method === 'session/close') return {};
          if (method === 'session/prompt') {
            const sid = params.sessionId;
            const mcpUrl = acpMock._lastMcpUrl;
            // 1) 误传 old_string/new_string
            const bad1 = await fetch(mcpUrl, {
              method: 'POST', headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'Edit', arguments: { file_path: 'lib/core.js', old_string: 'a', new_string: 'b' } } }),
            }).then((r) => r.text());
            interceptedReplies.push(bad1);
            // 2) PUT 漏末尾冒号
            const bad2 = await fetch(mcpUrl, {
              method: 'POST', headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'Edit', arguments: { path: 'lib/core.js', tag: 'fb2a', ops: 'PUT 5.=5\n+missing_colon' } } }),
            }).then((r) => r.text());
            interceptedReplies.push(bad2);
            // 3) Task 误传 subagent_type/prompt
            const bad3 = await fetch(mcpUrl, {
              method: 'POST', headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'Task', arguments: { subagent_type: 'nuaa-zxh', prompt: 'check' } } }),
            }).then((r) => r.text());
            interceptedReplies.push(bad3);
            // 4) 模型修正后传入合法别名与单行简写：file_path + 小写 tag + PUT 5:
            const okEdit = await fetch(mcpUrl, {
              method: 'POST', headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'Edit', arguments: { file_path: 'lib/core.js', tag: 'fb2a', ops: 'PUT 5:\n+healed_line' } } }),
            }).then((r) => r.text());
            if (okEdit.includes('EDIT_APPLIED_OK')) {
              acpRef.onNotification({
                method: 'session/update',
                params: { sessionId: sid, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'PREFLIGHT_FLOW_SUCCESS' } } },
              });
            }
            return { stopReason: 'end_turn' };
          }
          return {};
        },
      };
      const origReq = acpMock.request;
      acpMock.request = async (method, params) => {
        if (method === 'session/new') acpMock._lastMcpUrl = params.mcpServers?.[0]?.url || '';
        return origReq(method, params);
      };
      acpRef = acpMock;
      const gw = createGateway({
        acp: acpMock, limiter: lim,
        getConfig: () => ({ ...config, concurrency: 2, source: path.join(dir, 'config.json') }),
        log: () => {},
      });
      await gw.listen([p]);
      const hostTools = [
        {
          type: 'function', name: 'Edit',
          parameters: {
            type: 'object',
            properties: { path: { type: 'string' }, file_path: { type: 'string' }, tag: { type: 'string' }, ops: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' } },
          },
        },
        {
          type: 'function', name: 'Task',
          parameters: { type: 'object', required: ['agent', 'task'], properties: { agent: { type: 'string' }, task: { type: 'string' } } },
        },
      ];
      try {
        const r1 = await fetch(`http://127.0.0.1:${p}/v1/responses`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'test', stream: true, prompt_cache_key: 'pf-key', tools: hostTools, input: [{ role: 'user', content: '更新第 5 行' }] }),
        }).then((r) => r.text());
        assert.equal(interceptedReplies.length, 3, '前 3 次违例工具调用必须在 MCP 内部原地拦截返回');
        assert.ok(interceptedReplies.every((x) => x.includes('"isError":true')), '被拦截调用必须标记 isError:true');
        const uniqueCallIds = [...new Set([...r1.matchAll(/"call_id":"(call_[^"]+)"/g)].map((m) => m[1]))];
        assert.equal(uniqueCallIds.length, 1, '宿主只应收到修正后的那 1 次合法 Edit 调用（零消耗宿主重试预算）');
        assert.ok(r1.includes('\\"path\\":\\"lib/core.js\\"') && r1.includes('\\"tag\\":\\"FB2A\\"') && r1.includes('PUT 5.=5:'), `应完成 file_path/tag/PUT 单行无损归一，实际: ${r1}`);
        const cid = uniqueCallIds[0];
        const r2 = await fetch(`http://127.0.0.1:${p}/v1/responses`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: 'test', stream: true, prompt_cache_key: 'pf-key', tools: hostTools,
            input: [
              { role: 'user', content: '更新第 5 行' },
              { type: 'function_call', call_id: cid, name: 'Edit', arguments: '{"path":"lib/core.js","tag":"FB2A","ops":"PUT 5.=5:\\n+healed_line"}' },
              { type: 'function_call_output', call_id: cid, output: 'EDIT_APPLIED_OK' },
            ],
          }),
        }).then((r) => r.text());
        assert.ok(r2.includes('PREFLIGHT_FLOW_SUCCESS'), `回填后应顺利收尾，实际: ${r2}`);
      } finally {
        gw.close();
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    });

    await check('unreturned tool_output after MUTATION_RETRY_BUDGET_EXHAUSTED recovers cleanly on regenerate, turn-1 edit, and 2-char CJK compaction without orphan sub-lanes', async () => {
      const p = await (async () => { const s = net.createServer(); await new Promise((r) => s.listen(0, '127.0.0.1', r)); const pt = s.address().port; await new Promise((r) => s.close(r)); return pt; })();
      const dir = path.join(process.env.PI_SCRATCH_DIR || process.cwd(), `gw-mut-unret-${Date.now()}`);
      const { createLimiter } = require('../lib/core.js');
      const lim = createLimiter({ limit: 1, maxQueue: 4, queueTimeoutMs: 1500 });
      const createdSids = [];
      const cancels = [];
      let promptSeq = 0;
      let acpRef;
      const acpMock = {
        policyBySession: new Map(), start: async () => {}, discover: async () => {},
        cwdFor: async () => process.env.PI_SCRATCH_DIR || process.cwd(),
        resolveModel: (m) => m, status: () => ({ running: true, ready: true }),
        notify: (method, params) => {
          if (method === 'session/cancel') cancels.push(params.sessionId);
        },
        request: async (method, params) => {
          if (method === 'session/new') {
            const sid = `unret-sid-${createdSids.length + 1}`;
            const mcpUrl = params.mcpServers?.[0]?.url || '';
            createdSids.push({ sid, mcpUrl });
            return { sessionId: sid, models: { currentModelId: 'test', availableModels: [] } };
          }
          if (method === 'session/close') return {};
          if (method === 'session/prompt') {
            const sid = params.sessionId;
            const pText = JSON.stringify(params.prompt || '');
            if (pText.includes('context summarization assistant')) {
              acpRef.onNotification({
                method: 'session/update',
                params: { sessionId: sid, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '<summary>short cjk summary</summary>' } } },
              });
              return { stopReason: 'end_turn' };
            }
            promptSeq += 1;
            const entry = createdSids.find((x) => x.sid === sid);
            if (promptSeq <= 3 && entry && entry.mcpUrl) {
              await fetch(entry.mcpUrl, {
                method: 'POST', headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ jsonrpc: '2.0', id: promptSeq, method: 'tools/call', params: { name: 'Edit', arguments: { path: 'a.js', tag: 'BEEF', ops: 'PUT 1.=1:\n+v' + promptSeq } } }),
              }).then((r) => r.text());
              return { stopReason: 'end_turn' };
            }
            acpRef.onNotification({
              method: 'session/update',
              params: { sessionId: sid, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'RECOVERED_AFTER_COMPACT' } } },
            });
            return { stopReason: 'end_turn' };
          }
          return {};
        },
      };
      acpRef = acpMock;
      const gw = createGateway({
        acp: acpMock, limiter: lim,
        getConfig: () => ({ ...config, concurrency: 1, source: path.join(dir, 'config.json') }),
        log: () => {},
      });
      await gw.listen([p]);
      const parentTools = [
        { type: 'function', name: 'Edit', parameters: { type: 'object', required: ['path', 'tag', 'ops'], properties: { path: { type: 'string' }, tag: { type: 'string' }, ops: { type: 'string' } } } },
        { type: 'function', name: 'Task', parameters: { type: 'object', required: ['agent', 'task'], properties: { agent: { type: 'string' }, task: { type: 'string' } } } },
      ];
      try {
        // 第 1 轮：2 字中文短指令挂起在 Edit，宿主本地熔断未回传 tool_output
        const t1 = await fetch(`http://127.0.0.1:${p}/v1/responses`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'test', stream: true, prompt_cache_key: 'unret-pk', instructions: 'Parent sys', tools: parentTools, input: [{ role: 'user', content: '修复' }] }),
        }).then((r) => r.text());
        assert.ok(t1.includes('"call_id":"call_'), '首轮挂起在 Edit');

        // 第 2 轮：用户点击「重新生成 / 重试」（无 tool_output，首句相同）→ 必须命中原通道取消旧挂起，绝不误分流到 _sub1
        const t2 = await fetch(`http://127.0.0.1:${p}/v1/responses`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'test', stream: true, prompt_cache_key: 'unret-pk', instructions: 'Parent sys', tools: parentTools, input: [{ role: 'user', content: '修复' }] }),
        }).then((r) => r.text());
        assert.ok(t2.includes('"call_id":"call_'), '重试轮次应正常重新挂起而非卡死');
        assert.ok(!createdSids.some((x) => x.mcpUrl.includes('_sub')), `重试不得分配 _sub 孤儿通道，实际: ${JSON.stringify(createdSids)}`);

        // 第 3 轮：熔断未回传 tool_output 后用户追加新指令继续（保留首句前缀）→ 必须命中原通道取消旧挂起，绝不误分流到 _sub1
        const t3 = await fetch(`http://127.0.0.1:${p}/v1/responses`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'test', stream: true, prompt_cache_key: 'unret-pk', instructions: 'Parent sys', tools: parentTools, input: [{ role: 'user', content: '修复' }, { role: 'user', content: '彻底修复' }] }),
        }).then((r) => r.text());
        assert.ok(t3.includes('"call_id":"call_'), '追加指令重发应正常执行');
        assert.ok(!createdSids.some((x) => x.mcpUrl.includes('_sub')), '追加指令重发不得分配 _sub 孤儿通道');

        // 第 4 轮：无 prompt_cache_key 的自动压缩（匹配短中文历史锚点「彻底修复」）→ 释放挂起后完成压缩与续推
        const cRes = await fetch(`http://127.0.0.1:${p}/v1/responses`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: 'test', stream: false,
            instructions: 'You are a context summarization assistant.',
            input: [{ role: 'user', content: 'Summarize the entire conversation:\nUser: 彻底修复' }],
          }),
        });
        assert.equal(cRes.status, 200);

        const t4 = await fetch(`http://127.0.0.1:${p}/v1/responses`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: 'test', stream: true, prompt_cache_key: 'unret-pk', instructions: 'Parent sys', tools: parentTools,
            input: [
              { role: 'user', content: 'The conversation history before this point was compacted into the following summary:\n<summary>short cjk summary</summary>\n\n继续收尾' },
            ],
          }),
        }).then((r) => r.text());
        assert.ok(t4.includes('RECOVERED_AFTER_COMPACT'), `压缩后续推应正常收尾且无 AGENT_BUSY，实际: ${t4}`);
        assert.ok(!createdSids.some((x) => x.mcpUrl.includes('_sub')), '全程不得产生任何 _sub 孤儿通道');
      } finally {
        gw.close();
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    });
    await check('aborted auxiliary UI requests and subagent compaction sharing prompt_cache_key never kill parked main bridge', async () => {
      const p = await (async () => { const s = net.createServer(); await new Promise((r) => s.listen(0, '127.0.0.1', r)); const pt = s.address().port; await new Promise((r) => s.close(r)); return pt; })();
      const dir = path.join(process.env.PI_SCRATCH_DIR || process.cwd(), `gw-aux-disconnect-${Date.now()}`);
      const { createLimiter } = require('../lib/core.js');
      const lim = createLimiter({ limit: 1, maxQueue: 8, queueTimeoutMs: 5000 });
      const cancelledSids = [];
      let mainMcpUrl = '';
      let auxStreamHoldRelease = null;
      let auxStreamStartedResolve = null;
      const auxStreamStarted = new Promise((r) => { auxStreamStartedResolve = r; });
      let sidSeq = 0;
      const acpMock = {
        policyBySession: new Map(), start: async () => {}, discover: async () => {},
        cwdFor: async () => process.cwd(), resolveModel: (m) => m, status: () => ({ running: true, ready: true }),
        notify: (method, params) => {
          if (method === 'session/cancel' && params && params.sessionId) cancelledSids.push(params.sessionId);
        },
        abandon: () => 1,
        request: async (method, params) => {
          if (method === 'session/new') {
            const sid = `iso-sess-${++sidSeq}`;
            const url = params.mcpServers && params.mcpServers[0] && params.mcpServers[0].url;
            if (url && !mainMcpUrl) mainMcpUrl = url;
            return { sessionId: sid, models: { currentModelId: 'test', availableModels: [] } };
          }
          if (method === 'session/close') return {};
          if (method === 'session/prompt') {
            const sid = params.sessionId;
            const pText = (params.prompt || []).map((b) => b.text || '').join('\n');
            if (pText.includes("predict the user's next message")) {
              if (auxStreamStartedResolve) { auxStreamStartedResolve(sid); auxStreamStartedResolve = null; }
              await new Promise((r) => { auxStreamHoldRelease = r; });
              return { stopReason: 'cancelled' };
            }
            if (pText.includes('Summarize the entire conversation')) {
              acpMock.onNotification({
                method: 'session/update',
                params: { sessionId: sid, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '<summary>subagent compacted</summary>' } } },
              });
              return { stopReason: 'end_turn' };
            }
            // 主会话首轮：调 Task 挂起，等待宿主回填
            const callTask = await fetch(mainMcpUrl, {
              method: 'POST', headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'Task', arguments: { agent: 'research', task: 'check module' } } }),
            }).then((r) => r.text());
            assert.ok(!callTask.includes('"isError":true') && callTask.includes('SUBAGENT_DONE'), `主会话挂起的 Task 绝不能被辅助请求断流或子代理压缩误杀，实际: ${callTask}`);
            acpMock.onNotification({
              method: 'session/update',
              params: { sessionId: sid, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'PARENT_RESUMED_INTACT' } } },
            });
            return { stopReason: 'end_turn' };
          }
          return {};
        },
      };
      const gw = createGateway({ acp: acpMock, limiter: lim, getConfig: () => config, log: () => {}, dataDir: dir });
      await gw.listen([p]);
      const tools = [{
        type: 'function', name: 'Task',
        parameters: { type: 'object', required: ['agent', 'task'], properties: { agent: { type: 'string' }, task: { type: 'string' } } },
      }];
      try {
        const r1 = await fetch(`http://127.0.0.1:${p}/v1/responses`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'test', stream: true, prompt_cache_key: 'shared-aux-pk', tools, input: [{ role: 'user', content: 'run subagent check' }] }),
        }).then((r) => r.text());
        const taskCallId = /"call_id":"(call_[^"]+)"/.exec(r1)?.[1];
        assert.ok(taskCallId, `主会话应挂起在 Task 工具上，实际: ${r1}`);

        // 1) 发起带相同 prompt_cache_key 的辅助追问预测请求，并在 active 流式中主动 abort（模拟宿主切换状态断流）
        const acActive = new AbortController();
        const aux1Promise = fetch(`http://127.0.0.1:${p}/v1/responses`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, signal: acActive.signal,
          body: JSON.stringify({
            model: 'test', stream: true, prompt_cache_key: 'shared-aux-pk',
            instructions: "You predict the user's next message, not the assistant's answer.",
            input: [{ role: 'user', content: 'run subagent check' }],
          }),
        }).catch(() => null);
        const auxSid = await auxStreamStarted;

        // 2) 在单并发槽位被 aux1 占住时，再发起第 2 个排队中的辅助请求并立刻 abort（覆盖 !task.active 分支）
        const acQueued = new AbortController();
        const aux2Promise = fetch(`http://127.0.0.1:${p}/v1/responses`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, signal: acQueued.signal,
          body: JSON.stringify({
            model: 'test', stream: true, prompt_cache_key: 'shared-aux-pk',
            instructions: "You predict the user's next message, not the assistant's answer.",
            input: [{ role: 'user', content: 'queued prediction' }],
          }),
        }).catch(() => null);
        await new Promise((r) => setTimeout(r, 40));
        acQueued.abort();
        acActive.abort();
        await new Promise((r) => setTimeout(r, 50));
        if (auxStreamHoldRelease) auxStreamHoldRelease();
        await Promise.all([aux1Promise, aux2Promise]);

        assert.ok(!cancelledSids.includes('iso-sess-1'), `辅助请求断流绝不能向主会话发送 session/cancel，实际取消列表: ${JSON.stringify(cancelledSids)}`);
        assert.ok(cancelledSids.includes(auxSid), '活跃辅助请求断流应正常取消辅助会话自身以释放槽位');

        // 3) 子代理携带相同 prompt_cache_key 触发自动压缩：不得误杀父会话挂起的 Task
        const subCompact = await fetch(`http://127.0.0.1:${p}/v1/responses`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: 'test', stream: false, prompt_cache_key: 'shared-aux-pk',
            instructions: 'You are a context summarization assistant.',
            input: [{ role: 'user', content: 'Summarize the entire conversation:\nUser: subagent internal prompt' }],
          }),
        });
        assert.equal(subCompact.status, 200);
        assert.ok(!cancelledSids.includes('iso-sess-1'), '子代理压缩绝不能抢占父会话挂起的 Task');

        // 4) 宿主回填 Task 结果，主会话无损恢复收尾
        const r2 = await fetch(`http://127.0.0.1:${p}/v1/responses`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: 'test', stream: true, prompt_cache_key: 'shared-aux-pk', tools,
            input: [
              { role: 'user', content: 'run subagent check' },
              { type: 'function_call', call_id: taskCallId, name: 'Task', arguments: '{"agent":"research","task":"check module"}' },
              { type: 'function_call_output', call_id: taskCallId, output: 'SUBAGENT_DONE' },
            ],
          }),
        }).then((r) => r.text());
        assert.ok(r2.includes('PARENT_RESUMED_INTACT'), `父会话应无损恢复收尾，实际: ${r2}`);
      } finally {
        gw.close();
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    });
    await check('rapid multi-steering, subagent Task/prefix protection, and sibling-lane compaction never cross-stream or cancel wrong lane', async () => {
      const p = await (async () => { const s = net.createServer(); await new Promise((r) => s.listen(0, '127.0.0.1', r)); const pt = s.address().port; await new Promise((r) => s.close(r)); return pt; })();
      const dir = path.join(process.env.PI_SCRATCH_DIR || process.cwd(), `gw-p1-guards-${Date.now()}`);
      const { createLimiter } = require('../lib/core.js');
      const lim = createLimiter({ limit: 4, maxQueue: 16, queueTimeoutMs: 5000 });
      let sidSeq = 0;
      const mcpUrlsBySid = new Map();
      let acpRef;
      let releaseSlowCancel = null;
      const acpMock = {
        policyBySession: new Map(), start: async () => {}, discover: async () => {},
        cwdFor: async () => process.cwd(), resolveModel: (m) => m, status: () => ({ running: true, ready: true }),
        notify: () => {},
        abandon: () => 1,
        request: async (method, params) => {
          if (method === 'session/new') {
            const sid = `p1-sess-${++sidSeq}`;
            const url = params.mcpServers && params.mcpServers[0] && params.mcpServers[0].url;
            if (url) mcpUrlsBySid.set(sid, url);
            return { sessionId: sid, models: { currentModelId: 'test', availableModels: [] } };
          }
          if (method === 'session/close') return {};
          if (method === 'session/prompt') {
            const sid = params.sessionId;
            const txt = (params.prompt || []).map((b) => b.text || '').join('\n');
            const mUrl = mcpUrlsBySid.get(sid) || '';
            if (txt.includes('STEER_ONE')) {
              await new Promise((r) => { releaseSlowCancel = r; });
              return { stopReason: 'cancelled' };
            }
            if (txt.includes('STEER_TWO')) {
              acpRef.onNotification({ method: 'session/update', params: { sessionId: sid, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'WRONG_STEER_TWO_ANSWER' } } } });
              return { stopReason: 'end_turn' };
            }
            if (txt.includes('STEER_THREE')) {
              acpRef.onNotification({ method: 'session/update', params: { sessionId: sid, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'EXACT_STEER_THREE_ANSWER' } } } });
              return { stopReason: 'end_turn' };
            }
            if (txt.includes('Summarize the entire conversation')) {
              acpRef.onNotification({ method: 'session/update', params: { sessionId: sid, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '<summary>beta summary</summary>' } } } });
              return { stopReason: 'end_turn' };
            }
            if (txt.includes('Continue beta after compact')) {
              acpRef.onNotification({ method: 'session/update', params: { sessionId: sid, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `BETA_COMPACT_OK_ON_${sid}` } } } });
              return { stopReason: 'end_turn' };
            }
            if (txt.includes('PARENT_PARK_READ') || txt.includes('ALPHA_READ_LANE') || txt.includes('BETA_READ_LANE')) {
              const tag = txt.includes('ALPHA_READ_LANE') ? 'alpha' : (txt.includes('BETA_READ_LANE') ? 'beta' : 'p-read');
              const res = await fetch(mUrl, {
                method: 'POST', headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'Read', arguments: { path: `${tag}.js` } } }),
              }).then((r) => r.text());
              if (res.includes('"isError":true')) {
                if (tag !== 'beta') throw new Error(`${tag} Read unexpectedly cancelled: ${res}`);
                return { stopReason: 'cancelled' };
              }
              acpRef.onNotification({ method: 'session/update', params: { sessionId: sid, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `DONE_${tag.toUpperCase()}_${sid}` } } } });
              return { stopReason: 'end_turn' };
            }
            if (txt.includes('PARENT_PARK_TASK') && !txt.includes('CHILD_DELEGATED_STEP')) {
              const res = await fetch(mUrl, {
                method: 'POST', headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'Task', arguments: { agent: 'self', task: 'child' } } }),
              }).then((r) => r.text());
              assert.ok(!res.includes('"isError":true'), `父会话挂起的 Task 绝不能被携带前缀的子代理取消: ${res}`);
              acpRef.onNotification({ method: 'session/update', params: { sessionId: sid, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'PARENT_TASK_DONE' } } } });
              return { stopReason: 'end_turn' };
            }
            acpRef.onNotification({ method: 'session/update', params: { sessionId: sid, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'CHILD_EXEC_OK' } } } });
            return { stopReason: 'end_turn' };
          }
          return {};
        },
      };
      acpRef = acpMock;
      const gw = createGateway({ acp: acpMock, limiter: lim, getConfig: () => config, log: () => {}, dataDir: dir });
      await gw.listen([p]);
      const fullTools = [
        { type: 'function', name: 'Read', parameters: { type: 'object', properties: { path: { type: 'string' } } } },
        { type: 'function', name: 'Task', parameters: { type: 'object', required: ['agent', 'task'], properties: { agent: { type: 'string' }, task: { type: 'string' } } } },
      ];
      try {
        // 1) 连续快速二次改向（STEER_ONE 未退完时连发 STEER_TWO 与 STEER_THREE）：绝不挂死中间请求、绝不串流
        const s1 = fetch(`http://127.0.0.1:${p}/v1/responses`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'test', stream: true, prompt_cache_key: 'steer-pk', tools: fullTools, input: [{ role: 'user', content: 'STEER_ONE' }] }),
        }).then((r) => r.text());
        await new Promise((r) => setTimeout(r, 35));
        const s2 = fetch(`http://127.0.0.1:${p}/v1/responses`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'test', stream: true, prompt_cache_key: 'steer-pk', tools: fullTools, input: [{ role: 'user', content: 'STEER_ONE' }, { role: 'user', content: 'STEER_TWO' }] }),
        }).then((r) => r.text());
        await new Promise((r) => setTimeout(r, 20));
        const s3 = fetch(`http://127.0.0.1:${p}/v1/responses`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'test', stream: true, prompt_cache_key: 'steer-pk', tools: fullTools, input: [{ role: 'user', content: 'STEER_ONE' }, { role: 'user', content: 'STEER_TWO' }, { role: 'user', content: 'STEER_THREE' }] }),
        }).then((r) => r.text());
        await new Promise((r) => setTimeout(r, 40));
        if (releaseSlowCancel) releaseSlowCancel();
        const [out1, out2, out3] = await Promise.all([s1, s2, s3]);
        assert.ok(out1.includes('response.completed'), '被改向替代的请求 1 必须正常收尾结束');
        assert.ok(out2.includes('response.completed') && !out2.includes('EXACT_STEER_THREE_ANSWER'), '中间被替代的请求 2 必须正常结束且不串流');
        assert.ok(out3.includes('EXACT_STEER_THREE_ANSWER') && !out3.includes('WRONG_STEER_TWO_ANSWER'), `最新请求 3 必须拿到自身结果且不混入旧改向输出，实际: ${out3}`);

        // 2a) 父会话挂起 Read，同缓存键独立子代理携带 Task 工具声明 → 不得取消父会话 Read
        const pr1 = await fetch(`http://127.0.0.1:${p}/v1/responses`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'test', stream: true, prompt_cache_key: 'sub-read-pk', instructions: 'Same sys', tools: fullTools, input: [{ role: 'user', content: 'PARENT_PARK_READ' }] }),
        }).then((r) => r.text());
        const prCallId = /"call_id":"(call_[^"]+)"/.exec(pr1)?.[1];
        assert.ok(prCallId);
        const childWithTaskTool = await fetch(`http://127.0.0.1:${p}/v1/responses`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'test', stream: true, prompt_cache_key: 'sub-read-pk', instructions: 'Same sys', tools: fullTools, input: [{ role: 'user', content: 'INDEPENDENT_CHILD_PROMPT' }] }),
        }).then((r) => r.text());
        assert.ok(childWithTaskTool.includes('CHILD_EXEC_OK'));
        const pr2 = await fetch(`http://127.0.0.1:${p}/v1/responses`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: 'test', stream: true, prompt_cache_key: 'sub-read-pk', instructions: 'Same sys', tools: fullTools,
            input: [
              { role: 'user', content: 'PARENT_PARK_READ' },
              { type: 'function_call', call_id: prCallId, name: 'Read', arguments: '{"path":"p-read.js"}' },
              { type: 'function_call_output', call_id: prCallId, output: 'file ok' },
            ],
          }),
        }).then((r) => r.text());
        assert.ok(pr2.includes('DONE_P-READ_'), `父会话 Read 必须完好恢复，实际: ${pr2}`);

        // 2b) 父会话挂起 Task，子代理携带父历史前缀 → 不得取消父会话 Task
        const pt1 = await fetch(`http://127.0.0.1:${p}/v1/responses`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'test', stream: true, prompt_cache_key: 'sub-task-pk', instructions: 'Same sys', tools: fullTools, input: [{ role: 'user', content: 'PARENT_PARK_TASK' }] }),
        }).then((r) => r.text());
        const ptCallId = /"call_id":"(call_[^"]+)"/.exec(pt1)?.[1];
        assert.ok(ptCallId);
        const childWithPrefix = await fetch(`http://127.0.0.1:${p}/v1/responses`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'test', stream: true, prompt_cache_key: 'sub-task-pk', instructions: 'Same sys', tools: fullTools, input: [{ role: 'user', content: 'PARENT_PARK_TASK' }, { role: 'user', content: 'CHILD_DELEGATED_STEP' }] }),
        }).then((r) => r.text());
        assert.ok(childWithPrefix.includes('CHILD_EXEC_OK'));
        const pt2 = await fetch(`http://127.0.0.1:${p}/v1/responses`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: 'test', stream: true, prompt_cache_key: 'sub-task-pk', instructions: 'Same sys', tools: fullTools,
            input: [
              { role: 'user', content: 'PARENT_PARK_TASK' },
              { type: 'function_call', call_id: ptCallId, name: 'Task', arguments: '{"agent":"self","task":"child"}' },
              { type: 'function_call_output', call_id: ptCallId, output: 'child ok' },
            ],
          }),
        }).then((r) => r.text());
        assert.ok(pt2.includes('PARENT_TASK_DONE'), `父会话 Task 必须完好恢复，实际: ${pt2}`);

        // 3) 同画像双通道 A/B 均挂起 Read，仅压缩 B 并续推 B → 绝不误抢 A，且 B 精准接回原会话
        const la1 = await fetch(`http://127.0.0.1:${p}/v1/responses`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'test', stream: true, prompt_cache_key: 'sib-pk', instructions: 'Sib sys', tools: fullTools, input: [{ role: 'user', content: 'ALPHA_READ_LANE' }] }),
        }).then((r) => r.text());
        const alphaCallId = /"call_id":"(call_[^"]+)"/.exec(la1)?.[1];
        const lb1 = await fetch(`http://127.0.0.1:${p}/v1/responses`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'test', stream: true, prompt_cache_key: 'sib-pk', instructions: 'Sib sys', tools: fullTools, input: [{ role: 'user', content: 'BETA_READ_LANE' }] }),
        }).then((r) => r.text());
        const betaCallId = /"call_id":"(call_[^"]+)"/.exec(lb1)?.[1];
        assert.ok(alphaCallId && betaCallId && alphaCallId !== betaCallId);

        const compB = await fetch(`http://127.0.0.1:${p}/v1/responses`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: 'test', stream: false, prompt_cache_key: 'sib-pk',
            instructions: 'You are a context summarization assistant.',
            input: [{ role: 'user', content: 'Summarize the entire conversation:\nUser: BETA_READ_LANE' }],
          }),
        });
        assert.equal(compB.status, 200);

        const lb2 = await fetch(`http://127.0.0.1:${p}/v1/responses`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: 'test', stream: true, prompt_cache_key: 'sib-pk', instructions: 'Sib sys', tools: fullTools,
            input: [{ role: 'user', content: 'The conversation history before this point was compacted into the following summary:\n<summary>beta summary</summary>\n\nContinue beta after compact' }],
          }),
        }).then((r) => r.text());
        assert.ok(lb2.includes('BETA_COMPACT_OK_ON_'), `B 压缩续推应正常完成，实际: ${lb2}`);

        const la2 = await fetch(`http://127.0.0.1:${p}/v1/responses`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: 'test', stream: true, prompt_cache_key: 'sib-pk', instructions: 'Sib sys', tools: fullTools,
            input: [
              { role: 'user', content: 'ALPHA_READ_LANE' },
              { type: 'function_call', call_id: alphaCallId, name: 'Read', arguments: '{"path":"alpha.js"}' },
              { type: 'function_call_output', call_id: alphaCallId, output: 'alpha data' },
            ],
          }),
        }).then((r) => r.text());
        assert.ok(la2.includes('DONE_ALPHA_'), `兄弟通道 A 的挂起 Read 必须毫发无损，实际: ${la2}`);
      } finally {
        gw.close();
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    });

    await check('mid-turn compaction with real <summary> resets bloated session, clears stale contextUsed, and stops infinite compaction loop', async () => {
      const dir = path.join(process.env.PI_SCRATCH_DIR || process.cwd(), `gw-mid-compact-reset-${Date.now()}`);
      let mcpUrl = '';
      let bridgedSessionSeq = 0;
      let sumSeq = 0;
      const closedSids = [];
      const seenPrompts = [];
      const acpLoopFix = {
        policyBySession: new Map(),
        discover: async () => {},
        resolveModel: (m) => m,
        cwdFor: async () => process.env.PI_SCRATCH_DIR || process.cwd(),
        start: async () => {},
        status: () => ({ running: true, ready: true }),
        notify: () => {},
        abandon: () => 0,
        request: async (method, params) => {
          if (method === 'session/new') {
            if (params.mcpServers && params.mcpServers.length > 0) {
              mcpUrl = params.mcpServers[0].url;
              bridgedSessionSeq += 1;
              return { sessionId: `bridged-sess-${bridgedSessionSeq}` };
            }
            sumSeq += 1;
            return { sessionId: `sum-sess-${sumSeq}` };
          }
          if (method === 'session/close') {
            closedSids.push(params.sessionId);
            return {};
          }
          if (method === 'session/prompt') {
            const sid = params.sessionId;
            const promptText = params.prompt.map((b) => b.text || '').join('\n');
            seenPrompts.push({ sid, promptText });
            if (sid.startsWith('sum-sess-')) {
              acpLoopFix.onNotification({
                method: 'session/update',
                params: { sessionId: sid, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '<summary>compacted history</summary>' } } },
              });
              return { stopReason: 'end_turn' };
            }
            if (sid === 'bridged-sess-1') {
              // 旧会话已膨胀到 920,000 tokens（超过 1M 的 90%），挂起请求 Read 工具
              acpLoopFix.onNotification({
                method: 'session/update',
                params: { sessionId: sid, update: { sessionUpdate: 'usage_update', used: 920000, size: 1000000 } } },
              );
              await fetch(mcpUrl, {
                method: 'POST', headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ jsonrpc: '2.0', id: 101, method: 'tools/call', params: { name: 'Read', arguments: { path: 'heavy.ts' } } }),
              }).then((r) => r.text());
              return { stopReason: 'cancelled' };
            }
            if (sid === 'bridged-sess-2') {
              // 压缩重建后的全新会话：首次调工具前仅发了初始化 used: 0，尚未推送新非零 used，验证绝不残留旧会话的 920000！
              acpLoopFix.onNotification({
                method: 'session/update',
                params: { sessionId: sid, update: { sessionUpdate: 'usage_update', used: 0, size: 1000000 } } },
              );
              const editRes = await fetch(mcpUrl, {
                method: 'POST', headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ jsonrpc: '2.0', id: 102, method: 'tools/call', params: { name: 'Bash', arguments: { command: 'echo ok' } } }),
              }).then((r) => r.text());
              assert.ok(editRes.includes('echo-done'), `新会话第二次工具应顺利回填: ${editRes}`);
              acpLoopFix.onNotification({
                method: 'session/update',
                params: { sessionId: sid, update: { sessionUpdate: 'usage_update', used: 14200, size: 1000000 } } },
              );
              acpLoopFix.onNotification({
                method: 'session/update',
                params: { sessionId: sid, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'all done on fresh compacted session' } } },
              });
              return { stopReason: 'end_turn', usage: { inputTokens: 2200, cachedReadTokens: 12000, outputTokens: 60, thoughtTokens: 20, totalTokens: 14260 } };
            }
          }
          return {};
        },
      };
      const gw = createGateway({
        acp: acpLoopFix,
        limiter: { run: (f) => f(), stats: () => ({}) },
        getConfig: () => ({ ...config, source: path.join(dir, 'config.json') }),
        log: () => {},
      });
      const p = await gw.listen([0]);
      const tools = [
        { type: 'function', name: 'Read', parameters: { type: 'object', properties: { path: { type: 'string' } } } },
        { type: 'function', name: 'Bash', parameters: { type: 'object', properties: { command: { type: 'string' } } } },
      ];
      const parseResp = async (r) => {
        const raw = await r.text();
        return raw.split('\n\n').filter(Boolean).map((blk) => {
          const ev = /^event: (.+)$/m.exec(blk)?.[1];
          const d = /^data: (.+)$/m.exec(blk)?.[1];
          return ev && d ? { type: ev, data: JSON.parse(d) } : null;
        }).filter(Boolean);
      };
      try {
        // 1. 第一步：旧会话上下文高达 920,000 tokens，挂起返回 Read 调用
        const t1 = await parseResp(await fetch(`http://127.0.0.1:${p}/v1/responses`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: 'claude-opus-4-6-thinking', stream: true, prompt_cache_key: 'loop-fix-key',
            instructions: 'KEEP_SYS_PROMPT_V1', tools,
            input: [{ role: 'user', content: 'refactor heavy.ts' }],
          }),
        }));
        const d1 = t1.find((e) => e.type === 'response.completed');
        const fcRead = d1.data.response.output.find((o) => o.type === 'function_call');
        assert.equal(d1.data.response.usage.input_tokens, 920000);

        // 2. 第二步：宿主检测到 920,000 达阈值，在回传 Read 结果前发起旁路自动压缩请求
        const sumRes = await fetch(`http://127.0.0.1:${p}/v1/responses`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: 'claude-opus-4-6-thinking', stream: false, prompt_cache_key: 'loop-fix-key',
            instructions: 'You are a context summarization assistant.',
            input: [{ role: 'user', content: 'Summarize the entire conversation:\nUser: refactor heavy.ts' }],
          }),
        });
        assert.equal(sumRes.status, 200);

        // 3. 第三步：宿主带着真实 <summary> 与刚执行完的 Read function_call_output（末尾为 tool！）续跑
        const t2 = await parseResp(await fetch(`http://127.0.0.1:${p}/v1/responses`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: 'claude-opus-4-6-thinking', stream: true, prompt_cache_key: 'loop-fix-key',
            instructions: 'KEEP_SYS_PROMPT_V1', tools,
            input: [
              { role: 'user', content: '# Resuming from a compaction\n\n<summary>\nUser asked to refactor heavy.ts.\n</summary>' },
              { type: 'function_call', call_id: fcRead.call_id, name: 'Read', arguments: fcRead.arguments },
              { type: 'function_call_output', call_id: fcRead.call_id, output: 'HEAVY_TS_FILE_BODY_AFTER_COMPACT' },
            ],
          }),
        }));
        const d2 = t2.find((e) => e.type === 'response.completed');
        const fcBash = d2.data.response.output.find((o) => o.type === 'function_call');
        assert.ok(fcBash, '压缩重置后的新会话应正常挂起下一个工具 Bash');
        assert.ok(closedSids.includes('bridged-sess-1'), '工具轮中途触发真实 Compaction 时必须关闭膨胀的旧会话 bridged-sess-1');
        assert.equal(bridgedSessionSeq, 2, '必须创建全新的底层会话 bridged-sess-2');
        assert.ok(d2.data.response.usage.input_tokens < 50000, `新会话首次挂起绝不能残留旧会话的 920000 水位（实际: ${d2.data.response.usage.input_tokens}），否则会触发无限连环压缩`);
        const sess2Prompt = seenPrompts.find((x) => x.sid === 'bridged-sess-2');
        assert.ok(sess2Prompt.promptText.includes('KEEP_SYS_PROMPT_V1'), '重建的新会话必须包含完整系统指令');
        assert.ok(sess2Prompt.promptText.includes('User asked to refactor heavy.ts'), '重建的新会话必须包含压缩摘要');
        assert.ok(sess2Prompt.promptText.includes('HEAVY_TS_FILE_BODY_AFTER_COMPACT'), '重建的新会话必须包含压缩点后的尾部工具输出');

        // 4. 第四步：回填 Bash 工具输出，收到新会话真实低水位 14,200 tokens 并正常完结
        const t3 = await parseResp(await fetch(`http://127.0.0.1:${p}/v1/responses`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: 'claude-opus-4-6-thinking', stream: true, prompt_cache_key: 'loop-fix-key',
            instructions: 'KEEP_SYS_PROMPT_V1', tools,
            input: [
              { role: 'user', content: '# Resuming from a compaction\n\n<summary>\nUser asked to refactor heavy.ts.\n</summary>' },
              { type: 'function_call', call_id: fcBash.call_id, name: 'Bash', arguments: fcBash.arguments },
              { type: 'function_call_output', call_id: fcBash.call_id, output: 'echo-done' },
            ],
          }),
        }));
        const d3 = t3.find((e) => e.type === 'response.completed');
        assert.equal(d3.data.response.usage.input_tokens, 14200, '压缩后新会话应回落至真实低水位 14200');
        assert.equal(d3.data.response.output.find((o) => o.type === 'message').content[0].text, 'all done on fresh compacted session');
        assert.deepEqual(d3.data.response.usage.input_tokens_details, { cached_tokens: 12000 }, '续流终态应携带本轮真实 cached_tokens');
        assert.deepEqual(d3.data.response.usage.output_tokens_details, { reasoning_tokens: 20 }, '续流终态应携带本轮真实 reasoning_tokens');
      } finally {
        gw.close();
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    });

    await check('parked Task mid-turn compaction (or external summarizer) resets bloated session and isolates turnUsage across user turns', async () => {
      const dir = path.join(process.env.PI_SCRATCH_DIR || process.cwd(), `gw-task-compact-reset-${Date.now()}`);
      let mcpUrl = '';
      let sessSeq = 0;
      const closedSids = [];
      const seenPrompts = [];
      let sess2TurnCount = 0;
      const acpTaskCompact = {
        policyBySession: new Map(),
        discover: async () => {},
        resolveModel: (m) => m,
        cwdFor: async () => process.env.PI_SCRATCH_DIR || process.cwd(),
        start: async () => {},
        status: () => ({ running: true, ready: true }),
        notify: () => {},
        abandon: () => 0,
        request: async (method, params) => {
          if (method === 'session/new') {
            if (params.mcpServers && params.mcpServers.length > 0) {
              mcpUrl = params.mcpServers[0].url;
              sessSeq += 1;
              return { sessionId: `task-sess-${sessSeq}` };
            }
            return { sessionId: 'aux-sum-sess' };
          }
          if (method === 'session/close') {
            closedSids.push(params.sessionId);
            return {};
          }
          if (method === 'session/prompt') {
            const sid = params.sessionId;
            const promptText = params.prompt.map((b) => b.text || '').join('\n');
            seenPrompts.push({ sid, promptText });
            if (sid === 'aux-sum-sess') {
              acpTaskCompact.onNotification({
                method: 'session/update',
                params: { sessionId: sid, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '<summary>task compacted</summary>' } } },
              });
              return { stopReason: 'end_turn' };
            }
            if (sid === 'task-sess-1') {
              // 父会话已膨胀至 890,000 tokens，并发起挂起 Task 工具调用（summarize 期间因 Task 保护不会提前抢占）
              acpTaskCompact.onNotification({
                method: 'session/update',
                params: { sessionId: sid, update: { sessionUpdate: 'usage_update', used: 890000, size: 1000000 } },
              });
              await fetch(mcpUrl, {
                method: 'POST', headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ jsonrpc: '2.0', id: 201, method: 'tools/call', params: { name: 'Task', arguments: { agent: 'nuaa-zxh', task: 'audit repo' } } }),
              }).then((r) => r.text());
              return { stopReason: 'cancelled' };
            }
            if (sid === 'task-sess-2') {
              sess2TurnCount += 1;
              if (sess2TurnCount === 1) {
                acpTaskCompact.onNotification({
                  method: 'session/update',
                  params: { sessionId: sid, update: { sessionUpdate: 'usage_update', used: 15800, size: 1000000 } },
                });
                acpTaskCompact.onNotification({
                  method: 'session/update',
                  params: { sessionId: sid, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'task summary integrated cleanly' } } },
                });
                return { stopReason: 'end_turn', usage: { inputTokens: 3800, cachedReadTokens: 12000, outputTokens: 180, thoughtTokens: 90, totalTokens: 15980 } };
              }
              // 下一轮新用户提问：挂起 Read 工具时本轮 session/prompt 尚未返回，不得残留上一轮的 cached_tokens / reasoning_tokens / outputTokens
              acpTaskCompact.onNotification({
                method: 'session/update',
                params: { sessionId: sid, update: { sessionUpdate: 'usage_update', used: 16400, size: 1000000 } },
              });
              await fetch(mcpUrl, {
                method: 'POST', headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ jsonrpc: '2.0', id: 202, method: 'tools/call', params: { name: 'Read', arguments: { path: 'next.js' } } }),
              }).then((r) => r.text());
              acpTaskCompact.onNotification({
                method: 'session/update',
                params: { sessionId: sid, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'turn 2 done' } } },
              });
              return { stopReason: 'end_turn', usage: { inputTokens: 1400, cachedReadTokens: 15000, outputTokens: 40, thoughtTokens: 10, totalTokens: 16440 } };
            }
          }
          return {};
        },
      };
      const gw = createGateway({
        acp: acpTaskCompact,
        limiter: { run: (f) => f(), stats: () => ({}) },
        getConfig: () => ({ ...config, source: path.join(dir, 'config.json') }),
        log: () => {},
      });
      const p = await gw.listen([0]);
      const tools = [
        { type: 'function', name: 'Task', parameters: { type: 'object', required: ['agent', 'task'], properties: { agent: { type: 'string' }, task: { type: 'string' } } } },
        { type: 'function', name: 'Read', parameters: { type: 'object', properties: { path: { type: 'string' } } } },
      ];
      const parseResp = async (r) => {
        const raw = await r.text();
        return raw.split('\n\n').filter(Boolean).map((blk) => {
          const ev = /^event: (.+)$/m.exec(blk)?.[1];
          const d = /^data: (.+)$/m.exec(blk)?.[1];
          return ev && d ? { type: ev, data: JSON.parse(d) } : null;
        }).filter(Boolean);
      };
      try {
        // 1) 父会话膨胀到 890k 并挂起 Task
        const r1 = await parseResp(await fetch(`http://127.0.0.1:${p}/v1/responses`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: 'gemini-4-hydrogen', stream: true, prompt_cache_key: 'task-compact-pk',
            instructions: 'PARENT_SYS_V1', tools,
            input: [{ role: 'user', content: 'delegate full audit' }],
          }),
        }));
        const fcTask = r1.find((e) => e.type === 'response.completed').data.response.output.find((o) => o.type === 'function_call');
        assert.ok(fcTask && fcTask.name === 'Task');

        // 2) 宿主甚至可能通过外部摘要模型直接完成压缩（网关未收到 ::sum 抢占），随即带 <summary> 与 Task 输出恢复父会话
        const r2 = await parseResp(await fetch(`http://127.0.0.1:${p}/v1/responses`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: 'gemini-4-hydrogen', stream: true, prompt_cache_key: 'task-compact-pk',
            instructions: 'PARENT_SYS_V1', tools,
            input: [
              { role: 'user', content: '# Resuming from a compaction\n\n<summary>\nParent delegated full audit.\n</summary>' },
              { type: 'function_call', call_id: fcTask.call_id, name: 'Task', arguments: fcTask.arguments },
              { type: 'function_call_output', call_id: fcTask.call_id, output: 'SUBAGENT_AUDIT_REPORT_PAYLOAD' },
            ],
          }),
        }));
        const done2 = r2.find((e) => e.type === 'response.completed').data.response;
        assert.ok(closedSids.includes('task-sess-1'), '挂起 Task 期间父会话自身完成压缩后必须关闭旧膨胀会话 task-sess-1');
        assert.equal(sessSeq, 2, '必须切换到重建的清洁会话 task-sess-2');
        assert.equal(done2.usage.input_tokens, 15800, '水位必须从 890000 降至新会话真实 15800，根除连环压缩');
        const rebuiltPrompt = seenPrompts.find((x) => x.sid === 'task-sess-2');
        assert.ok(rebuiltPrompt.promptText.includes('SUBAGENT_AUDIT_REPORT_PAYLOAD'), '重建会话必须完整保留 Task 工具返回报告');

        // 3) 下一轮新提问挂起 Read 时，验证上一轮的 turnUsage 明细绝不串染到本轮半途挂起包
        const r3 = await parseResp(await fetch(`http://127.0.0.1:${p}/v1/responses`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: 'gemini-4-hydrogen', stream: true, prompt_cache_key: 'task-compact-pk',
            instructions: 'PARENT_SYS_V1', tools,
            input: [
              { role: 'user', content: '# Resuming from a compaction\n\n<summary>\nParent delegated full audit.\n</summary>' },
              { role: 'assistant', content: 'task summary integrated cleanly' },
              { role: 'user', content: 'now inspect next.js' },
            ],
          }),
        }));
        const park3 = r3.find((e) => e.type === 'response.completed').data.response;
        const fcRead = park3.output.find((o) => o.type === 'function_call');
        assert.ok(fcRead && fcRead.name === 'Read');
        assert.equal(park3.usage.input_tokens, 16400);
        assert.equal(park3.usage.input_tokens_details, undefined, '新一轮挂起期间不得串染上一轮的 cached_tokens');
        assert.equal(park3.usage.output_tokens_details, undefined, '新一轮挂起期间不得串染上一轮的 reasoning_tokens');
        assert.ok(park3.usage.output_tokens < 50, `新一轮挂起期间不得串染上一轮的 outputTokens=180（实际: ${park3.usage.output_tokens}）`);

        // 回填 Read 收尾清理
        const r4 = await parseResp(await fetch(`http://127.0.0.1:${p}/v1/responses`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: 'gemini-4-hydrogen', stream: true, prompt_cache_key: 'task-compact-pk',
            instructions: 'PARENT_SYS_V1', tools,
            input: [
              { role: 'user', content: '# Resuming from a compaction\n\n<summary>\nParent delegated full audit.\n</summary>' },
              { role: 'assistant', content: 'task summary integrated cleanly' },
              { role: 'user', content: 'now inspect next.js' },
              { type: 'function_call', call_id: fcRead.call_id, name: 'Read', arguments: fcRead.arguments },
              { type: 'function_call_output', call_id: fcRead.call_id, output: 'export default 1;' },
            ],
          }),
        }));
        const done4 = r4.find((e) => e.type === 'response.completed').data.response;
        assert.deepEqual(done4.usage.input_tokens_details, { cached_tokens: 15000 });
      } finally {
        gw.close();
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    });

    await check('tool outputs with <summary> never trigger false compaction, and slow-cancel compaction preemption strictly isolates ?k= bridges across concurrent conversations', async () => {
      const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'ag-iso-compact-'));
      let sessSeq = 0;
      const closedSids = [];
      const mcpBySid = new Map();
      const pendingPrompts = new Map();
      let releaseConvB;
      const convBReady = new Promise((r) => { releaseConvB = r; });
      let finishConvB;
      const convBHold = new Promise((r) => { finishConvB = r; });

      const acpIso = {
        policyBySession: new Map(),
        onNotification: null,
        start: async () => {},
        discover: async () => ({ groups: new Map(), raw: [] }),
        cwdFor: async () => dir,
        resolveModel: async (m) => m,
        status: () => ({ running: true, ready: true }),
        notify: () => {
          // 故意忽略 session/cancel，逼迫 waitPromptIdle 走 1.5s 超时 + acp.abandon 分支
        },
        abandon: (method, reason, targetSid = '') => {
          if (method !== 'session/prompt') return 0;
          const p = pendingPrompts.get(targetSid);
          if (!p) return 0;
          pendingPrompts.delete(targetSid);
          p.reject(Object.assign(new Error(reason || 'ACP session/prompt 已放弃'), { code: 'ACP_ABANDONED' }));
          return 1;
        },
        request: async (method, params) => {
          if (method === 'session/new') {
            sessSeq += 1;
            const sid = `iso-sess-${sessSeq}`;
            mcpBySid.set(sid, params.mcpServers?.[0]?.url || '');
            return { sessionId: sid, models: { currentModelId: 'gemini-4-hydrogen', availableModels: [] } };
          }
          if (method === 'session/close') {
            closedSids.push(params.sessionId);
            return {};
          }
          if (method === 'session/prompt') {
            const sid = params.sessionId;
            const mcpUrl = mcpBySid.get(sid);
            if (sid === 'iso-sess-1') {
              // 第 1 步：调 Read 读取含 C# XML <summary> 与压缩字面量的文件；第 2 步：调 Task 后挂死不响应 cancel
              const readRes = await fetch(mcpUrl, {
                method: 'POST', headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ jsonrpc: '2.0', id: 301, method: 'tools/call', params: { name: 'Read', arguments: { path: 'Fixture.cs' } } }),
              }).then((r) => r.text());
              assert.ok(readRes.includes('<summary>Builds a fixture</summary>'), '第一次 Read 必须在原会话内正常收到 C# <summary> 内容');
              const taskCall = fetch(mcpUrl, {
                method: 'POST', headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ jsonrpc: '2.0', id: 302, method: 'tools/call', params: { name: 'Task', arguments: { agent: 'nuaa-zxh', task: 'audit' } } }),
              }).catch(() => {});
              return await new Promise((resolve, reject) => {
                pendingPrompts.set(sid, { resolve, reject, taskCall });
              });
            }
            if (sid === 'iso-sess-2') {
              // 对话 B 正在等待（bridgeB.waiting === true），尚未发起任何工具调用
              releaseConvB(mcpUrl);
              await convBHold;
              acpIso.onNotification({
                method: 'session/update',
                params: { sessionId: sid, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'CONV_B_CLEAN_REPLY' } } },
              });
              return { stopReason: 'end_turn' };
            }
            if (sid === 'iso-sess-3') {
              // 对话 A 压缩重建后的新会话：连续并发发起 2 个 Read，必须全部落回对话 A 自身，绝不串进等待中的对话 B
              const [resA1, resA2] = await Promise.all([
                fetch(mcpUrl, {
                  method: 'POST', headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({ jsonrpc: '2.0', id: 303, method: 'tools/call', params: { name: 'Read', arguments: { path: 'A_ONLY_PRIVATE_1.cs' } } }),
                }).then((r) => r.text()),
                fetch(mcpUrl, {
                  method: 'POST', headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({ jsonrpc: '2.0', id: 304, method: 'tools/call', params: { name: 'Read', arguments: { path: 'A_ONLY_PRIVATE_2.cs' } } }),
                }).then((r) => r.text()),
              ]);
              assert.ok(resA1.includes('A1_OK') && resA2.includes('A2_OK'));
              acpIso.onNotification({
                method: 'session/update',
                params: { sessionId: sid, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'CONV_A_REBUILT_CLEAN' } } },
              });
              return { stopReason: 'end_turn' };
            }
          }
          return {};
        },
      };
      const gw = createGateway({
        acp: acpIso,
        limiter: { run: (f) => f(), stats: () => ({}) },
        getConfig: () => ({ ...config, source: path.join(dir, 'config.json') }),
        log: () => {},
      });
      const p = await gw.listen([0]);
      const tools = [
        { type: 'function', name: 'Task', parameters: { type: 'object', required: ['agent', 'task'], properties: { agent: { type: 'string' }, task: { type: 'string' } } } },
        { type: 'function', name: 'Read', parameters: { type: 'object', properties: { path: { type: 'string' } } } },
      ];
      const parseResp = async (r) => {
        const raw = await r.text();
        return raw.split('\n\n').filter(Boolean).map((blk) => {
          const ev = /^event: (.+)$/m.exec(blk)?.[1];
          const d = /^data: (.+)$/m.exec(blk)?.[1];
          return ev && d ? { type: ev, data: JSON.parse(d) } : null;
        }).filter(Boolean);
      };
      try {
        // 1) 对话 A 启动，先挂起 Read('Fixture.cs')
        const aTurn1 = await parseResp(await fetch(`http://127.0.0.1:${p}/v1/responses`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'gemini-4-hydrogen', stream: true, prompt_cache_key: 'iso-conv-a', instructions: 'SYS_A', tools, input: [{ role: 'user', content: 'inspect Fixture.cs' }] }),
        }));
        const fcRead1 = aTurn1.find((e) => e.type === 'response.completed').data.response.output.find((o) => o.type === 'function_call');
        assert.equal(fcRead1.name, 'Read');

        // 2) 回填含 C# XML <summary> 与 `# Resuming from a compaction` 源码文本的工具输出，验证绝不误触发压缩重建！
        const aTurn2 = await parseResp(await fetch(`http://127.0.0.1:${p}/v1/responses`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: 'gemini-4-hydrogen', stream: true, prompt_cache_key: 'iso-conv-a', instructions: 'SYS_A', tools,
            input: [
              { role: 'user', content: 'inspect Fixture.cs' },
              { type: 'function_call', call_id: fcRead1.call_id, name: 'Read', arguments: fcRead1.arguments },
              { type: 'function_call_output', call_id: fcRead1.call_id, output: '# Resuming from a compaction\n/// <summary>Builds a fixture</summary>\npublic class Fixture {}' },
            ],
          }),
        }));
        const fcTask = aTurn2.find((e) => e.type === 'response.completed').data.response.output.find((o) => o.type === 'function_call');
        assert.equal(fcTask.name, 'Task');
        assert.equal(sessSeq, 1, '工具输出含 <summary> 或压缩源码字面量时绝不能误判为宿主压缩而销毁活跃会话');
        assert.equal(closedSids.length, 0);

        // 3) 启动对话 B 并保持在 waiting:true 状态，同时校验未知租户 ?k=ghost-tenant 调用不会串入对话 B
        const convBPromise = fetch(`http://127.0.0.1:${p}/v1/responses`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'gemini-4-hydrogen', stream: true, prompt_cache_key: 'iso-conv-b', instructions: 'SYS_B', tools, input: [{ role: 'user', content: 'hello B' }] }),
        }).then(parseResp);
        const mcpUrlB = await convBReady;
        const ghostUrl = mcpUrlB.replace(/\?k=[^&#]+/, '?k=ghost-tenant');
        const ghostRes = await fetch(ghostUrl, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 999, method: 'tools/call', params: { name: 'Read', arguments: { path: 'LEAKED_GHOST.cs' } } }),
        }).then((r) => r.text());
        assert.ok(ghostRes.includes('"error"') || ghostRes.includes('没有等待中的桥接轮次'), `未知 ?k= 租户调用必须被拒绝而不能串入等待中的对话 B，实际: ${ghostRes}`);

        // 4) 对话 A 发送真实压缩后续跑请求（旧会话故意忽略 cancel 触发 1.5s 超时 abandon），新会话发起 2 个并发 Read
        const aTurn3 = await parseResp(await fetch(`http://127.0.0.1:${p}/v1/responses`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: 'gemini-4-hydrogen', stream: true, prompt_cache_key: 'iso-conv-a', instructions: 'SYS_A', tools,
            input: [
              { role: 'user', content: 'The conversation history before this point was compacted into the following summary:\n\n<summary>\nReal host compaction.\n</summary>' },
              { type: 'function_call', call_id: fcTask.call_id, name: 'Task', arguments: fcTask.arguments },
              { type: 'function_call_output', call_id: fcTask.call_id, output: 'TASK_AUDIT_DONE' },
            ],
          }),
        }));
        const aCalls3 = aTurn3.find((e) => e.type === 'response.completed').data.response.output.filter((o) => o.type === 'function_call');
        assert.equal(aCalls3.length, 2, '对话 A 压缩重建后的 2 个并发 Read 必须全部挂起在对话 A 自身');
        assert.ok(aCalls3.some((c) => c.arguments.includes('A_ONLY_PRIVATE_1.cs')) && aCalls3.some((c) => c.arguments.includes('A_ONLY_PRIVATE_2.cs')));

        // 放行对话 B，验证对话 B 全程未收到任何来自 A 或 ghost 的工具调用
        finishConvB();
        const bDone = await convBPromise;
        const bResp = bDone.find((e) => e.type === 'response.completed').data.response;
        assert.equal(bResp.output.filter((o) => o.type === 'function_call').length, 0, '对话 B 绝不能混入其它对话的工具调用');
        assert.equal(bResp.output.find((o) => o.type === 'message').content[0].text, 'CONV_B_CLEAN_REPLY');

        // 回填对话 A 的 2 个并发 Read 并收尾
        const aTurn4 = await parseResp(await fetch(`http://127.0.0.1:${p}/v1/responses`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: 'gemini-4-hydrogen', stream: true, prompt_cache_key: 'iso-conv-a', instructions: 'SYS_A', tools,
            input: [
              { role: 'user', content: 'The conversation history before this point was compacted into the following summary:\n\n<summary>\nReal host compaction.\n</summary>' },
              { type: 'function_call', call_id: fcTask.call_id, name: 'Task', arguments: fcTask.arguments },
              { type: 'function_call_output', call_id: fcTask.call_id, output: 'TASK_AUDIT_DONE' },
              { type: 'function_call', call_id: aCalls3[0].call_id, name: 'Read', arguments: aCalls3[0].arguments },
              { type: 'function_call', call_id: aCalls3[1].call_id, name: 'Read', arguments: aCalls3[1].arguments },
              { type: 'function_call_output', call_id: aCalls3[0].call_id, output: 'A1_OK' },
              { type: 'function_call_output', call_id: aCalls3[1].call_id, output: 'A2_OK' },
            ],
          }),
        }));
        const aMsg4 = aTurn4.find((e) => e.type === 'response.completed').data.response.output.find((o) => o.type === 'message').content[0].text;
        assert.equal(aMsg4, 'CONV_A_REBUILT_CLEAN');
      } finally {
        finishConvB();
        gw.close();
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    });

    await check('bridged /v1/responses tracks real-time un-amplified mid-turn tool watermarks, unfolds 1.5.0 multi-call PromptResponse.usage & folded usage_update, and writes back owner.contextUsed', async () => {
      const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'ag-watermark-232-'));
      let mcpUrl = '';
      let promptCount = 0;
      const acpWm = {
        policyBySession: new Map(),
        onNotification: null,
        start: async () => {},
        discover: async () => ({ groups: new Map(), raw: [] }),
        cwdFor: async () => dir,
        resolveModel: async (m) => m,
        status: () => ({ running: true, ready: true }),
        notify: () => {},
        request: async (method, params) => {
          if (method === 'session/new') {
            mcpUrl = (params.mcpServers && params.mcpServers[0] && params.mcpServers[0].url) || '';
            return { sessionId: 'wm-sess-1', models: { currentModelId: 'gemini-4-hydrogen', availableModels: [] } };
          }
          if (method === 'session/close') return {};
          if (method === 'session/prompt') {
            promptCount += 1;
            const sid = params.sessionId;
            const callRead = (id, file) => fetch(mcpUrl, {
              method: 'POST', headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'Read', arguments: { path: file } } }),
            }).then((r) => r.text());

            if (promptCount === 1) {
              // 第 1 轮：种下 187,300 基准上下文占用
              acpWm.onNotification({
                method: 'session/update',
                params: { sessionId: sid, update: { sessionUpdate: 'usage_update', used: 187300, size: 1000000 } },
              });
              acpWm.onNotification({
                method: 'session/update',
                params: { sessionId: sid, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'seeded baseline' } } },
              });
              return { stopReason: 'end_turn', usage: { inputTokens: 7300, cachedReadTokens: 180000, outputTokens: 50, thoughtTokens: 10, totalTokens: 187350 } };
            }
            if (promptCount === 2) {
              // 第 2 轮：模拟 1.5.0 连续 3 步 MCP 工具调用且轮中零 usage_update，结束时返回 4 次调用累加的 PromptResponse.usage
              acpWm.onNotification({
                method: 'session/update',
                params: { sessionId: sid, update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Inspecting step 1 files carefully.' } } },
              });
              await callRead(1, 'alpha.js');
              acpWm.onNotification({
                method: 'session/update',
                params: { sessionId: sid, update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Inspecting step 2 files carefully.' } } },
              });
              await callRead(2, 'beta.js');
              acpWm.onNotification({
                method: 'session/update',
                params: { sessionId: sid, update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Inspecting step 3 files carefully.' } } },
              });
              await callRead(3, 'gamma.js');
              acpWm.onNotification({
                method: 'session/update',
                params: { sessionId: sid, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'All 3 files analyzed.' } } },
              });
              // 4 次模型调用累计输入：187.4k + 188.5k + 190.6k + 192.2k = 758,700
              return {
                stopReason: 'end_turn',
                usage: { inputTokens: 38700, cachedReadTokens: 720000, outputTokens: 480, thoughtTokens: 160, totalTokens: 759180 },
              };
            }
            if (promptCount === 3) {
              // 第 3 轮：验证：
              // (a) item.resolve 后紧跟上一步模型调用的 usage_update 不得抹掉刚回填的 4,000 字大工具结果；
              // (b) 1.5.0 漏读 WebSocket Message 2 导致下一步 usage_update 叠成 2 倍 (396,000) 时自动展开还原单次水位
              await callRead(4, 'delta.js');
              // 模拟 _stream_live_step 在工具返回后立刻报出上一步模型调用的 usage_update(193000)
              acpWm.onNotification({
                method: 'session/update',
                params: { sessionId: sid, update: { sessionUpdate: 'usage_update', used: 193000, size: 1000000 } },
              });
              acpWm.onNotification({
                method: 'session/update',
                params: { sessionId: sid, update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Processing delta.js output.' } } },
              });
              await callRead(5, 'epsilon.js');
              acpWm.onNotification({
                method: 'session/update',
                params: { sessionId: sid, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Done with folded check.' } } },
              });
              // 模拟两拍合并翻倍的 usage_update (2 * ~198k = 396000)
              acpWm.onNotification({
                method: 'session/update',
                params: { sessionId: sid, update: { sessionUpdate: 'usage_update', used: 396000, size: 1000000 } },
              });
              return { stopReason: 'end_turn' };
            }
            return { stopReason: 'end_turn' };
          }
          return {};
        },
      };
      const gw = createGateway({
        acp: acpWm,
        limiter: { run: (f) => f(), stats: () => ({}) },
        getConfig: () => ({ ...config, source: path.join(dir, 'config.json') }),
        log: () => {},
      });
      const p = await gw.listen([0]);
      const tools = [{ type: 'function', name: 'Read', parameters: { type: 'object', properties: { path: { type: 'string' } } } }];
      const postResp = async (input) => {
        const raw = await fetch(`http://127.0.0.1:${p}/v1/responses`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'gemini-4-hydrogen', stream: true, prompt_cache_key: 'wm-conv-232', tools, input }),
        }).then((r) => r.text());
        const evs = raw.split('\n\n').filter(Boolean).map((blk) => {
          const ev = /^event: (.+)$/m.exec(blk)?.[1];
          const d = /^data: (.+)$/m.exec(blk)?.[1];
          return ev && d ? { type: ev, data: JSON.parse(d) } : null;
        }).filter(Boolean);
        return evs.find((e) => e.type === 'response.completed').data.response;
      };
      try {
        const r0 = await postResp([{ role: 'user', content: 'seed' }]);
        assert.equal(r0.usage.input_tokens, 187300);

        const hist = [
          { role: 'user', content: 'seed' },
          { role: 'assistant', content: 'seeded baseline' },
          { role: 'user', content: 'audit alpha, beta, gamma' },
        ];
        const p1 = await postResp(hist);
        const fc1 = p1.output.find((o) => o.type === 'function_call');
        assert.ok(p1.usage.input_tokens > 187300 && p1.usage.input_tokens < 188000, `park1 应平滑微增而非死锁在 187300（实际: ${p1.usage.input_tokens}）`);

        hist.push({ type: 'function_call', call_id: fc1.call_id, name: 'Read', arguments: fc1.arguments });
        hist.push({ type: 'function_call_output', call_id: fc1.call_id, output: 'A'.repeat(4000) }); // ~1000 tokens
        const p2 = await postResp(hist);
        const fc2 = p2.output.find((o) => o.type === 'function_call');
        assert.ok(p2.usage.input_tokens >= p1.usage.input_tokens + 950 && p2.usage.input_tokens < p1.usage.input_tokens + 1300, `park2 应按真实无放大增量涨约 1000 tokens（p1=${p1.usage.input_tokens}, p2=${p2.usage.input_tokens}）`);

        hist.push({ type: 'function_call', call_id: fc2.call_id, name: 'Read', arguments: fc2.arguments });
        hist.push({ type: 'function_call_output', call_id: fc2.call_id, output: 'B'.repeat(8000) }); // ~2000 tokens
        const p3 = await postResp(hist);
        const fc3 = p3.output.find((o) => o.type === 'function_call');
        assert.ok(p3.usage.input_tokens >= p2.usage.input_tokens + 1950 && p3.usage.input_tokens < p2.usage.input_tokens + 2300, `park3 应按真实无放大增量涨约 2000 tokens（p2=${p2.usage.input_tokens}, p3=${p3.usage.input_tokens}）`);

        hist.push({ type: 'function_call', call_id: fc3.call_id, name: 'Read', arguments: fc3.arguments });
        hist.push({ type: 'function_call_output', call_id: fc3.call_id, output: 'C'.repeat(6000) }); // ~1500 tokens
        const fin2 = await postResp(hist);
        assert.ok(fin2.usage.input_tokens > 190000 && fin2.usage.input_tokens < 196000, `多步累计 PromptResponse.usage(758700) 必须展开为单轮真实水位 ~192k 并回写（实际: ${fin2.usage.input_tokens}）`);
        assert.ok(fin2.usage.input_tokens_details.cached_tokens < fin2.usage.input_tokens, 'cached_tokens 必须按比例缩放而非顶满 100%');

        // Turn 3：验证 owner.contextUsed 已继承 ~192k，且工具返回后上一步 usage_update(193000) 保留刚回填的 3000 token 工具增量，终态 2 倍折叠值 (396000) 自动展开
        hist.push({ role: 'assistant', content: 'All 3 files analyzed.' });
        hist.push({ role: 'user', content: 'now inspect delta and epsilon' });
        const t3p1 = await postResp(hist);
        const fc4 = t3p1.output.find((o) => o.type === 'function_call');
        assert.ok(t3p1.usage.input_tokens > fin2.usage.input_tokens, `下一轮挂起必须继承已回写的 ${fin2.usage.input_tokens} 水位并继续递增（实际: ${t3p1.usage.input_tokens}）`);

        hist.push({ type: 'function_call', call_id: fc4.call_id, name: 'Read', arguments: fc4.arguments });
        hist.push({ type: 'function_call_output', call_id: fc4.call_id, output: 'D'.repeat(12000) }); // ~3000 tokens
        const t3p2 = await postResp(hist);
        const fc5 = t3p2.output.find((o) => o.type === 'function_call');
        assert.ok(t3p2.usage.input_tokens >= 195800 && t3p2.usage.input_tokens < 197500, `item.resolve 后的上一步 usage_update(193000) 必须保留刚回填的 3000 tokens 工具结果，严禁倒退回 193000（实际: ${t3p2.usage.input_tokens}）`);

        hist.push({ type: 'function_call', call_id: fc5.call_id, name: 'Read', arguments: fc5.arguments });
        hist.push({ type: 'function_call_output', call_id: fc5.call_id, output: 'E'.repeat(2000) }); // ~500 tokens
        const fin3 = await postResp(hist);
        assert.ok(fin3.usage.input_tokens > 196000 && fin3.usage.input_tokens < 205000, `1.5.0 漏帧导致的 2 倍叠加 usage_update(396000) 必须自动展开还原 ~199k（实际: ${fin3.usage.input_tokens}）`);
      } finally {
        gw.close();
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    });

    await check('false-positive content filter triggers in-session safe continuation and rotates poisoned session cleanly', async () => {
      const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'ag-filter-232-'));
      let sidSeq = 0;
      const closedSids = [];
      const promptsBySid = [];
      const acpFlt = {
        policyBySession: new Map(),
        onNotification: null,
        start: async () => {},
        discover: async () => ({ groups: new Map(), raw: [] }),
        cwdFor: async () => dir,
        resolveModel: async (m) => m,
        status: () => ({ running: true, ready: true }),
        notify: () => {},
        request: async (method, params) => {
          if (method === 'session/new') {
            sidSeq += 1;
            return { sessionId: `flt-sess-${sidSeq}`, models: { currentModelId: 'gemini-4-hydrogen', availableModels: [] } };
          }
          if (method === 'session/close') {
            closedSids.push(params.sessionId);
            return {};
          }
          if (method === 'session/prompt') {
            const text = params.prompt.map((b) => b.text || '').join('\n');
            promptsBySid.push({ sid: params.sessionId, text });
            if (params.sessionId === 'flt-sess-1') {
              // 模拟旧会话轨迹中毒：首次调用与会话内重试均被 PROHIBITED_CONTENT 拦截，触发桥接层轮换新会话脱敏挽救
              throw new Error('Candidate was blocked due to finish_reason: PROHIBITED_CONTENT');
            }
            acpFlt.onNotification({
              method: 'session/update',
              params: { sessionId: params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'SALVAGED_CLEAN_RESPONSE' } } },
            });
            return { stopReason: 'end_turn' };
          }
          return {};
        },
      };
      const gw = createGateway({
        acp: acpFlt,
        limiter: { run: (f) => f(), stats: () => ({}) },
        getConfig: () => ({ ...config, source: path.join(dir, 'config.json'), contentFilterMaxRetries: 2 }),
        log: () => {},
      });
      const p = await gw.listen([0]);
      const tools = [{ type: 'function', name: 'Read', parameters: { type: 'object', properties: { path: { type: 'string' } } } }];
      try {
        const raw = await fetch(`http://127.0.0.1:${p}/v1/responses`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: 'gemini-4-hydrogen', stream: true, prompt_cache_key: 'flt-conv-1', tools,
            input: [
              { role: 'user', content: 'audit prompt injection and reverse shell guardrails in security module' },
            ],
          }),
        }).then((r) => r.text());
        const evs = raw.split('\n\n').filter(Boolean).map((blk) => {
          const ev = /^event: (.+)$/m.exec(blk)?.[1];
          const d = /^data: (.+)$/m.exec(blk)?.[1];
          return ev && d ? { type: ev, data: JSON.parse(d) } : null;
        }).filter(Boolean);
        const done = evs.find((e) => e.type === 'response.completed').data.response;
        assert.equal(done.output.find((o) => o.type === 'message').content[0].text, 'SALVAGED_CLEAN_RESPONSE');
        assert.equal(promptsBySid.filter((x) => x.sid === 'flt-sess-1').length, 2, '中毒会话应先执行 1 次会话内安全声明重试，共 2 次请求');
        assert.ok(closedSids.includes('flt-sess-1'), '轮换纯净会话时必须关闭已中毒的旧会话');
        const salvagedCall = promptsBySid.find((x) => x.sid === 'flt-sess-2');
        assert.ok(salvagedCall && !/reverse shell/i.test(salvagedCall.text), '挽救会话提示词应对敏感触发词脱敏');
      } finally {
        gw.close();
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    });
    await check('fresh-session multi-step watermarks unfold accurately without 31% inflation, post-tool usage_update keeps result delta, filter retry after tool uses continuation, and compaction retains userTimeline', async () => {
      const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'ag-fresh-wm-232-'));
      let mcpUrl = '';
      let sidCounter = 0;
      const promptsLog = [];
      const acpFresh = {
        policyBySession: new Map(),
        onNotification: null,
        start: async () => {},
        discover: async () => ({ groups: new Map(), raw: [] }),
        cwdFor: async () => dir,
        resolveModel: async (m) => m,
        status: () => ({ running: true, ready: true }),
        notify: () => {},
        request: async (method, params) => {
          if (method === 'session/new') {
            sidCounter += 1;
            mcpUrl = (params.mcpServers && params.mcpServers[0] && params.mcpServers[0].url) || mcpUrl;
            return { sessionId: `fresh-sid-${sidCounter}`, models: { currentModelId: 'gemini-4-hydrogen', availableModels: [] } };
          }
          if (method === 'session/close') return {};
          if (method === 'session/prompt') {
            const sid = params.sessionId;
            const pText = params.prompt.map((b) => b.text || '').join('\n');
            promptsLog.push({ sid, pText });
            const callRead = (id, file) => fetch(mcpUrl, {
              method: 'POST', headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'Read', arguments: { path: file } } }),
            }).then((r) => r.text());

            // Case 1: 新建会话（baseUsed=0），初始约 20k tokens，3 次模型调用，结尾收到 3 倍折叠 usage_update(63999)
            if (sid === 'fresh-sid-1') {
              await callRead(1, 'f1.js');
              await callRead(2, 'f2.js');
              acpFresh.onNotification({
                method: 'session/update',
                params: { sessionId: sid, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'FRESH_FOLDED_OK' } } },
              });
              acpFresh.onNotification({
                method: 'session/update',
                params: { sessionId: sid, update: { sessionUpdate: 'usage_update', used: 63999, size: 1000000 } },
              });
              return { stopReason: 'end_turn' };
            }
            // Case 2: 新建会话（baseUsed=0），初始约 20k tokens，4 次模型调用无中间 usage_update，仅返回累计 PromptResponse.usage(87350)
            if (sid === 'fresh-sid-2') {
              await callRead(11, 'g1.js');
              await callRead(12, 'g2.js');
              await callRead(13, 'g3.js');
              acpFresh.onNotification({
                method: 'session/update',
                params: { sessionId: sid, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'FRESH_CUMULATIVE_OK' } } },
              });
              return {
                stopReason: 'end_turn',
                usage: { inputTokens: 27350, cachedReadTokens: 60000, outputTokens: 200, thoughtTokens: 50, totalTokens: 87550 },
              };
            }
            // Case 3: Post-tool 100,000 -> 1,000 result -> 102,000 preceding usage_update -> next park >= 103,000
            if (sid === 'fresh-sid-3') {
              if (promptsLog.filter((x) => x.sid === sid).length === 1) {
                acpFresh.onNotification({
                  method: 'session/update',
                  params: { sessionId: sid, update: { sessionUpdate: 'usage_update', used: 100000, size: 1000000 } },
                });
                await callRead(21, 'stepA.js');
                // Preceding call usage_update arrives at 102,000 (within 1.5x of 101,000!), must NOT wipe 1,000-token result delta!
                acpFresh.onNotification({
                  method: 'session/update',
                  params: { sessionId: sid, update: { sessionUpdate: 'usage_update', used: 102000, size: 1000000 } },
                });
                await callRead(22, 'stepB.js');
                acpFresh.onNotification({
                  method: 'session/update',
                  params: { sessionId: sid, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'POST_TOOL_OK' } } },
                });
                return { stopReason: 'end_turn' };
              }
            }
            // Case 4: 新建会话完成一步工具后触发误判拦截，会话内重试必须发 continuation 而非重发初始完整任务
            if (sid === 'fresh-sid-4') {
              const attemptNo = promptsLog.filter((x) => x.sid === sid).length;
              if (attemptNo === 1) {
                await callRead(31, 'once.js');
                throw new Error('Candidate was blocked due to finish_reason: SAFETY');
              }
              acpFresh.onNotification({
                method: 'session/update',
                params: { sessionId: sid, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'CONT_AFTER_TOOL_OK' } } },
              });
              return { stopReason: 'end_turn' };
            }
            // Case 5 & 6: Compaction 携带保留的 assistant 消息时不得被误判成 branchRevision 清空早期 userTimeline
            acpFresh.onNotification({
              method: 'session/update',
              params: { sessionId: sid, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'TIMELINE_OK' } } },
            });
            return { stopReason: 'end_turn' };
          }
          return {};
        },
      };
      const gw = createGateway({
        acp: acpFresh,
        limiter: { run: (f) => f(), stats: () => ({}) },
        getConfig: () => ({ ...config, source: path.join(dir, 'config.json'), contentFilterMaxRetries: 2 }),
        log: () => {},
      });
      const p = await gw.listen([0]);
      const tools = [{ type: 'function', name: 'Read', parameters: { type: 'object', properties: { path: { type: 'string' } } } }];
      const postR = async (key, input) => {
        const raw = await fetch(`http://127.0.0.1:${p}/v1/responses`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'gemini-4-hydrogen', stream: true, prompt_cache_key: key, tools, input }),
        }).then((r) => r.text());
        const evs = raw.split('\n\n').filter(Boolean).map((blk) => {
          const ev = /^event: (.+)$/m.exec(blk)?.[1];
          const d = /^data: (.+)$/m.exec(blk)?.[1];
          return ev && d ? { type: ev, data: JSON.parse(d) } : null;
        }).filter(Boolean);
        return evs.find((e) => e.type === 'response.completed').data.response;
      };
      try {
        // Verify Case 1 (fresh session folded usage_update=63999 across 3 calls -> ~22k, NOT 63999)
        const init20k = 'P'.repeat(78000); // ~19,500 tokens + tool guidance ≈ 20,300 tokens
        const c1Hist = [{ role: 'user', content: init20k }];
        const c1p1 = await postR('fresh-case-1', c1Hist);
        const c1fc1 = c1p1.output.find((o) => o.type === 'function_call');
        c1Hist.push({ type: 'function_call', call_id: c1fc1.call_id, name: 'Read', arguments: c1fc1.arguments });
        c1Hist.push({ type: 'function_call_output', call_id: c1fc1.call_id, output: 'R'.repeat(4000) });
        const c1p2 = await postR('fresh-case-1', c1Hist);
        const c1fc2 = c1p2.output.find((o) => o.type === 'function_call');
        c1Hist.push({ type: 'function_call', call_id: c1fc2.call_id, name: 'Read', arguments: c1fc2.arguments });
        c1Hist.push({ type: 'function_call_output', call_id: c1fc2.call_id, output: 'S'.repeat(4000) });
        const c1Fin = await postR('fresh-case-1', c1Hist);
        assert.ok(c1Fin.usage.input_tokens >= 21000 && c1Fin.usage.input_tokens <= 24000, `新建会话 3 拍折叠 usage_update(63999) 必须展开回 ~22k（实际: ${c1Fin.usage.input_tokens}）`);

        // Verify Case 2 (fresh session 4 calls cumulative PromptResponse.usage=87350 -> ~23k, NOT ~30.6k)
        const c2Hist = [{ role: 'user', content: init20k }];
        const c2p1 = await postR('fresh-case-2', c2Hist);
        const c2fc1 = c2p1.output.find((o) => o.type === 'function_call');
        c2Hist.push({ type: 'function_call', call_id: c2fc1.call_id, name: 'Read', arguments: c2fc1.arguments });
        c2Hist.push({ type: 'function_call_output', call_id: c2fc1.call_id, output: 'X'.repeat(4000) });
        const c2p2 = await postR('fresh-case-2', c2Hist);
        const c2fc2 = c2p2.output.find((o) => o.type === 'function_call');
        c2Hist.push({ type: 'function_call', call_id: c2fc2.call_id, name: 'Read', arguments: c2fc2.arguments });
        c2Hist.push({ type: 'function_call_output', call_id: c2fc2.call_id, output: 'Y'.repeat(4000) });
        const c2p3 = await postR('fresh-case-2', c2Hist);
        const c2fc3 = c2p3.output.find((o) => o.type === 'function_call');
        c2Hist.push({ type: 'function_call', call_id: c2fc3.call_id, name: 'Read', arguments: c2fc3.arguments });
        c2Hist.push({ type: 'function_call_output', call_id: c2fc3.call_id, output: 'Z'.repeat(4000) });
        const c2Fin = await postR('fresh-case-2', c2Hist);
        assert.ok(c2Fin.usage.input_tokens >= 21500 && c2Fin.usage.input_tokens <= 25000, `新建会话 4 拍累计输入不得把初始提示词当成增长虚胖至 30k+（实际: ${c2Fin.usage.input_tokens}）`);

        // Verify Case 3 (100,000 -> +1,000 result -> 102,000 preceding usage_update -> next park >= 103,000)
        const c3Hist = [{ role: 'user', content: 'start 100k test' }];
        const c3p1 = await postR('fresh-case-3', c3Hist);
        const c3fc1 = c3p1.output.find((o) => o.type === 'function_call');
        c3Hist.push({ type: 'function_call', call_id: c3fc1.call_id, name: 'Read', arguments: c3fc1.arguments });
        c3Hist.push({ type: 'function_call_output', call_id: c3fc1.call_id, output: 'M'.repeat(4000) }); // 1,000 tokens
        const c3p2 = await postR('fresh-case-3', c3Hist);
        const c3fc2 = c3p2.output.find((o) => o.type === 'function_call');
        assert.ok(c3p2.usage.input_tokens >= 103000, `上一步延迟 usage_update(102000) 绝不能吞掉刚回填的 1000 token 工具结果（实际: ${c3p2.usage.input_tokens}）`);
        c3Hist.push({ type: 'function_call', call_id: c3fc2.call_id, name: 'Read', arguments: c3fc2.arguments });
        c3Hist.push({ type: 'function_call_output', call_id: c3fc2.call_id, output: 'done' });
        await postR('fresh-case-3', c3Hist);

        // Verify Case 4 (filter retry after completed tool on fresh session sends continuation, NOT original prompt)
        const c4Hist = [{ role: 'user', content: 'UNIQUE_INITIAL_NON_IDEMPOTENT_TASK_8821' }];
        const c4p1 = await postR('fresh-case-4', c4Hist);
        const c4fc1 = c4p1.output.find((o) => o.type === 'function_call');
        c4Hist.push({ type: 'function_call', call_id: c4fc1.call_id, name: 'Read', arguments: c4fc1.arguments });
        c4Hist.push({ type: 'function_call_output', call_id: c4fc1.call_id, output: 'ONCE_RESULT' });
        const c4Fin = await postR('fresh-case-4', c4Hist);
        assert.equal(c4Fin.output.find((o) => o.type === 'message').content[0].text, 'CONT_AFTER_TOOL_OK');
        const sid4Calls = promptsLog.filter((x) => x.sid === 'fresh-sid-4');
        assert.equal(sid4Calls.length, 2);
        assert.ok(!sid4Calls[1].pText.includes('UNIQUE_INITIAL_NON_IDEMPOTENT_TASK_8821'), '工具已执行后触发会话内过滤重试时严禁重发初始任务原文');

        // Verify Case 5 (Compaction with retained assistant message preserves ORIGINAL_USER_INTENT_KEEP in timeline)
        await postR('fresh-case-5', [{ role: 'user', content: 'ORIGINAL_USER_INTENT_KEEP' }]);
        await postR('fresh-case-5', [
          { role: 'user', content: '# Resuming from a compaction\n\n<summary>\nCOMPACTED_STATE\n</summary>' },
          { role: 'assistant', content: 'Retained recent assistant reply' },
          { role: 'user', content: 'NEXT_POST_COMPACTION_STEP' },
        ]);
        const rebuiltCall = promptsLog.find((x) => x.sid === 'fresh-sid-6');
        assert.ok(rebuiltCall && rebuiltCall.pText.includes('ORIGINAL_USER_INTENT_KEEP'), '带保留 assistant 历史的阶段压缩重建后不得丢失早期用户意图脉络');
      } finally {
        gw.close();
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    });

    await check('steering during async getAllowedRoots lookup never corrupts replacement turn stats or steals its response', async () => {
      const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'ag-steer-roots-232-'));
      let mcpUrl = '';
      let pauseCwd = false;
      let releaseCwd = null;
      let cwdPausedResolve = null;
      const cwdPausedPromise = new Promise((r) => { cwdPausedResolve = r; });
      let promptSeq = 0;
      const acpSteer = {
        policyBySession: new Map(),
        onNotification: null,
        start: async () => {},
        discover: async () => ({ groups: new Map(), raw: [] }),
        cwdFor: async () => {
          if (pauseCwd) {
            pauseCwd = false;
            if (cwdPausedResolve) cwdPausedResolve();
            await new Promise((r) => { releaseCwd = r; });
          }
          return dir;
        },
        resolveModel: async (m) => m,
        status: () => ({ running: true, ready: true }),
        notify: () => {},
        request: async (method, params) => {
          if (method === 'session/new') {
            mcpUrl = (params.mcpServers && params.mcpServers[0] && params.mcpServers[0].url) || mcpUrl;
            return { sessionId: 'steer-root-sid', models: { currentModelId: 'gemini-4-hydrogen', availableModels: [] } };
          }
          if (method === 'session/close') return {};
          if (method === 'session/prompt') {
            promptSeq += 1;
            if (promptSeq === 1) {
              await fetch(mcpUrl, {
                method: 'POST', headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'Read', arguments: { path: 'slow.js' } } }),
              }).then((r) => r.text());
              return { stopReason: 'cancelled' };
            }
            // Replacement turn after steering: wait until old getAllowedRoots finishes, then answer!
            await new Promise((r) => setTimeout(r, 60));
            acpSteer.onNotification({
              method: 'session/update',
              params: { sessionId: params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'STEERED_NEW_ANSWER' } } },
            });
            return { stopReason: 'end_turn' };
          }
          return {};
        },
      };
      const gw = createGateway({
        acp: acpSteer,
        limiter: { run: (f) => f(), stats: () => ({}) },
        getConfig: () => ({ ...config, source: path.join(dir, 'config.json') }),
        log: () => {},
      });
      const p = await gw.listen([0]);
      const tools = [{ type: 'function', name: 'Read', parameters: { type: 'object', properties: { path: { type: 'string' } } } }];
      const parseResp = (raw) => {
        const evs = raw.split('\n\n').filter(Boolean).map((blk) => {
          const ev = /^event: (.+)$/m.exec(blk)?.[1];
          const d = /^data: (.+)$/m.exec(blk)?.[1];
          return ev && d ? { type: ev, data: JSON.parse(d) } : null;
        }).filter(Boolean);
        return evs.find((e) => e.type === 'response.completed')?.data?.response;
      };
      try {
        const r1Raw = await fetch(`http://127.0.0.1:${p}/v1/responses`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'gemini-4-hydrogen', stream: true, prompt_cache_key: 'steer-root-conv', tools, input: [{ role: 'user', content: 'step 1' }] }),
        }).then((r) => r.text());
        const fc = parseResp(r1Raw).output.find((o) => o.type === 'function_call');

        // Pause getAllowedRoots inside tool resume
        pauseCwd = true;
        const oldResumePromise = fetch(`http://127.0.0.1:${p}/v1/responses`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: 'gemini-4-hydrogen', stream: true, prompt_cache_key: 'steer-root-conv', tools,
            input: [
              { role: 'user', content: 'step 1' },
              { type: 'function_call', call_id: fc.call_id, name: 'Read', arguments: fc.arguments },
              { type: 'function_call_output', call_id: fc.call_id, output: 'L'.repeat(4000) },
            ],
          }),
        }).then((r) => r.text());

        await cwdPausedPromise;
        // Now start a new user steering turn while old tool resume is suspended in getAllowedRoots!
        const steerPromise = fetch(`http://127.0.0.1:${p}/v1/responses`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: 'gemini-4-hydrogen', stream: true, prompt_cache_key: 'steer-root-conv', tools,
            input: [
              { role: 'user', content: 'step 1' },
              { role: 'user', content: 'hi' },
            ],
          }),
        }).then((r) => r.text());

        await new Promise((r) => setTimeout(r, 25));
        if (releaseCwd) releaseCwd();
        const [oldRaw, steerRaw] = await Promise.all([oldResumePromise, steerPromise]);
        const steerResp = parseResp(steerRaw);
        assert.ok(steerResp, '新打断轮次必须正常完成结算');
        assert.equal(steerResp.output.find((o) => o.type === 'message')?.content?.[0]?.text, 'STEERED_NEW_ANSWER', '新回答必须交付给新打断请求而非旧挂起请求');
        assert.ok(!oldRaw.includes('STEERED_NEW_ANSWER'), '被接管的旧请求不得窃取新轮次回答');
        assert.ok(steerResp.usage.input_tokens < 500, `旧挂起工具的 1000 tokens 不得污染新打断轮次统计（实际: ${steerResp.usage.input_tokens}）`);
      } finally {
        if (releaseCwd) releaseCwd();
        gw.close();
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    });
    console.log(`${passed}/${passed} behavioral tests passed`);
  } finally { gateway.close(); }
}
main().catch(e=>{console.error(e);process.exitCode=1;});
