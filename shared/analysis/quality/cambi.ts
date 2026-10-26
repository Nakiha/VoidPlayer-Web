import type {SourceBinding,PairTarget,PairProvenance,PairDecoder} from './frame-pair.ts';
import {pairBudget} from './frame-pair.ts';
import type {LibraryPairResult} from './library-pair.ts';
import {canonicalJson,VMAF_SOURCE_REVISION} from './vmaf.ts';
export {canonicalJson};
export const CAMBI_LIMITS=Object.freeze({frames:32,intervalAus:256,width:1920,height:1080,minLongEdge:320,maxRawBytes:64*1024*1024,maxHeatBytes:32*1024*1024,maxTemporaryBytes:256*1024*1024,maxElapsedMs:120000,nativeCpuSeconds:60,nativeMemoryBytes:512*1024*1024,maxReadBytes:128*1024*1024,maxPackets:1024,maxIndexBytes:64*1024*1024,maxIndexPackets:1000000,stdoutBytes:65536,resultBytes:2*1024*1024,page:4,queue:4,actorOutstanding:2,historyRows:8,historyBytes:256*1024*1024});
export const CAMBI_RECIPE=Object.freeze({feature:'cambi',mode:'no-reference',prediction:false,fullRef:false,eotf:'bt1886',subsample:1,encBitdepthOverride:0,sourceResolutionOverrides:0,windowAdjustment:'floor(floor(63*(width+height)/375)/16)',sourceRange:'limited',color:'bt709-sdr',windowSize:63,topk:0.6,tviThreshold:0.019,maxLogContrast:2,encResolution:'source-visible-no-resize',internalBitDepth:10,threads:1,cpuMask:0,scoreDirection:'higher-is-more-banding',thresholdCalibration:'none',temporal:'independent-per-frame-no-tracking',heatmapLayout:'gray16le-row-major-frames-concatenated',heatmapMeaning:'upstream-scaled-c-values-not-cropped-rescore',sourceRevision:VMAF_SOURCE_REVISION} as const);
export type CambiInput={schema:'voidplayer-cambi-job';version:1;client:{id:string;kind:'browser'|'agent'|'other'};source:SourceBinding;interval:{startPtsUs:number;endPtsUs:number};sampling:{stride:number};budget:{maxRawBytes:number;maxHeatBytes:number;maxTemporaryBytes:number;maxElapsedMs:number;nativeCpuSeconds:number;nativeMemoryBytes:number}};
export class CambiError extends Error{readonly code:string;constructor(code:string,message:string){super(message);this.code=code;}}
export function cambiCheck(test:unknown,message:string):asserts test{if(!test)throw new CambiError('invalid-cambi-request',message);}
export function cambiObject(value:unknown,keys:string[]){cambiCheck(value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join(',')===[...keys].sort().join(','),'Unknown or missing CAMBI fields');}
export function cambiInput(value:unknown):CambiInput{
 cambiObject(value,['schema','version','client','source','interval','sampling','budget']);const v=structuredClone(value) as CambiInput;
 cambiObject(v.client,['id','kind']);cambiObject(v.source,['mediaId','mediaVersion','size','indexIdentity','indexBuildId']);cambiObject(v.interval,['startPtsUs','endPtsUs']);cambiObject(v.sampling,['stride']);cambiObject(v.budget,['maxRawBytes','maxHeatBytes','maxTemporaryBytes','maxElapsedMs','nativeCpuSeconds','nativeMemoryBytes']);
 cambiCheck(v.schema==='voidplayer-cambi-job'&&v.version===1&&typeof v.client.id==='string'&&/^[A-Za-z0-9._:-]{1,80}$/.test(v.client.id)&&['browser','agent','other'].includes(v.client.kind),'Invalid CAMBI envelope');
 cambiCheck(v.source.indexIdentity?.kind==='flv','Native CAMBI requires trusted FLV; MP4 is unsupported');
 const target={...v.source,sourcePtsUs:0,picture:{sourceVersion:`${v.source.mediaId}@${v.source.mediaVersion}`,stream:'video',configuration:0,au:0,picture:0,layer:0,field:'frame'}} as PairTarget;
 pairBudget({pairing:'caller-specified',reference:target,distorted:target,roi:{x:0,y:0,width:2,height:2}});
 cambiCheck(Number.isSafeInteger(v.interval.startPtsUs)&&v.interval.startPtsUs>=0&&Number.isSafeInteger(v.interval.endPtsUs)&&v.interval.endPtsUs>v.interval.startPtsUs,'Use a nonnegative half-open source PTS interval');
 cambiCheck(Number.isInteger(v.sampling.stride)&&v.sampling.stride>=1&&v.sampling.stride<=256,'Invalid deterministic AU sampling stride');
 for(const k of Object.keys(v.budget) as (keyof CambiInput['budget'])[])cambiCheck(Number.isSafeInteger(v.budget[k])&&v.budget[k]>=1&&v.budget[k]<=CAMBI_LIMITS[k],`Invalid ${k} budget`);
 return v;
}
export type CambiScale={scale:number;width:number;height:number;bytes:number;file:string;mapping:{factor:number;originX:0;originY:0;edge:'ceil-sized-decimated-grid'}};
export function cambiScales(width:number,height:number):CambiScale[]{
 cambiCheck([width,height].every(n=>Number.isSafeInteger(n)&&n>=64&&n%2===0)&&width<=CAMBI_LIMITS.width&&height<=CAMBI_LIMITS.height&&Math.max(width,height)>=320,'CAMBI requires even 64..1920×64..1080 uncropped square geometry with long edge ≥320');
 const out:CambiScale[]=[];for(let scale=0;scale<5;scale++){out.push({scale,width,height,bytes:width*height*2,file:`cambi_heatmap_scale_${scale}_${width}x${height}_16b.gray`,mapping:{factor:2**scale,originX:0,originY:0,edge:'ceil-sized-decimated-grid'}});width=Math.ceil(width/2);height=Math.ceil(height/2);}return out;
}
/** Trusted fixed upstream writes exactly five named heatmap files. Each is
 * capped by FSIZE. Reserve all five caps + result cap, not one FSIZE as a total.
 * Expected exact lengths are independently validated after physical exit. */
