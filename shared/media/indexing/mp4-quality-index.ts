import {configurationPixelFields} from '../codecs/configuration-pixel-fields.ts';
import {inspectPacketPicture} from '../codecs/packet-picture.ts';
import {nalRanges} from '../codecs/nal-framing.ts';
import {avcGeometry} from '../codecs/avc-geometry.ts';
import {hevcGeometry,hevcFieldPictures} from '../codecs/hevc-geometry.ts';

export const MP4_QUALITY_BUILD='mp4-quality-tables-v1';
export const MP4_QUALITY_LIMITS=Object.freeze({sourceBytes:64*1024*1024,readBytes:128*1024*1024,metadataBytes:24*1024*1024,samples:250000,boxes:100000,packetBytes:8*1024*1024});
export type Mp4QualitySample={ordinal:number;description:1;offset:number;size:number;dtsTicks:number;ctsTicks:number;durationTicks:number;dtsUs:number;ptsUs:number;durationUs:number;key:boolean};
export type Mp4QualityDocument={schema:'voidplayer-mp4-quality-index';version:1;size:number;trackId:number;timescale:number;durationTicks:number;
  sampleEntry:'avc1'|'hvc1';codec:'h264'|'hevc';description:number[];width:number;height:number;
  color:{primaries:1;transfer:1;matrix:1;fullRange:boolean};moov:{offset:number;size:number;sha256:string};mdat:{start:number;end:number}[];samples:Mp4QualitySample[]};
