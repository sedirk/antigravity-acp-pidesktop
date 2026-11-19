// Run with node --test; PI_TRUSTED_RUNTIME optionally points to an exact source checkout with jiti.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {dirname,join} from 'node:path';
import register from '../agent/budget-status-239.mjs';
import {endpoint,receiptURL,observation,readReceipt} from '../agent/receipt.mjs';
const receipt='a'.repeat(32), second='b'.repeat(32), root=dirname(dirname(fileURLToPath(import.meta.url)));
const sample=(used,size)=>({version:1,state:'observed',observation:{used,...(size===undefined?{}:{size})}});
let serial=0;
function harness(base='http://127.0.0.1:32321/v1',id=`session-${++serial}`,native=true) {
  const handlers={},cmd={},writes=[],notices=[],stats={reads:0,status:0};let model={baseUrl:base,provider:'custom-local',id:'gemini-4-carbon',api:'openai-responses'};
  const ctx={get model(){return model;},set model(v){model=v;},ui:{notify:t=>notices.push(t),setStatus:()=>stats.status++,...(native?{setProviderContext:x=>writes.push(x)}:{})},
    sessionManager:{getSessionId:()=>id},getContextUsage:()=>{stats.reads++;return {tokens:131752,contextWindow:224000};}};
  register({on:(n,h)=>handlers[n]=h,registerCommand:(n,v)=>cmd[n]=v});
  let waiting=false;
  const emit=(n,e={})=>{if(n==='before_provider_request')waiting=true;if(n==='after_provider_response')waiting=false;return handlers[n](e,ctx);};emit('session_start');
  const headers=(r=receipt,extra={})=>({model:ctx.model,response:{status:200,headers:{'X-Antigravity-ACP':'1',...(r?{'X-Antigravity-ACP-Context-Id':r}:{})}},...extra});
  return {ctx,emit,headers,writes,notices,stats,command:()=>cmd['acp-context'].handler('',ctx),response:(r=receipt,extra={})=>{if(!waiting)emit('before_provider_request',{contextRequestId:extra.contextRequestId});return emit('after_provider_response',headers(r,extra));}};
}
async function fixture(t,fn){const requests=[];const srv=http.createServer((req,res)=>{requests.push({path:req.url,headers:req.headers});fn(req,res);});await new Promise(r=>srv.listen(0,'127.0.0.1',r));t.after(()=>{srv.closeAllConnections();return new Promise(r=>srv.close(r));});return {base:`http://127.0.0.1:${srv.address().port}/v1`,requests};}
function json(res,b){res.writeHead(200,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(b));}
test('read-only command: stock host, measured shrink/zero and observed capacity are separate from budget',async t=>{
  let n=41895;const f=await fixture(t,(_q,r)=>json(r,sample(n,1048576)));const h=harness(f.base,undefined,false);t.after(()=>h.emit('session_shutdown'));
  h.response();await h.command();assert.match(h.notices.at(-1),/131,752 \/ 224,000 · 59%/);assert.match(h.notices.at(-1),/41,895 \/ 1,048,576/);n=0;await h.command();assert.match(h.notices.at(-1),/：0 \/ 1,048,576/);assert.equal(h.stats.status,0);assert.ok(f.requests.every(q=>!q.headers.authorization&&!q.headers.cookie&&q.path.endsWith(receipt)));
});
test('unmarked, non-2xx, foreign, stale model, invalid session and missing receipt fail closed',async()=>{
  for(const mode of ['never','unmarked','error','foreign','stale','no-id']){const h=harness(undefined,mode==='no-id'?'':undefined);if(mode==='foreign')h.ctx.model={...h.ctx.model,baseUrl:'https://school.invalid/v1'};
    if(mode!=='never')h.response(null,mode==='unmarked'?{response:{status:200,headers:{}}}:mode==='error'?{response:{status:503,headers:{'x-antigravity-acp':'1'}}}:mode==='stale'?{model:{...h.ctx.model,id:'other'}}:{});
    assert.equal(h.emit('session_before_compact'),undefined);await h.command();assert.match(h.notices.at(-1),/尚无已确认/);assert.equal(h.stats.reads,0);assert.equal(h.stats.status,0);assert.deepEqual(h.writes,[]);h.emit('session_shutdown');}
  const h=harness();h.response(null);await h.command();assert.match(h.notices.at(-1),/尚无可归属/);assert.deepEqual(h.writes,[{}]);h.emit('session_shutdown');
});
test('native publisher only receives source observations; compaction retains labelled pre-sample and no decisions',async t=>{
  const f=await fixture(t,(_q,r)=>json(r,sample(12)));const h=harness(f.base);t.after(()=>h.emit('session_shutdown'));h.response();await h.command();assert.deepEqual(h.writes,[{},{used:12}]);h.ctx.getContextUsage=()=>({tokens:201904,contextWindow:224000,autoCompactAt:201600});assert.equal(h.emit('session_before_compact',{reason:'threshold'}),undefined);h.response(second);assert.equal(h.emit('session_compact'),undefined);h.ctx.getContextUsage=()=>({tokens:38655,contextWindow:224000,autoCompactAt:201600});await h.command();assert.match(h.notices.at(-1),/38,655/);assert.match(h.notices.at(-1),/201,600/);assert.match(h.notices.at(-1),/压缩前采样：201,904/);assert.match(h.notices.at(-1),/尚无可归属/);assert.equal(h.stats.status,0);
});
test('late receipt across replacement, active model switch, runner replacement and aborted request never leaks',async t=>{
  let held,seen;const arrived=new Promise(r=>seen=r);const f=await fixture(t,(q,r)=>{if(q.url.endsWith(receipt)){held=r;seen();}else json(r,sample(7));});const h=harness(f.base,'replace');h.response();const first=h.command();await arrived;h.response(second);held.end(JSON.stringify(sample(999)));await first;await h.command();assert.deepEqual(h.writes.at(-1),{used:7});assert.equal(h.notices.length,1);assert.ok(!h.writes.some(o=>o?.used===999));
  h.ctx.model={...h.ctx.model,id:'new-model'};await h.command();assert.equal(h.writes.at(-1),undefined);const h2=harness(f.base,'replace');h.emit('session_shutdown');h2.response(second);await h2.command();assert.deepEqual(h2.writes.at(-1),{used:7});h2.emit('message_end',{message:{role:'assistant',stopReason:'aborted'}});await h2.command();assert.match(h2.notices.at(-1),/尚无可归属/);h2.emit('agent_end');h2.response(second);assert.deepEqual(h2.writes.at(-1),{});h2.emit('session_shutdown');
});
test('remote/redirect/oversized/corrupt/timeout are not observations or source of external traffic',async t=>{
  for(const baseUrl of ['https://school.invalid/v1','file:///x','http://u:p@127.0.0.1/v1','http://not-localhost.test/v1','http://127.0.0.1/v1?x=y'])assert.equal(endpoint({baseUrl}),undefined);
  assert.equal(receiptURL({baseUrl:'http://localhost:5/v1'},'../secret'),undefined);
  for(const o of [{used:-1},{used:2.1},{used:'12'},{used:5,size:0},{used:Number.MAX_SAFE_INTEGER+1}])assert.equal(observation({version:1,state:'observed',observation:o}),undefined);
  let mode='redirect';const f=await fixture(t,(_q,r)=>{if(mode==='redirect'){r.writeHead(302,{Location:'/not-allowed'});r.end();}else if(mode==='big')json(r,{x:'x'.repeat(2048)});else if(mode==='bad'){r.writeHead(200,{'Content-Type':'application/json'});r.end('{');}else{} });
  const url=receiptURL({baseUrl:f.base},receipt);for(mode of ['redirect','big','bad','timeout'])assert.equal(await readReceipt(url,new AbortController().signal),undefined);assert.equal(f.requests.length,4);
});
test('two concurrent sessions/end and disabled native surface: no status fallback',async t=>{
  const f=await fixture(t,(q,r)=>json(r,sample(q.url.endsWith(receipt)?2:200,512)));const a=harness(f.base),b=harness(f.base);a.response();b.response(second);await Promise.all([a.command(),b.command()]);assert.deepEqual(a.writes.at(-1),{used:2,size:512});assert.deepEqual(b.writes.at(-1),{used:200,size:512});a.emit('session_shutdown');await b.command();assert.match(b.notices.at(-1),/200 \/ 512/);assert.equal(a.stats.status+b.stats.status,0);b.emit('session_shutdown');
});
test('observations while streaming are readable; the next request clears the prior reading before headers',async t=>{
  let state='pending';const f=await fixture(t,(_q,r)=>json(r,{version:1,state,...(state==='pending'?{observation:{used:0,size:8192}}:{})}));const h=harness(f.base);t.after(()=>h.emit('session_shutdown'));h.response();await h.command();assert.deepEqual(h.writes.at(-1),{used:0,size:8192});assert.match(h.notices.at(-1),/：0 \/ 8,192/);
  assert.equal(h.emit('before_provider_request',{payload:{}}),undefined);assert.deepEqual(h.writes.at(-1),{});await h.command();assert.match(h.notices.at(-1),/尚无可归属/);assert.equal(f.requests.length,1);
  state='unavailable';h.response(second);await h.command();assert.match(h.notices.at(-1),/尚无可归属/);assert.equal(h.stats.status,0);
});
test('same binding: late headers do not replace the next step; stock ambiguity clears when both drain',async t=>{
  const f=await fixture(t,(q,r)=>json(r,sample(q.url.endsWith(receipt)?111:222)));
  for(const withId of [true,false]){
    const h=harness(f.base);t.after(()=>h.emit('session_shutdown'));await h.response(second);
    const event=id=>withId?{contextRequestId:id}:{};
    for(const reverse of [true,false]){
      h.emit('before_provider_request',event(1));h.emit('before_provider_request',event(2));
      for(const [n,id] of reverse?[[second,2],[receipt,1]]:[[receipt,1],[second,2]])await h.emit('after_provider_response',h.headers(n,event(id)));
      await h.command(); if(withId)assert.match(h.notices.at(-1),/：222/);else assert.match(h.notices.at(-1),/尚无可归属/);
      assert.ok(!h.writes.some(x=>x?.used===111));
    }
    await h.response(second,event(3));await h.command();assert.match(h.notices.at(-1),/：222/);
  }
});
test('actual plugin grant/index/runner and slash command (no model traffic)',{skip:!process.env.PI_TRUSTED_RUNTIME},async()=>{
  const rt=process.env.PI_TRUSTED_RUNTIME, file=(...p)=>pathToFileURL(join(rt,...p)).href;const {createJiti}=await import(file('node_modules','jiti','lib','jiti-static.mjs'));const j=createJiti(file('package.json'),{moduleCache:false,tryNative:false,alias:Object.fromEntries(['plugin-sdk','host-runtime','shared','agent-host'].map(n=>[`@pi-desktop/${n}`,join(rt,'packages',n,'src','index.ts')]))});
  const {PluginRuntime}=await j.import(file('apps/desktop/electron/main/plugin-runtime.ts'));const {TrustedExtensionRunner}=await j.import(file('packages/agent-runtime/src/extensions/runner.ts'));
  const runtime=new PluginRuntime({audit(){},spawnProcess(){let receive;return{onMessage(h){receive=h;},onExit(){},kill(){},postMessage(m){queueMicrotask(()=>receive({t:'res',id:m.id,ok:true}));}};}});const id='local.antigravity-acp';let runner;
  try{const m=await runtime.loadFromPath(root,['ui.panel','ui.view','background.service']);assert.equal(m.version,'2.3.9');assert.equal(runtime.rendererDescriptor(id),undefined);assert.deepEqual(runtime.getAgentExtensions(),[]);
    await runtime.loadFromPath(root,m.permissions);assert.ok(runtime.rendererDescriptor(id));assert.deepEqual(m.rendererActions,['plugin.call']);assert.deepEqual(m.rendererCallMethods,['readContextMeter']);const specs=runtime.getAgentExtensions().map(x=>({id:x.id,entry:x.entry,label:x.pluginName,source:'plugin',root:x.root}));assert.equal(specs.length,1);
    const ui=[],mdl={id:'m',provider:'pi',baseUrl:'http://127.0.0.1:1/v1'};runner=new TrustedExtensionRunner({specs,bridge:{sessionId:'real',cwd:rt,getModel:()=>mdl,isIdle:()=>true,getContextUsage:()=>({tokens:38177,contextWindow:224000}),publishCommands(){},publishDiagnostics(){},getAllTools:()=>[],getActiveTools:()=>[],requestUi:async(_s,r)=>{ui.push(r);return{kind:r.kind};}}});const [r]=await runner.load();assert.equal(r.state,'loaded');assert.ok(r.commandNames.includes('acp-context'));await runner.emit('before_provider_request',{payload:{}});await runner.emit('after_provider_response',{model:mdl,response:{status:200,headers:{'x-antigravity-acp':'1'}}});assert.equal(await runner.runCommand('acp-context',''),true);assert.match(ui.find(e=>e.kind==='notify').message,/38,177 \/ 224,000/);assert.ok(!ui.some(e=>e.kind==='setStatus'));assert.deepEqual(runner.getDiagnostics(),[]);
  }finally{await runner?.dispose();await runtime.unload(id);}assert.deepEqual(runtime.getAgentExtensions(),[]);
});
test('a summary cannot establish the first ACP reading, even if its headers arrive after the checkpoint',async t=>{
  const f=await fixture(t,(_q,r)=>json(r,sample(75)));const h=harness(f.base);t.after(()=>h.emit('session_shutdown'));
  h.emit('session_before_compact');h.emit('before_provider_request');h.emit('session_compact');
  await h.emit('after_provider_response',h.headers(receipt));await h.command();
  assert.match(h.notices.at(-1),/尚无已确认/);assert.deepEqual(h.writes,[]);assert.equal(f.requests.length,0);
  await h.response(second);await h.command();assert.match(h.notices.at(-1),/：75/);
});
test('stock preheader abort, delayed old receipt, then independent successes: do not guess or wedge the runner',async t=>{
  const early=Date.now()-1000;let issued=0;
  const f=await fixture(t,(q,r)=>{const old=q.url.endsWith(receipt);r.setHeader('x-antigravity-acp-receipt-issued-at',String(old?early:issued));json(r,sample(old?919:222));});
  const h=harness(f.base);t.after(()=>h.emit('session_shutdown'));
  h.emit('agent_start');h.emit('before_provider_request');h.emit('message_end',{message:{role:'assistant',stopReason:'aborted'}});h.emit('agent_end');h.emit('agent_settled');
  await new Promise(r=>setTimeout(r,8));issued=Date.now();
  for(let i=0;i<3;i++){h.emit('agent_start');h.emit('before_provider_request');await h.emit('after_provider_response',h.headers(receipt));assert.ok(!h.writes.some(v=>v?.used===919));
    const current=h.emit('after_provider_response',h.headers(second));if(i===1)h.emit('agent_end');await current;await h.command();assert.match(h.notices.at(-1),/：222/);h.emit('agent_end');}
});
