import assert from 'node:assert/strict';import test from 'node:test';import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,existsSync,readdirSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import ts from 'typescript-ast';
import {checkMediaTranslationBoundary} from '../../scripts/testing/i18n-architecture.mjs';
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

function withCatalogProject(run) {
 const temp=mkdtempSync(join(tmpdir(),'vp-i18n-inventory-'));
 try {
  mkdirSync(join(temp,'src'));mkdirSync(join(temp,'locales'));
  writeFileSync(join(temp,'src/a.ts'),"msg('greeting','你好 {name}');\nmsg('greeting','你好 {name}');\n");
  writeFileSync(join(temp,'locales/en.json'),JSON.stringify({greeting:{source:'你好 {name}',translation:'Hello {name}'}}));
  writeFileSync(join(temp,'locales/scope.json'),JSON.stringify({files:[],exceptions:[]}));
  generate(temp,'extract');generate(temp,'compile');run(temp);
 } finally {rmSync(temp,{recursive:true,force:true});}
}

test('moving descriptors and inserting comments only refresh the ignored location index',()=>withCatalogProject(temp=>{
 const tracked=['locales/messages.json','locales/en.json',...readdirSync(join(temp,'src/i18n/generated')).map(name=>'src/i18n/generated/'+name)];
 const before=tracked.map(file=>readFileSync(join(temp,file),'utf8'));
 const index=join(temp,'.run/i18n/message-locations.json');
 assert.deepEqual(JSON.parse(readFileSync(index,'utf8')).greeting,['src/a.ts:1','src/a.ts:2']);
 assert.deepEqual(JSON.parse(before[0]),{greeting:{source:'你好 {name}',params:{name:'string | number'}}});
 mkdirSync(join(temp,'src/nested'));
 writeFileSync(join(temp,'src/nested/moved.ts'),"// comment\n\n// another comment\n"+readFileSync(join(temp,'src/a.ts'),'utf8'));
 rmSync(join(temp,'src/a.ts'));rmSync(join(temp,'.run'),{recursive:true});
 generate(temp,'check');
 assert.equal(existsSync(join(temp,'.run')),false,'check neither requires nor writes the location index');
 generate(temp,'extract');generate(temp,'compile');generate(temp,'check');
 assert.deepEqual(tracked.map(file=>readFileSync(join(temp,file),'utf8')),before,'committed inventory, translations and compiled bytes remain identical');
 assert.deepEqual(JSON.parse(readFileSync(index,'utf8')).greeting,['src/nested/moved.ts:4','src/nested/moved.ts:5']);
}));

