import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

/** Bind generated capability evidence to the exact packaged WASM bytes. At
 * preparation time a live module independently verifies the recorded registry. */
export async function verifyCoreCapabilities(directory,lock,product,suffix='',core){
 const stem=product==='analysis'?'voidplayer-analysis':`voidplayer-core${suffix}`;
 const capability=JSON.parse(await readFile(path.join(directory,`capabilities${suffix}.json`),'utf8'));
 const binary=await readFile(path.join(directory,stem+'.wasm'));
 assert.equal(lock.capabilityAbi,1);assert.equal(lock.demuxAbi,0);
 assert.equal(capability.schema,1);assert.equal(capability.abi,1);assert.equal(capability.product,product);
 assert.equal(capability.variant,suffix?'pthreads':'single');assert.equal(capability.revision,lock.revision);
 assert.equal(capability.wasmSha256,createHash('sha256').update(binary).digest('hex'));
 const normalized=capability.registeredDemuxers.map(name=>name.split(',')[0]==='mpeg'?'mpegps':name.split(',')[0]).sort();
 assert.deepEqual(normalized,lock.demuxers.slice().sort());assert.deepEqual(capability.declaredDemuxers,lock.demuxers.slice().sort());
 assert.deepEqual(capability.independentDemuxExports,[]);
 assert.deepEqual(capability.libraries,product==='analysis'?['avcodec','avutil']:['avformat','avcodec','swscale','avutil','dav1d']);
 if(product==='analysis')assert.deepEqual(capability.containerEntries,[]);
 if(lock.packetIdentityAbi!==undefined){assert.equal(lock.packetIdentityAbi,1);assert.equal(capability.packetIdentityAbi,lock.packetIdentityAbi);}
 if(core){
  if(lock.packetIdentityAbi===1){assert.equal(core._vp_packet_identity_abi(),1);for(const name of ['_vp_packet_open_identity','_vp_packet_send_identity','_vp_packet_identity_info'])assert.equal(typeof core[name],'function');}
  const string=pointer=>{assert.ok(Number.isInteger(pointer)&&pointer>0&&pointer<core.HEAPU8.length);const end=core.HEAPU8.indexOf(0,pointer);assert.ok(end>=pointer&&end-pointer<=1024);return new TextDecoder().decode(core.HEAPU8.subarray(pointer,end));};
  assert.equal(core._vp_capability_abi(),1);assert.equal(string(core._vp_build_id()),lock.revision);
  const registry=kind=>{const count=core[`_vp_${kind}_count`]();assert.ok(Number.isInteger(count)&&count>=0&&count<=1024);
   return Array.from({length:count},(_,i)=>string(core[`_vp_${kind}_name`](i))).sort();};
  assert.deepEqual(registry('demuxer'),capability.registeredDemuxers);assert.deepEqual(registry('decoder'),capability.registeredDecoders);
  assert.deepEqual(Object.keys(core).filter(name=>name.startsWith('_vpd_')),[]);
  if(product==='analysis')for(const name of ['_vp_open','_vp_open_blob','_vp_open_range'])assert.equal(typeof core[name],'undefined');
 }
 return capability;
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){
 const [directory,lockFile,product,suffix='']=process.argv.slice(2),lock=JSON.parse(await readFile(lockFile,'utf8'));
 const stem=product==='analysis'?'voidplayer-analysis':`voidplayer-core${suffix}`,create=(await import(pathToFileURL(path.resolve(directory,stem+'.js')).href)).default;
 const core=await create({wasmBinary:await readFile(path.join(directory,stem+'.wasm'))});await verifyCoreCapabilities(directory,lock,product,suffix,core);
 process.exit(0); // This probe owns any pthread pool it creates.
}
