import {readFile,mkdir,cp,writeFile} from 'node:fs/promises';
import {createHash}from'node:crypto';import path from'node:path';import assert from'node:assert/strict';
const root=path.resolve(import.meta.dirname,'..'),source=path.resolve(process.argv[2]),target=path.resolve(process.argv[3]??path.join(root,'public/vendor/voidplayer-analysis'));
const lock=JSON.parse(await readFile(path.join(root,'scripts/release-analysis.json'),'utf8')),manifest=JSON.parse(await readFile(path.join(source,'manifest.json'),'utf8'));
for(const key of ['repository','revision','ffmpegRepository','ffmpegRevision','abi','semanticVersion'])assert.equal(manifest[key],lock[key],`Analysis provenance ${key}`);
assert.ok(manifest.emscripten.includes(` ${lock.emscripten} `),'Analysis toolchain version');
await mkdir(target,{recursive:true});const hashes={};
for(const file of ['voidplayer-analysis.js','voidplayer-analysis.wasm','LICENSE','manifest.json']){const bytes=await readFile(path.join(source,file));hashes[file]=createHash('sha256').update(bytes).digest('hex');if(source!==target)await cp(path.join(source,file),path.join(target,file));}
await writeFile(path.join(target,'provenance.json'),JSON.stringify({schema:'voidplayer-analysis-build',version:1,source:lock,files:hashes},null,2)+'\n');
console.log(`Prepared analysis core ${lock.revision}: ${target}`);