export class Mp4QualityError extends Error {readonly code:'unsupported-source'|'identity-mismatch'|'budget-exceeded';constructor(code:Mp4QualityError['code'],message:string){super(message);this.name='Mp4QualityError';this.code=code;}}
const fail=(message:string):never=>{throw new Mp4QualityError('unsupported-source',message);};
const budget=(message:string):never=>{throw new Mp4QualityError('budget-exceeded',message);};
const safe=(n:number)=>Number.isSafeInteger(n);
const view=(b:Uint8Array)=>new DataView(b.buffer,b.byteOffset,b.byteLength);
const u32=(b:Uint8Array,at:number)=>view(b).getUint32(at);
const text=(b:Uint8Array,at:number)=>String.fromCharCode(...b.subarray(at,at+4));
type Box={type:string;start:number;data:number;end:number};
/** Exact integer conversion; this authority never rounds or repairs clocks. */
export function mp4TicksToUs(ticks:number,timescale:number):number{
  if(!safe(ticks)||!safe(timescale)||timescale<1)fail('Invalid MP4 clock');
  const n=BigInt(ticks)*1000000n,d=BigInt(timescale);
  if(n%d!==0n)fail('MP4 clock is not exactly representable in integer microseconds');
  const result=Number(n/d);if(!safe(result))fail('MP4 clock exceeds exact integer range');return result;
}
function boxes(bytes:Uint8Array,start:number,end:number):Box[]{
  const result:Box[]=[];
  for(let at=start;at<end;){
    if(end-at<8)fail('Truncated MP4 box header');let size=u32(bytes,at),header=8;
    if(size===1){if(end-at<16)fail('Truncated extended MP4 box');size=Number(view(bytes).getBigUint64(at+8));header=16;}
    if(size===0)size=end-at;
    if(!safe(size)||size<header||size>end-at)fail('MP4 box extends outside its parent');
    result.push({type:text(bytes,at+4),start:at,data:at+header,end:at+size});at+=size;
    if(result.length>MP4_QUALITY_LIMITS.boxes)budget('MP4 box count exceeds budget');
  }return result;
}
function one(list:Box[],type:string):Box{const matches=list.filter(b=>b.type===type);if(matches.length!==1)fail(`MP4 requires exactly one ${type}`);return matches[0];}
function payload(bytes:Uint8Array,box:Box,min=0){const b=bytes.subarray(box.data,box.end);if(b.length<min)fail(`Truncated MP4 ${box.type}`);return b;}
function full(bytes:Uint8Array,box:Box,versions=[0],min=8){const b=payload(bytes,box,min);if(!versions.includes(b[0])||b[1]||b[2]||b[3])fail(`Unsupported MP4 ${box.type} version/flags`);return b;}
function rows(bytes:Uint8Array,box:Box,stride:number,versions=[0]){const b=full(bytes,box,versions);const count=u32(b,4);if(count>MP4_QUALITY_LIMITS.samples)budget('MP4 table entries exceed budget');if(b.length!==8+count*stride)fail(`Invalid MP4 ${box.type} table length`);return {b,count};}
function runs(bytes:Uint8Array,box:Box,count:number,signed=false){const {b,count:n}=rows(bytes,box,8,signed?[0,1]:[0]);const result:number[]=[];for(let i=0;i<n;i++){const length=u32(b,8+i*8),value=signed&&b[0]===1?view(b).getInt32(12+i*8):u32(b,12+i*8);if(!length||result.length+length>count)fail(`Invalid MP4 ${box.type} run`);for(let k=0;k<length;k++)result.push(value);}if(result.length!==count)fail(`Incomplete MP4 ${box.type}`);return result;}
function configurationSets(codec:'h264'|'hevc',bytes:Uint8Array){
  const result:Uint8Array[]=[];let at=codec==='h264'?6:23;
  const add=()=>{if(at+2>bytes.length)fail('Truncated configuration');const n=bytes[at]*256+bytes[at+1];at+=2;if(!n||at+n>bytes.length)fail('Invalid configuration NAL');result.push(bytes.subarray(at,at+n));at+=n;};
  if(codec==='h264'){if(bytes.length<7||bytes[0]!==1)fail('Invalid avcC');for(let n=bytes[5]&31;n;n--)add();if(at>=bytes.length)fail('Missing AVC PPS');for(let n=bytes[at++];n;n--)add();}
  else{if(bytes.length<23||bytes[0]!==1)fail('Invalid hvcC');for(let n=bytes[22];n;n--){if(at+3>bytes.length)fail('Truncated HEVC configuration');const count=bytes[at+1]*256+bytes[at+2];at+=3;for(let j=0;j<count;j++)add();}}
  return result;
}
export function verifyMp4QualityPacket(doc:Pick<Mp4QualityDocument,'codec'|'description'>,sample:Pick<Mp4QualitySample,'key'>,bytes:Uint8Array){
  const description=new Uint8Array(doc.description),evidence=inspectPacketPicture(doc.codec,description,bytes);
  if(!evidence.singlePicture||evidence.closedRandomAccess!==sample.key)fail('MP4 sync table is not a verified single-picture closed IDR declaration');
  const sets=configurationSets(doc.codec,description);
  for(const range of nalRanges(doc.codec,description,bytes)){
    const nal=bytes.subarray(range.offset,range.offset+range.size),type=doc.codec==='h264'?nal[0]&31:nal[0]>>1&63;
    const parameter=doc.codec==='h264'?[7,8,13,15].includes(type):[32,33,34].includes(type);
    if(parameter&&!sets.some(s=>s.length===nal.length&&s.every((v,i)=>v===nal[i])))fail('MP4 sample changes codec configuration');
    if(doc.codec==='hevc'&&[16,17,18,21,22,23].includes(type))fail('MP4 open/unsupported HEVC random access is not admitted');
  }
}
/** Every track must refer to this file, including unscored audio. */
function selfContainedTrack(bytes:Uint8Array,media:Box[],video=true){
  const minf=one(media,'minf'),info=boxes(bytes,minf.data,minf.end),dinf=one(info,'dinf'),dref=one(boxes(bytes,dinf.data,dinf.end),'dref'),refs=full(bytes,dref);
  const references=boxes(bytes,dref.data+8,dref.end);
  if(u32(refs,4)!==1||references.length!==1||references[0].type!=='url ')fail('MP4 external data references are unsupported');
  const url=payload(bytes,references[0],4);
  if(url.length!==4||url[0]||url[1]||url[2]||url[3]!==1)fail('MP4 samples must be self-contained');
  const stbl=one(info,'stbl'),tables=boxes(bytes,stbl.data,stbl.end);
  if(tables.some(b=>['senc','saiz','saio',...(video?['sgpd','sbgp']:[])].includes(b.type)))fail('MP4 encrypted/grouped samples are unsupported');
  const stsd=one(tables,'stsd'),sd=full(bytes,stsd),entries=boxes(bytes,stsd.data+8,stsd.end);
  if(u32(sd,4)!==entries.length||entries.some(e=>['encv','enca','enct','encs'].includes(e.type)))fail('MP4 protected sample descriptions are unsupported');
  return {tables,stsd,sd,entries};
}
/** Only a single identity edit is supported. Compare rational durations directly,
 * preserving the original sample clock and introducing no rounded movie offset. */
