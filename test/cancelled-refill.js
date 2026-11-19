'use strict';
// Real localhost HTTP, MCP and both wire encodings. ACP runs entirely in memory.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createGateway } = require(process.env.PI_TEST_ACP_ROOT ? path.join(process.env.PI_TEST_ACP_ROOT,'lib/server.js') : '../lib/server');
const delay = ms => new Promise(r => setTimeout(r,ms));
async function until(fn) { for(let i=0;i<300;i++){if(fn())return;await delay(10);} throw new Error('fixture did not reach expected state'); }
const parse = raw => raw.split(/\r?\n\r?\n/).map(f=>/^data: (.+)$/m.exec(f)?.[1]).filter(s=>s && s!=='[DONE]').map(JSON.parse);
for (const api of ['responses','chat']) test(`${api}: exact refill retry, edits, cancellation and real contraction`,{timeout:18000},async()=>{
  const responses = api==='responses', logs=[], bodies=[], returned=[], events=[];
  const dir=fs.mkdtempSync(path.join(process.env.PI_SCRATCH_DIR||os.tmpdir(),'refill-'));
  const cfg={source:path.join(dir,'config.json'),bind:'127.0.0.1',port:0,defaultModel:'m',bridgeTools:true,toolPolicy:'all',promptTimeoutMs:10000,promptIdleTimeoutMs:9000,highContextThrottleMs:0};
  const before=214028, after=25863, older='OLDER-result|'+'X'.repeat(100000), latest='LATEST-result|'+'Y'.repeat(35061);
  let mcp,resolveCancel,serial=0,waiting=0,stops=0;
  const acp={policyBySession:new Map(),start:async()=>{},discover:async()=>{},cwdFor:async()=>dir,resolveModel:x=>x,status:()=>({ready:true}),
    notify(method){if(method==='session/cancel'){stops++;resolveCancel?.();}},
    async request(method,p){if(method==='session/new'){mcp=p.mcpServers[0].url;return {sessionId:'sid-'+(++serial)};}if(method!=='session/prompt')return {};
      const n=bodies.push(p.prompt.map(b=>b.text||'').join(''));
      const emit=u=>acp.onNotification({method:'session/update',params:{sessionId:p.sessionId,update:u}});
      if(n===1){
        emit({sessionUpdate:'usage_update',used:before,size:1048576});
        for(let i=1;i<=2;i++){
          const result=await fetch(mcp,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:i,method:'tools/call',params:{name:'Read',arguments:{file:'f'+i}}})});
          returned.push(await result.text());
        }
      }
      if(n<=6){
        waiting=n;await new Promise(r=>{resolveCancel=r;});resolveCancel=null;
        // Some runtimes send a final progress/watermark and even end_turn AFTER cancellation.
        emit({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'LATE_UNDELIVERED'}});
        emit({sessionUpdate:'usage_update',used:990001,size:1048576});
        return {stopReason:n%2===0?'end_turn':'cancelled',usage:{inputTokens:990000,outputTokens:1,totalTokens:990001}};
      }
      emit({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'RECOVERED'}});
      emit({sessionUpdate:'usage_update',used:after,size:1048576});return {stopReason:'end_turn'};
    }};
  const gw=createGateway({acp,getConfig:()=>cfg,limiter:{run:f=>f(),stats:()=>({})},log:s=>{logs.push(s);if(s.startsWith('[acp-diag] '))events.push(JSON.parse(s.slice(11)));}});
  const history=[{role:'user',content:'audit the whole file'}];
  try{
    const port=await gw.listen([0]);const tool={name:'Read',parameters:{type:'object',properties:{file:{type:'string'}}}};
    const post=async(signal)=>{const req={model:'m',stream:true,prompt_cache_key:'case',tools:responses?[{type:'function',...tool}]:[{type:'function',function:tool}],...(responses?{input:history}:{messages:history})};const res=await fetch(`http://127.0.0.1:${port}/v1/${responses?'responses':'chat/completions'}`,{method:'POST',signal,headers:{'content-type':'application/json'},body:JSON.stringify(req)});assert.equal(res.status,200);return res.text();};
    for(const payload of [older,latest]){
      const frames=parse(await post());const call=responses?frames.find(e=>e.type==='response.completed').response.output.find(x=>x.type==='function_call'):frames.flatMap(e=>e.choices?.[0]?.delta?.tool_calls||[]).find(x=>x.id);
      assert.ok(call); if(responses){history.push(call,{type:'function_call_output',call_id:call.call_id,output:payload});}else history.push({role:'assistant',content:'',tool_calls:[call]},{role:'tool',tool_call_id:call.id,content:payload});
    }
    for(let n=1;n<=6;n++){
      const ctl=new AbortController();const request=post(ctl.signal).catch(e=>{if(!ctl.signal.aborted)throw e;});await until(()=>waiting===n);ctl.abort();await request;
      await until(()=>events.filter(e=>e.event==='end').length===n);
    }
    assert.equal(returned.length,2);assert.ok(returned[0].includes(older) && returned[1].includes(latest));
    const ends=events.filter(e=>e.event==='context_final');assert.equal(ends.length,6);
    assert.deepEqual(ends.map(e=>e.reportedUsed),Array(6).fill(before),'cancelled increments must never become a new baseline');
    assert.ok(ends.every(e=>e.pendingBefore>0));assert.equal(events.some(e=>e.rawUsed===990001),false);
    assert.ok(events.filter(e=>e.event==='end').every(e=>e.status==='cancelled' && e.waitingForProgress));
    for(const text of bodies.slice(1)){assert.ok(text.includes(latest),'preserve the in-doubt last result');assert.ok(!text.includes(older),'do not replay known earlier tool history');}
    if(responses)history[2].output=older+' EDITED';else history[2].content=older+' EDITED';
    const recovered=await post();assert.ok(recovered.includes('RECOVERED'));assert.ok(!recovered.includes('LATE_UNDELIVERED'));
    assert.ok(bodies[6].includes(older+' EDITED') && bodies[6].includes(latest),'changed snapshot: full incremental fallback');
    assert.equal(events.filter(e=>e.event==='context_final').at(-1).reportedUsed,after);
    assert.equal(stops,6);assert.equal(serial,1);assert.equal(bodies.length,7);
  }finally{resolveCancel?.();await gw.close();fs.rmSync(dir,{recursive:true,force:true});}
});

