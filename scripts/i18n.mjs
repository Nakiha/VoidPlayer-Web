import ts from 'typescript-ast';
import MessageFormat from '@messageformat/core';
import compileModule from '@messageformat/core/compile-module.js';
import { parse } from '@messageformat/parser';
import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, relative } from 'node:path';
// Catalogs and scope paths are portable Git paths, regardless of host separators.
export const portablePath = path => path.replaceAll('\\', '/');
const sourcePath = (root, file) => portablePath(relative(root, file));
import { fileURLToPath } from 'node:url';
export function parameters(source) {
  const result = {};
  function walk(tokens) { for (const token of tokens) {
    if (['argument','function','plural','selectordinal','select'].includes(token.type)) {
      const type = ['plural','selectordinal'].includes(token.type) || (token.type === 'function' && token.key === 'number') ? 'number' : 'string | number';
      if (result[token.arg] && result[token.arg] !== type) throw new Error(`Conflicting parameter type: ${token.arg}`);
      result[token.arg] = type;
    }
    for (const c of token.cases ?? []) walk(c.tokens);
  } } walk(parse(source)); return Object.fromEntries(Object.entries(result).sort());
}
export function extract(root) {
  const messages = {};
  function scan(dir) { for (const entry of readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))) {
    const file=resolve(dir,entry.name); if(entry.isDirectory()){if(entry.name !== 'generated')scan(file);continue;} if(!file.endsWith('.ts'))continue;
    const source=readFileSync(file,'utf8'); const tree=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true);
    function visit(node){
      if(ts.isCallExpression(node)&&ts.isIdentifier(node.expression)&&node.expression.text==='msg'){
        const [id,text]=node.arguments;
        if(!id||!text||!ts.isStringLiteral(id)||!ts.isStringLiteral(text))throw new Error(`Descriptor must use literal id and source: ${sourcePath(root,file)}`);
        const params=parameters(text.text);
        if(messages[id.text]&&messages[id.text].source!==text.text)throw new Error(`Conflicting message ID: ${id.text}`);
        const message=messages[id.text]??={source:text.text,params,locations:[]};
        message.locations.push(`${sourcePath(root,file)}:${tree.getLineAndCharacterOfPosition(node.getStart()).line+1}`);
      }ts.forEachChild(node,visit);
    } visit(tree);
  }}scan(resolve(root,'src'));return Object.fromEntries(Object.entries(messages).sort());
}
export function validate(messages,catalog) {
  for(const [id,message]of Object.entries(messages)){
    const entry=catalog[id];if(!entry?.translation)throw new Error(`Missing English translation: ${id}`);
    if(entry.needsReview || entry.source!==message.source)throw new Error(`Stale translation: ${id}; review translation and update source`);
    if(JSON.stringify(parameters(entry.translation))!==JSON.stringify(message.params))throw new Error(`Translation parameters differ: ${id}`);
    new MessageFormat('en').compile(entry.translation);new MessageFormat('zh').compile(message.source);
  }
  for(const id of Object.keys(catalog))if(!messages[id])throw new Error(`Unknown catalog ID: ${id}`);
}
export function validateScope(root) {
  const scope = JSON.parse(readFileSync(resolve(root,'locales/scope.json'),'utf8'));
  function classified(directory) {
    for(const entry of readdirSync(directory,{withFileTypes:true})) {
      const file=resolve(directory,entry.name);
      if(entry.isDirectory())classified(file);
      else if(file.endsWith('.ts')&&!scope.files.includes(sourcePath(root,file)))throw new Error(`Unclassified UI file: ${sourcePath(root,file)}; add it to scope.json`);
    }
  }
  if(existsSync(resolve(root,'src/ui')))classified(resolve(root,'src/ui'));
  const used = new Set();
  for (const file of scope.files) {
    const tree = ts.createSourceFile(file,readFileSync(resolve(root,file),'utf8'),ts.ScriptTarget.Latest,true);
    function visit(node) {
      if (ts.isCallExpression(node) && node.expression.getText(tree) === 'msg') return;
      if ((ts.isStringLiteral(node) || ts.isTemplateLiteralToken(node)) && /[\u4e00-\u9fff]/.test(node.text)) {
        let parent=node.parent, diagnostic=false;
        while(parent) {
          if(ts.isCallExpression(parent) && /(?:log|scoped)\b.*\.(?:info|warn|error|debug)$/.test(parent.expression.getText(tree)))diagnostic=true;
          parent=parent.parent;
        }
        if(!diagnostic) {
          const index=scope.exceptions.findIndex(e=>e.file===file && e.literal===node.text);
          if(index<0)throw new Error(`Unextracted scoped copy: ${file}:${tree.getLineAndCharacterOfPosition(node.getStart()).line+1}: ${node.text}`);
          used.add(index);
        }
      }
      ts.forEachChild(node,visit);
    }
    visit(tree);
  }
  scope.exceptions.forEach((e,i)=>{if(!used.has(i))throw new Error(`Unused scope exception: ${e.file}: ${e.literal}`);});
}
// Pseudo text expands only literal tokens; placeholders and ICU selection syntax survive.
export function pseudo(source) {
  let out=''; const ast=parse(source);
  function emit(tokens){return tokens.map(t=>t.type==='content'?t.value.replace(/[A-Za-z]/g,c=>c+'~') :t.type==='argument'?`{${t.arg}}`:t.type==='octothorpe'?'#':t.cases?`{${t.arg}, ${t.type}, ${t.cases.map(c=>`${c.key}{${emit(c.tokens)}}`).join(' ')}}`:`{${t.arg}, ${t.key}${t.param?', '+emit(t.param):''}}`).join('');}
  out=emit(ast);return `［${out} ········］`;
}
export function generate(root,mode='check') {
  const messages=extract(root);const location=resolve(root,'locales/en.json');const catalog=JSON.parse(readFileSync(location,'utf8'));
  if(mode==='extract'){
    const next={};for(const [id,m]of Object.entries(messages)){next[id]=catalog[id]??{source:m.source,translation:'',needsReview:true};if(next[id].source!==m.source)next[id].needsReview=true;}
    writeFileSync(location,JSON.stringify(next,null,2)+'\n');
    mkdirSync(resolve(root,'locales'),{recursive:true});writeFileSync(resolve(root,'locales/messages.json'),JSON.stringify(messages,null,2)+'\n');return;
  }
  validate(messages,catalog);
  validateScope(root);
  const inventory=JSON.stringify(messages,null,2)+'\n';
  if(mode==='check' && readFileSync(resolve(root,'locales/messages.json'),'utf8')!==inventory)throw new Error('Outdated message inventory; run npm run i18n:extract');
  const types='// Generated by scripts/i18n.mjs. Do not edit.\nexport interface Sources {\n'+Object.entries(messages).map(([id,m])=>`  ${JSON.stringify(id)}: ${JSON.stringify(m.source)};`).join('\n')+'\n}\nexport interface MessageParameters {\n'+Object.entries(messages).map(([id,m])=>`  ${JSON.stringify(id)}: { ${Object.entries(m.params).map(([n,t])=>`${JSON.stringify(n)}: ${t}`).join('; ')} };`).join('\n')+'\n}\n';
  const outputs={'types.ts':types};
  for(const locale of ['zh-CN','en','pseudo']){
    const entries=Object.fromEntries(Object.entries(messages).map(([id,m])=>[id,locale==='zh-CN'?m.source:locale==='en'?catalog[id].translation:pseudo(catalog[id].translation)]));
    outputs[locale+'.js']='// Generated by scripts/i18n.mjs. Do not edit.\n'+compileModule(new MessageFormat(locale==='zh-CN'?'zh':'en'),entries)+'\n';
    outputs[locale+'.d.ts']='declare const catalog: Partial<Record<import("./types.ts").Sources extends infer S ? keyof S : never, (values?: Record<string, string | number>) => string>>;\nexport default catalog;\n';
  }
  mkdirSync(resolve(root,'src/i18n/generated'),{recursive:true});
  for(const [file,content]of Object.entries(outputs)){
    const target=resolve(root,'src/i18n/generated',file);if(mode==='compile')writeFileSync(target,content);else if(readFileSync(target,'utf8')!==content)throw new Error(`Outdated generated file: ${file}; run npm run i18n:compile`);
  }
  return messages;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const messages=generate(process.cwd(),process.argv[2]??'check');console.log(`i18n ${process.argv[2]??'check'}: ${Object.keys(messages??extract(process.cwd())).length} messages`);
}