function identityEdit(bytes:Uint8Array,track:Box[],media:Box[],movieTimescale:number){
  const edits=track.filter(b=>b.type==='edts');if(!edits.length)return;
  if(edits.length!==1)fail('Duplicate MP4 edit list');
  const editBoxes=boxes(bytes,edits[0].data,edits[0].end),elst=one(editBoxes,'elst'),b=full(bytes,elst,[0,1]);
  const stride=b[0]===1?20:12;if(editBoxes.length!==1||u32(b,4)!==1||b.length!==8+stride)fail('MP4 edit remapping is unsupported');
  const segment=b[0]===1?view(b).getBigUint64(8):BigInt(u32(b,8)),mediaTime=b[0]===1?view(b).getBigInt64(16):BigInt(view(b).getInt32(12)),rateAt=b[0]===1?24:16;
  const mdhd=full(bytes,one(media,'mdhd'),[0,1],24),clockAt=mdhd[0]===1?20:12;
  if(mdhd.length<clockAt+(mdhd[0]===1?12:8))fail('Truncated MP4 edit clock');
  const timescale=u32(mdhd,clockAt),duration=mdhd[0]===1?view(mdhd).getBigUint64(clockAt+4):BigInt(u32(mdhd,clockAt+4));
  const tkhd=payload(bytes,one(track,'tkhd'),84),durationAt=tkhd[0]===1?28:20;
  if(tkhd[0]!==0&&tkhd[0]!==1||tkhd.length<durationAt+(tkhd[0]===1?8:4))fail('Invalid MP4 edit track header');
  const trackDuration=tkhd[0]===1?view(tkhd).getBigUint64(durationAt):BigInt(u32(tkhd,durationAt));
  if(!timescale||!movieTimescale||mediaTime!==0n||segment<=0n||segment!==trackDuration||segment*BigInt(timescale)!==duration*BigInt(movieTimescale)||view(b).getInt16(rateAt)!==1||view(b).getInt16(rateAt+2)!==0)fail('MP4 edit remapping is unsupported');
}
/** Validate a persisted document without granting producer trust. The host owns
 * its commit/digest seal; execution also re-reads the authoritative source tables. */