test('stable inventories still reject semantic additions, removals, source changes and parameter drift',()=>{
 const cases=[
  {name:'missing translation',source:"msg('new','新增');",error:/Missing English translation/},
  {name:'stale translation',source:"msg('greeting','您好 {name}');",error:/Stale translation/},
  {name:'new descriptor with translation',source:"msg('greeting','你好 {name}');msg('new','新增');",catalog:{greeting:{source:'你好 {name}',translation:'Hello {name}'},new:{source:'新增',translation:'New'}},error:/Outdated message inventory/},
  {name:'removed descriptor and translation',source:'export {};',catalog:{},error:/Outdated message inventory/},
  {name:'reviewed source change',source:"msg('greeting','您好 {name}');",catalog:{greeting:{source:'您好 {name}',translation:'Hello {name}'}},error:/Outdated message inventory/},
  {name:'reviewed parameter change',source:"msg('greeting','你好 {user}');",catalog:{greeting:{source:'你好 {user}',translation:'Hello {user}'}},error:/Outdated message inventory/},
 ];
 for(const row of cases)withCatalogProject(temp=>{
  writeFileSync(join(temp,'src/a.ts'),row.source);
  if(row.catalog)writeFileSync(join(temp,'locales/en.json'),JSON.stringify(row.catalog));
  assert.throws(()=>generate(temp,'check'),row.error,row.name);
 });
 withCatalogProject(temp=>{
  const file=join(temp,'locales/messages.json'),inventory=JSON.parse(readFileSync(file,'utf8'));
  inventory.greeting.params.name='number';writeFileSync(file,JSON.stringify(inventory,null,2)+'\n');
  assert.throws(()=>generate(temp,'check'),/Outdated message inventory/);
 });
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
 checkMediaTranslationBoundary(root);
 for(const file of ['src/main.ts','src/ui/workbench/tracks.ts']){
  const code=readFileSync(join(root,file),'utf8');const tree=ts.createSourceFile(file,code,ts.ScriptTarget.Latest,true);let body;
  function find(node){if(ts.isFunctionDeclaration(node)&&node.name?.text==='renderProgress')body=node.body.getText(tree);ts.forEachChild(node,find);}find(tree);assert.ok(body,file);
  assert.doesNotMatch(body,/\b(?:t|tr|th|msg|formatDate|formatNumber)\(/,file);
 }
});

test('static certificate emphasis preserves safe shell topology in English and pseudo locales',()=>{
 const source='打开<strong>钥匙串访问</strong>，导入证书。';
 const messages={step:{source,params:{}}};
 const catalog=translation=>({step:{source,translation}});
 validate(messages,catalog('Open <strong>Keychain Access</strong> and import the certificate.'));
 for(const text of ['Open <em>Keychain Access</em>.','<strong onclick="alert(1)">Open</strong>.','Open <strong>Keychain Access</strong><img src=x>.'])assert.throws(()=>validate(messages,catalog(text)),/Invalid static rich/);
 const expanded=pseudo('Open <strong>Keychain Access</strong> and import the certificate.');
 assert.deepEqual(expanded.match(/<[^>]*>/g),['<strong>','</strong>']);assert.ok(expanded.includes('O~p~e~n~'));
});

test('administration scope includes actual recursive modules and connection guide',()=>{
 const scope=JSON.parse(readFileSync(join(root,'locales/scope.json'),'utf8'));
 assert.ok(scope.files.includes('src/connection-guide.ts'));
 for(const file of readdirSync(join(root,'src/admin')).filter(f=>f.endsWith('.ts')))assert.ok(scope.files.includes('src/admin/'+file),file);
 assert.ok(!scope.notCovered.some(e=>e.files?.includes('src/admin.ts')));
 const tree=ts.createSourceFile('measurement.ts',readFileSync(join(root,'src/admin/measurement.ts'),'utf8'),ts.ScriptTarget.Latest,true);
 let body;function visit(n){if(ts.isFunctionDeclaration(n)&&n.name?.text==='runTransfers')body=n.body.getText(tree);ts.forEachChild(n,visit)}visit(tree);
 assert.ok(body);assert.doesNotMatch(body,/\b(?:t|th|msg|formatDate|formatNumber)\(/,'timed transfer path has no translation work');
});

// Exercise the same checker used above against complete temporary graphs.
test('media architecture negative fixtures reject missing roots and thumbnail dependencies',async t=>{
 const temp=mkdtempSync(join(tmpdir(),'vp-media-translation-'));
 const actualRoots=['src/media.ts','src/presenter.ts','src/ffmpeg-worker.ts','src/packet-worker.ts','src/thumbnails/pixel-worker.ts'];
 try{
  mkdirSync(join(temp,'src/thumbnails'),{recursive:true});
  for(const file of actualRoots)writeFileSync(join(temp,file),'export {};');
  await t.test('each mandatory root must exist',()=>{
   checkMediaTranslationBoundary(temp);
   for(const file of actualRoots){
    rmSync(join(temp,file));
    try{assert.throws(()=>checkMediaTranslationBoundary(temp),error=>error.message.includes(file));}
    finally{writeFileSync(join(temp,file),'export {};');}
   }
  });
  writeFileSync(join(temp,'src/i18n.ts'),'export const msg=()=>{};');
  const worker=join(temp,'src/thumbnails/pixel-worker.ts');
  await t.test('thumbnail root rejects imports, re-exports and literal dynamic imports',()=>{
   try{
    for(const code of ["import {msg} from '../i18n.ts';","export {msg} from '../i18n.ts';","void import('../i18n.ts');"]){
     writeFileSync(worker,code);assert.throws(()=>checkMediaTranslationBoundary(temp),/i18n/);
    }
   }finally{writeFileSync(worker,'export {};');}
  });
  await t.test('thumbnail transitive dependency rejects translation imports',()=>{
   writeFileSync(worker,"import {pixels} from './pixels.ts';");
   writeFileSync(join(temp,'src/thumbnails/pixels.ts'),"import {msg} from '../i18n.ts'; export const pixels=msg;");
   try{assert.throws(()=>checkMediaTranslationBoundary(temp),/i18n/);}
   finally{writeFileSync(worker,'export {};');}
  });
  await t.test('type-only imports are outside the runtime graph',()=>{
   writeFileSync(worker,"import type {Message} from '../i18n.ts'; import {type Message2} from '../i18n.ts';");
   checkMediaTranslationBoundary(temp);
  });
 }finally{rmSync(temp,{recursive:true});}
});
