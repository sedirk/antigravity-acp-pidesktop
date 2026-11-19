// Optional integration test: PI_HOST_RUNTIME_DIR points to the matching built host package
// (including its patched pi-ai dependency). Node only, synthetic ACP, no desktop or account.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const require = createRequire(import.meta.url);
const host = process.env.PI_HOST_RUNTIME_DIR;
if (!host || !path.isAbsolute(host)) throw new Error('Set PI_HOST_RUNTIME_DIR to packages/agent-runtime with dist and node_modules');
const load = p => import(pathToFileURL(path.join(host, p)));
const { streamIdleTimeoutMs, withStreamIdleTimeout } = await load('dist/provider-retry.js');
const adapters = {};
for (const api of ['openai-completions', 'openai-responses']) adapters[api] = (await load(`node_modules/@earendil-works/pi-ai/dist/api/${api}.js`)).stream;
const prev = process.env.PI_DESKTOP_STREAM_IDLE_TIMEOUT_MS;
let ordinary, extended;
try {
  delete process.env.PI_DESKTOP_STREAM_IDLE_TIMEOUT_MS; ordinary = streamIdleTimeoutMs();
  process.env.PI_DESKTOP_STREAM_IDLE_TIMEOUT_MS = '600000'; extended = streamIdleTimeoutMs();
} finally { if (prev === undefined) delete process.env.PI_DESKTOP_STREAM_IDLE_TIMEOUT_MS; else process.env.PI_DESKTOP_STREAM_IDLE_TIMEOUT_MS = prev; }
assert.equal(ordinary,180000); assert.equal(extended,600000);
const quick = process.argv.includes('--quick');
const delay = ms => new Promise(r => setTimeout(r, ms));
const wait = quick ? 1600 : 185000;
async function run(api, mode) {
  const root = mode === 'default' && process.env.PI_OLD_ACP_DIR;
  const {createGateway} = root ? require(path.join(root,'lib/server.js')) : require('../lib/server');
  const dir = fs.mkdtempSync(path.join(process.env.PI_SCRATCH_DIR || os.tmpdir(),'idle-host-'));
  const logs = []; let calls = 0, cancellations = 0, stall = 0, finishWait, timer, abortEarly;
  let entered; const dispatched = new Promise(r => { entered = r; });
  const acp = { policyBySession: new Map(), start: async()=>{}, discover: async()=>{}, cwdFor: async()=>dir, resolveModel:x=>x, status:()=>({ready:true}),
    notify(method){if(method==='session/cancel'){++cancellations;finishWait?.(false);}},
    async request(method,p){if(method==='session/new')return {sessionId:'fixture'}; if(method!=='session/prompt')return {};
      ++calls; const active=await new Promise(r=>{finishWait=r;timer=setTimeout(()=>r(true),wait);entered();}); clearTimeout(timer);
      if(!active)return {stopReason:'cancelled'};
      acp.onNotification({method:'session/update',params:{sessionId:p.sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'ONLY_REAL_REPLY'}}}});
      return {stopReason:'end_turn'};
    }};
  const cfg={source:path.join(dir,'config.json'),bind:'127.0.0.1',port:0,bridgeTools:true,toolPolicy:'all',promptIdleTimeoutMs:300000,promptTimeoutMs:0,...(quick?{protocolKeepaliveMs:100}:{})};
  const gw=createGateway({acp,limiter:{run:f=>f(),stats:()=>({})},getConfig:()=>cfg,log:s=>logs.push(s)});
  const ctl=new AbortController(), types=[]; const start=Date.now(); let responseMarker;
  try {
    const port=await gw.listen([0]);
    const model={id:'fixture',name:'fixture',api,provider:'fixture',baseUrl:`http://127.0.0.1:${port}/v1`,input:['text'],contextWindow:256000,maxTokens:32000,reasoning:false,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}};
    const inner=adapters[api](model,{messages:[{role:'user',content:'hello',timestamp:1}],tools:[{name:'Read',description:'unused',parameters:{type:'object',properties:{}}}]},{apiKey:'local-fixture',maxRetries:0,signal:ctl.signal,onResponse:r=>{responseMarker=r.headers['x-antigravity-acp'];}});
    const ms=mode==='default'?(quick?850:ordinary):(quick?5000:extended);
    const stream=withStreamIdleTimeout(inner,model,ms,()=>{++stall;ctl.abort();});
    if(mode==='user-stop') void dispatched.then(()=>{abortEarly=setTimeout(()=>ctl.abort(),120);});
    for await(const e of stream) types.push(e.type);
    const message=await stream.result();
    if(mode==='extended') {assert.equal(stall,0);assert.equal(message.stopReason,'stop',message.errorMessage);assert.deepEqual(message.content.map(x=>[x.type,x.text]),[['text','ONLY_REAL_REPLY']]);assert.equal(responseMarker,'1');}
    else { assert.equal(stall,mode==='default'?1:0);assert.equal(message.stopReason,mode==='default'?'error':'aborted',message.errorMessage);if(mode==='default')assert.match(message.errorMessage,/stream stalled/); }
    for(let n=0;n<100&&cancellations===0&&mode!=='extended';n++)await delay(15);
    assert.equal(calls,1);assert.equal(cancellations,mode==='extended'?0:1);
    console.log(JSON.stringify({mode,api,watchMs:ms,durationMs:Date.now()-start,events:types,stop:message.stopReason,calls,cancellations,stall,marker:responseMarker}));
  } finally {ctl.abort();clearTimeout(abortEarly);clearTimeout(timer);finishWait?.(false);await gw.close();fs.rmSync(dir,{recursive:true,force:true});}
}
const results = await Promise.allSettled(Object.keys(adapters).flatMap(api=>['default','extended','user-stop'].map(mode=>run(api,mode))));
for (const r of results) if (r.status==='rejected') {console.error(r.reason);process.exitCode=1;}
