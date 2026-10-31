import type {DecodedFrame,MediaSource} from '../contract.ts';
import {MediaOpenError} from '../../../shared/media/io/media-errors.ts';
import {chromaOffset,resolveYuvColor,validateYuv,yuvSample,visibleChromaBounds} from '../../../shared/color/yuv-color.ts';
import { hdrTransfer } from '../../../shared/color/hdr-policy.ts';

/** Certify a same-PTS raw-plane witness, never fit browser RGB output. */
export function verifyNativeWitness(native:DecodedFrame,reference:DecodedFrame){
  const a=native.description,b=reference.description;
  const reject=(reason:string)=>{throw new MediaOpenError('decode',`硬件原始平面未通过软件首帧核对：${reason}`);};
  if(native.sourcePtsUs!==reference.sourcePtsUs)return reject('源 PTS 不一致。');
  const nativePixels=native.pixels,referencePixels=reference.pixels;
  if(!a.yuv||!b.yuv||!nativePixels||!referencePixels)return reject('需要可读取的原始 YUV 平面。');
  try{validateYuv(a,nativePixels.byteLength);validateYuv(b,referencePixels.byteLength);}catch{return reject('YUV 平面布局无效。');}
  const is420=(l:NonNullable<typeof a.yuv>)=>[8,10,12].includes(l.bitDepth)&&l.bitShift===0&&l.subsampleX===1&&l.subsampleY===1;
  if(!is420(a.yuv)||!is420(b.yuv)||a.yuv.bitDepth!==b.yuv.bitDepth)return reject('需要位深一致的可读取 4:2:0 平面。');
  const ar=a.visibleRect,br=b.visibleRect;
  if(ar.x!==br.x||ar.y!==br.y||ar.width!==br.width||ar.height!==br.height)return reject('裁剪区域不一致。');
  const x=resolveYuvColor(a),y=resolveYuvColor(b);
  if(!x.supported||!y.supported||(a.yuv.bitDepth!==8&&!x.hdr)||(['matrix','primaries','fullRange'] as const).some(k=>x[k]!==y[k])||(x.hdr?x.hdr!==y.hdr:x.transfer!==y.transfer))return reject('色彩条件不一致或不受支持。');
  const [aOx,aOy]=chromaOffset(a.yuv),[bOx,bOy]=chromaOffset(b.yuv);
  if(aOx!==bOx||aOy!==bOy)return reject('色度采样位置不一致。');
  // Compare every cell used by crop-bounded reconstruction. CTU padding
  // outside these cells is ignored by CPU, WebGL and WebGPU presentation.
  const bounds=visibleChromaBounds(a);
  for(let c=0;c<3;c++){
    const sx=c?2**a.yuv.subsampleX:1,sy=c?2**a.yuv.subsampleY:1;
    const [x0,y0,x1,y1]=c?bounds:[ar.x,ar.y,ar.x+ar.width-1,ar.y+ar.height-1];
    for(let row=y0;row<=y1;row++)for(let col=x0;col<=x1;col++){
      if(yuvSample(nativePixels,a.yuv,c,col*sx,row*sy)!==yuvSample(referencePixels,b.yuv,c,col*sx,row*sy))
        return reject(`平面 ${c} 的可见样本不一致（列 ${col}，行 ${row}）。`);
    }
  }
}

