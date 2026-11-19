'use strict';
const {test}=require('node:test'),a=require('node:assert/strict'),p=require('node:path'),fs=require('node:fs'),os=require('node:os'),crypto=require('node:crypto'),net=require('node:net');
const {createStore}=require('../lib/meter-store'),{meterService}=require('../lib/meter-service'),{publisher}=require('../lib/meter-link');const t0=Date.now(),A='1'.repeat(32),B='2'.repeat(32);const src=new Map([[A,{seq:1,createdAt:t0,expiresAt:t0+600000,used:111,size:1024}],[B,{seq:2,createdAt:t0,expiresAt:t0+600000,used:null,size:null}]]);
const msg=(r=A,rev=1,extra={})=>({version:1,sessionId:'pi-one',providerId:'local-abcd',modelId:'test-model',receipt:r,revision:rev,sampledAt:t0,phase:'sample',budget:{tokens:130,limit:100},...extra});
const wait=ms=>new Promise(r=>setTimeout(r,ms));async function poll(fn){for(let i=0;i<90;i++){const x=await fn();if(x)return x;await wait(12);}a.fail('expected condition');}
test('receipt ownership, newer HTTP steps, deterministic same-step order, explicit zero/missing size, expiry',()=>{let now=t0;const map=new Map(src),s=createStore(r=>map.get(r),()=>now);a.equal(s.accept(msg()),true);a.deepEqual(s.read('pi-one').upstream,{used:111,size:1024});a.equal(s.accept(msg(A,2,{sessionId:'pi-two'})),false);a.equal(s.accept(msg(B)),true);a.equal(s.read('pi-one').upstream,undefined);a.equal(s.accept(msg(A,999)),false);map.set(B,{...map.get(B),used:0});a.deepEqual(s.read('pi-one').upstream,{used:0});a.equal(s.accept(msg(B,3,{budget:{tokens:0,limit:4}})),true);a.equal(s.accept(msg(B,2)),false);a.equal(s.read('pi-one').budget.tokens,0);now=t0+600000;a.equal(s.read('pi-one'),null);a.equal(s.accept(msg(B,4)),false);});
test('compaction starts by hiding, including veto without a terminal hook; a tombstone rejects late samples',()=>{const s=createStore(r=>src.get(r),()=>t0);s.accept(msg());a.equal(s.accept(msg(A,2,{phase:'compacting'})),true);a.equal(s.read('pi-one'),null);a.equal(s.accept(msg(A,3)),false);s.accept(msg(A,4,{phase:'drop'}));a.equal(s.read('pi-one'),null);a.equal(s.accept(msg(A,5)),false);s.accept(msg(B,1));a.equal(s.read('pi-one').budget.tokens,130);});
test('malformed/missing identity or source is not rendered; invalid/unknown budget is not zero',()=>{const s=createStore(r=>src.get(r),()=>t0);for(const bad of [{providerId:''},{sessionId:'\n'},{modelId:'X'.repeat(257)},{sampledAt:t0+10000},{revision:.5},{receipt:'0'.repeat(32)},{phase:'error'}])a.equal(s.accept(msg(A,1,bad)),false);a.equal(s.read('pi-one'),null);a.equal(s.accept(msg(A,1,{budget:{tokens:-1,limit:44}})),true);a.equal(s.read('pi-one').budget,undefined);});
test('local channel validates its own gateway, selection, auth, closed service, and does not cache bootstrap across restart',async()=>{const d=fs.mkdtempSync(p.join(os.tmpdir(),'pi-meter-check-'));let active='pi-one',delayed,reads=0;const gw={meterReceipt:r=>src.get(r)},start=()=>meterService(gw,()=>{reads++;return delayed||Promise.resolve({sessionId:active});},d),pub=publisher(d),rd=s=>s.read('readContextMeter',{sessionId:'pi-one'});let service=start();try{a.ok(await service.ready);pub(msg('0'.repeat(32)));await wait(40);a.equal(await rd(service),null);a.equal(reads,0);pub(msg());a.equal((await poll(()=>rd(service))).budget.tokens,130);active='school';a.equal(await rd(service),null);active='pi-one';a.equal(await service.read('x',{sessionId:'pi-one'}),null);a.equal(await service.read('readContextMeter',{sessionId:'pi-one',receipt:A}),null);
const k=fs.readFileSync(p.join(d,'channel'),'utf8'),stem='pam-'+crypto.createHash('sha256').update('socket\0'+k).digest('hex').slice(0,32),address=process.platform==='win32'?'\\\\.\\pipe\\'+stem:p.join(d,stem+'.sock');for(const bytes of [Buffer.from(JSON.stringify(msg(A,9,{phase:'drop'}))),Buffer.alloc(4600,1)])await new Promise(res=>{const s=net.createConnection(address,()=>s.end(bytes));s.on('error',()=>{});s.on('close',res);});a.equal((await rd(service)).budget.tokens,130);
let go;delayed=new Promise(r=>go=r);const result=rd(service);service.close();go({sessionId:'pi-one'});a.equal(await result,null);delayed=null;service=start();a.ok(await service.ready);pub(msg(B,1));a.equal((await poll(()=>rd(service))).upstream,undefined);pub(msg(B,2,{phase:'drop'}));await poll(async()=>(await rd(service))===null);a.equal(fs.readdirSync(d).filter(n=>n==='channel').length,1);a.equal(fs.readFileSync(p.join(d,'channel'),'utf8').length,64);
}finally{service.close();await wait(30);fs.rmSync(d,{recursive:true,force:true});}});
test('stock modelChanged invalidates issued receipts including delayed first samples, other sessions untouched',()=>{let t=t0;const m=new Map(src),s=createStore(r=>m.get(r),()=>t);s.accept(msg());t+=10;s.modelChanged({sessionId:'pi-one',modelKey:'school/new'});a.equal(s.read('pi-one'),null);a.equal(s.accept(msg(A,99)),false);a.equal(s.accept(msg(B,1,{providerId:'school',modelId:'new'})),false);t+=10;m.set(B,{...m.get(B),createdAt:t});a.equal(s.accept(msg(B,1,{sampledAt:t})),false);a.equal(s.accept(msg(B,1,{sampledAt:t,providerId:'school',modelId:'new'})),true);a.equal(s.read('pi-one').expiresAt,m.get(B).expiresAt);s.modelChanged({sessionId:'other',modelKey:null});a.equal(s.read('pi-one').modelId,'new');});
test('oldest gateway evictions do not wedge the bounded owner registry',()=>{const db=require('../lib/observations').createObservationStore({now:()=>t0});const s=createStore(r=>db.inspect(r),()=>t0);for(let i=1;i<=515;i++){const {receipt}=db.issue();a.equal(s.accept(msg(receipt,1,{budget:{tokens:i,limit:1000}})),true);}a.equal(db.size(),512);a.equal(s.read('pi-one').budget.tokens,515);});
test('custom endpoint UUID modelChanged clears old sample, blocks pre-switch turn, and immediately accepts post-switch custom sample',async()=>{
  let now=t0,seq=2;const C='3'.repeat(32),D='4'.repeat(32);const m=new Map(src);
  const s=createStore(r=>m.get(r),()=>now,()=>seq);
  // Model A (custom runtime provider, host UUID row A)
  a.equal(s.accept(msg(A,1,{providerId:'custom',modelId:'model-a',turnAt:now-20})),true);
  a.equal(s.read('pi-one').modelId,'model-a');
  // Host emits session:modelChanged with row UUID + model-b
  now+=50;s.modelChanged({sessionId:'pi-one',modelKey:'7b9e41d0-1111-4222-8333-444455556666/model-b'});
  a.equal(s.read('pi-one'),null);
  // Late receipt from a turn that started BEFORE modelChanged (even if receipt issued after fence): rejected
  const fenceAt=now;now+=20;seq=3;m.set(C,{seq:3,createdAt:now,expiresAt:now+600000,used:999,size:1024});
  a.equal(s.accept(msg(C,1,{providerId:'custom',modelId:'model-b',sampledAt:now,turnAt:fenceAt})),false);
  a.equal(s.fencedAfter('pi-one',fenceAt),true);
  // New turn started AFTER modelChanged on custom provider row B: accepted immediately without waiting 10min TTL
  now+=20;seq=4;m.set(D,{seq:4,createdAt:now,expiresAt:now+600000,used:640,size:1048576});
  a.equal(s.fencedAfter('pi-one',now),false);
  a.equal(s.accept(msg(D,1,{providerId:'custom',modelId:'model-b',sampledAt:now,turnAt:now,budget:{tokens:630,limit:1000}})),true);
  a.deepEqual(s.read('pi-one').upstream,{used:640,size:1048576});
  // extension-agent provider prefix remains strictly enforced
  now+=10;s.modelChanged({sessionId:'pi-one',modelKey:'extension-agent:demo/model-b'});
  now+=10;seq=5;const E='5'.repeat(32);m.set(E,{seq:5,createdAt:now,expiresAt:now+600000,used:700,size:1024});
  a.equal(s.accept(msg(E,1,{providerId:'custom',modelId:'model-b',sampledAt:now,turnAt:now})),false);
  a.equal(s.accept(msg(E,1,{providerId:'extension-agent:demo',modelId:'model-b',sampledAt:now,turnAt:now})),true);
});
