import {inspectFlvFramePair,measureFlvFramePair} from '../../shared/analysis/quality/frame-pair.ts';
import type {PairDecoder} from '../../shared/analysis/quality/frame-pair.ts';
import type {QualityEvidence} from '../../shared/review/quality-evidence.ts';
import type {AnnotationRecord} from '../../shared/review/annotation-record.ts';
import {rgbaDescription} from '../../shared/media/frame-description.ts';
import {preparedPair,pairRequest,wrapFlv,pairAvcc,admissionIdr} from './frame-pair-fixture.ts';
const origin='http://localhost',reference={space:'shared',annotationId:'mark',evidenceId:'evidence'};
export async function pairViewFixture(spatial=false) {
 const bytes=wrapFlv('h264',pairAvcc,[admissionIdr,admissionIdr]),a=await preparedPair(bytes),b=await preparedPair(bytes,'a'.repeat(24),1),request=pairRequest(a.target,b.target);
 if(spatial)request.spatial={blockWidth:16,blockHeight:16};
 const description=rgbaDescription(32,32,{format:'YUV',stride:null,byteLength:1536,color:{primaries:'bt709',transfer:'bt709',matrix:'bt709',fullRange:false},yuv:{bitDepth:8,bitShift:0,subsampleX:1,subsampleY:1,semiplanar:false,chromaLocation:1,planes:[{offset:0,stride:32,width:32,height:32},{offset:1024,stride:16,width:16,height:16},{offset:1280,stride:16,width:16,height:16}]}});
 const decoder:PairDecoder={version:{backend:'ffmpeg-wasm',buildId:'c'.repeat(40),frameAbi:2,packetIdentity:'isolated-closed-au-v1'},async decode(_c,_d,_p,pts){return {pts,pixels:new Uint8Array(1536),description:structuredClone(description)};},close(){}};
 const result=await measureFlvFramePair(request,[a.open(),b.open()],async()=>decoder,new AbortController().signal);
 const producer={producer:'server-flv-scan-v1' as const,sourceVersion:a.target.picture.sourceVersion,size:bytes.length,epoch:1,packetCommitId:'commit',documentSha256:'d'.repeat(64),sourceStat:{size:String(bytes.length),dev:'1',ino:'2',mtimeNs:'3',ctimeNs:'4'}};
 const evidence:QualityEvidence={schema:'voidplayer-annotation-psnr',version:1,id:reference.evidenceId,ref:{jobId:'job',attemptId:'attempt',digest:'e'.repeat(64),side:'reference'},serviceOrigin:origin,completedAt:1,attachedAt:'now',attachedBy:{id:'actor',name:'Actor'},verification:'server-verified',value:{schema:'voidplayer-library-frame-pair-psnr',version:1,execution:{host:'node-worker',runtime:'node',runtimeVersion:'test',sourceIdentity:'stat-version-v1'},result,sources:{reference:{binding:a.source.binding,producer},distorted:{binding:b.source.binding,producer}}}};
 const pair=await inspectFlvFramePair({...request,budget:{maxSamples:1}},[a.open(),b.open()],async()=>decoder,new AbortController().signal);
 const record={id:'mark',space:'shared',revision:1,sequence:1,deleted:false,updatedAt:'now',updatedBy:'actor',document:{mark:{qualityEvidence:[evidence]},media:[]}} as unknown as AnnotationRecord;
 return {request,evidence,pair,record,description};
}
