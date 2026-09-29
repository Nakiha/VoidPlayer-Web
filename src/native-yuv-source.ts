import type {DecodedFrame,MediaSource} from './media.ts';
import {MediaOpenError} from './media-errors.ts';
import {chromaOffset,resolveYuvColor,validateYuv,yuvSample} from './yuv-color.ts';

/** Certify a same-PTS raw-plane witness, never fit browser RGB output. */
export function verifyNativeWitness(native:DecodedFrame,reference:DecodedFrame){
  const a=native.description,b=reference.description;
  const reject=(reason:string)=>{throw new MediaOpenError('decode',`硬件原始平面未通过软件首帧核对：${reason}`);};
  if(native.sourcePtsUs!==reference.sourcePtsUs)return reject('源 PTS 不一致。');
  const nativePixels=native.pixels,referencePixels=reference.pixels;
  if(!a.yuv||!b.yuv||!nativePixels||!referencePixels)return reject('需要可读取的原始 YUV 平面。');
  try{validateYuv(a,nativePixels.byteLength);validateYuv(b,referencePixels.byteLength);}catch{return reject('YUV 平面布局无效。');}
  const is420=(l:NonNullable<typeof a.yuv>)=>l.bitDepth===8&&l.bitShift===0&&l.subsampleX===1&&l.subsampleY===1;
  if(!is420(a.yuv)||!is420(b.yuv))return reject('需要可读取的 8-bit 4:2:0 平面。');
  const ar=a.visibleRect,br=b.visibleRect;
  if(ar.x!==br.x||ar.y!==br.y||ar.width!==br.width||ar.height!==br.height)return reject('裁剪区域不一致。');
  const x=resolveYuvColor(a),y=resolveYuvColor(b);
  if(!x.supported||!y.supported||(['matrix','primaries','fullRange','transfer'] as const).some(k=>x[k]!==y[k]))return reject('SDR 色彩条件不一致或不受支持。');
  const [aOx,aOy]=chromaOffset(a.yuv),[bOx,bOy]=chromaOffset(b.yuv);
  if(aOx!==bOx||aOy!==bOy)return reject('色度采样位置不一致。');
  // Coded dimensions can differ when a decoder retains CTU padding. Compare
  // luma in the visible rectangle plus every chroma sample touched by its
  // bilinear reconstruction, including the one-sample edge halo.
  const clampIndex=(index:number,size:number)=>Math.max(0,Math.min(size-1,index));
  for(let c=0;c<3;c++){
    const sx=c?2**a.yuv.subsampleX:1,sy=c?2**a.yuv.subsampleY:1;
    let x0=c?Math.floor((ar.x-aOx)/sx):ar.x,y0=c?Math.floor((ar.y-aOy)/sy):ar.y;
    let x1=c?Math.floor((ar.x+ar.width-1-aOx)/sx)+1:ar.x+ar.width-1;
    let y1=c?Math.floor((ar.y+ar.height-1-aOy)/sy)+1:ar.y+ar.height-1;
    if(c){
      const ap=a.yuv.planes[a.yuv.semiplanar?1:c],bp=b.yuv.planes[b.yuv.semiplanar?1:c];
      const ax0=clampIndex(x0,ap.width),bx0=clampIndex(x0,bp.width);
      const ay0=clampIndex(y0,ap.height),by0=clampIndex(y0,bp.height);
      const ax1=clampIndex(x1,ap.width),bx1=clampIndex(x1,bp.width);
      const ay1=clampIndex(y1,ap.height),by1=clampIndex(y1,bp.height);
      x0=Math.min(ax0,bx0);y0=Math.min(ay0,by0);x1=Math.max(ax1,bx1);y1=Math.max(ay1,by1);
    }
    const read=(pixels:Uint8ClampedArray,d:typeof a,col:number,row:number)=>{
      const layout=d.yuv!,plane=layout.planes[layout.semiplanar&&c?1:c];
      return yuvSample(pixels,layout,c,clampIndex(col,plane.width)*sx,clampIndex(row,plane.height)*sy);
    };
    for(let row=y0;row<=y1;row++)for(let col=x0;col<=x1;col++){
      if(read(nativePixels,a,col,row)!==read(referencePixels,b,col,row))return reject(`平面 ${c} 的可见样本不一致。`);
    }
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
    getAnalysisCapability:source.getAnalysisCapability?.bind(source),
    queryAnalysis:source.queryAnalysis?.bind(source),
    rankAnalysisTime:source.rankAnalysisTime?.bind(source),
    analysisSampleAtNumber:source.analysisSampleAtNumber?.bind(source),
    locateAnalysisSample:source.locateAnalysisSample?.bind(source),
    frameAt:async pts=>convert(await source.frameAt(pts)),
    async framesAfter(pts,count){const result:DecodedFrame[]=[];try{for await(const frame of pipeline(source.framesFrom(pts))){if(frame.ptsUs<=pts){frame.close();continue;}result.push(frame);if(result.length>=count)break;}return result;}catch(error){result.forEach(f=>f.close());throw error;}},
    framesFrom:pts=>pipeline(source.framesFrom(pts)),
    ...(source.framesFollowing?{framesFollowing:(pts:number)=>pipeline(source.framesFollowing!(pts))}:{}),
    dispose(){if(disposed)return;disposed=true;source.dispose();for(const slot of slots){slot.reject?.(aborted());slot.worker.terminate();}while(waiters.length)waiters.shift()!(slots[0]);},
  };
}
