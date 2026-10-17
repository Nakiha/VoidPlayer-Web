import {execFileSync,spawnSync} from 'node:child_process';
import {buildFingerprint} from '../../scripts/testing/build.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { checkModuleBoundaries, moduleEdges } from '../../scripts/testing/module-boundaries.mjs';
const root = path.resolve(import.meta.dirname, '../..');
test('production modules respect host boundaries and resolve their relative imports and Worker URLs', () => checkModuleBoundaries(root));
test('vendor directory URLs retain asset resolution without installed binaries', () => {
  const manifest=JSON.parse(readFileSync(path.join(root,'scripts/testing/manifest.json'),'utf8'));
  const folders=new Set(['core','analysis-core'].flatMap(name=>manifest.fixtures[name].paths.map(file=>path.dirname(path.join(root,file)))));
  function check(directory) {
    for(const entry of readdirSync(directory,{withFileTypes:true})) {
      const file=path.join(directory,entry.name);
      if(entry.isDirectory()) check(file);
      else if(/\.(?:ts|mjs|js)$/.test(file)) for(const edge of moduleEdges(readFileSync(file,'utf8'),file)) {
        if(edge.kind!=='url'||!edge.specifier?.startsWith('.')) continue;
        const target=path.resolve(path.dirname(file),edge.specifier);
        if(folders.has(target)) assert.equal(new URL('probe.asset',new URL(edge.specifier,pathToFileURL(file))).href,pathToFileURL(path.join(target,'probe.asset')).href,`${path.relative(root,file)}: vendor directory URL changes the asset base`);
      }
    }
  }
  for(const directory of ['src','server','shared','scripts','test']) check(path.join(root,directory));
});
test('module dependencies include types, re-exports, literal loads and Worker URLs', () => {
  assert.deepEqual(moduleEdges(`import type {A} from './a.ts'; export {b} from './b.ts'; type C=import('./c.ts').C; import('./d.ts'); require('./e.ts'); new Worker(new URL('./worker.ts',import.meta.url));`, 'probe.ts').map(e=>e.specifier), ['./a.ts','./b.ts','./c.ts','./d.ts','./e.ts','./worker.ts']);
});
function project(files, run) {
  const root=mkdtempSync(path.join(os.tmpdir(),'vp-boundaries-'));
  try {for(const [file,code]of Object.entries(files)){mkdirSync(path.dirname(path.join(root,file)),{recursive:true});writeFileSync(path.join(root,file),code);}return run(root);}finally{rmSync(root,{recursive:true,force:true});}
}
for (const syntax of ["import './bad.ts'", "export * from './bad.ts'", "type A=import('./bad.ts').A", "import('./bad.ts')", "new Worker(new URL('./bad.ts',import.meta.url))"]) {
  test(`forbids shared host dependencies: ${syntax}`, () => project({'shared/a.ts':syntax,'shared/bad.ts':"export * from '../src/ui.ts'",'src/ui.ts':'export const A=1'}, root=>assert.throws(()=>checkModuleBoundaries(root),/shared code imports host/)));
}
test('server cannot introduce a UI dependency, including type-only dependencies',()=>project({'server/a.ts':"import type {A} from '../src/ui.ts'",'src/ui.ts':'export interface A{}'},root=>assert.throws(()=>checkModuleBoundaries(root),/server imports frontend/)));
test('frontend cannot import Node host implementation',()=>project({'src/a.ts':"import '../server/a.ts'",'server/a.ts':''},root=>assert.throws(()=>checkModuleBoundaries(root),/frontend imports server/)));
test('missing Worker entries fail closed',()=>project({'src/a.ts':"new Worker(new URL('./missing.ts',import.meta.url))"},root=>assert.throws(()=>checkModuleBoundaries(root),/missing url dependency/)));
test('shared Node dependencies fail closed',()=>project({'shared/a.ts':"import fs from 'node:fs'"},root=>assert.throws(()=>checkModuleBoundaries(root),/shared code imports host package/)));

test('shared code rejects computed loads and browser packages',()=>{
  for(const code of ["import(modulePath)","require(modulePath)","import 'react-dom'"])
    project({'shared/a.ts':code},root=>assert.throws(()=>checkModuleBoundaries(root),/computed module load|host package/));
});
test('shared sources compile without a DOM type environment',()=>{
  execFileSync(process.execPath,[path.join(root,'node_modules/typescript/bin/tsc'),'-p',path.join(root,'tsconfig.shared.json')],{cwd:root,stdio:'pipe'});
  project({'shared/bad.ts':'export const x = [window, document, indexedDB, VideoFrame];'},temp=>{
    writeFileSync(path.join(temp,'tsconfig.json'),JSON.stringify({compilerOptions:{target:'ES2023',module:'ESNext',moduleResolution:'bundler',lib:['ES2023'],types:['node'],typeRoots:[path.join(root,'node_modules/@types')],strict:true,noEmit:true,skipLibCheck:true},include:['shared']}));
    const result=spawnSync(process.execPath,[path.join(root,'node_modules/typescript/bin/tsc'),'-p',path.join(temp,'tsconfig.json')],{encoding:'utf8'});
    assert.equal(result.status,1);for(const name of ['window','document','indexedDB','VideoFrame'])assert.match(result.stdout,new RegExp(`Cannot find name '${name}'`));
  });
});
test('shared edits invalidate prepared frontend builds',async()=>{
  const temp=mkdtempSync(path.join(os.tmpdir(),'vp-shared-build-'));
  try{mkdirSync(path.join(temp,'shared'));writeFileSync(path.join(temp,'shared/value.ts'),'export const value=1;');const before=await buildFingerprint(temp);writeFileSync(path.join(temp,'shared/value.ts'),'export const value=2;');assert.notEqual(await buildFingerprint(temp),before);}finally{rmSync(temp,{recursive:true,force:true});}
});

test('frontend root stays limited to application entrypoints',()=>project({'src/new-helper.ts':'export const x=1;'},root=>assert.throws(()=>checkModuleBoundaries(root),/unowned frontend root module/)));
test('analysis modules declare metadata or bitstream responsibility in every layer',()=>{
  for(const layer of ['src','shared','server']) project({[`${layer}/analysis/another-name.ts`]:'export const x=1;'},root=>assert.throws(()=>checkModuleBoundaries(root),/analysis must declare/));
});

test('embedded Bun Worker addresses resolve from the compiled server root',()=>{
 const scheduler="new Worker(new URL(typeof VOIDPLAYER_COMPILED !== 'undefined' && VOIDPLAYER_COMPILED ? './analysis/worker.ts' : './worker.ts',import.meta.url));";
 project({'server/analysis/bitstream/scheduler.ts':scheduler,'server/analysis/bitstream/worker.ts':'export {};'},root=>assert.throws(()=>checkModuleBoundaries(root),/missing compiled-url dependency/));
 project({'server/analysis/bitstream/scheduler.ts':scheduler.replace('./analysis/worker.ts','./analysis/bitstream/worker.ts'),'server/analysis/bitstream/worker.ts':'export {};'},root=>assert.equal(checkModuleBoundaries(root).edges.filter(e=>e.to==='server/analysis/bitstream/worker.ts').length,2));
});
