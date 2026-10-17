import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript-ast';

const portable = file => file.replaceAll('\\', '/');
const codeFile = file => /\.(?:[cm]?js|[cm]?ts|tsx)$/.test(file);
export function moduleEdges(code, file) {
  const tree = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true), edges = [];
  const add = (node, kind) => { if (node && ts.isStringLiteralLike(node)) edges.push({ specifier: node.text, kind }); else if (kind === 'load') edges.push({specifier:null,kind:'computed-load'}); };
  function visit(node) {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) add(node.moduleSpecifier, node.importClause?.isTypeOnly || node.isTypeOnly ? 'type' : 'module');
    else if (ts.isImportTypeNode(node)) add(node.argument.literal, 'type');
    else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(node.expression) && node.expression.text === 'require')) add(node.arguments[0], 'load');
    else if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'URL'
      && node.arguments?.[1]?.getText(tree) === 'import.meta.url') add(node.arguments[0], 'url');
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
    if (edge.specifier === null) { assert.ok(!from.startsWith('shared/'), `${from}: shared code uses a computed module load`); continue; }
    if (!edge.specifier.startsWith('.')) {
      if (from.startsWith('shared/')) assert.ok(edge.specifier === 'mediabunny', `${from}: shared code imports host package ${edge.specifier}`);
      continue;
    }
    const target = path.resolve(path.dirname(file), edge.specifier), to = portable(path.relative(root, target));
    assert.ok(!to.startsWith('../'), `${from}: dependency escapes project: ${to}`);
    assert.ok(existsSync(target), `${from}: missing ${edge.kind} dependency: ${to}`);
    if (from.startsWith('src/')) assert.ok(!to.startsWith('server/'), `${from}: frontend imports server ${to}`);
    if (from.startsWith('shared/')) assert.ok(!/^(src|server)\//.test(to), `${from}: shared code imports host ${to}`);
    if (from.startsWith('server/') && to.startsWith('src/')) assert.ok(false, `${from}: server imports frontend ${to}`);
    edges.push({ from, to, kind: edge.kind });
  }
  return { files: files.length, edges };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = checkModuleBoundaries(path.resolve(import.meta.dirname, '../..'));
  console.log(`Module boundaries passed: ${result.files} modules, ${result.edges.length} relative dependencies`);
}