test('multi-tool (28) disconnect retry unlocks wedged session, reloads worker, replays only trailing batch, and filters steer skips',{timeout:25000},async()=>{
  const dir=fs.mkdtempSync(path.join(process.env.PI_SCRATCH_DIR||os.tmpdir(),'refill28-'));
  const cfg={source:path.join(dir,'config.json'),bind:'127.0.0.1',port:0,defaultModel:'m',bridgeTools:true,toolPolicy:'all',promptTimeoutMs:0,promptIdleTimeoutMs:300000,highContextThrottleMs:0};
  let mcp,serial=0,prompts=0,loads=0,closes=0,wedgedReject=null,waitingRetryGate=false;
  const bodies=[],toolCallsReceived=[];
  const acp={policyBySession:new Map(),start:async()=>{},discover:async()=>{},cwdFor:async()=>dir,resolveModel:x=>x,status:()=>({ready:true,running:true}),
    notify(){ /* 模拟底层卡死：忽略 session/cancel */ },
    abandon(method,reason,targetSid){if(method==='session/prompt'&&wedgedReject){const r=wedgedReject;wedgedReject=null;r(Object.assign(new Error(reason||'abandoned'),{code:'ACP_ABANDONED'}));return 1;}return 0;},
    async request(method,p){
      if(method==='session/new'){mcp=p.mcpServers[0].url;return {sessionId:'sid28-'+(++serial)};}
      if(method==='session/close'){closes++;return {};}
      if(method==='session/load'){loads++;mcp=p.mcpServers[0].url;return {};}
      if(method!=='session/prompt')return {};
      const n=++prompts;
      bodies.push(p.prompt.map(b=>b.text||'').join(''));
      const emit=u=>acp.onNotification({method:'session/update',params:{sessionId:p.sessionId,update:u}});
      if(n===1){
        // 第一步：单个历史工具；第二步：并发 28 个工具回交，收到全部 28 个结果后底层挂死不返回
        const r0=await fetch(mcp,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:100,method:'tools/call',params:{name:'Read',arguments:{file:'old.txt'}}})});
        toolCallsReceived.push(await r0.text());
        const batch=await Promise.all(Array.from({length:28},(_,i)=>fetch(mcp,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:200+i,method:'tools/call',params:{name:'Read',arguments:{file:`b_${i}.txt`}}})}).then(r=>r.text())));
        toolCallsReceived.push(...batch);
        waitingRetryGate=true;
        return await new Promise((_,rej)=>{wedgedReject=rej;});
      }
      emit({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'BATCH_28_RECOVERED'}});
      return {stopReason:'end_turn'};
    }};
  const gw=createGateway({acp,getConfig:()=>cfg,limiter:{run:f=>f(),stats:()=>({})},log:()=>{}});
  try{
    const port=await gw.listen([0]);
    const tool={type:'function',function:{name:'Read',parameters:{type:'object',properties:{file:{type:'string'}}}}};
    const messages=[{role:'user',content:'inspect 28 files'}];
    const post=async(signal)=>{const res=await fetch(`http://127.0.0.1:${port}/v1/chat/completions`,{method:'POST',signal,headers:{'content-type':'application/json'},body:JSON.stringify({model:'m',stream:true,prompt_cache_key:'c28',tools:[tool],messages})});assert.equal(res.status,200);return res.text();};
    // Step 1: old single tool
    const f1=parse(await post());
    const c0=f1.flatMap(e=>e.choices?.[0]?.delta?.tool_calls||[]).find(x=>x.id);
    assert.ok(c0);
    messages.push({role:'assistant',content:'',tool_calls:[c0]},{role:'tool',tool_call_id:c0.id,content:'OLD_STEP_DATA_DO_NOT_REPLAY'});
    // Step 2: 28 parallel tools
    const f2=parse(await post());
    const calls28=f2.flatMap(e=>e.choices?.[0]?.delta?.tool_calls||[]).filter(x=>x.id);
    assert.equal(calls28.length,28);
    messages.push({role:'assistant',content:'',tool_calls:calls28},...calls28.map((c,i)=>({role:'tool',tool_call_id:c.id,content:`RES_28_${i}`})));
    // Step 3: 180s host stream idle disconnect while ACP prompt #1 is wedged
    const ctl=new AbortController();
    const leg3=post(ctl.signal).catch(e=>{if(!ctl.signal.aborted)throw e;});
    await until(()=>waitingRetryGate);
    ctl.abort();
    await leg3;
    // Step 4: Automatic host retry 1s later with identical messages -> must unlock within ~1.6s, close+load wedged session, and replay ONLY the 28-tool trailing batch
    const tStart=Date.now();
    const recovered=await post();
    assert.ok(Date.now()-tStart<6000,'retry must not deadlock behind wedged prompt lock');
    assert.ok(recovered.includes('BATCH_28_RECOVERED'));
    assert.equal(serial,1,'session reused via session/load instead of losing context');
    assert.equal(closes,1);
    assert.equal(loads,1);
    assert.equal(toolCallsReceived.length,29,'no tool was re-executed');
    assert.ok(bodies[1].includes('RES_28_0')&&bodies[1].includes('RES_28_27'),'replayed in-doubt 28-tool batch');
    assert.ok(!bodies[1].includes('OLD_STEP_DATA_DO_NOT_REPLAY'),'did not replay earlier tool history');
    // Step 5: Host steer skip placeholder is never forwarded as real tool output
    messages.push(
      {role:'assistant',content:'',tool_calls:[{id:'call_skip_1',type:'function',function:{name:'Read',arguments:'{"file":"x"}'}}]},
      {role:'tool',tool_call_id:'call_skip_1',content:'Skipped because new user input is waiting.'},
      {role:'user',content:'继续执行真实任务'}
    );
    const afterSteer=await post();
    assert.ok(afterSteer.includes('BATCH_28_RECOVERED'));
    assert.ok(!bodies[2].includes('Skipped because new user input is waiting.'),'steer skip placeholder filtered');
    assert.ok(bodies[2].includes('继续执行真实任务'));
  }finally{wedgedReject?.(Object.assign(new Error('cleanup'),{code:'ACP_ABANDONED'}));await gw.close();fs.rmSync(dir,{recursive:true,force:true});}
});

