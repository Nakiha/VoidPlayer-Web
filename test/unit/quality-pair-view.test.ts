import {pairViewFixture as fixture} from '../helpers/pair-view-fixture.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectFlvFramePair,measureFlvFramePair,requireInspectionGeometry} from '../../shared/analysis/quality/frame-pair.ts';
import type {InspectedFramePair,PairDecoder} from '../../shared/analysis/quality/frame-pair.ts';
import {QualityPairViewSession} from '../../src/session/quality-pair-view.ts';
import {qualityPairViewUrl,pairViewEvidence,requirePairViewGeometry,verifyPairViewPresentation,verifyInspectedPair} from '../../shared/review/quality-pair-view.ts';
import type {PairViewPresentation} from '../../shared/review/quality-pair-view.ts';
import type {QualityEvidence} from '../../shared/review/quality-evidence.ts';
import type {AnnotationRecord} from '../../shared/review/annotation-record.ts';
import {rgbaDescription} from '../../shared/media/frame-description.ts';
import {preparedPair,pairRequest,wrapFlv,pairAvcc,admissionIdr} from '../helpers/frame-pair-fixture.ts';
const origin='http://localhost',reference={space:'shared',annotationId:'mark',evidenceId:'evidence'};

function deferred<T>() {let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>resolve=r);return {promise,resolve};}
test('inspection uses exact AU admission without numerical measurement, despite maxSamples=1',async()=>{const f=await fixture();assert.equal('metric' in f.pair,false);verifyInspectedPair(f.evidence,f.pair);assert.equal(f.pair.frames[0].pts,2000000);assert.equal(f.pair.frames[1].pts,3000000);});
test('shared reference URL is bounded, service-local, and historical/foreign evidence cannot confer inspection',async()=>{const f=await fixture();assert.match(qualityPairViewUrl(reference,origin),/^http:\/\/localhost\/quality.html\?/);assert.throws(()=>qualityPairViewUrl({...reference,space:'../private'},origin));assert.throws(()=>pairViewEvidence({...f.evidence,verification:'historical'},origin),/Historical/);assert.throws(()=>pairViewEvidence(f.evidence,'http://other'));
 for(const fault of ['crop','sar','rotation']){const d=structuredClone(f.description);if(fault==='crop'){d.width=30;d.displayWidth=30;d.visibleRect.x=2;d.visibleRect.width=30;}if(fault==='sar')d.displayWidth*=2;assert.throws(()=>requirePairViewGeometry(d,fault==='rotation'?90:0),/crop\/SAR\/rotation/);}
});
test('presentation refuses wrong AU, PTS, namespace, build and geometry',async()=>{const f=await fixture(),p=f.pair.provenance.reference,d=f.description;
 const token:PairViewPresentation={sourceGeometry:f.pair.sourceGeometry.reference,commit:1,picture:p.picture,sourceBinding:{mediaId:p.mediaId,mediaVersion:p.mediaVersion,size:p.size,indexIdentity:p.indexIdentity,indexBuildId:p.indexBuildId},sourcePtsUs:p.sourcePtsUs,geometry:{codedWidth:d.codedWidth,codedHeight:d.codedHeight,visibleRect:d.visibleRect,displayWidth:d.displayWidth,displayHeight:d.displayHeight,rotation:0}};verifyPairViewPresentation(f.evidence,'reference',token);
 for(const fault of ['au','pts','namespace','build','geometry','sar','missing-sar']){const t=structuredClone(token);if(fault==='au')t.picture!.au++;if(fault==='pts')t.sourcePtsUs++;if(fault==='namespace')t.sourceBinding.indexIdentity.indexerBuild='old';if(fault==='build')t.sourceBinding.indexBuildId='other';if(fault==='geometry')t.geometry.displayWidth++;if(fault==='sar')t.sourceGeometry.sarDen=1001;if(fault==='missing-sar')delete (t as Partial<PairViewPresentation>).sourceGeometry;assert.throws(()=>verifyPairViewPresentation(f.evidence,'reference',t));}
 for(const fault of ['decoder','color','packet']){const pair=structuredClone(f.pair);if(fault==='decoder')pair.decoder.buildId='d'.repeat(40);if(fault==='color')pair.frames[0].description.color.matrix='bt2020-ncl';if(fault==='packet')pair.provenance.reference.packet.offset++;assert.throws(()=>verifyInspectedPair(f.evidence,pair));}
});
test('two independent immutable snapshots present and release their actual frame budget',async()=>{const f=await fixture();let paints=0;const session=new QualityPairViewSession((_s,frame)=>{frame.presentedCommit=++paints;},origin,{read:async()=>structuredClone(f.record),inspect:async()=>structuredClone(f.pair)});await session.open(reference);assert.equal(paints,2);assert.equal(session.getState().state,'ready');assert.equal(session.resources.totalBytes,3072);session.cancel();assert.equal(session.resources.totalBytes,0);assert.equal(session.getState().presented,undefined);await session.close();});
test('cancel/close during a hung source read rejects late recovery without decoding or painting',async()=>{const f=await fixture(),gate=deferred<AnnotationRecord>(),entered=deferred<void>();let decoded=0,painted=0;const session=new QualityPairViewSession(()=>painted++,origin,{read:async()=>{entered.resolve();return gate.promise;},inspect:async()=>{decoded++;return f.pair;}});const open=session.open(reference);await entered.promise;let closed=false;const done=session.close().then(()=>closed=true);await Promise.resolve();assert.equal(closed,false);gate.resolve(f.record);await assert.rejects(open,{name:'AbortError'});await done;assert.equal(decoded,0);assert.equal(painted,0);assert.equal(session.resources.totalBytes,0);assert.equal(session.getState().state,'closed');});
test('a superseding open waits for the old inspector physical exit and discards its late frames',async()=>{const f=await fixture(),entered=deferred<void>(),exit=deferred<InspectedFramePair>();let inspections=0,paints=0;const session=new QualityPairViewSession((_s,frame)=>frame.presentedCommit=++paints,origin,{read:async()=>structuredClone(f.record),inspect:async()=>{inspections++;if(inspections===1){entered.resolve();return exit.promise;}return structuredClone(f.pair);}});const old=session.open(reference);await entered.promise;const next=session.open(reference);await Promise.resolve();assert.equal(inspections,1);exit.resolve(f.pair);await assert.rejects(old,{name:'AbortError'});await next;assert.equal(inspections,2);assert.equal(paints,2);assert.equal(session.getState().state,'ready');await session.close();assert.equal(session.resources.totalBytes,0);});
test('final shared evidence removal or downgrade prevents publication and leaves no ROI/frame',async()=>{for(const fault of ['removed','historical']){const f=await fixture();let reads=0,painted=0;const session=new QualityPairViewSession(()=>painted++,origin,{read:async()=>{const r=structuredClone(f.record);if(++reads===2){if(fault==='removed')r.document.mark.qualityEvidence=[];else r.document.mark.qualityEvidence![0].verification='historical';}return r;},inspect:async()=>structuredClone(f.pair)});await assert.rejects(session.open(reference));assert.equal(painted,0);assert.equal(session.resources.totalBytes,0);assert.equal(session.getState().state,'failed');await session.close();}});

