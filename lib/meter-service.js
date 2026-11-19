'use strict';
const {listen}=require('./meter-link');
const {createStore,validId}=require('./meter-store');
function meterService(gw,getActive,dir){
  const store=createStore(r=>gw.meterReceipt(r),Date.now,()=>typeof gw.meterSeq==='function'?gw.meterSeq():null); let closed=false;
  const link=listen(store.accept,dir);
  return {ready:link.ready,modelChanged(e){if(!closed)store.modelChanged(e);},close(){closed=true;store.clear();link.close();},async read(method,args){
    if(closed||method!=='readContextMeter'||Object.keys(args||{}).length!==1||!validId(args?.sessionId))return null;
    const id=args.sessionId;if(!store.read(id))return null;
    try{const active=await getActive();if(closed||active?.sessionId!==id||(active?.activeTurn&&store.fencedAfter(id,active.activeTurn.startedAt)))return null;return store.read(id);}catch{return null;}
  }};
}
module.exports={meterService};
