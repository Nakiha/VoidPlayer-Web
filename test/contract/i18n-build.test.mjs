import assert from 'node:assert/strict';import test from 'node:test';import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,existsSync,readdirSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import ts from 'typescript-ast';
import {extract,validate,parameters,pseudo,generate,validateScope,portablePath} from '../../scripts/i18n.mjs';
import {lowerDescriptors} from '../../scripts/testing/i18n-transform.mjs';
const root=join(import.meta.dirname,'../..');
test('ICU validation rejects stale/missing translations, malformed syntax, wrong parameters and conflicting IDs',()=>{
 const m={count:{source:'{count, plural, other {# 项}}',params:{count:'number'}}};
 const good={count:{source:m.count.source,translation:'{count, plural, one {One} other {# items}}'}};validate(m,good);
 assert.throws(()=>validate(m,{}),/Missing/);assert.throws(()=>validate(m,{count:{...good.count,needsReview:true}}),/Stale/);assert.throws(()=>validate(m,{count:{...good.count,source:'changed'}}),/Stale/);
 assert.throws(()=>validate(m,{count:{...good.count,translation:'{wrong}'}}),/parameters/);assert.throws(()=>parameters('{count, plural, one {X}'),/syntax|Unexpected|invalid/i);
 const temp=mkdtempSync(join(tmpdir(),'vp-i18n-'));try{mkdirSync(join(temp,'src'));writeFileSync(join(temp,'src/a.ts'),"msg('duplicate','原文'); msg('duplicate','different');");assert.throws(()=>extract(temp),/Conflicting message ID/);}finally{rmSync(temp,{recursive:true});}
 assert.deepEqual(parameters(pseudo('{count, plural, one {One {name}} other {# {name}}}')),{count:'number',name:'string | number'});
});
test('catalog paths normalize Windows separators and keep nested source locations portable',()=>{
 assert.equal(portablePath('src\\ui\\analysis-canvas.ts'),'src/ui/analysis-canvas.ts');
 const inventory=extract(root);for(const message of Object.values(inventory))for(const location of message.locations)assert.ok(!location.includes('\\'),location);
});

test('generated catalogs are deterministic and browser lowering removes defaults without a runtime ICU parser',()=>{
 const before=readFileSync(join(root,'src/i18n/generated/en.js'),'utf8');generate(root,'check');assert.equal(readFileSync(join(root,'src/i18n/generated/en.js'),'utf8'),before);
 const lowered=lowerDescriptors("import {msg} from './i18n.ts';const x=msg('semantic.id','源码默认文案');",'/src/ui/example.ts');assert.ok(lowered.code.includes('"semantic.id"'));assert.ok(!lowered.code.includes('源码默认文案'));
 assert.ok(!before.includes('@messageformat/parser'));assert.ok(!before.includes('@messageformat/core'));
});

test('CRLF checkout artifacts validate against deterministic LF generation',()=>{
 const temp=mkdtempSync(join(tmpdir(),'vp-i18n-crlf-'));try{
  mkdirSync(join(temp,'src'));mkdirSync(join(temp,'locales'));
  writeFileSync(join(temp,'src/ui.ts'),"msg('first','第一行');\nmsg('second','第二行');\n");
  writeFileSync(join(temp,'locales/en.json'),JSON.stringify({first:{source:'第一行',translation:'First'},second:{source:'第二行',translation:'Second'}}));
  writeFileSync(join(temp,'locales/scope.json'),JSON.stringify({files:['src/ui.ts'],exceptions:[]}));
  generate(temp,'extract');generate(temp,'compile');
  for(const file of ['src/ui.ts','locales/messages.json',...readdirSync(join(temp,'src/i18n/generated')).map(name=>'src/i18n/generated/'+name)]){const target=join(temp,file);writeFileSync(target,readFileSync(target,'utf8').replaceAll('\n','\r\n'));}
  assert.ok(readFileSync(join(temp,'locales/messages.json'),'utf8').includes('\r\n'));generate(temp,'check');
  const target=join(temp,'locales/messages.json');writeFileSync(target,readFileSync(target,'utf8').replace('第一行','changed'));assert.throws(()=>generate(temp,'check'),/Outdated message inventory/);
 }finally{rmSync(temp,{recursive:true});}
});

test('scope completeness catches new hardcoded copy and does not mask unused exceptions',()=>{
 const temp=mkdtempSync(join(tmpdir(),'vp-i18n-scope-'));try{
  mkdirSync(join(temp,'src'));mkdirSync(join(temp,'locales'));
  writeFileSync(join(temp,'src/ui.ts'),"button.title='新增遗漏';");
  writeFileSync(join(temp,'locales/scope.json'),JSON.stringify({files:['src/ui.ts'],exceptions:[]}));
  assert.throws(()=>validateScope(temp),/Unextracted scoped copy/);
  writeFileSync(join(temp,'src/ui.ts'),"msg('id','新增文案');log.warn('ui','诊断原文');");validateScope(temp);
  mkdirSync(join(temp,'src/ui'));writeFileSync(join(temp,'src/ui/new.ts'),'export {};');assert.throws(()=>validateScope(temp),/Unclassified UI file/);rmSync(join(temp,'src/ui'),{recursive:true});
  writeFileSync(join(temp,'locales/scope.json'),JSON.stringify({files:['src/ui.ts'],exceptions:[{file:'src/ui.ts',literal:'不存在'}]}));
  assert.throws(()=>validateScope(temp),/Unused scope exception/);
 }finally{rmSync(temp,{recursive:true});}
});

test('translation dependencies do not enter media/worker/presenter graphs or progress callbacks',()=>{
 const visited=new Set();
 function scan(file){
  if(visited.has(file)||!existsSync(file))return;visited.add(file);
  assert.ok(!file.includes('/i18n'),file);
  const code=readFileSync(file,'utf8');
  for(const match of code.matchAll(/import\s+(?!type\b)(?:[^;]*?from\s*)?['"](\.[^'"]+)['"]/g))scan(join(file,'..',match[1]));
 }
 for(const file of ['media.ts','presenter.ts','ffmpeg-worker.ts','packet-worker.ts','thumbnail-worker.ts'])scan(join(root,'src',file));
 for(const file of ['src/main.ts','src/ui/workbench/tracks.ts']){
  const code=readFileSync(join(root,file),'utf8');const tree=ts.createSourceFile(file,code,ts.ScriptTarget.Latest,true);let body;
  function find(node){if(ts.isFunctionDeclaration(node)&&node.name?.text==='renderProgress')body=node.body.getText(tree);ts.forEachChild(node,find);}find(tree);assert.ok(body,file);
  assert.doesNotMatch(body,/\b(?:t|tr|th|msg|formatDate|formatNumber)\(/,file);
 }
});