export function parseMp4QualityDocument(value:unknown,size:number):Mp4QualityDocument{
  const d=value as Mp4QualityDocument;
  const fields=(v:unknown,names:string[])=>!!v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===[...names].sort().join(',');
  if(!fields(d,['schema','version','size','trackId','timescale','durationTicks','sampleEntry','codec','description','width','height','color','moov','mdat','samples'])
    ||d.schema!=='voidplayer-mp4-quality-index'||d.version!==1||d.size!==size||!safe(size)||size<8||size>MP4_QUALITY_LIMITS.sourceBytes
    ||!safe(d.trackId)||d.trackId<1||!safe(d.timescale)||d.timescale<1||!safe(d.durationTicks)||d.durationTicks<1
    ||!['avc1','hvc1'].includes(d.sampleEntry)||d.codec!==(d.sampleEntry==='avc1'?'h264':'hevc')
    ||![d.width,d.height].every(n=>safe(n)&&n>0&&n<=16384)||!Array.isArray(d.description)||!d.description.length||d.description.length>1024*1024||d.description.some(n=>!Number.isInteger(n)||n<0||n>255)
    ||!fields(d.color,['primaries','transfer','matrix','fullRange'])||d.color.primaries!==1||d.color.transfer!==1||d.color.matrix!==1||typeof d.color.fullRange!=='boolean'
    ||!fields(d.moov,['offset','size','sha256'])||!safe(d.moov.offset)||d.moov.offset<0||!safe(d.moov.size)||d.moov.size<8||d.moov.size>MP4_QUALITY_LIMITS.metadataBytes||d.moov.offset+d.moov.size>size||!/^[a-f0-9]{64}$/.test(d.moov.sha256)
    ||!Array.isArray(d.mdat)||!d.mdat.length||d.mdat.length>MP4_QUALITY_LIMITS.boxes||!Array.isArray(d.samples)||!d.samples.length||d.samples.length>MP4_QUALITY_LIMITS.samples)fail('Invalid persisted MP4 quality index');
  let previousEnd=0;for(const m of d.mdat){if(!fields(m,['start','end'])||!safe(m.start)||!safe(m.end)||m.start<previousEnd||m.end<=m.start||m.end>size||m.start<d.moov.offset+d.moov.size&&m.end>d.moov.offset)fail('Invalid MP4 media extents');previousEnd=m.end;}
  const pts=new Set<number>();let expectedDts=0;
  for(const [ordinal,s]of d.samples.entries()){
    if(!fields(s,['ordinal','description','offset','size','dtsTicks','ctsTicks','durationTicks','dtsUs','ptsUs','durationUs','key'])||s.ordinal!==ordinal||s.description!==1||!safe(s.offset)||!safe(s.size)||s.size<1||s.size>MP4_QUALITY_LIMITS.packetBytes||!d.mdat.some(m=>s.offset>=m.start&&s.offset+s.size<=m.end)
      ||![s.dtsTicks,s.ctsTicks,s.durationTicks,s.dtsUs,s.ptsUs,s.durationUs].every(safe)||s.durationTicks<1||s.dtsTicks!==expectedDts||typeof s.key!=='boolean'
      ||s.dtsUs!==mp4TicksToUs(s.dtsTicks,d.timescale)||s.ptsUs!==mp4TicksToUs(s.dtsTicks+s.ctsTicks,d.timescale)||s.durationUs!==mp4TicksToUs(s.durationTicks,d.timescale)||pts.has(s.ptsUs))fail('Invalid MP4 sample identity/clock');
    expectedDts+=s.durationTicks;if(!safe(expectedDts))fail('MP4 sample clock overflow');pts.add(s.ptsUs);
  }
  const sorted=[...d.samples].sort((a,b)=>a.offset-b.offset);if(sorted.some((s,i)=>i>0&&s.offset<sorted[i-1].offset+sorted[i-1].size)||d.samples.some((s,i)=>i>0&&s.offset<d.samples[i-1].offset+d.samples[i-1].size)||!d.samples[0].key||expectedDts!==d.durationTicks)fail('Incomplete MP4 sample table');
  configurationSets(d.codec,new Uint8Array(d.description));return d;
}
/** Dedicated strict authority for quality. No playback recovery, edit/POC repair,
 * approximate clocks, media-bunny timing, decoder or implicit index publication. */
