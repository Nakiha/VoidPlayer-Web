// One observation of an existing routed preparation POST. Outcomes always
// resolve, including failure before the caller finishes its click; no rejected
// body promise can become unhandled while the caller awaits another action.
export function preparationReceiptObserver(timeoutMs=30000){
 let active;
 return {
  arm(){
   if(active)throw Error('A preparation receipt observation is already active');
   let resolve,settled=false,timer;
   const result=new Promise(done=>resolve=done);
   const slot={claimed:false,finish(outcome){if(settled)return false;settled=true;clearTimeout(timer);if(active===slot)active=undefined;resolve(outcome);return true;}};
   active=slot;timer=setTimeout(()=>slot.finish({ok:false,error:Error('Preparation receipt observation timed out')}),timeoutMs);
   return {result,close:()=>slot.finish({ok:false,error:Error('Preparation receipt observation closed')})};
  },
  claim(){
   const slot=active;if(!slot||slot.claimed)return null;slot.claimed=true;
   return {complete:receipt=>slot.finish({ok:true,receipt}),fail:error=>slot.finish({ok:false,error})};
  }
 };
}
