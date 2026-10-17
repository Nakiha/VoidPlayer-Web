import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import ts from 'typescript-ast';

// Worker URL edges are explicit roots. Traverse relative runtime imports,
// re-exports and literal dynamic imports; type-only and package edges are excluded.
// Computed imports/require and arbitrary new Worker URLs are outside this check.
export const MEDIA_ROOTS = ['src/media/source.ts', 'src/presentation/presenter.ts', 'src/media/decoding/ffmpeg-worker.ts', 'src/media/decoding/packet-worker.ts', 'src/thumbnails/pixel-worker.ts'];

export function checkMediaTranslationBoundary(root) {
  const visited = new Set();
  function scan(file) {
    const label = relative(root, file).replaceAll('\\', '/');
    assert.ok(!label.startsWith('src/i18n'), `Translation dependency in media graph: ${label}`);
    assert.ok(existsSync(file), `Missing media dependency: ${label}`);
    if (visited.has(file)) return;
    visited.add(file);
    const code = readFileSync(file, 'utf8');
    const tree = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true);
    function edge(specifier) {
      if (specifier && ts.isStringLiteral(specifier) && specifier.text.startsWith('.')) scan(join(dirname(file), specifier.text));
    }
    function visit(node) {
      if (ts.isImportDeclaration(node)) {
        const clause = node.importClause;
        const bindings = clause?.namedBindings;
        const onlyTypes = clause?.isTypeOnly || (!clause?.name && bindings && ts.isNamedImports(bindings)
          && bindings.elements.length > 0 && bindings.elements.every(element => element.isTypeOnly));
        if (!onlyTypes) edge(node.moduleSpecifier);
      } else if (ts.isExportDeclaration(node)) {
        const onlyTypes = node.isTypeOnly || (node.exportClause && ts.isNamedExports(node.exportClause)
          && node.exportClause.elements.length > 0 && node.exportClause.elements.every(element => element.isTypeOnly));
        if (!onlyTypes) edge(node.moduleSpecifier);
      } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        edge(node.arguments[0]);
      }
      ts.forEachChild(node, visit);
    }
    visit(tree);
  }
  for (const file of MEDIA_ROOTS) assert.ok(existsSync(join(root, file)), `Missing required media root: ${file}`);
  for (const file of MEDIA_ROOTS) scan(join(root, file));
}
