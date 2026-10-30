import type {ProductIndexIdentity} from './products.ts';
import { BUDGET, pictureId } from './contract.ts';
import type { AnalysisResult, ReadonlyAnalysisResult, SourcePictureKey } from './contract.ts';
import { OwnedBlocks, isProduct, productKey, validateOutput } from './products.ts';
import type { AnalysisBlocks } from './products.ts';
/** Exact blocks have a private packed owner; summaries live only in DiagramStore. */
export class AnalysisCache {
  private entries = new Map<string, { owner: OwnedBlocks; view: ReadonlyAnalysisResult; bytes: number; key: string }>();
  private bytes = 0;
  get(picture: SourcePictureKey) { const entry = this.entry(picture); return entry ? entry.owner.legacy() : null; }
  getProduct(picture: SourcePictureKey, buildId: string, indexIdentity: ProductIndexIdentity | null) {
    const entry = this.entry(picture);
    return entry?.key === productKey(picture,buildId,indexIdentity,'blocks') ? entry.owner.copy() : null;
  }
  getMatching(picture:SourcePictureKey,buildId:string,indexIdentity:ProductIndexIdentity|null) { const entry=this.entry(picture);return entry?.key===productKey(picture,buildId,indexIdentity,'blocks')?entry.owner.legacy():null; }
  private entry(picture: SourcePictureKey) {
    const id = pictureId(picture), entry = this.entries.get(id);
    if (entry) { this.entries.delete(id); this.entries.set(id,entry); }
    return entry;
  }
  peek(picture: SourcePictureKey): ReadonlyAnalysisResult | null { return this.entry(picture)?.view ?? null; }
  put(value: AnalysisResult | AnalysisBlocks,indexIdentity:ProductIndexIdentity|null=null) {
    if(value.confidence!=='exact'){validateOutput(value);return;}
    const owner=isProduct(value)?new OwnedBlocks(value):OwnedBlocks.fromLegacy(value,indexIdentity), count=isProduct(value)?value.validatedBlockCount:value.blocks.length, bytes=owner.byteLength+count*8;
    if (bytes > BUDGET.resultBytes) throw new Error('Analysis cache result budget exceeded');
    const id = pictureId(value.picture), old = this.entries.get(id);
    if (old) this.bytes -= old.bytes; this.entries.delete(id);
    while (this.bytes + bytes > BUDGET.cacheBytes && this.entries.size) { const [key, entry] = this.entries.entries().next().value!; this.entries.delete(key); this.bytes -= entry.bytes; }
    this.entries.set(id,{owner,view:owner.view(),bytes,key:productKey(value.picture,value.buildId,isProduct(value)?value.indexIdentity:indexIdentity,'blocks')}); this.bytes += bytes;
  }
  *readablePictures(source:string,buildId:string,indexIdentity:ProductIndexIdentity|null) {for(const entry of this.entries.values())if(entry.view.picture.sourceVersion===source&&entry.key===productKey(entry.view.picture,buildId,indexIdentity,'blocks'))yield {picture:structuredClone(entry.view.picture),sourcePtsUs:entry.view.sourcePtsUs};}
  invalidateSource(source:string) { for(const [id,entry] of this.entries)if(entry.view.picture.sourceVersion===source){this.bytes-=entry.bytes;this.entries.delete(id);} }
  peekProduct(picture:SourcePictureKey,buildId:string,indexIdentity:ProductIndexIdentity|null) { const entry=this.entry(picture);return entry?.key===productKey(picture,buildId,indexIdentity,'blocks')?entry.view:null; }
  clear() { this.entries.clear(); this.bytes = 0; }
  get sizeBytes() { return this.bytes; }
}
