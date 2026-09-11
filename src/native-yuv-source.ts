import type {DecodedFrame,MediaSource} from './media.ts';
import {MediaOpenError} from './media-errors.ts';
import {resolveYuvColor,validateYuv,yuvSample} from './yuv-color.ts';

/** Certify a same-PTS raw-plane witness, never fit browser RGB output. */
export function verifyNativeWitness(native:DecodedFrame,reference:DecodedFrame){
  const a=native.description,b=reference.description;
  const reject=()=>{throw new MediaOpenError('decode','硬件原始平面未通过软件首帧核对。');};
  if(native.sourcePtsUs!==reference.sourcePtsUs||!a.yuv||!b.yuv||!native.pixels||!reference.pixels||b.yuv.bitDepth!==8||b.yuv.subsampleX!==1||b.yuv.subsampleY!==1||a.codedWidth!==b.codedWidth||a.codedHeight!==b.codedHeight||JSON.stringify(a.visibleRect)!==JSON.stringify(b.visibleRect))return reject();
  const x=resolveYuvColor(a),y=resolveYuvColor(b);
  if(!x.supported||!y.supported||(['matrix','primaries','fullRange','transfer'] as const).some(k=>x[k]!==y[k]))return reject();
  for(let c=0;c<3;c++)for(let row=0;row<a.codedHeight;row+=c?2:1)for(let col=0;col<a.codedWidth;col+=c?2:1){
    if(yuvSample(native.pixels,a.yuv,c,col,row)!==yuvSample(reference.pixels,b.yuv,c,col,row))return reject();
  }
}

/** A source owns its workers; yielded buffers belong to frames until close(). */
export function nativeYuvSource(source:MediaSource,depth:number,chromaLocation:number|null=null):MediaSource{
  let disposed=false;
  let signature:string|undefined;
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
    // Keep the initial capability boundary deliberately narrow. Public native
    // APIs do not expose chroma siting; unknown uses the shared center policy.
    if(!frame.sample||conflicting||sourceUnsupported||!['NV12','I420'].includes(d.format??'')||!resolveYuvColor(d).supported){frame.close();throw new MediaOpenError('decode','硬件帧无法提供色彩标签一致的 SDR 原始平面。');}
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
      const description={...d,byteLength:pixels.byteLength,byteLengthEstimated:false,yuv:{bitDepth:8,bitShift:0,subsampleX:1,subsampleY:1,semiplanar:d.format==='NV12',chromaLocation,
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
    frameAt:async pts=>convert(await source.frameAt(pts)),
    async framesAfter(pts,count){const result:DecodedFrame[]=[];try{for await(const frame of pipeline(source.framesFrom(pts))){if(frame.ptsUs<=pts){frame.close();continue;}result.push(frame);if(result.length>=count)break;}return result;}catch(error){result.forEach(f=>f.close());throw error;}},
    framesFrom:pts=>pipeline(source.framesFrom(pts)),
    ...(source.framesFollowing?{framesFollowing:(pts:number)=>pipeline(source.framesFollowing!(pts))}:{}),
    dispose(){if(disposed)return;disposed=true;source.dispose();for(const slot of slots){slot.reject?.(aborted());slot.worker.terminate();}while(waiters.length)waiters.shift()!(slots[0]);},
  };
}
