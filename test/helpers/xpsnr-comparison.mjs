import assert from 'node:assert/strict';
import {writeFile,readFile,copyFile} from 'node:fs/promises';
import path from 'node:path';
import {xpsnrFixture,until} from './native-xpsnr.mjs';
import {waitForAnnotationMedia} from '../../scripts/testing/agent-annotations-ready.mjs';

/** Four real fixed public encodings, one pinned reference, eight presentation
 * frames. Includes identical pixels (infinity) and requested/not-requested SSIM. */
export async function comparisonFixture(staticDir='public'){
  const f=await xpsnrFixture({depth:8,distorted:true,staticDir});
  try{
    const mp4=JSON.parse(await readFile(new URL('./native-vmaf-mp4-samples.json',import.meta.url),'utf8')).samples.find(s=>s.codec==='hevc'&&s.depth===8);
    const names=['copy-reference.flv','hevc-distorted.mp4','hevc-reference.mp4'];
    await copyFile(path.join(f.media,'reference.flv'),path.join(f.media,names[0]));
    for(const [i,side]of ['distorted','reference'].entries())await writeFile(path.join(f.media,names[i+1]),Buffer.from(mp4[side].mp4,'base64'));
    await f.service.library.refresh();const extras=await waitForAnnotationMedia(f.service.library,names),inputs=[f.input];
    for(const [i,source]of extras.entries()){
      const prep=(await f.json('/api/library/preparations',{source:{id:source.id,version:source.version},operation:'quality-index',client:{id:'comparison-fixture',name:'Fixed comparison fixture'}},'prepare-extra-'+i,{'x-voidplayer-action':'library-preparation'})).job;
      const ready=await until(()=>f.json('/api/library/preparations/'+prep.id),j=>!['queued','running','cancelling'].includes(j.state));assert.equal(ready.state,'completed',JSON.stringify(ready));
      const relation=(await f.json('/api/quality/reference-relations',{schema:'voidplayer-quality-reference-relation',version:1,client:f.input.client,reference:{mediaId:f.entries[0].id,mediaVersion:f.entries[0].version,stream:'video',configuration:0},distorted:{mediaId:source.id,mediaVersion:source.version,stream:'video',configuration:0},declaration:'Fixed public fixture comparison; not content certification',clock:{mode:'piecewise-exact-source-pts-offset',segments:[{id:'same',referenceStartUs:0,referenceEndUs:10000000,offsetUs:0}]}},'relation-extra-'+i)).relation;
      const planInput={...structuredClone(f.planInput),relation:{id:relation.id,revision:1},distortedBuildId:ready.result.binding.indexBuildId};
      const plan=(await f.json('/api/quality/correspondence-plans',planInput,'plan-extra-'+i)).plan;
      const done=await until(()=>f.json('/api/quality/correspondence-plans/'+plan.id),r=>!['queued','running'].includes(r.plan.state));assert.equal(done.plan.state,'completed',JSON.stringify(done));
      inputs.push({...structuredClone(f.input),plan:{id:plan.id,attemptId:done.plan.attemptId,digest:done.plan.resultDigest},metrics:{psnr:true,ssim:i%2===1}});
    }
    const jobs=[],summaries=[];
    for(const [i,input]of inputs.entries()){
      const accepted=(await f.json('/api/quality/xpsnr/jobs',input,'version-'+i)).job,done=await f.wait(accepted.id);assert.equal(done.state,'completed',JSON.stringify(done));jobs.push(done);summaries.push(await f.json(`/api/quality/xpsnr/jobs/${done.id}/result`));
    }
    return {...f,jobs,summaries};
  }catch(e){await f.close();throw e;}
}
