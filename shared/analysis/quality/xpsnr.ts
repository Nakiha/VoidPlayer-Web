import {canonicalJson,VMAF_LIMITS,vmafSequence,vmafSequenceFrame,vmafSourceVersion} from './vmaf.ts';
import type {VmafPrepared,VmafPlanSnapshot,VmafMetricState,VmafSequence,VmafSequenceFrame} from './vmaf.ts';
import type {LibraryPairResult} from './library-pair.ts';
import type {QualityVideoIndex} from './source-index.ts';
import type {PsnrStatistics} from './psnr.ts';
export {canonicalJson};
export const XPSNR_SOURCE_REVISION='8998a1a670c81a04d144c36f9e2d3aa680c10720';
export const XPSNR_FILTER_SHA256='4b59b32eb4a501ac74f6d767a916ef1a29833e1895b150cfa96b8e4ffb91f3d7';
export const XPSNR_SUPERVISOR_SOURCE_SHA256='df6ab9f43548839f3743d773958468f0e5f6416268006843eb68deab43eff48f';
export const XPSNR_LIMITS=Object.freeze({...VMAF_LIMITS});
export const XPSNR_RECIPE='ffmpeg-xpsnr-reference-first-temporal-v1';
export type XpsnrDb=PsnrStatistics['psnr'];
export type XpsnrPlanes={y:XpsnrDb;u:XpsnrDb;v:XpsnrDb};
export type XpsnrComponentConfig={directory:string;manifestSha256:string};
export type XpsnrInput={schema:'voidplayer-native-xpsnr-job';version:1;client:{id:string;kind:'browser'|'agent'|'other'};plan:{id:string;attemptId:string;digest:string};recipe:typeof XPSNR_RECIPE;cadenceUs:number;metrics:{psnr:true;ssim:boolean};budget:{maxRawBytes:number;maxElapsedMs:number;nativeCpuSeconds:number;nativeMemoryBytes:number}};
export type XpsnrPlanSnapshot=VmafPlanSnapshot;
export type XpsnrPrepared=VmafPrepared;
export type XpsnrSequence=VmafSequence;
export type XpsnrNativeResult={frames:{index:number;planes:XpsnrPlanes;minimum:XpsnrDb}[];pooled:{planes:XpsnrPlanes;minimum:XpsnrDb};statistics:{format:'ffmpeg-xpsnr-stats-4-decimal-v1';text:string;sha256:string};version:string;component:{manifestSha256:string;binarySha256:string;supervisorSha256:string;sourceRevision:string;filterSha256:string};recipe:{id:typeof XPSNR_RECIPE;threads:1;cpuFlags:0;inputOrder:'reference-distorted';pooling:'official-square-mean-root-with-low-distortion-log-fallback';preprocessing:'none';range:'limited';color:'bt709-sdr';pixelFormat:'yuv420p'|'yuv420p10le';width:number;height:number;bitDepth:8|10;cadenceUs:number;frameRate:{numerator:1000000;denominator:number};boundary:'clip-reset-and-final-flush';rawPacking:'visible-y-u-v-tight-little-endian-v1'};resources:{exitCode:number;signal:number;cpuMs:number;wallMs:number;peakRssBytes:number;stdoutBytes:number;stderrBytes:number;finalVerification?:{indexBytes:number;indexPackets:number;elapsedMs:number}}};
export type XpsnrResult={schema:'voidplayer-native-xpsnr-result';version:1|2;plan:XpsnrInput['plan'];prepared:XpsnrPrepared;xpsnr:XpsnrNativeResult|null;metrics:{psnr:VmafMetricState;ssim:VmafMetricState;xpsnr:VmafMetricState}};
export type XpsnrJob={schema:'voidplayer-native-xpsnr-job-state';version:1;id:string;actor:{id:string;name:string};key:string;requestId:string;input:XpsnrInput;revision:number;createdAt:number;queueUntil:number;startedAt:number|null;endedAt:number|null;attemptId:string|null;state:'queued'|'preparing'|'running'|'cancelling'|'completed'|'partial'|'failed'|'cancelled'|'interrupted';phase:string;reason:{code:string;message:string}|null;progress:{preparedFrames:number;targetFrames:number};metrics:XpsnrResult['metrics'];resultDigest:string|null;process:{pid:number;startTicks:string;bootId:string}|null};
export const terminalXpsnr=(s:XpsnrJob['state'])=>!['queued','preparing','running','cancelling'].includes(s);
export class XpsnrError extends Error{readonly code:string;constructor(code:string,message:string){super(message);this.code=code;}}
const fail=(message:string):never=>{throw new XpsnrError('invalid-xpsnr-result',message);};
const object=(v:unknown,keys:string[])=>{if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).some(k=>!keys.includes(k)))throw new XpsnrError('invalid-xpsnr-request','Unknown XPSNR fields');};
export function xpsnrInput(value:unknown):XpsnrInput{
 object(value,['schema','version','client','plan','recipe','cadenceUs','metrics','budget']);const v=structuredClone(value)as XpsnrInput;
 object(v.client,['id','kind']);object(v.plan,['id','attemptId','digest']);object(v.metrics,['psnr','ssim']);object(v.budget,['maxRawBytes','maxElapsedMs','nativeCpuSeconds','nativeMemoryBytes']);
 if(v.schema!=='voidplayer-native-xpsnr-job'||v.version!==1||v.recipe!==XPSNR_RECIPE||typeof v.client.id!=='string'||!/^[A-Za-z0-9._:-]{1,80}$/.test(v.client.id)||!['agent','browser','other'].includes(v.client.kind)||v.metrics.psnr!==true||typeof v.metrics.ssim!=='boolean'||!Number.isSafeInteger(v.cadenceUs)||v.cadenceUs<1||v.cadenceUs>1000000)throw new XpsnrError('invalid-xpsnr-request','Pin the reference-first XPSNR recipe, joint PSNR and exact cadence (1..1000000 microseconds)');
 if(!/^[a-f0-9-]{36}$/.test(v.plan.id)||!/^[a-f0-9-]{36}$/.test(v.plan.attemptId)||!/^[a-f0-9]{64}$/.test(v.plan.digest))throw new XpsnrError('invalid-xpsnr-request','Pin a committed correspondence attempt and digest');
 const maxima={maxRawBytes:XPSNR_LIMITS.maxRawBytes,maxElapsedMs:XPSNR_LIMITS.maxElapsedMs,nativeCpuSeconds:XPSNR_LIMITS.nativeCpuSeconds,nativeMemoryBytes:XPSNR_LIMITS.nativeMemoryBytes};
 for(const k of Object.keys(maxima)as(keyof typeof maxima)[])if(!Number.isSafeInteger(v.budget[k])||v.budget[k]<1||v.budget[k]>maxima[k])throw new XpsnrError('invalid-xpsnr-request',`Invalid ${k} budget`);
 return v;
}
/** Same trusted continuous source domain as VMAF; no model or VMAF computation. */
export function xpsnrSequence(snapshot:XpsnrPlanSnapshot,indexes:[QualityVideoIndex,QualityVideoIndex],cadenceUs:number){try{return vmafSequence(snapshot,indexes,cadenceUs);}catch(e){throw new XpsnrError('unsupported-xpsnr-sequence',(e as Error).message.replaceAll('VMAF','XPSNR'));}}
export const xpsnrSequenceFrame=vmafSequenceFrame;
export const xpsnrSourceVersion=vmafSourceVersion;
export function xpsnrDb(v:unknown):XpsnrDb{if(v==='inf')return {kind:'positive-infinity',db:null};if(typeof v==='string'&&/^-?\d+\.\d{4}$/.test(v)&&Number.isFinite(Number(v)))return {kind:'finite',db:Number(v)};return fail('Invalid official XPSNR dB token');}
export function validateXpsnrDb(v:unknown):XpsnrDb{object(v,['kind','db']);const p=v as XpsnrDb;if(p.kind==='positive-infinity'&&p.db===null||p.kind==='finite'&&Number.isFinite(p.db))return p;return fail('Invalid extended XPSNR value');}
export const xpsnrMinimum=(p:XpsnrPlanes):XpsnrDb=>{const finite=Object.values(p).filter(v=>v.kind==='finite').map(v=>v.db!);return finite.length?{kind:'finite',db:Math.min(...finite)}:{kind:'positive-infinity',db:null};};
/** Read the filter's emitted pool verbatim. Never reconstruct it from rounded frame dB. */
export function parseXpsnrStatistics(text:string,frames:number){
 const rows=text.trim().split(/\r?\n/).filter(Boolean),pattern=/^n:\s+(\d+)\s+XPSNR y:\s+(\S+)\s+XPSNR u:\s+(\S+)\s+XPSNR v:\s+(\S+)$/;
 if(rows.length!==frames+1||frames<2||frames>XPSNR_LIMITS.frames)fail('Official XPSNR frame count differs');
 const values=rows.slice(0,-1).map((row,index)=>{const m=pattern.exec(row);if(!m||Number(m[1])!==index+1)fail('Official XPSNR frame order differs');const planes={y:xpsnrDb(m![2]),u:xpsnrDb(m![3]),v:xpsnrDb(m![4])};return {index,planes,minimum:xpsnrMinimum(planes)};});
 const m=/^XPSNR average, (\d+) frames\s+y:\s+(\S+)\s+u:\s+(\S+)\s+v:\s+(\S+)\s+\(minimum:\s+(\S+)\)$/.exec(rows.at(-1)!);
 if(!m||Number(m[1])!==frames)fail('Missing official XPSNR sequence pool');
 const planes={y:xpsnrDb(m![2]),u:xpsnrDb(m![3]),v:xpsnrDb(m![4])},minimum=xpsnrDb(m![5]);if(canonicalJson(minimum)!==canonicalJson(xpsnrMinimum(planes)))fail('Official plane minimum differs');
 return {frames:values,pooled:{planes,minimum}};
}
export type XpsnrAssociation={schema:'voidplayer-xpsnr-sequence-association';version:1|2;jobId:string;attemptId:string;resultDigest:string;plan:XpsnrInput['plan'];sequence:{cadenceUs:number;referenceIntegrity:'not-certified';concealmentDetection:'unavailable';pairs:{reference:VmafSequenceFrame;distorted:VmafSequenceFrame}[]};index:number;frames:number;planes:XpsnrPlanes;pooled:XpsnrNativeResult['pooled'];component:XpsnrNativeResult['component'];recipe:XpsnrNativeResult['recipe'];raw:XpsnrPrepared['raw'];statisticsSha256:string;spatial:'full-frame-temporal-score-not-localized'};
export function validateXpsnrAssociation(value:unknown,pair:LibraryPairResult):XpsnrAssociation{
 const v=value as XpsnrAssociation;object(v,['schema','version','jobId','attemptId','resultDigest','plan','sequence','index','frames','planes','pooled','component','recipe','raw','statisticsSha256','spatial']);
 const hex=(s:unknown)=>typeof s==='string'&&/^[a-f0-9]{64}$/.test(s),uuid=(s:unknown)=>typeof s==='string'&&/^[a-f0-9-]{36}$/.test(s);
 if(v.schema!=='voidplayer-xpsnr-sequence-association'||v.version!==xpsnrSourceVersion(pair.sources)||v.version!==pair.version||!/^xpsnr-[a-f0-9-]{36}$/.test(v.jobId)||!uuid(v.attemptId)||!hex(v.resultDigest)||!hex(v.statisticsSha256)||v.spatial!=='full-frame-temporal-score-not-localized'||!Number.isInteger(v.frames)||v.frames<2||v.frames>32||!Number.isInteger(v.index)||v.index<0||v.index>=v.frames)fail('Invalid XPSNR association identity');
 object(v.plan,['id','attemptId','digest']);if(!uuid(v.plan.id)||!uuid(v.plan.attemptId)||!hex(v.plan.digest))fail('Invalid C plan');
 for(const p of [v.planes,v.pooled?.planes]){object(p,['y','u','v']);for(const k of ['y','u','v']as const)validateXpsnrDb(p[k]);}object(v.pooled,['planes','minimum']);validateXpsnrDb(v.pooled.minimum);if(canonicalJson(v.pooled.minimum)!==canonicalJson(xpsnrMinimum(v.pooled.planes)))fail('Invalid pool minimum');
 const c=v.component,r=v.recipe;object(c,['manifestSha256','binarySha256','supervisorSha256','sourceRevision','filterSha256']);if(![c.manifestSha256,c.binarySha256,c.supervisorSha256].every(hex)||c.sourceRevision!==XPSNR_SOURCE_REVISION||c.filterSha256!==XPSNR_FILTER_SHA256)fail('Unpinned component');
 object(r,['id','threads','cpuFlags','inputOrder','pooling','preprocessing','range','color','pixelFormat','width','height','bitDepth','cadenceUs','frameRate','boundary','rawPacking']);object(r.frameRate,['numerator','denominator']);
 if(r.id!==XPSNR_RECIPE||r.threads!==1||r.cpuFlags!==0||r.inputOrder!=='reference-distorted'||r.pooling!=='official-square-mean-root-with-low-distortion-log-fallback'||r.preprocessing!=='none'||r.range!=='limited'||r.color!=='bt709-sdr'||r.boundary!=='clip-reset-and-final-flush'||r.rawPacking!=='visible-y-u-v-tight-little-endian-v1'||r.pixelFormat!==(r.bitDepth===8?'yuv420p':'yuv420p10le')||![8,10].includes(r.bitDepth)||!Number.isSafeInteger(r.cadenceUs)||r.cadenceUs<1||r.cadenceUs>1000000||r.frameRate.numerator!==1000000||r.frameRate.denominator!==r.cadenceUs)fail('Invalid reference-first temporal recipe');
 object(v.sequence,['cadenceUs','referenceIntegrity','concealmentDetection','pairs']);if(v.sequence.cadenceUs!==r.cadenceUs||v.sequence.referenceIntegrity!=='not-certified'||v.sequence.concealmentDetection!=='unavailable'||v.sequence.pairs.length!==v.frames)fail('Invalid continuous sequence');
 for(const side of ['reference','distorted']as const){const seen=new Set<number>();for(const [i,item]of v.sequence.pairs.entries()){object(item,['reference','distorted']);const p=item[side];object(p,['au','sourcePtsUs','decode','container']);if(!Number.isSafeInteger(p.au)||p.au<0||seen.has(p.au)||!Number.isSafeInteger(p.sourcePtsUs)||p.sourcePtsUs<0||i>0&&p.sourcePtsUs-v.sequence.pairs[i-1][side].sourcePtsUs!==r.cadenceUs)fail('Invalid sequence clocks');seen.add(p.au);}
  const p=v.sequence.pairs[v.index][side],actual=pair.result.provenance[side];if(canonicalJson(p)!==canonicalJson(xpsnrSequenceFrame(actual)))fail('Selected original frame differs');
 }
 const m=pair.result.metric;if(![r.width,r.height].every(n=>Number.isSafeInteger(n)&&n>=64&&n%2===0)||r.width>1920||r.height>1080||m.roi.x||m.roi.y||m.roi.width!==r.width||m.roi.height!==r.height||m.bitDepth!==r.bitDepth||m.color.primaries!=='bt709'||m.color.transfer!=='bt709'||m.color.matrix!=='bt709'||m.color.fullRange||m.color.chromaLocation!==1)fail('XPSNR full-frame pixel domain differs');
 object(v.raw,['referenceSha256','distortedSha256','bytes']);if(!hex(v.raw.referenceSha256)||!hex(v.raw.distortedSha256)||v.raw.bytes!==r.width*r.height*3/2*(r.bitDepth===8?1:2)*v.frames*2||v.raw.bytes>XPSNR_LIMITS.maxRawBytes)fail('Invalid raw sequence witness');
 return structuredClone(v);
}
export const XPSNR_CAPABILITY={schema:'voidplayer-native-xpsnr-capability',version:1,platforms:['linux-x64'],limits:XPSNR_LIMITS,recipe:XPSNR_RECIPE,sourceRevision:XPSNR_SOURCE_REVISION,filterSha256:XPSNR_FILTER_SHA256,license:'LGPL-2.1-or-later',containers:{flv:{codecs:['h264','hevc'],bitDepths:[8,10]},mp4:{sampleEntries:['avc1','hvc1'],matrix:['h264-8','hevc-8','hevc-10'],fragmented:false}},requires:'committed-C-plan; 2..32 all mapped continuous exact integer-microsecond cadence frames',input:'full-frame limited BT.709 SDR YUV420 same geometry and 8/10 bit depth; reference input first; no conversion',metrics:{required:['psnr','xpsnr'],optional:['ssim']},pooling:'official per-plane pool and minimum; never average rounded frame dB',temporalBoundary:'clip-reset-and-final-flush',scoreDirection:'higher-is-better',scoreRange:'extended-dB-positive-infinity-allowed',contentCertification:false,perceptualSuperiority:'not-established',negativePts:false,vfr:false,spatial:'no-XPSNR-heatmap-or-localized-defect'}as const;
