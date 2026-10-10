import { BUDGET, pictureId, validateResult } from './contract.ts';
import type { AnalysisResult, SourcePictureKey } from './contract.ts';
/** Session-only local cache. Identity never uses name/size/mtime. */
export class AnalysisCache {
  private entries=new Map<string,{result:AnalysisResult;bytes:number}>();private bytes=0;
  get(key:SourcePictureKey){const id=pictureId(key),entry=this.entries.get(id);if(!entry)return null;this.entries.delete(id);this.entries.set(id,entry);return structuredClone(entry.result);}
  put(result:AnalysisResult){validateResult(result);if(result.confidence!=='exact')return;const bytes=JSON.stringify(result).length*2;if(bytes>BUDGET.resultBytes)throw new Error('Analysis cache result budget exceeded');const id=pictureId(result.picture),old=this.entries.get(id);if(old)this.bytes-=old.bytes;this.entries.delete(id);while(this.bytes+bytes>BUDGET.cacheBytes&&this.entries.size){const [key,value]=this.entries.entries().next().value!;this.entries.delete(key);this.bytes-=value.bytes;}this.entries.set(id,{result:structuredClone(result),bytes});this.bytes+=bytes;}
  clear(){this.entries.clear();this.bytes=0;}
  get sizeBytes(){return this.bytes;}
}
