import type {DecodedFrame,MediaSource} from './media.ts';
import {MediaOpenError} from './media-errors.ts';
import {chromaOffset,resolveYuvColor,validateYuv,yuvSample,visibleChromaBounds} from './yuv-color.ts';
import { hdrTransfer } from './hdr-policy.ts';

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
  let disposed=false;
  let signature:string|undefined;
  const sourceFrameAt=source.frameAt.bind(source),sourceFramesFrom=source.framesFrom.bind(source),sourceFramesFollowing=source.framesFollowing?.bind(source);
  type Slot={worker:Worker;buffer?:ArrayBuffer;reject?: (error:Error)=>void};
  const slots:Slot[]=[];
  try{for(let i=0;i<depth;i++)slots.push({worker:new Worker(new URL('./native-yuv-worker.ts',import.meta.url),{type:'module'})});}
  catch(error){slots.forEach(s=>s.worker.terminate());throw error;}
  const free=[...slots],waiters:Array<(slot:Slot)=>void>=[];
  const aborted=()=>new DOMException('媒体已释放。','AbortError');
  const release=(slot:Slot)=>{slot.reject=undefined;const next=waiters.shift();if(next)next(slot);else free.push(slot);};
  async function convert(frame:DecodedFrame):Promise<DecodedFrame>{
    if(disposed){frame.close();throw aborted();}
    if(frame.kind==='yuv')return frame;
    const d=frame.description;
    const sourceColor=d.sourceColor;
    const conflicting=sourceColor&&(['matrix','primaries'] as const).some(k=>sourceColor[k]!=null&&d.color[k]!=null&&sourceColor[k]!==d.color[k]);
    const sourceUnsupported=sourceColor&&!resolveYuvColor({...d,color:sourceColor}).supported;
    const sourceHdr=hdrTransfer(sourceColor?.transfer),resourceHdr=hdrTransfer(d.color.transfer);
    const format=d.format??'',bitDepth=format.endsWith('P10')?10:format.endsWith('P12')?12:8;
    // Keep the initial capability boundary deliberately narrow. Public native
    // APIs do not expose chroma siting; unknown uses the shared center policy.
    if(!frame.sample||conflicting||sourceUnsupported||(sourceHdr&&sourceHdr!==resourceHdr)||!['NV12','I420','I420P10','I420P12'].includes(format)||!resolveYuvColor(d).supported||(bitDepth!==8&&!resourceHdr)||(resourceHdr&&bitDepth<10)){frame.close();throw new MediaOpenError('decode','硬件帧无法提供色彩标签与位深一致的原始平面。');}
    const key=JSON.stringify([d.format,d.codedWidth,d.codedHeight,d.visibleRect,d.color]);
    if(signature!==undefined&&signature!==key){frame.close();throw new MediaOpenError('decode','硬件输出格式或色彩标签发生变化，请切换软件解码。');}signature=key;
    const slot=free.shift()??await new Promise<Slot>(r=>waiters.push(r));
    if(disposed){frame.close();release(slot);throw aborted();}
    const start=performance.now();let resource:VideoFrame|undefined;
    try{
      resource=frame.sample.toVideoFrame();const rotation=frame.sample.rotation;frame.close();
      const reply=await new Promise<{buffer:ArrayBuffer;layout:PlaneLayout[]}>((done,fail)=>{
        slot.reject=fail;slot.worker.onmessage=e=>e.data.error?fail(new MediaOpenError('decode',e.data.error)):done(e.data);
        slot.worker.onerror=()=>fail(new MediaOpenError('decode','硬件平面读回 Worker 失败。'));
        const buffer=slot.buffer;slot.buffer=undefined;
        slot.worker.postMessage({frame:resource,buffer},buffer?[resource!,buffer]:[resource!]);
      });
      const pixels=new Uint8ClampedArray(reply.buffer);
      const description={...d,byteLength:pixels.byteLength,byteLengthEstimated:false,yuv:{bitDepth,bitShift:0,subsampleX:1,subsampleY:1,semiplanar:d.format==='NV12',chromaLocation,
        planes:reply.layout.map((p,i)=>({...p,width:Math.ceil(d.codedWidth/(i?2:1)),height:Math.ceil(d.codedHeight/(i?2:1))}))}};
      validateYuv(description,pixels.byteLength);
      if(disposed)throw aborted();
      let closed=false;
      return {...frame,sample:undefined,rotation,kind:'yuv',description,pixels,byteSize:pixels.byteLength,copyMs:performance.now()-start,
        close(){if(closed)return;closed=true;if(!disposed&&!slot.buffer)slot.buffer=reply.buffer;}};
    }catch(error){frame.close();throw error;}
    finally{resource?.close();release(slot);}
  }
  async function* pipeline(iterator:AsyncGenerator<DecodedFrame>){
    const pending:Promise<DecodedFrame>[]=[];let ended=false,cancelled=false,failure:unknown;
    let wakeConsumer:(()=>void)|undefined,wakeProducer:(()=>void)|undefined;
    const producer=(async()=>{
      try{while(!cancelled){
        while(pending.length>=depth&&!cancelled)await new Promise<void>(r=>wakeProducer=r);
        if(cancelled)break;
        const next=await iterator.next();if(next.done)break;
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
    }finally{cancelled=true;wakeProducer?.();await producer;await iterator.return(undefined);await Promise.all(pending.map(p=>p.then(f=>f.close(),()=>{})));}
  }
  return {
    get info(){return source.info;},set info(info){source.info=info;},
    get onInfoChange(){return source.onInfoChange;},set onInfoChange(fn){source.onInfoChange=fn;},
    ensureIndexed:source.ensureIndexed?.bind(source),
    requestCachedAudio:source.requestCachedAudio?.bind(source),
    setCachedAudioEnabled:source.setCachedAudioEnabled?.bind(source),
    get onCachedAudio(){return source.onCachedAudio;},set onCachedAudio(fn){source.onCachedAudio=fn;},
    getAnalysisCapability:source.getAnalysisCapability?.bind(source),
    queryAnalysis:source.queryAnalysis?.bind(source),
    rankAnalysisTime:source.rankAnalysisTime?.bind(source),
    analysisSampleAtNumber:source.analysisSampleAtNumber?.bind(source),
    locateAnalysisSample:source.locateAnalysisSample?.bind(source),
    frameAt:async pts=>convert(await sourceFrameAt(pts)),
    async framesAfter(pts,count){const result:DecodedFrame[]=[];try{for await(const frame of pipeline(sourceFramesFrom(pts))){if(frame.ptsUs<=pts){frame.close();continue;}result.push(frame);if(result.length>=count)break;}return result;}catch(error){result.forEach(f=>f.close());throw error;}},
    framesFrom:pts=>pipeline(sourceFramesFrom(pts)),
    ...(sourceFramesFollowing?{framesFollowing:(pts:number)=>pipeline(sourceFramesFollowing(pts))}:{}),
    dispose(){if(disposed)return;disposed=true;if(ownsSource)source.dispose();for(const slot of slots){slot.reject?.(aborted());slot.worker.terminate();}while(waiters.length)waiters.shift()!(slots[0]);},
  };
}
