import ts from 'typescript-ast';
/** Vite-only lowering: source defaults remain in TS but never duplicate the compiled catalog in browser chunks. */
export function lowerDescriptors(code,id) {
  if(!id.endsWith('.ts')||!code.includes('msg(')||!code.includes('i18n.ts'))return;
  const tree=ts.createSourceFile(id,code,ts.ScriptTarget.Latest,true),edits=[];
  function visit(node) {
    if(ts.isCallExpression(node)&&ts.isIdentifier(node.expression)&&node.expression.text==='msg') {
      const [key,source]=node.arguments;
      if(!ts.isStringLiteral(key)||!ts.isStringLiteral(source))throw new Error(`Non-literal descriptor in ${id}`);
      edits.push([node.getStart(tree),node.end,JSON.stringify(key.text)]);return;
    }ts.forEachChild(node,visit);
  }visit(tree);
  for(const [start,end,value]of edits.reverse())code=code.slice(0,start)+value+code.slice(end);
  return edits.length?{code,map:null}:undefined;
}
