import ts from 'typescript-ast';

function contains(source, predicate) {
  const tree = ts.createSourceFile('contract.mjs', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  function visit(node) {
    return predicate(node) || ts.forEachChild(node, visit);
  }
  return !!visit(tree);
}
export function hasAssignment(source, object, property, value) {
  return contains(
    source,
    (node) =>
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(node.left) &&
      ts.isIdentifier(node.left.expression) &&
      node.left.expression.text === object &&
      node.left.name.text === property &&
      ts.isIdentifier(node.right) &&
      node.right.text === value,
  );
}
export function hasAwaitedCall(source, name, args) {
  return contains(
    source,
    (node) =>
      ts.isAwaitExpression(node) &&
      ts.isCallExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === name &&
      node.expression.arguments.length === args.length &&
      node.expression.arguments.every((arg, index) => ts.isIdentifier(arg) && arg.text === args[index]),
  );
}
