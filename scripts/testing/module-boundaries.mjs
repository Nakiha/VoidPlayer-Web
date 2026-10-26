import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript-ast';

const portable = file => file.replaceAll('\\', '/');
const computedLoaders = new Set(['src/i18n.ts','src/media/decoding/core-loader.ts','src/analysis/bitstream/local-worker.ts','server/frame-index-builder.ts','server/analysis/bitstream/worker.ts','server/analysis/quality/task.ts','server/analysis/vmaf/decode-task.ts']);
const entrypoints = new Set(['bootstrap.ts','agent.ts','build-info.ts','env.d.ts','i18n.ts','main.ts','session.ts']);
const codeFile = file => /\.(?:[cm]?js|[cm]?ts|tsx)$/.test(file);
export function moduleEdges(code, file) {
  const tree = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true), edges = [];
  const add = (node, kind) => { if (node && ts.isStringLiteralLike(node)) edges.push({ specifier: node.text, kind }); else if (kind === 'load') edges.push({specifier:null,kind:'computed-load'}); };
  function visit(node) {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) add(node.moduleSpecifier, node.importClause?.isTypeOnly || node.isTypeOnly ? 'type' : 'module');
    else if (ts.isImportTypeNode(node)) add(node.argument.literal, 'type');
    else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(node.expression) && node.expression.text === 'require')) add(node.arguments[0], 'load');
    else if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'URL'
      && node.arguments?.[1]?.getText(tree) === 'import.meta.url') {
      const target=node.arguments[0];
      if(target && ts.isConditionalExpression(target) && target.condition.getText(tree).includes('VOIDPLAYER_COMPILED')) { add(target.whenTrue,'compiled-url');add(target.whenFalse,'url'); }
      else add(target,'url');
    }
    ts.forEachChild(node, visit);
  }
  visit(tree); return edges;
}
export function checkModuleBoundaries(root) {
  const files = [], edges = [];
  function scan(directory) {
    if (!existsSync(directory)) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) scan(file);
      else if (codeFile(file)) files.push(file);
    }
  }
  for (const dir of ['src', 'server', 'shared']) scan(path.join(root, dir));
  assert.ok(files.length, 'No production modules found');
  for (const file of files) for (const edge of moduleEdges(readFileSync(file, 'utf8'), file)) {
    const from = portable(path.relative(root, file));
    if (edge.specifier === null) { assert.ok(computedLoaders.has(from), `${from}: unregistered computed module load`); continue; }
    if (!edge.specifier.startsWith('.')) {
      if (from.startsWith('shared/')) assert.ok(edge.specifier === 'mediabunny', `${from}: shared code imports host package ${edge.specifier}`);
      continue;
    }
    const target = path.resolve(edge.kind === 'compiled-url' ? path.join(root,'server') : path.dirname(file), edge.specifier), to = portable(path.relative(root, target));
    assert.ok(!to.startsWith('../'), `${from}: dependency escapes project: ${to}`);
    assert.ok(existsSync(target), `${from}: missing ${edge.kind} dependency: ${to}`);
    if (from.startsWith('src/')) assert.ok(!to.startsWith('server/'), `${from}: frontend imports server ${to}`);
    if (from.startsWith('shared/')) assert.ok(!/^(src|server)\//.test(to), `${from}: shared code imports host ${to}`);
    if (from.startsWith('server/') && to.startsWith('src/')) assert.ok(false, `${from}: server imports frontend ${to}`);
    edges.push({ from, to, kind: edge.kind });
  }
  for (const file of files) {
    const name = portable(path.relative(root, file));
    if (name.startsWith('src/') && !name.slice(4).includes('/')) assert.ok(entrypoints.has(name.slice(4)), `${name}: unowned frontend root module`);
    assert.ok(!/^src\/(bitstream-analysis|analysis-overlay)\//.test(name), `${name}: obsolete analysis namespace`);
    for (const layer of ['shared','src','server']) if (name.startsWith(`${layer}/analysis/`)) {
      const domains = 'metadata|bitstream|quality|vmaf';
      assert.match(name, new RegExp(`^${layer}/analysis/(${domains})/`), `${name}: analysis must declare ${domains} responsibility`);
    }
  }
  const harnessFiles = [];
  function scanHarness(directory) {
    if (!existsSync(directory)) return;
    for (const entry of readdirSync(directory,{withFileTypes:true})) {
      const file=path.join(directory,entry.name);
      if(entry.isDirectory()) scanHarness(file); else if(codeFile(file)) harnessFiles.push(file);
    }
  }
  for(const directory of ['scripts','test']) scanHarness(path.join(root,directory));
  let program, checker, harnessLoads=0;
  for(const file of harnessFiles) {
    const tree=ts.createSourceFile(file,readFileSync(file,'utf8'),ts.ScriptTarget.Latest,true);
    function visit(node) {
      if(ts.isCallExpression(node)&&node.expression.kind===ts.SyntaxKind.ImportKeyword&&ts.isStringLiteralLike(node.arguments[0])&&/^\/(src|shared)\//.test(node.arguments[0].text)) {
        const target=path.resolve(root,'.'+node.arguments[0].text),from=portable(path.relative(root,file));
        assert.ok(target.startsWith(root+path.sep)&&existsSync(target),`${from}: missing browser harness module ${node.arguments[0].text}`);
        harnessLoads++;
        const binding=ts.isAwaitExpression(node.parent)?node.parent.parent:node.parent;
        if(ts.isVariableDeclaration(binding)&&ts.isObjectBindingPattern(binding.name)) {
          program??=ts.createProgram(files,{target:ts.ScriptTarget.ES2023,module:ts.ModuleKind.ESNext,moduleResolution:ts.ModuleResolutionKind.Bundler,allowImportingTsExtensions:true,allowJs:true,checkJs:false,types:[]});
          checker??=program.getTypeChecker();
          const source=program.getSourceFile(target),module=source&&checker.getSymbolAtLocation(source);
          const exports=new Map(module?checker.getExportsOfModule(module).map(symbol=>[symbol.name,symbol]):[]);
          for(const element of binding.name.elements) {
            if(element.dotDotDotToken) continue;
            const name=(element.propertyName??element.name).getText(tree).replace(/^['"]|['"]$/g,''),symbol=exports.get(name);
            const value=symbol?.flags&ts.SymbolFlags.Alias?checker.getAliasedSymbol(symbol):symbol;
            assert.ok(value&&(value.flags&ts.SymbolFlags.Value),`${from}: browser harness import ${node.arguments[0].text} has no runtime export ${name}`);
          }
        }
      }
      ts.forEachChild(node,visit);
    }
    visit(tree);
  }
  return { files: files.length, edges, harnessLoads };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = checkModuleBoundaries(path.resolve(import.meta.dirname, '../..'));
  console.log(`Module boundaries passed: ${result.files} modules, ${result.edges.length} relative dependencies, ${result.harnessLoads} browser harness imports`);
}
