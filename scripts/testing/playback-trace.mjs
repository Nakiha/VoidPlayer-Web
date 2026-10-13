/** Called inside the owned fixture page. Bounds evidence and observes only
 * metadata; never touches transferable resources or changes RPC replies. */
export function beginPlaybackTrace() {
  const started = performance.now(), events = [], samples = [], longTasks = [];
  const pending = new Map(), workers = new Map();
  const post = Worker.prototype.postMessage;
  const push = value => { if (events.length < 256) events.push(value); };
  Worker.prototype.postMessage = function (...args) {
    const message = args[0];
    if (!message || !['extract', 'at', 'next'].includes(message.type) || typeof message.id !== 'number')
      return Reflect.apply(post, this, args);
    let current = workers.get(this);
    if (!current) {
      const id = workers.size + 1;
      const receive = event => {
        const response = event.data, key = `${id}:${response?.id}`, request = pending.get(key);
        if (!request || typeof response.ok !== 'boolean') return;
        const at = performance.now(); pending.delete(key);
        push({ event: 'reply', worker: id, id: response.id, atMs: at-started, elapsedMs: at-request.started,
          ok: response.ok, pts: response.data?.pts == null ? null : String(response.data.pts), error: response.error ?? null });
      };
      current = { id, receive }; workers.set(this,current); this.addEventListener('message',receive);
    }
    const at = performance.now(), key = `${current.id}:${message.id}`;
    const request = { worker: current.id, id: message.id, type: message.type, ctx: message.ctx ?? null,
      index: message.index ?? null, pts: message.pts ?? null, started: at, atMs: at-started };
    pending.set(key,request); push({event:'request',...request});
    try { return Reflect.apply(post,this,args); }
    catch(error) { pending.delete(key);push({event:'post-failure',worker:current.id,id:message.id,atMs:performance.now()-started,error:String(error)});throw error; }
  };
  const sample = () => {
    if(samples.length>=128)return;
    const state=window.voidPlayer.getState();
    samples.push({atMs:performance.now()-started,playing:state.playing,busy:state.busy,positionUs:state.positionUs,error:state.error,
      measurements:state.playback,tracks:state.tracks.map(t=>({slot:t.slot,id:t.id,sourceGen:t.sourceGen,frame:t.frame,indexState:t.indexState,decoder:t.decoder}))});
  };
  sample(); const timer=setInterval(sample,75);
  const supported=typeof PerformanceObserver!=='undefined'&&PerformanceObserver.supportedEntryTypes.includes('longtask');
  const observer=supported?new PerformanceObserver(list=>{
    for(const e of list.getEntries())if(longTasks.length<128)longTasks.push({atMs:e.startTime-started,durationMs:e.duration});
  }):null;
  observer?.observe({entryTypes:['longtask']});
  window.__finishPlaybackTrace=()=>{
    clearInterval(timer);sample();observer?.disconnect();Worker.prototype.postMessage=post;
    const at=performance.now();
    const outstanding=[...pending.values()].map(r=>({...r,elapsedMs:at-r.started}));
    for(const [worker,current] of workers)worker.removeEventListener('message',current.receive);
    workers.clear();pending.clear();delete window.__finishPlaybackTrace;
    return {startedMs:started,elapsedMs:at-started,events,samples,longTasksSupported:supported,longTasks,outstanding};
  };
}
