import {AnalysisFailure} from './failure.ts';
/** Lexical allocation admission before JSON.parse. JSON.parse still owns syntax
 * validation; this scan bounds nesting, nodes and array members without building
 * a second object graph. Page members are the sole depth-two array. */
export function admitJson(text:string,kind:'header'|'page'|'state'='header'):void {
 const maxNodes=kind==='header'?131072:262144,stack:{array:boolean;commas:number}[]=[];
 let quoted=false,escaped=false,nodes=0;
 for(let i=0;i<text.length;i++){
  const c=text[i];
  if(quoted){if(escaped)escaped=false;else if(c==='\\')escaped=true;else if(c==='"')quoted=false;continue;}
  if(c==='"'){quoted=true;nodes++;}
  else if(c==='{'||c==='['){if(stack.length>=12)throw new AnalysisFailure('resource-limit','Analysis JSON depth budget exceeded');stack.push({array:c==='[',commas:0});nodes++;}
  else if(c==='}'||c===']')stack.pop();
  else if(c===','){const current=stack.at(-1);if(current?.array){current.commas++;const max=kind==='page'&&stack.length===2?32:kind==='state'?8192:4096;if(current.commas>=max)throw new AnalysisFailure('resource-limit','Analysis JSON array budget exceeded');}nodes++;}
  else if(c===':')nodes++;
  if(nodes>maxNodes)throw new AnalysisFailure('resource-limit','Analysis JSON node budget exceeded');
 }
}
export function parseBudgetedJson(text:string,kind:'header'|'page'|'state'='header'):unknown {admitJson(text,kind);return JSON.parse(text);
}