export async function readMp4QualityIndex(reader:{size:number;read(offset:number,length:number):Promise<Uint8Array>},options:{digest(bytes:Uint8Array):Promise<string>;check?():void;validatePayloads?:boolean}):Promise<{document:Mp4QualityDocument;readBytes:number}>{
  const limit=MP4_QUALITY_LIMITS;if(!safe(reader.size)||reader.size<8||reader.size>limit.sourceBytes)budget('MP4 source size exceeds quality preparation budget');
  let readBytes=0;
  const read=async(at:number,n:number)=>{options.check?.();if(!safe(at)||!safe(n)||at<0||n<0||at+n>reader.size)fail('MP4 read outside source');if(readBytes+n>limit.readBytes)budget('MP4 cumulative read budget exceeded');readBytes+=n;const b=await reader.read(at,n);options.check?.();if(b.length!==n)fail('Short MP4 read');return b;};
  const root:Box[]=[];for(let at=0;at<reader.size;){const h=await read(at,Math.min(16,reader.size-at));if(h.length<8)fail('Truncated root MP4 box');let n=u32(h,0),header=8;if(n===1){if(h.length<16)fail('Truncated extended box');n=Number(view(h).getBigUint64(8));header=16;}if(n===0)n=reader.size-at;if(!safe(n)||n<header||n>reader.size-at)fail('Truncated or invalid MP4 root box');root.push({type:text(h,4),start:at,data:at+header,end:at+n});at+=n;if(root.length>limit.boxes)budget('MP4 box count exceeds budget');}
  const fileType=one(root,'ftyp');if(fileType.end-fileType.data<8||fileType.end-fileType.data>4096||(fileType.end-fileType.data)%4)fail('Invalid MP4 file type declaration');const brands=await read(fileType.data,fileType.end-fileType.data);if(!['isom','iso2','iso3','iso4','iso5','iso6','mp41','mp42','avc1','hvc1','M4V '].includes(text(brands,0))||Array.from({length:(brands.length-8)/4},(_,i)=>text(brands,8+i*4)).includes('qt  '))fail('MP4 quality requires an explicit supported ISO MP4 file type');if(root.some(b=>['moof','styp','sidx','mfra'].includes(b.type)))fail('Fragmented MP4 is unsupported for quality');const moov=one(root,'moov'),mdat=root.filter(b=>b.type==='mdat').map(b=>({start:b.data,end:b.end}));if(!mdat.length)fail('MP4 has no media data');if(moov.end-moov.start>limit.metadataBytes)budget('MP4 metadata exceeds budget');
  const bytes=await read(moov.start,moov.end-moov.start),children=boxes(bytes,moov.data-moov.start,bytes.length);if(children.some(b=>b.type==='mvex'))fail('Fragmented MP4 defaults are unsupported');
  const tracks=children.filter(b=>b.type==='trak').map(trak=>{const track=boxes(bytes,trak.data,trak.end),mdia=one(track,'mdia'),media=boxes(bytes,mdia.data,mdia.end),handler=payload(bytes,one(media,'hdlr'),12);return {track,media,kind:text(handler,8)};});
  const mvhd=full(bytes,one(children,'mvhd'),[0,1],24),movieClockAt=mvhd[0]===1?20:12;if(mvhd.length<movieClockAt+4)fail('Truncated MP4 movie clock');const movieTimescale=u32(mvhd,movieClockAt),movieMatrixAt=mvhd[0]===1?48:36;if(!movieTimescale||mvhd.length<movieMatrixAt+36)fail('Invalid MP4 movie clock/geometry');if([65536,0,0,0,65536,0,0,0,1073741824].some((n,i)=>u32(mvhd,movieMatrixAt+i*4)!==n))fail('MP4 movie rotation/transform is unsupported');
  const trackIds=new Set<number>();for(const t of tracks){const h=payload(bytes,one(t.track,'tkhd'),24),at=h[0]===1?20:12;if(![0,1].includes(h[0])||h.length<at+4)fail('Invalid MP4 track header');const id=u32(h,at);if(!id||trackIds.has(id))fail('MP4 track IDs must be unique');trackIds.add(id);}
  for(const t of tracks){selfContainedTrack(bytes,t.media,t.kind==='vide');identityEdit(bytes,t.track,t.media,movieTimescale);}
  const videos=tracks.filter(t=>t.kind==='vide');if(videos.length!==1)fail('Quality requires one explicit MP4 video track');const {track,media}=videos[0];
  const tkhd=payload(bytes,one(track,'tkhd'),84),v=tkhd[0];if(v!==0&&v!==1)fail('Unsupported MP4 track header');const idAt=v===1?20:12,matrixAt=v===1?52:40,widthAt=v===1?88:76;if(tkhd.length<widthAt+8)fail('Truncated MP4 track geometry');const trackId=u32(tkhd,idAt);if(!trackId)fail('Invalid MP4 track ID');
  const identity=[65536,0,0,0,65536,0,0,0,1073741824];if(identity.some((n,i)=>u32(tkhd,matrixAt+i*4)!==n))fail('MP4 rotation/transform is unsupported');
  const mdhd=full(bytes,one(media,'mdhd'),[0,1],24),clockAt=mdhd[0]===1?20:12;if(mdhd.length<clockAt+(mdhd[0]===1?12:8))fail('Truncated MP4 clock');const timescale=u32(mdhd,clockAt),durationTicks=mdhd[0]===1?Number(view(mdhd).getBigUint64(clockAt+4)):u32(mdhd,clockAt+4);if(!timescale||!safe(durationTicks)||durationTicks<1)fail('Invalid MP4 media clock');
  const {tables,stsd,sd,entries}=selfContainedTrack(bytes,media);if(u32(sd,4)!==1||entries.length!==1)fail('MP4 requires a single sample description');const entry=entries[0];if(entry.type!=='avc1'&&entry.type!=='hvc1')fail('MP4 quality requires avc1/hvc1');const visual=payload(bytes,entry,78),vv=view(visual),width=vv.getUint16(24),height=vv.getUint16(26);if(vv.getUint16(6)!==1||!width||!height||u32(tkhd,widthAt)!==width*65536||u32(tkhd,widthAt+4)!==height*65536)fail('MP4 display/sample dimensions or data reference differ');
  const extensions=boxes(bytes,entry.data+78,entry.end);if(extensions.some(b=>['sinf','clap'].includes(b.type)))fail('MP4 encryption/clean aperture is unsupported');const pasps=extensions.filter(b=>b.type==='pasp');if(pasps.length>1)fail('Duplicate MP4 pixel aspect ratio');if(pasps.length){const p=payload(bytes,pasps[0],8);if(p.length!==8||!u32(p,0)||u32(p,0)!==u32(p,4))fail('MP4 requires exact square sample aspect ratio');}
  const colr=payload(bytes,one(extensions,'colr'),11);if(colr.length!==11||text(colr,0)!=='nclx'||view(colr).getUint16(4)!==1||view(colr).getUint16(6)!==1||view(colr).getUint16(8)!==1||(colr[10]&127))fail('MP4 quality requires explicit BT.709 SDR nclx color: '+[...colr].join(','));
  const codec=entry.type==='avc1'?'h264':'hevc',config=payload(bytes,one(extensions,codec==='h264'?'avcC':'hvcC'),1);if(config.length>1024*1024)budget('MP4 configuration exceeds budget');const sets=configurationSets(codec,config),annexB=new Uint8Array(sets.reduce((n,b)=>n+4+b.length,0));let setAt=0;for(const set of sets){annexB.set([0,0,0,1],setAt);annexB.set(set,setAt+4);setAt+=4+set.length;}
  const nominal=configurationPixelFields(codec,config),actual=configurationPixelFields(codec,annexB),depth=actual.bitDepth.value;
  if(actual.bitDepth.status!=='known'||actual.pixelFormat.status!=='known'||actual.bitDepth.value!==nominal.bitDepth.value||actual.pixelFormat.value!==nominal.pixelFormat.value||!(codec==='h264'?depth===8:depth===8||depth===10)||actual.pixelFormat.value!==(depth===8?'yuv420p':'yuv420p10'))fail('MP4 quality requires H2648 or HEVC8/10 YUV420 proven by codec configuration and SPS');
  const g=codec==='h264'?avcGeometry(config,true):hevcGeometry(config,true);if(!g||('interlaced'in g&&g.interlaced)||(codec==='hevc'&&hevcFieldPictures(config))||!g.sarSpecified||g.sarNum!==g.sarDen||g.sarNum<1||g.x||g.y||g.width!==g.codedWidth||g.height!==g.codedHeight||g.width!==width||g.height!==height)fail('MP4 requires proven progressive uncropped square-pixel SPS geometry');
  const sz=full(bytes,one(tables,'stsz'),[0],12),fixed=u32(sz,4),count=u32(sz,8);if(!count||count>limit.samples)budget('MP4 sample count exceeds budget');if(sz.length!==(fixed?12:12+count*4))fail('Invalid MP4 sample sizes');const sizes=Array.from({length:count},(_,i)=>fixed||u32(sz,12+i*4));if(sizes.some(n=>!n||n>limit.packetBytes))budget('MP4 sample byte budget exceeded');
  const deltas=runs(bytes,one(tables,'stts'),count);if(deltas.some(n=>!n))fail('MP4 decode durations must be positive');const ctts=tables.filter(b=>b.type==='ctts');if(ctts.length>1)fail('Duplicate MP4 composition table');const cts=ctts.length?runs(bytes,ctts[0],count,true):Array<number>(count).fill(0);
  const offsetBoxes=tables.filter(b=>b.type==='stco'||b.type==='co64');if(offsetBoxes.length!==1)fail('MP4 requires one chunk-offset table');const offsetBox=offsetBoxes[0],stride=offsetBox.type==='co64'?8:4,{b:chunks,count:chunkCount}=rows(bytes,offsetBox,stride);if(!chunkCount)fail('Empty MP4 chunk table');const {b:sc,count:runCount}=rows(bytes,one(tables,'stsc'),12);if(!runCount)fail('Empty MP4 sample-to-chunk table');
  const offsets:number[]=[];for(let run=0;run<runCount;run++){const first=u32(sc,8+run*12),per=u32(sc,12+run*12),description=u32(sc,16+run*12),next=run+1<runCount?u32(sc,20+run*12):chunkCount+1;if((run===0&&first!==1)||next<=first||next>chunkCount+1||!per||description!==1)fail('MP4 sample/configuration chunk mapping is invalid');for(let chunk=first;chunk<next;chunk++){let at=stride===8?Number(view(chunks).getBigUint64(8+(chunk-1)*stride)):u32(chunks,8+(chunk-1)*stride);for(let k=0;k<per;k++){const size=sizes[offsets.length];if(!size||!safe(at)||!safe(at+size)||!mdat.some(m=>at>=m.start&&at+size<=m.end))fail('MP4 sample outside complete mdat');offsets.push(at);at+=size;}}}if(offsets.length!==count)fail('MP4 sample table counts differ');
  const extents=offsets.map((at,i)=>({start:at,end:at+sizes[i]})).sort((a,b)=>a.start-b.start);if(extents.some((e,i)=>i>0&&e.start<extents[i-1].end))fail('MP4 video sample byte ranges overlap');if(offsets.some((at,i)=>i>0&&at<offsets[i-1]+sizes[i-1]))fail('MP4 non-monotonic sample byte order is unsupported');
  const syncBoxes=tables.filter(b=>b.type==='stss');if(syncBoxes.length>1)fail('Duplicate MP4 sync table');let keys:Set<number>|undefined;if(syncBoxes.length){const {b,count:n}=rows(bytes,syncBoxes[0],4);keys=new Set();let previous=0;for(let i=0;i<n;i++){const ordinal=u32(b,8+i*4);if(ordinal<=previous||ordinal>count)fail('Invalid MP4 sync ordinal');keys.add(ordinal-1);previous=ordinal;}}
  let dts=0;const uniquePts=new Set<number>();const samples:Mp4QualitySample[]=sizes.map((size,ordinal)=>{const ticks=dts;dts+=deltas[ordinal];if(!safe(dts)||!safe(ticks+cts[ordinal]))fail('MP4 clock overflow');const dtsUs=mp4TicksToUs(ticks,timescale),ptsUs=mp4TicksToUs(ticks+cts[ordinal],timescale),durationUs=mp4TicksToUs(deltas[ordinal],timescale);if(uniquePts.has(ptsUs))fail('MP4 presentation clock is ambiguous');uniquePts.add(ptsUs);return {ordinal,description:1,offset:offsets[ordinal],size,dtsTicks:ticks,ctsTicks:cts[ordinal],durationTicks:deltas[ordinal],dtsUs,ptsUs,durationUs,key:keys?keys.has(ordinal):true};});if(dts!==durationTicks)fail('MP4 media duration differs from complete sample table');if(!samples[0].key)fail('MP4 source must begin at a verified closed IDR candidate');
  const sha256=await options.digest(bytes);if(!/^[a-f0-9]{64}$/.test(sha256))fail('Invalid MP4 metadata digest');
  const document:Mp4QualityDocument={schema:'voidplayer-mp4-quality-index',version:1,size:reader.size,trackId,timescale,durationTicks,sampleEntry:codec==='h264'?'avc1':'hvc1',codec,description:[...config],width,height,color:{primaries:1,transfer:1,matrix:1,fullRange:!!(colr[10]&128)},moov:{offset:moov.start,size:bytes.length,sha256},mdat,samples};
  if(options.validatePayloads!==false)for(const sample of samples)verifyMp4QualityPacket(document,sample,await read(sample.offset,sample.size));
  return {document,readBytes};
}
