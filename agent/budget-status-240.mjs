// Read-only trusted extension. Nothing is written to history, token usage or a status overlay.
import {endpoint, receiptURL, readReceipt} from './receipt.mjs';
import meterLink from '../lib/meter-link.js';
const sendMeter = meterLink.publisher();
function meter(s,phase,b) {
  const m=s?.meter; if(!m)return;
  const sampledAt=Date.now();m.next=sampledAt+5000;
  try { sendMeter({version:1,receipt:m.receipt,revision:++m.revision,sessionId:m.id,providerId:m.provider,modelId:m.model,
    sampledAt,...(m.turnAt?{turnAt:m.turnAt}:{}),phase,...(phase==='sample'&&b?{budget:{tokens:b.tokens,limit:b.limit}}:{})}); } catch {}
  if(phase==='drop')s.meter=undefined;
}
const sessions = new Map();
function sid(ctx) { try { const id=ctx.sessionManager.getSessionId(); return typeof id==='string'&&id?id:undefined; } catch {} }
function key(model) { const u=endpoint(model); return u && typeof model?.id==='string' && model.id && typeof model.provider==='string' && model.provider ? JSON.stringify([model.provider,model.id,model.api??'',u.href.replace(/\/+$/,'')]) : undefined; }
function header(h,k) { if(!h)return; if(typeof h.get==='function')return h.get(k); return h[Object.keys(h).find(n=>n.toLowerCase()===k)??k]; }
function budget(ctx) {
  try { const u=ctx.getContextUsage?.();
    if(Number.isSafeInteger(u?.tokens)&&u.tokens>=0&&Number.isSafeInteger(u.contextWindow)&&u.contextWindow>0)
      return {tokens:u.tokens,limit:u.contextWindow,at:u.autoCompactAt===null?null:Number.isSafeInteger(u.autoCompactAt)&&u.autoCompactAt>0?u.autoCompactAt:undefined};
  } catch {}
}
function invalidate(s) {s.ticket++; s.controller?.abort(); s.controller=undefined; s.work=undefined; s.url=undefined; s.nextRead=0;}
function hasNative(ctx) {try { return typeof ctx?.ui?.setProviderContext==='function'; } catch { return false; } }
function native(ctx, value) {try { ctx.ui?.setProviderContext?.(value); } catch {} }
function forget(ctx,s) {meter(s,'drop');invalidate(s); if(s.confirmed)native(ctx,undefined); s.confirmed=undefined; s.sample=undefined; s.before=undefined; s.compacting=false; s.expect=undefined;}
const invocation=e=>Number.isSafeInteger(e?.contextRequestId)&&e.contextRequestId>0?e.contextRequestId:undefined;
// On stock PI the notification has no request ID. If two headers are outstanding, neither can be
// assigned safely until both drain. Keep the ambiguous group unknown; never trust handler arrival order.
function expectHeaders(s,k,e) {
  const id=invocation(e);
  if(id===undefined&&++s.plainHeaders>1)s.plainOverlap=true;
  s.expect=s.compacting||s.ended?undefined:{k,id};
}
function takeHeaders(s,k,e) {
  const id=invocation(e),slot=s.expect;
  if(id===undefined){
    if(!s.plainHeaders)return false;
    const overlap=s.plainOverlap; if(--s.plainHeaders===0)s.plainOverlap=false;
    if(overlap)return false;
  }
  if(!slot||slot.k!==k||slot.id!==id)return false;
  s.expect=undefined;return true;
}
// A terminal stream may never receive headers (stock only calls onResponse on success). Retire its
// debt, but require subsequent stock candidates to prove their receipt was issued AFTER that boundary.
// A delayed old callback cannot consume the new slot; equal-millisecond or unknown origins fail closed.
function retirePlain(s) {
  if(s.plainHeaders>0){s.recoverAt=Math.max(s.recoverAt||0,Date.now());s.plainHeaders=0;s.plainOverlap=false;}
  s.expect=undefined;s.proving=undefined;
}
const fmt=n=>n.toLocaleString('en-US');
export default function register(pi) {
  const owner={};
  function state(ctx) {const s=sessions.get(sid(ctx)); return s?.owner===owner?s:undefined;}
  function current(ctx,s) {const k=key(ctx.model); if(s.confirmed&&k!==s.confirmed)forget(ctx,s); return k;}
  function own(ctx,s) {return !!s&&!ctx.signal?.aborted&&current(ctx,s)===s.confirmed&&!!s.confirmed;}
  function active(ctx,s,token) {return !ctx.signal?.aborted&&state(ctx)===s&&s.ticket===token&&own(ctx,s);}
  const sample=(ctx,s)=>{if(!s?.meter)return;if(hasNative(ctx)){meter(s,'drop');return;}if(!s.compacting&&own(ctx,s))meter(s,'sample',budget(ctx));};
  // Share only a network result, never a handler's ctx. 0.22.0 revokes the SDK after each handler settles.
  function fetchOnce(s) {
    if(s.work)return s.work;
    const ctl=new AbortController(); s.controller=ctl; s.nextRead=Date.now()+5000;
    const job=readReceipt(s.url,ctl.signal).catch(()=>undefined).finally(()=>{if(s.controller===ctl){s.controller=undefined;s.work=undefined;}});
    s.work=job; return job;
  }
  async function read(ctx,s,atEnd=false) {
    if(!s?.url||!own(ctx,s))return;
    const token=s.ticket; let r=await fetchOnce(s);
    if(!active(ctx,s,token))return;
    // A short response can finish while the headers-time GET still says pending.
    if(atEnd&&r?.state==='pending'){r=await fetchOnce(s);if(!active(ctx,s,token))return;}
    if(!r)return;
    const sample=r.sample;
    if(s.sample?.used!==sample?.used||s.sample?.size!==sample?.size){s.sample=sample;native(ctx,sample??{});}
  }
  pi.on('session_start',(_e,ctx)=>{
    const id=sid(ctx); if(!id)return; const old=sessions.get(id); if(old)forget(ctx,old);
    sessions.set(id,{owner,ticket:0,ended:false,compacting:false,plainHeaders:0,plainOverlap:false,turnAt:0});
  });
  pi.on('agent_start',(_e,ctx)=>{const s=state(ctx);if(s){s.turnAt=Date.now();if(s.ended)retirePlain(s);meter(s,'drop');current(ctx,s);s.ended=false;s.compacting=false;}});
  pi.on('before_provider_request',(e,ctx)=>{const s=state(ctx);if(!s)return;
    if(!s.turnAt)s.turnAt=Date.now();
    meter(s,'drop');
    const k=current(ctx,s);if(!k)return;expectHeaders(s,k,e);
    if(s.ended||s.compacting||!own(ctx,s))return;
    invalidate(s);s.sample=undefined;native(ctx,{}); // no payload read, altered or returned
  });
  pi.on('after_provider_response',(e,ctx)=>{
    const s=state(ctx),k=key(e?.model);if(!s||!k)return;
    const marked=Number.isInteger(e.response?.status)&&e.response.status>=200&&e.response.status<300&&String(header(e.response.headers,'x-antigravity-acp')??'').trim()==='1';
    const url=marked&&receiptURL(e.model,header(e.response.headers,'x-antigravity-acp-context-id'));
    const accept=(proof)=>{
      if(!takeHeaders(s,k,e)||(!proof&&s.ended)||ctx.signal?.aborted||s.compacting||current(ctx,s)!==k)return;
      if(!marked){forget(ctx,s);return;}
      invalidate(s);s.proving=undefined;s.confirmed=k;s.sample=undefined;s.url=url||undefined;
      if(hasNative(ctx))meter(s,'drop');else if(url){s.meter={id:sid(ctx),provider:ctx.model.provider,model:ctx.model.id,receipt:url.pathname.split('/').at(-1),turnAt:s.turnAt||Date.now(),revision:0,next:0};sample(ctx,s);}
      native(ctx,{});
      if(!proof)return read(ctx,s);
      s.nextRead=Date.now()+5000;if(proof.sample){s.sample=proof.sample;native(ctx,proof.sample);}
      if(s.ended)return read(ctx,s,true);
    };
    if(s.recoverAt&&invocation(e)===undefined&&!s.plainOverlap){
      const slot=s.expect,fence=s.recoverAt,ticket=s.ticket;
      if(!url||!slot||slot.k!==k||s.ended||s.compacting||ctx.signal?.aborted)return;
      s.proving=slot;
      return readReceipt(url,ctx.signal||new AbortController().signal).then(proof=>{
        if(!proof?.issuedAt||proof.issuedAt<=fence||proof.issuedAt>Date.now()||state(ctx)!==s||s.expect!==slot||s.ticket!==ticket||s.recoverAt!==fence||ctx.signal?.aborted)return;
        return accept(proof);
      });
    }
    return accept(); // notification, not awaited by the provider stream
  });
  pi.on('message_update',(_e,ctx)=>{const s=state(ctx);if(!s||s.ended||s.compacting)return;if(s.meter&&Date.now()>=s.meter.next)sample(ctx,s);if(s.url&&!s.work&&Date.now()>=s.nextRead)return read(ctx,s);});
  const endStep=(e,ctx)=>{const s=state(ctx);if(!s||s.compacting)return;
    if(['aborted','error'].includes(e?.message?.stopReason)){retirePlain(s);if(own(ctx,s)){meter(s,'drop');invalidate(s);s.sample=undefined;native(ctx,{});}return;}
    if(!own(ctx,s))return;
    sample(ctx,s);
    if(e?.message?.role&&e.message.role!=='assistant')return;
    return read(ctx,s,true);
  };
  pi.on('message_end',endStep);pi.on('turn_end',endStep);
  pi.on('tool_execution_end',(_e,ctx)=>{const s=state(ctx);if(!s?.ended)sample(ctx,s);});
  pi.on('agent_settled',(_e,ctx)=>{const s=state(ctx);sample(ctx,s);});
  pi.on('session_info_changed',(_e,ctx)=>{const s=state(ctx);if(s)current(ctx,s);});
  pi.on('session_before_compact',(_e,ctx)=>{const s=state(ctx);if(!s)return;
    if(own(ctx,s)){s.before=budget(ctx);s.sample=undefined;native(ctx,{});}
    meter(s,'compacting');
    s.compacting=true;s.expect=undefined;invalidate(s);
    // No result: never veto or change compaction. On unpatched hosts this is a live-state sample, not a trigger record.
  });
  const compactDone=(_e,ctx)=>{const s=state(ctx);if(!s)return;meter(s,'drop');s.compacting=false;s.expect=undefined;if(own(ctx,s)){s.sample=undefined;native(ctx,{});}};
  pi.on('session_compact',compactDone);pi.on('session_compact_failed',compactDone);
  pi.on('agent_end',(_e,ctx)=>{const s=state(ctx);if(!s)return;s.ended=true;if(!s.proving||s.expect!==s.proving||ctx.signal?.aborted)retirePlain(s);if(ctx.signal?.aborted){meter(s,'drop');invalidate(s);s.sample=undefined;return;}sample(ctx,s);return read(ctx,s,true);});
  pi.on('session_shutdown',(_e,ctx)=>{const s=state(ctx);if(s){forget(ctx,s);sessions.delete(sid(ctx));}});
  pi.registerCommand?.('acp-context',{description:'查看本会话 ACP 实测水位和 PI 压缩预算（只读）',handler:async(_args,ctx)=>{
    const s=state(ctx);if(!own(ctx,s)){ctx.ui?.notify?.('本会话尚无已确认的本机 ACP 请求。');return;}
    const token=s.ticket;await read(ctx,s);if(!active(ctx,s,token))return;
    const b=budget(ctx),o=s.sample;const rows=[b?`PI 输入预算（宿主估算）：${fmt(b.tokens)} / ${fmt(b.limit)} · ${Math.round(100*b.tokens/b.limit)}%`:'PI 输入预算：未报告'];
    if(b?.at===null)rows.push('自动压缩：已关闭');else if(b?.at)rows.push(`自动压缩线：${fmt(b.at)}`);
    if(s.before)rows.push(`上次压缩前采样：${fmt(s.before.tokens)} / ${fmt(s.before.limit)}`);
    rows.push(o?`上游实测（本请求最近一次 ACP 水位）：${fmt(o.used)}${o.size?` / ${fmt(o.size)}`:''}`:'上游实测：本请求尚无可归属的 ACP 水位');
    ctx.ui?.notify?.(rows.join('\n'));
  }});
}
