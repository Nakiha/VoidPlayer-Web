import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript-ast';
import { isBuiltin } from 'node:module';

const portable = file => file.replaceAll('\\', '/');
const computedLoaders = new Set(['src/i18n.ts','src/media/decoding/core-loader.ts','src/analysis/bitstream/local-worker.ts','server/frame-index-builder.ts','server/analysis/bitstream/worker.ts','server/analysis/quality/task.ts','server/analysis/vmaf/decode-task.ts','server/analysis/cambi/decode-task.ts','server/analysis/quality/analysis-component.ts']);
const entrypoints = new Set(['bootstrap.ts','agent.ts','build-info.ts','env.d.ts','i18n.ts','main.ts','session.ts']);
const codeFile = file => /\.(?:[cm]?js|[cm]?ts|tsx)$/.test(file);
// Internal protocols have named callers, not directory-wide friendship. This
// applies to type edges and re-exports too, so a facade cannot leak the protocol.
const qualityInternals = new Map([
  ['server/analysis/quality/candidate-publication.ts', ['server/analysis/vmaf/service.ts', 'server/analysis/xpsnr/service.ts']],
  ['server/analysis/quality/prepared-facts.ts', ['server/analysis/vmaf/service.ts', 'server/analysis/xpsnr/service.ts']],
  ['server/analysis/quality/temporal-service.ts', ['server/analysis/vmaf/service.ts', 'server/analysis/xpsnr/service.ts']],
  ['server/analysis/quality/temporal-runner.ts', [
    'server/analysis/quality/temporal-service.ts', 'server/analysis/vmaf/runner.ts', 'server/analysis/vmaf/wasm-runner.ts', 'server/analysis/xpsnr/wasm-runner.ts',
  ]],
  ['server/analysis/quality/result-commands.ts', ['server/quality-application.ts', 'server/quality-service-ports.ts']],
]);
const qualityAdminEntries = new Set(['workspace.ts', 'resources.ts', 'reexecution.ts']);
export function moduleEdges(code, file) {
  const tree = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true), edges = [];
  const add = (node, kind) => { if (node && ts.isStringLiteralLike(node)) edges.push({ specifier: node.text, kind }); else if (kind === 'load') edges.push({specifier:null,kind:'computed-load'}); };
  function visit(node) {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const bindings = ts.isImportDeclaration(node) ? node.importClause?.namedBindings : node.exportClause;
      const namedTypes = (bindings && ts.isNamedImports(bindings)) || (bindings && ts.isNamedExports(bindings));
      const onlyTypes =
        node.importClause?.isTypeOnly ||
        node.isTypeOnly ||
        (namedTypes && bindings.elements.length > 0 && bindings.elements.every((e) => e.isTypeOnly) && !node.importClause?.name);
      add(node.moduleSpecifier, onlyTypes ? 'type' : 'module');
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) add(node.moduleReference.expression, node.isTypeOnly ? 'type' : 'module');
    else if (ts.isImportTypeNode(node)) add(node.argument.literal, 'type');
    else if (
      ts.isCallExpression(node)
      &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
    )
      add(node.arguments[0], 'load');
    else if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'URL' &&
      node.arguments?.[1]?.getText(tree) === 'import.meta.url'
    ) {
      const target = node.arguments[0];
      if (target && ts.isConditionalExpression(target) && target.condition.getText(tree).includes('VOIDPLAYER_COMPILED')) {
        add(target.whenTrue, 'compiled-url');
        add(target.whenFalse, 'url');
      } else add(target, 'url');
    }
    ts.forEachChild(node, visit);
  }
  visit(tree); return edges;
}
/** Types and Worker/asset URLs do not execute in the importing module's realm. */
export function checkRuntimeCycles(edges) {
  const graph = new Map(),
    visiting = new Set(),
    visited = new Set(),
    stack = [];
  for (const { from, to, kind } of edges)
    if (kind === 'module' || kind === 'load') {
      if (!graph.has(from)) graph.set(from, new Set());
      graph.get(from).add(to);
    }
  function visit(file) {
    assert.ok(!visiting.has(file), `Runtime dependency cycle: ${[...stack.slice(stack.indexOf(file)), file].join(' -> ')}`);
    if (visited.has(file)) return;
    visiting.add(file);
    stack.push(file);
    for (const to of graph.get(file) ?? []) visit(to);
    stack.pop();
    visiting.delete(file);
    visited.add(file);
  }
  for (const file of graph.keys()) visit(file);
}
// Shared code uses portable Web APIs present in both supported hosts. WebWorker
// supplies their standard types, but does not grant Worker/browser host globals.
const sharedWebGlobals = new Set([
  'AbortController',
  'AbortSignal',
  'Blob',
  'CompressionStream',
  'DecompressionStream',
  'DOMException',
  'Response',
  'TextDecoder',
  'TextEncoder',
  'URL',
  'URLSearchParams',
  'VideoDecoderConfig',
  'atob',
  'btoa',
  'clearInterval',
  'clearTimeout',
  'crypto',
  'fetch',
  'performance',
  'setInterval',
  'setTimeout',
  'structuredClone',
]);
function checkSharedGlobals(files) {
  if (!files.length) return;
  const program = ts.createProgram(files, {
    target: ts.ScriptTarget.ES2023,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    lib: ['lib.es2023.d.ts', 'lib.webworker.d.ts'],
    types: [],
    allowImportingTsExtensions: true,
    skipLibCheck: true,
  });
  const checker = program.getTypeChecker();
  for (const file of files) {
    const tree = program.getSourceFile(file);
    function visit(node) {
      const indexed = ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression);
      if (ts.isIdentifier(node) || indexed) {
        const name = indexed ? node.argumentExpression.text : node.text;
        const symbol = indexed ? checker.getTypeAtLocation(node.expression).getProperty(name) : checker.getSymbolAtLocation(node);
        const declarations = symbol?.declarations ?? [];
        const global = declarations.some(
          (d) =>
            /lib\.webworker\.d\.ts$/.test(d.getSourceFile().fileName) &&
            (ts.isSourceFile(d.parent) || (ts.isVariableDeclaration(d) && ts.isSourceFile(d.parent?.parent?.parent))),
        );
        assert.ok(!global || sharedWebGlobals.has(name), `${file}: shared code uses host global ${name}`);
      }
      ts.forEachChild(node, visit);
    }
    visit(tree);
  }
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
  const mediaContract = path.join(root, 'src/media/contract.ts');
  if (existsSync(mediaContract)) {
    const tree = ts.createSourceFile(mediaContract, readFileSync(mediaContract, 'utf8'), ts.ScriptTarget.Latest, true);
    for (const statement of tree.statements) {
      assert.ok(
        ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement) ||
        ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement),
        'src/media/contract.ts: browser media contract cannot own runtime state or execution',
      );
      // Node strips declaration-level type imports/exports completely. Inline
      // type specifiers can leave an empty declaration that still loads its module.
      if (ts.isImportDeclaration(statement))
        assert.equal(statement.importClause?.isTypeOnly, true,
          'src/media/contract.ts: browser media contract must use type-only dependencies via whole-declaration import type');
      if (ts.isExportDeclaration(statement))
        assert.equal(statement.isTypeOnly, true,
          'src/media/contract.ts: browser media contract must use type-only dependencies via whole-declaration export type');
    }
  }
  for (const file of files)
    for (const edge of moduleEdges(readFileSync(file, 'utf8'), file)) {
    const from = portable(path.relative(root, file));
    if (from === 'src/media/contract.ts')
      assert.equal(edge.kind, 'type', `${from}: browser media contract must use type-only dependencies`);
    if (edge.specifier === null) { assert.ok(computedLoaders.has(from), `${from}: unregistered computed module load`); continue; }
      if (!edge.specifier.startsWith('.')) {
        if (from.startsWith('src/')) assert.ok(!isBuiltin(edge.specifier), `${from}: browser code imports Node builtin ${edge.specifier}`);
      if (from.startsWith('shared/')) assert.ok(edge.specifier === 'mediabunny', `${from}: shared code imports host package ${edge.specifier}`);
      continue;
      }
    const target = path.resolve(edge.kind === 'compiled-url' ? path.join(root,'server') : path.dirname(file), edge.specifier), to = portable(path.relative(root, target));
    assert.ok(!to.startsWith('../'), `${from}: dependency escapes project: ${to}`);
    assert.ok(existsSync(target), `${from}: missing ${edge.kind} dependency: ${to}`);
    if (from === 'src/media/contract.ts')
      assert.ok(to.startsWith('shared/'), `${from}: browser media contract imports implementation ${to}`);
    if (/^src\/(media|analysis)\//.test(from) && from !== 'src/media/source.ts')
      assert.ok(to !== 'src/media/source.ts', `${from}: media implementation imports opening route ${to}`);
    if (to === 'src/media/source.ts')
      assert.notEqual(edge.kind, 'type', `${from}: media types belong to src/media/contract.ts`);
    if (/^shared\/(media|color)\//.test(from) || from.startsWith('src/media/'))
      assert.ok(!to.startsWith('shared/review/') ||
        (from.startsWith('src/media/') && to !== 'shared/review/model.ts'), `${from}: media/color imports review-owned base contracts ${to}`);
    if (to === 'src/media/policy/fallback-budget.ts')
      assert.ok(from.startsWith('src/media/'), `${from}: fallback input budget belongs to media policy`);
    if (qualityInternals.has(to))
      assert.ok(qualityInternals.get(to).includes(from), `${from}: quality internal capability is private: ${to}`);
    if (to.startsWith('src/admin/quality/') && !from.startsWith('src/admin/quality/'))
      assert.ok(qualityAdminEntries.has(to.slice('src/admin/quality/'.length)), `${from}: quality admin implementation is private: ${to}`);
    if (from === 'server/analysis/vmaf/runner.ts' && to === 'server/analysis/quality/temporal-runner.ts')
      assert.equal(edge.kind, 'type', `${from}: compatibility hooks must remain type-only`);
    if (from === 'shared/analysis/quality/temporal-contract.ts' || from === 'shared/analysis/quality/xpsnr.ts')
      assert.ok(!/^shared\/analysis\/quality\/(vmaf|xpsnr)\.ts$/.test(to), `${from}: temporal facts depend on another metric: ${to}`);
    if (from.startsWith('src/')) assert.ok(!to.startsWith('server/'), `${from}: frontend imports server ${to}`);
    if (from.startsWith('shared/')) assert.ok(!/^(src|server)\//.test(to), `${from}: shared code imports host ${to}`);
    if (from.startsWith('server/') && to.startsWith('src/')) assert.ok(false, `${from}: server imports frontend ${to}`);
      if (/^src\/(media|analysis|session)\//.test(from) || from === 'src/session.ts') {
        assert.ok(
          !/^src\/(ui|admin)\//.test(to) && !/^src\/(main|agent|bootstrap)\.ts$/.test(to),
          `${from}: lower layer imports UI/application entry ${to}`,
        );
      }
      if (/^src\/(media|analysis)\//.test(from)) {
        assert.ok(to !== 'src/session.ts' && !to.startsWith('src/session/'), `${from}: lower layer imports session ${to}`);
        assert.ok(!to.startsWith('src/presentation/'), `${from}: media/analysis imports concrete presentation ${to}`);
      }
    if(from.startsWith('src/services/'))assert.ok(!to.startsWith('src/ui/'),`${from}: service imports UI ${to}`);
    if(['src/media/decoding/packet-media.ts','src/media/decoding/ffmpeg-container-media.ts','src/media/decoding/fallback-runtime.ts'].includes(from))
      assert.ok(!['src/media/decoding/software-media.ts','src/media/decoding/ffmpeg-media.ts'].includes(to),`${from}: concrete decoder imports routing facade ${to}`);
    if(from==='shared/analysis/bitstream/contract.ts'&&edge.kind!=='type')assert.ok(!/shared\/analysis\/bitstream\/(diagrams|products)\.ts$/.test(to),`${from}: analysis contract imports product/display owner ${to}`);
    edges.push({ from, to, kind: edge.kind });
    }
  for (const file of files) {
    const name = portable(path.relative(root, file));
    if (name.startsWith('src/') && !name.slice(4).includes('/')) assert.ok(entrypoints.has(name.slice(4)), `${name}: unowned frontend root module`);
    assert.ok(!/^src\/(bitstream-analysis|analysis-overlay)\//.test(name), `${name}: obsolete analysis namespace`);
    for (const layer of ['shared','src','server']) if (name.startsWith(`${layer}/analysis/`)) {
      const domains = 'metadata|bitstream|quality|vmaf|xpsnr|cambi';
      assert.match(name, new RegExp(`^${layer}/analysis/(${domains})/`), `${name}: analysis must declare ${domains} responsibility`);
    }
  }
  checkRuntimeCycles(edges);
  checkSharedGlobals(files.filter((file) => portable(path.relative(root, file)).startsWith('shared/')));
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