/** A source owns its workers; yielded buffers belong to frames until close(). */
export function nativeYuvSource(source:MediaSource,depth:number,chromaLocation:number|null=null,ownsSource=true):MediaSource{
  if(!Number.isSafeInteger(depth)||depth<1)throw new RangeError('Invalid native readback depth');
  let disposed=false,failure:Error|undefined;
  let signature:string|undefined;
  const sourceFrameAt=source.frameAt.bind(source),sourceFramesFrom=source.framesFrom.bind(source),sourceFramesFollowing=source.framesFollowing?.bind(source);
  type Planes={buffer:ArrayBuffer;layout:PlaneLayout[]};
  type Reply=Planes&{description:DecodedFrame['description']};
  type Job={id:number;resolve:(reply:Reply)=>void;reject:(error:Error)=>void;describe:(planes:Planes)=>DecodedFrame['description']};
  type Slot={worker:Worker;nextId:number;buffer?:ArrayBuffer;job?:Job;terminated?:boolean};
  const slots:Slot[]=[],free:Slot[]=[],waiters:Array<{resolve:(slot:Slot)=>void;reject:(error:Error)=>void}>=[];
  const inputWaiters=new Set<(error:Error)=>void>();
  const aborted=()=>new DOMException('媒体已释放。','AbortError');
  const terminal=()=>disposed?aborted():failure;
  const assertActive=()=>{const error=terminal();if(error)throw error;};
  const terminate=(slot:Slot)=>{
    if(slot.terminated)return;slot.terminated=true;
    slot.worker.onmessage=null;slot.worker.onerror=null;slot.worker.onmessageerror=null;
    slot.worker.terminate();slot.buffer=undefined;
  };
  const stop=(error:Error)=>{
    for(const reject of [...inputWaiters])reject(error);
    for(const waiter of waiters.splice(0))waiter.reject(error);
    free.length=0;
    for(const slot of slots){const job=slot.job;slot.job=undefined;job?.reject(error);terminate(slot);}
  };
  const fail=(error:Error)=>{if(terminal())return;failure=error;stop(error);};
  try{for(let i=0;i<depth;i++){
    const slot:Slot={worker:new Worker(new URL('./native-yuv-worker.ts',import.meta.url),{type:'module'}),nextId:0};slots.push(slot);free.push(slot);
    slot.worker.onerror=()=>fail(new MediaOpenError('decode','硬件平面读回 Worker 失败。'));
    slot.worker.onmessageerror=()=>fail(new MediaOpenError('decode','硬件平面读回 Worker 消息无法反序列化。'));
    slot.worker.onmessage=({data})=>{
      if(terminal()||!slot.job)return;
      if(!data||!Number.isSafeInteger(data.id)||data.id<1||data.id>slot.job.id){fail(new MediaOpenError('decode','硬件平面读回 Worker 回复无效。'));return;}
      if(data.id!==slot.job.id)return;
      const job=slot.job;
      if(typeof data.error==='string'){slot.job=undefined;job.reject(new MediaOpenError('decode',data.error));return;}
      if(!(data.buffer instanceof ArrayBuffer)||!Array.isArray(data.layout)||!data.layout.every((p:PlaneLayout)=>Number.isSafeInteger(p?.offset)&&p.offset>=0&&Number.isSafeInteger(p?.stride)&&p.stride>0)){
        slot.job=job;fail(new MediaOpenError('decode','硬件平面读回 Worker 平面无效。'));return;
      }
      try{const description=job.describe(data);slot.job=undefined;job.resolve({...data,description});}
      catch(error){fail(new MediaOpenError('decode',`硬件平面读回 Worker 平面无效：${String(error)}`));}
    };
  }}catch(error){slots.forEach(terminate);throw error;}
  const release=(slot:Slot)=>{if(terminal()||slot.terminated)return;const next=waiters.shift();if(next)next.resolve(slot);else free.push(slot);};
  // A cancelled upstream read may resolve later. Its frame remains ours to
  // close, but cannot keep a disposed wrapper or iterator waiting indefinitely.
  function readInput<T>(work:Promise<T>,discard:(value:T)=>void,signal?:AbortSignal):Promise<T>{
    return new Promise((resolve,reject)=>{
      let cancelled=false;
      const cleanup=()=>{inputWaiters.delete(cancel);signal?.removeEventListener('abort',abort);};
      const cancel=(error:Error)=>{cancelled=true;cleanup();reject(error);};
      const abort=()=>cancel(signal?.reason??aborted());
      inputWaiters.add(cancel);signal?.addEventListener('abort',abort,{once:true});
      const error=terminal();if(error)cancel(error);else if(signal?.aborted)abort();
      work.then(value=>{cleanup();if(cancelled)discard(value);else resolve(value);},error=>{cleanup();reject(error);}).catch(reject);
    });
  }
  async function convert(frame:DecodedFrame):Promise<DecodedFrame>{
    let sampleClosed=false;const closeSample=()=>{if(!sampleClosed){sampleClosed=true;frame.close();}};
    const stopped=terminal();if(stopped){closeSample();throw stopped;}
    if(frame.kind==='yuv')return frame;
    const d=frame.description;
    const sourceColor=d.sourceColor;
    const conflicting=sourceColor&&(['matrix','primaries'] as const).some(k=>sourceColor[k]!=null&&d.color[k]!=null&&sourceColor[k]!==d.color[k]);
    const sourceUnsupported=sourceColor&&!resolveYuvColor({...d,color:sourceColor}).supported;
    const sourceHdr=hdrTransfer(sourceColor?.transfer),resourceHdr=hdrTransfer(d.color.transfer);
    const format=d.format??'',bitDepth=format.endsWith('P10')?10:format.endsWith('P12')?12:8;
    // Keep the initial capability boundary deliberately narrow. Public native
    // APIs do not expose chroma siting; unknown uses the shared center policy.
    if(!frame.sample||conflicting||sourceUnsupported||(sourceHdr&&sourceHdr!==resourceHdr)||!['NV12','I420','I420P10','I420P12'].includes(format)||!resolveYuvColor(d).supported||(bitDepth!==8&&!resourceHdr)||(resourceHdr&&bitDepth<10)){closeSample();throw new MediaOpenError('decode','硬件帧无法提供色彩标签与位深一致的原始平面。');}
    const key=JSON.stringify([d.format,d.codedWidth,d.codedHeight,d.visibleRect,d.color]);
    if(signature!==undefined&&signature!==key){closeSample();throw new MediaOpenError('decode','硬件输出格式或色彩标签发生变化，请切换软件解码。');}signature=key;
    let slot:Slot;try{slot=free.shift()??await new Promise<Slot>((resolve,reject)=>waiters.push({resolve,reject}));}catch(error){closeSample();throw error;}
    const stoppedAfterWait=terminal();if(stoppedAfterWait){closeSample();release(slot);throw stoppedAfterWait;}
    const start=performance.now();let resource:VideoFrame|undefined;
    try{
      resource=frame.sample.toVideoFrame();const rotation=frame.sample.rotation;closeSample();
      const reply=await new Promise<Reply>((resolve,reject)=>{
        const id=++slot.nextId;
        slot.job={id,resolve,reject,describe(reply){
          const description={...d,byteLength:reply.buffer.byteLength,byteLengthEstimated:false,yuv:{bitDepth,bitShift:0,subsampleX:1,subsampleY:1,semiplanar:d.format==='NV12',chromaLocation,
            planes:reply.layout.map((p,i)=>({...p,width:Math.ceil(d.codedWidth/(i?2:1)),height:Math.ceil(d.codedHeight/(i?2:1))}))}};
          validateYuv(description,reply.buffer.byteLength);return description;
        }};
        const buffer=slot.buffer;slot.buffer=undefined;
        try{slot.worker.postMessage({id,frame:resource,buffer},buffer?[resource!,buffer]:[resource!]);resource=undefined;}
        catch(error){fail(new MediaOpenError('decode',`硬件平面读回 Worker 发送失败：${String(error)}`));}
      });
      const pixels=new Uint8ClampedArray(reply.buffer);
      const description=reply.description;
      assertActive();
      let closed=false;
      return {...frame,sample:undefined,rotation,kind:'yuv',description,pixels,byteSize:pixels.byteLength,copyMs:performance.now()-start,
        close(){if(closed)return;closed=true;if(!terminal()&&!slot.buffer)slot.buffer=reply.buffer;}};
    }catch(error){closeSample();throw error;}
    finally{resource?.close();release(slot);}
  }
  // Async-generator return normally queues behind next(). Signal cancellation
  // before enqueueing it; an unfinished first next may still own a late frame.
  function openPipeline(open:()=>AsyncGenerator<DecodedFrame>){
    const producerControl=new AbortController(),consumerControl=new AbortController();
    const generator=pipeline(open,producerControl),next=generator.next.bind(generator),finish=generator.return.bind(generator),raise=generator.throw.bind(generator);
    let outstanding=0,cancelRequested=false;
    generator.next=async(...args)=>{
      if(cancelRequested)return {done:true,value:undefined};assertActive();outstanding++;
      try{return await readInput(next(...args),result=>{if(!result.done)result.value.close();},consumerControl.signal);}
      catch(error){if(cancelRequested)return {done:true,value:undefined};throw error;}
      finally{outstanding--;}
    };
    const cancel=(reason:unknown)=>{cancelRequested=true;consumerControl.abort(reason);producerControl.abort(reason);};
    generator.return=async value=>{
      if(cancelRequested)return {done:true,value:await value};
      const busy=outstanding>0;cancel(aborted());const returning=finish(value);
      if(busy){void returning.catch(()=>{});return {done:true,value:await value};}return returning;
    };
    generator.throw=async error=>{
      const busy=outstanding>0;cancel(error);const throwing=raise(error);
      if(busy){void throwing.catch(()=>{});throw error;}return throwing;
    };
    return generator;
  }
  async function* pipeline(open:()=>AsyncGenerator<DecodedFrame>,controller:AbortController){
    assertActive();if(controller.signal.aborted)return;const iterator=open();
    const pending:Promise<DecodedFrame>[]=[];let ended=false,cancelled=false,failure:unknown,inputPending=false;
    let wakeConsumer:(()=>void)|undefined,wakeProducer:(()=>void)|undefined;
    const producer=(async()=>{
      try{while(!cancelled&&!controller.signal.aborted){
        while(pending.length>=depth&&!cancelled)await new Promise<void>(r=>wakeProducer=r);
        if(cancelled||controller.signal.aborted)break;assertActive();
        inputPending=true;const input=iterator.next();input.then(()=>inputPending=false,()=>inputPending=false);
        const next=await readInput(input,next=>{if(!next.done)next.value.close();},controller.signal);if(next.done)break;
        if(cancelled){next.value.close();break;}
        const p=convert(next.value);p.catch(()=>{});pending.push(p);wakeConsumer?.();wakeConsumer=undefined;
      }}catch(error){failure=error;}finally{ended=true;wakeConsumer?.();}
    })();
    try{
      while(!ended||pending.length){
        if(!pending.length){await new Promise<void>(r=>wakeConsumer=r);continue;}
        const frame=await pending[0];pending.shift();wakeProducer?.();wakeProducer=undefined;
        yield frame;
      }
      if(failure)throw failure;
    }finally{
      cancelled=true;controller.abort(aborted());wakeProducer?.();await producer;
      const returning=iterator.return(undefined);if(inputPending)void returning.catch(()=>{});else await returning;
      await Promise.all(pending.map(p=>p.then(f=>f.close(),()=>{})));
    }
  }
  return {
    get info(){return source.info;},set info(info){source.info=info;},
    get onInfoChange(){return source.onInfoChange;},set onInfoChange(fn){source.onInfoChange=fn;},
    ensureIndexed:source.ensureIndexed?.bind(source),
    requestCachedAudio:source.requestCachedAudio?.bind(source),
    setCachedAudioEnabled:source.setCachedAudioEnabled?.bind(source),
    get onCachedAudio(){return source.onCachedAudio;},set onCachedAudio(fn){source.onCachedAudio=fn;},
    getAnalysisCapability:source.getAnalysisCapability?.bind(source),
    getBitstreamFlvIndex:source.getBitstreamFlvIndex?.bind(source),
    getBitstreamIndex:source.getBitstreamIndex?.bind(source),
    bitstreamIndexIdentity:source.bitstreamIndexIdentity,
    queryAnalysis:source.queryAnalysis?.bind(source),
    rankAnalysisTime:source.rankAnalysisTime?.bind(source),
    analysisSampleAtNumber:source.analysisSampleAtNumber?.bind(source),
    locateAnalysisSample:source.locateAnalysisSample?.bind(source),
    frameAt:async pts=>{assertActive();return convert(await readInput(sourceFrameAt(pts),frame=>frame.close()));},
    async framesAfter(pts,count){const result:DecodedFrame[]=[];try{for await(const frame of openPipeline(()=>sourceFramesFrom(pts))){if(frame.ptsUs<=pts){frame.close();continue;}result.push(frame);if(result.length>=count)break;}return result;}catch(error){result.forEach(f=>f.close());throw error;}},
    framesFrom:pts=>openPipeline(()=>sourceFramesFrom(pts)),
    ...(sourceFramesFollowing?{framesFollowing:(pts:number)=>openPipeline(()=>sourceFramesFollowing(pts))}:{}),
    dispose(){if(disposed)return;disposed=true;stop(aborted());if(ownsSource)source.dispose();},
  };
}
