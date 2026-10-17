import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { checkModuleBoundaries, moduleEdges } from '../../scripts/testing/module-boundaries.mjs';
const root = path.resolve(import.meta.dirname, '../..');
test('production modules respect host boundaries and resolve their relative imports and Worker URLs', () => checkModuleBoundaries(root));
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
test('shared Node dependencies fail closed',()=>project({'shared/a.ts':"import fs from 'node:fs'"},root=>assert.throws(()=>checkModuleBoundaries(root),/shared code imports Node/)));
