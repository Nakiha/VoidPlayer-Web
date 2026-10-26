import {readFile} from 'node:fs/promises';
import {scanFlv} from '../../shared/media/containers/flv-demux.ts';
import {serializeFlvIndex} from '../../shared/media/indexing/flv-index-cache.ts';
import {FLV_MEDIA_INDEX_IDENTITY} from '../../shared/media/indexing/media-index-identity.ts';
import type {LibraryPairBinding} from '../../shared/analysis/quality/library-pair.ts';
import {referenceRelationInput,correspondenceInput} from '../../shared/analysis/quality/correspondence.ts';
import type {ReferenceRelation} from '../../shared/analysis/quality/correspondence.ts';

export async function correspondenceFixture(){
  const samples=JSON.parse(await readFile(new URL('./quality-http-samples.json',import.meta.url),'utf8')).samples;
  const sample=samples.find((s:any)=>s.codec==='h264'&&s.depth===8&&s.tagged),bytes=Buffer.from(sample.flv,'base64');
  const {index}=await scanFlv({size:bytes.length,async read(at,n){return bytes.subarray(at,at+n);}}),doc=serializeFlvIndex(index,bytes.length);
  const source=(id:string)=>({binding:{mediaId:id.repeat(24),mediaVersion:'c'.repeat(24),size:bytes.length,indexIdentity:FLV_MEDIA_INDEX_IDENTITY,indexBuildId:`build-${id}`},producer:{producer:'server-flv-scan-v1',sourceVersion:`${id.repeat(24)}@${'c'.repeat(24)}`,size:bytes.length,epoch:1,packetCommitId:'commit',documentSha256:'d'.repeat(64),sourceStat:{size:String(bytes.length),dev:'1',ino:'1',mtimeNs:'1',ctimeNs:'1'}},index:structuredClone(doc)}) as LibraryPairBinding&{index:typeof doc};
  const sources=[source('a'),source('b')] as const,p0=doc.packets[0][2],p1=doc.packets[1][2];
  const input=referenceRelationInput({schema:'voidplayer-quality-reference-relation',version:1,client:{id:'clock-test',kind:'agent'},reference:{mediaId:sources[0].binding.mediaId,mediaVersion:'c'.repeat(24),stream:'video',configuration:0},distorted:{mediaId:sources[1].binding.mediaId,mediaVersion:'c'.repeat(24),stream:'video',configuration:0},declaration:'Caller declares these sources for comparison',clock:{mode:'piecewise-exact-source-pts-offset',segments:[{id:'positive',referenceStartUs:p0,referenceEndUs:p0+1,offsetUs:p1-p0},{id:'negative',referenceStartUs:p1,referenceEndUs:p1+1,offsetUs:p0-p1}]}});
  const relation:ReferenceRelation={id:'11111111-1111-4111-8111-111111111111',actor:{id:'owner',name:'Owner'},requestId:'relation-request',key:'relation-key',revision:1,createdAt:1,input,assessment:'caller-declared-not-content-certified'};
  const request=correspondenceInput({schema:'voidplayer-quality-correspondence-plan',version:1,client:input.client,relation:{id:relation.id,revision:1},referenceBuildId:'build-a',distortedBuildId:'build-b',interval:{startAu:0,endAu:1},sampling:{mode:'all'},recipe:{roi:{x:0,y:0,width:32,height:32},budget:{maxReadBytes:65536,maxInputBytes:65536}},budget:{maxReadBytes:131072,maxPackets:4,maxOutputFrames:4,maxInputBytes:131072,maxElapsedMs:10000},planningBudget:{maxIndexBytes:65536,maxIndexPackets:16,maxElapsedMs:10000}});
  return {sources:[...sources] as [typeof sources[0],typeof sources[1]],relation,request,doc};
}
