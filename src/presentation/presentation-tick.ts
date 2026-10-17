/** Keep a visible canvas player advancing when the browser throttles rAF despite
 * reporting visibility/focus. Normal rAF wins; no timer runs while paused. This
 * controls frame submission, not physical display scanout or refresh rate. */
export function schedulePresentationTick(callback:()=>void):()=>void {
  let done=false,raf:number|undefined,timer:ReturnType<typeof setTimeout>|undefined;
  const finish=()=>{
    if(done)return;done=true;
    if(raf!==undefined)cancelAnimationFrame(raf);
    if(timer!==undefined)clearTimeout(timer);
    callback();
  };
  if(typeof requestAnimationFrame==='function'){
    raf=requestAnimationFrame(finish);
    if(typeof document!=='undefined'&&document.visibilityState==='visible')timer=setTimeout(finish,20);
  }else timer=setTimeout(finish,8);
  return finish;
}