test('rounded display equality never substitutes for exact SPS SAR, including absent evidence',async()=>{
 const f=await fixture(),g={...f.pair.sourceGeometry.reference,sarNum:1000,sarDen:1001};
 assert.equal(Math.round(g.width*g.sarNum/g.sarDen),g.width);
 requirePairViewGeometry(f.description);assert.throws(()=>requireInspectionGeometry({...g,sarNum:1,sarDen:1,sarSpecified:false}),/exact SPS SAR/);assert.throws(()=>requireInspectionGeometry({...g,sarNum:1,sarDen:1,sarSpecified:undefined}),/exact SPS SAR/);assert.throws(()=>requireInspectionGeometry(g),/exact SPS SAR/);
 const pair=structuredClone(f.pair);pair.sourceGeometry.reference=g;assert.throws(()=>verifyInspectedPair(f.evidence,pair),/exact SPS SAR/);
 delete (pair as Partial<typeof pair>).sourceGeometry;assert.throws(()=>verifyInspectedPair(f.evidence,pair),/exact SPS SAR/);
});

test('cache digest inspection clearly refuses hosts without secure WebCrypto',async()=>{
 const f=await fixture(),{inspectLibraryEvidence}=await import('../../src/analysis/quality/inspection.ts'),descriptor=Object.getOwnPropertyDescriptor(globalThis,'crypto');
 try{Object.defineProperty(globalThis,'crypto',{value:undefined,configurable:true});await assert.rejects(inspectLibraryEvidence(f.evidence,origin,new AbortController().signal),/requires HTTPS or localhost/);}
 finally{if(descriptor)Object.defineProperty(globalThis,'crypto',descriptor);else Reflect.deleteProperty(globalThis,'crypto');}
});

test('block selection is a read-only view of the same bound snapshots and clears on new open/cancel',async()=>{
 const f=await fixture(true);let paints=0,inspections=0,reads=0;
 const session=new QualityPairViewSession((_s,frame)=>frame.presentedCommit=++paints,origin,{read:async()=>{reads++;return structuredClone(f.record);},inspect:async()=>{inspections++;return structuredClone(f.pair);}});
 assert.throws(()=>session.selectBlock(0),/not ready/);await session.open(reference);const before=session.getState();
 session.selectBlock(3);assert.equal(session.getState().selectedBlock,3);assert.deepEqual(session.getState().presented,before.presented);assert.equal(paints,2);assert.equal(inspections,1);assert.equal(reads,2);
 for(const index of [-1,4,1.5,NaN])assert.throws(()=>session.selectBlock(index));assert.equal(session.getState().selectedBlock,3);
 session.selectBlock(null);assert.equal(session.getState().selectedBlock,undefined);session.selectBlock(1);await session.open(reference);assert.equal(session.getState().selectedBlock,undefined);
 session.selectBlock(2);session.cancel();assert.equal(session.getState().selectedBlock,undefined);assert.equal(session.resources.totalBytes,0);assert.throws(()=>session.selectBlock(0),/not ready/);await session.close();
});

test('forged spatial evidence never reaches inspection or presentation',async()=>{
 const f=await fixture(true);f.record.document.mark.qualityEvidence![0].value.result.metric.spatial!.blocks[0].roi.x++;
 let inspected=0;const session=new QualityPairViewSession(()=>assert.fail('forged block painted'),origin,{read:async()=>f.record,inspect:async()=>{inspected++;return f.pair;}});
 await assert.rejects(session.open(reference),/spatial.evidence/);assert.equal(inspected,0);assert.equal(session.resources.totalBytes,0);await session.close();
});

test('older immutable results without recorded annotation clocks cannot invent candidate timing',async()=>{
 const {applyAnnotationOperation}=await import('../../shared/review/annotation-command.ts');const f=await fixture();delete f.evidence.value.annotationContext;
 assert.throws(()=>applyAnnotationOperation({id:'candidate-old',operationId:'candidate-old',revision:0,action:'create-quality-candidate',candidate:{text:'Explicit request',severity:2},evidence:f.evidence.ref},null,{id:'owner',name:'Owner'},new Date().toISOString(),f.evidence),error=>(error as any).code==='annotation-context-unavailable');
});