export function cambiOutputBudget(width:number,height:number,frames:number,input:CambiInput){
 cambiCheck(Number.isInteger(frames)&&frames>=1&&frames<=CAMBI_LIMITS.frames,'CAMBI selected frame budget exceeded');const scales=cambiScales(width,height);
 const heatBytes=scales.reduce((n,s)=>n+s.bytes,0)*frames,rawBytes=width*height*3*frames; // worst-case 10 bit
 const fileCap=Math.max(scales[0].bytes*frames,CAMBI_LIMITS.resultBytes),reservedOutputBytes=fileCap*6;
 if(heatBytes>input.budget.maxHeatBytes||rawBytes>input.budget.maxRawBytes||rawBytes+reservedOutputBytes>input.budget.maxTemporaryBytes)throw new CambiError('budget-exceeded','Aggregate five-scale heatmap/raw/result disk reservation exceeds budget');
 return {scales,heatBytes,fileCap,reservedOutputBytes,temporaryReservedBytes:rawBytes+reservedOutputBytes};
}
export type CambiFrame={index:number;target:PairTarget;provenance:PairProvenance;sourceGeometry:import('../../media/codecs/hevc-geometry.ts').HevcGeometry;decoder:PairDecoder['version'];context:NonNullable<LibraryPairResult['annotationContext']>['reference'];proof:LibraryPairResult['sources']['reference'];rawSha256:string;score:number|null;heatmaps:{scale:number;sha256:string;bytes:number}[]};
export type CambiCoverage={scope:'bounded-source-pts-interval';interval:CambiInput['interval'];sampling:CambiInput['sampling'];intervalAus:number;selected:number;unsampled:number;unsupported:{au:number;sourcePtsUs:number;reason:string}[];scored:number;unscored:number;tracking:'none'};
export type CambiPrepared={frames:CambiFrame[];geometry:{width:number;height:number;bitDepth:8|10};coverage:CambiCoverage;output:ReturnType<typeof cambiOutputBudget>;rawBytes:number;work:{readBytes:number;packets:number;outputFrames:number;indexBytes:number;indexPackets:number;heapBytes:number;elapsedMs:number}};
export type CambiNative={version:string;recipe:typeof CAMBI_RECIPE;component:{manifestSha256:string;binarySha256:string;supervisorSha256:string;sourceRevision:string};frames:{index:number;score:number}[];pooled:{min:number;max:number;mean:number;harmonic_mean:number};resources:{exitCode:number;signal:number;cpuMs:number;wallMs:number;peakRssBytes:number;stdoutBytes:number;stderrBytes:number};outputBytes:number};
export type CambiResult={schema:'voidplayer-cambi-result';version:1;prepared:CambiPrepared;native:CambiNative|null};
export type CambiJob={schema:'voidplayer-cambi-job-state';version:1;id:string;actor:{id:string;name:string};key:string;requestId:string;input:CambiInput;revision:number;createdAt:number;queueUntil:number;startedAt:number|null;endedAt:number|null;attemptId:string|null;state:'queued'|'preparing'|'running'|'cancelling'|'completed'|'failed'|'cancelled'|'interrupted';phase:string;reason:{code:string;message:string}|null;progress:{preparedFrames:number;targetFrames:number;scoredFrames?:number};resultDigest:string|null;process:{pid:number;startTicks:string;bootId:string}|null};
export const terminalCambi=(state:CambiJob['state'])=>!['queued','preparing','running','cancelling'].includes(state);
export const CAMBI_CAPABILITY={schema:'voidplayer-cambi-capability',version:1,platforms:['linux-x64'],input:'single trusted complete FLV/EnhancedFLV; progressive H264/HEVC YUV420 8/10bit limited BT709 SDR; exact square uncropped geometry',recipe:CAMBI_RECIPE,limits:CAMBI_LIMITS,requiresReference:false,requiresCorrespondence:false,heatmaps:'five official gray16le scales; source-grid mapping; on-demand per-frame per-scale reads',threshold:'caller-declared-uncalibrated-candidate-not-pass-fail',referenceIntegrity:'not-certified',concealmentDetection:'unavailable',negativePts:false,vfr:false} as const;