test('127.0.0.1 loopback connectex self-heals via runtime restart + session/load, and salvages with full flatten if footprint lost',{timeout:20000},async()=>{
  const dir=fs.mkdtempSync(path.join(process.env.PI_SCRATCH_DIR||os.tmpdir(),'loopback-heal-'));
  const cfg={source:path.join(dir,'config.json'),bind:'127.0.0.1',port:0,defaultModel:'m',bridgeTools:true,toolPolicy:'all',promptTimeoutMs:10000,promptIdleTimeoutMs:10000};
  let restarts=0,starts=0,serial=0,mode='reload-ok',ready=true;
  const promptsBySid=[];
  const acp={policyBySession:new Map(),onExit:null,
    async start(){starts++;ready=true;},
    restart(){restarts++;ready=false;acp.onExit?.();return {pid:123,stopped:true};},
    discover:async()=>{},cwdFor:async()=>dir,resolveModel:x=>x,status:()=>({ready,running:ready}),notify(){},
    async request(method,p){
      if(method==='session/new')return {sessionId:'loop-sid-'+(++serial)};
      if(method==='session/load'){
        if(mode==='reload-lost')throw new Error('session footprint missing after crash');
        return {};
      }
      if(method!=='session/prompt')return {};
      const text=p.prompt.map(b=>b.text||'').join('');
      promptsBySid.push({sid:p.sessionId,text});
      if(promptsBySid.length===1||promptsBySid.length===3){
        throw new Error('Agent execution error: doRequest: error sending request: Post "http://127.0.0.1:59600/v1beta/models/gemini-4-carbon-high:streamGenerateContent?alt=sse": dial tcp 127.0.0.1:59600: connectex: A connection attempt failed because the connected party did not properly respond after a period of time, or established connection failed because connected host has failed to respond.');
      }
      acp.onNotification({method:'session/update',params:{sessionId:p.sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:mode==='reload-ok'?'HEALED_BY_LOAD':'HEALED_BY_SALVAGE'}}}});
      return {stopReason:'end_turn'};
    }};
  const gw=createGateway({acp,getConfig:()=>cfg,limiter:{run:f=>f(),stats:()=>({})},log:()=>{}});
  try{
    const port=await gw.listen([0]);
    const tool={type:'function',function:{name:'Read',parameters:{type:'object',properties:{file:{type:'string'}}}}};
    const post=async(key,messages)=>{const res=await fetch(`http://127.0.0.1:${port}/v1/chat/completions`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:'m',stream:true,prompt_cache_key:key,tools:[tool],messages})});assert.equal(res.status,200);return res.text();};
    // Case A: runtime restart + session/load succeeds transparently
    const r1=await post('conv-a',[{role:'user',content:'first turn recover via load'}]);
    assert.ok(r1.includes('HEALED_BY_LOAD'));
    assert.equal(restarts,1);
    assert.ok(starts>=1);
    assert.equal(promptsBySid[0].sid,'loop-sid-1');
    assert.equal(promptsBySid[1].sid,'loop-sid-1');
    // Case B: runtime restart + session/load fails -> RUNTIME_RELOAD_LOST_SESSION triggers fresh session full context replay
    mode='reload-lost';
    const r2=await post('conv-b',[
      {role:'user',content:'EARLY_CONTEXT_MUST_SURVIVE'},
      {role:'assistant',content:'acknowledged early context'},
      {role:'user',content:'continue after dead loopback'}
    ]);
    assert.ok(r2.includes('HEALED_BY_SALVAGE'));
    assert.equal(restarts,2);
    assert.equal(promptsBySid[2].sid,'loop-sid-2');
    assert.equal(promptsBySid[3].sid,'loop-sid-3');
    assert.ok(promptsBySid[3].text.includes('EARLY_CONTEXT_MUST_SURVIVE'),'salvage session replayed full conversation history');
  }finally{await gw.close();fs.rmSync(dir,{recursive:true,force:true});}
});
