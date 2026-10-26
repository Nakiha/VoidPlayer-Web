import {nativeFlvDecoder} from '../../../../src/media/decoding/flv-decoder.ts';
import {demuxFlv} from '../../../../shared/media/containers/flv-demux.ts';
import {inspectPacketPicture} from '../../../../shared/media/codecs/packet-picture.ts';
import {VideoSample} from 'mediabunny';
import {paintFrame,disposePresentation} from '../../../../src/presentation/presenter.ts';
/** Real native decoder and presenter. Readback is TEST ONLY and identifies
 * painted synthetic barcodes independently from the accepted-clock ledger. */
export async function probe(encoded:string,barcode:{columns:number[];y:number;threshold:number}){
 const bytes=Uint8Array.from(atob(encoded),c=>c.charCodeAt(0)),index=await demuxFlv({size:bytes.length,read:async(o,n)=>bytes.slice(o,o+n)}),decoder=await nativeFlvDecoder(index,undefined,undefined,true);
 if(!decoder)return {unsupported:true,rows:[]};
 const counts=new Map<number,number>();for(const p of index.packets)counts.set(p.pts,(counts.get(p.pts)??0)+1);
 const rows:{identity:unknown;phase:string;code:number;commit?:number}[]=[],canvas=document.createElement('canvas');document.body.append(canvas);let phase='input';
 const receive=()=>{let f;while(f=decoder.receive(-Infinity)){
  const sample=new VideoSample(f.frame!),out={kind:'video-sample' as const,sample,description:f.description,width:f.width,height:f.height,ptsUs:f.pts-index.firstPts,sourcePtsUs:f.pts,byteSize:f.description.byteLength,presentedCommit:undefined as number|undefined,close:()=>sample.close()};
  try{canvas.width=f.width;canvas.height=f.height;paintFrame(canvas,out);const copy=new OffscreenCanvas(f.width,f.height),ctx=copy.getContext('2d')!;ctx.drawImage(canvas,0,0);const data=ctx.getImageData(0,0,f.width,f.height).data;
   const code=barcode.columns.reduce((n,x,bit)=>n|((data[(barcode.y*f.width+x)*4]>barcode.threshold?1:0)<<bit),0);rows.push({identity:f.nativePicture??null,phase,code,commit:out.presentedCommit});
  }finally{out.close();}
 }};
 try{for(let au=0;au<index.packets.length;au++){
  const p=index.packets[au],payload=bytes.slice(p.offset,p.offset+p.size),singlePicture=counts.get(p.pts)===1&&inspectPacketPicture(index.codec,index.description,payload).singlePicture;
  while(await decoder.send(payload,p,{au,configuration:p.configuration??0,singlePicture})===false)receive();receive();
 }phase='drain';await decoder.drain();receive();return {unsupported:false,rows};
 }finally{decoder.close();disposePresentation();canvas.remove();}
}
