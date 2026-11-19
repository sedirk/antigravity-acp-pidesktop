'use strict';
// Display-only, ordered by gateway HTTP sequence then by extension revision. No transcript or standard usage.
const TTL=600000,CAP=512;
const validId=x=>typeof x==='string'&&x.length>0&&x.length<=256&&x===x.trim()&&!/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/.test(x);
const nonneg=x=>Number.isSafeInteger(x)&&x>=0, pos=x=>nonneg(x)&&x>0;
const validBudget=b=>b&&nonneg(b.tokens)&&pos(b.limit);
function parseModelKey(raw){
  if(raw===null||raw===undefined)return{model:null,extAgent:null,invalid:false};
  if(typeof raw!=='string')return{model:null,extAgent:null,invalid:true};
  const s=raw.trim(),slash=s.indexOf('/');
  if(slash<=0||slash>=s.length-1||s.length>514)return{model:null,extAgent:null,invalid:true};
  const provider=s.slice(0,slash),model=s.slice(slash+1);
  if(!validId(provider)||!validId(model))return{model:null,extAgent:null,invalid:true};
  return{model,extAgent:provider.startsWith('extension-agent:')?provider:null,invalid:false};
}
function createStore(lookup,now=Date.now,currentSeq=null){
  const rows=new Map(),bound=new Map(),fences=new Map();let overflowAt=0;
  function prune(t){
    for(const [id,r]of rows)if(r.expiresAt<=t)rows.delete(id);
    for(const [k,r]of bound)if(r.expiresAt<=t)bound.delete(k);
    for(const [k,r]of fences)if(r.at+TTL<=t)fences.delete(k);
  }
  function allowed(sessionId,providerId,modelId,o,turnAt){
    if(o.createdAt<=overflowAt)return false;
    const fence=fences.get(sessionId);if(!fence)return true;
    if(fence.invalid||o.createdAt<=fence.at||(fence.seq!==null&&o.seq<=fence.seq))return false;
    if(turnAt!==undefined&&turnAt<=fence.at)return false;
    if(fence.model!==null&&modelId!==fence.model)return false;
    if(fence.extAgent!==null&&providerId!==fence.extAgent)return false;
    return true;
  }
  function modelChanged(event){
    const id=event?.sessionId;if(!validId(id))return;
    const t=now();prune(t);rows.delete(id);
    if(fences.size>=CAP&&!fences.has(id)){
      // At the cap retire older readings, not the identity check on an old receipt.
      const oldest=fences.keys().next().value;overflowAt=Math.max(overflowAt,fences.get(oldest).at);fences.delete(oldest);
    }
    const seq=typeof currentSeq==='function'?currentSeq():null;
    fences.delete(id);fences.set(id,{at:t,seq:nonneg(seq)?seq:null,...parseModelKey(event.modelKey)});
  }
  function fencedAfter(id,startedAt){
    const fence=fences.get(id);
    return Boolean(fence&&pos(startedAt)&&startedAt<=fence.at);
  }
  function accept(v){
    if(v?.version!==1||!validId(v.sessionId)||!validId(v.providerId)||!validId(v.modelId)||!(/^[a-f0-9]{32}$/).test(typeof v.receipt==='string'?v.receipt:'')||!pos(v.revision)||!['sample','compacting','drop'].includes(v.phase))return false;
    const o=lookup(v.receipt),t=now();prune(t);
    if(v.turnAt!==undefined&&(!pos(v.turnAt)||v.turnAt>t+2000))return false;
    if(!o||!pos(o.seq)||!pos(o.createdAt)||!pos(o.expiresAt)||o.expiresAt<=t||!pos(v.sampledAt)||v.sampledAt>t+2000||v.sampledAt<o.createdAt-2000||!allowed(v.sessionId,v.providerId,v.modelId,o,v.turnAt))return false;
    const key=v.receipt,owner=JSON.stringify([v.sessionId,v.providerId,v.modelId]),binding=bound.get(key);
    if(binding&&binding.owner!==owner)return false;
    const last=rows.get(v.sessionId);
    if(last&&(o.seq<last.seq||o.seq===last.seq&&(v.revision<=last.revision||last.phase==='drop'||(last.phase==='compacting'&&v.phase==='sample'))))return false;
    if((!binding&&bound.size>=CAP)||(!last&&rows.size>=CAP)){
      for(const k of bound.keys())if(!lookup(k))bound.delete(k);
      for(const [id,r]of rows)if(!bound.has(r.receipt))rows.delete(id);
      if((!binding&&bound.size>=CAP)||(!rows.has(v.sessionId)&&rows.size>=CAP))return false;
    }
    bound.set(key,{owner,expiresAt:o.expiresAt});rows.set(v.sessionId,{providerId:v.providerId,modelId:v.modelId,seq:o.seq,receipt:key,revision:v.revision,phase:v.phase,sampledAt:v.sampledAt,turnAt:v.turnAt,expiresAt:o.expiresAt,...(v.phase==='sample'&&validBudget(v.budget)?{budget:{tokens:v.budget.tokens,limit:v.budget.limit}}:{})});return true;
  }
  function read(id){
    const t=now();prune(t);const r=rows.get(id);
    // session_before_compact is not proof of a running/successful summary: another extension may veto it silently.
    if(!r||r.phase!=='sample')return null;
    const o=lookup(r.receipt);if(!o||o.seq!==r.seq||o.expiresAt<=t||!allowed(id,r.providerId,r.modelId,o,r.turnAt))return null;
    const upstream=nonneg(o.used)?{used:o.used,...(pos(o.size)?{size:o.size}:{})}:undefined;
    return {version:1,sessionId:id,providerId:r.providerId,modelId:r.modelId,sampledAt:r.sampledAt,expiresAt:o.expiresAt,phase:'sample',...(r.budget?{budget:{...r.budget}}:{}),...(upstream?{upstream}:{})};
  }
  return {accept,read,modelChanged,fencedAfter,clear(){rows.clear();bound.clear();fences.clear();overflowAt=0;}};
}
module.exports={createStore,validId};
