import {parseBudgetedJson} from './json-budget.ts';
import { ANALYSIS_RECIPE, ANALYZER_VERSION, BUDGET, pictureId, validateMetadata, validateResult } from './contract.ts';
import type { AnalysisBlock, AnalysisResult, SourcePictureKey } from './contract.ts';
import { parseMediaIndexIdentity } from '../../media/indexing/media-index-identity.ts';
import type { MediaIndexIdentity } from '../../media/indexing/media-index-identity.ts';
import { AnalysisFailure } from './failure.ts';

export const MP4_ANALYSIS_INDEX = Object.freeze({kind:'mp4-analysis' as const,streamKey:'video:0',schemaVersion:1,indexerBuild:'mp4-input-v1'});
export type ProductIndexIdentity = MediaIndexIdentity | typeof MP4_ANALYSIS_INDEX;
export const analysisIndexIdentity = (identity?:ProductIndexIdentity|null):ProductIndexIdentity => identity ?? MP4_ANALYSIS_INDEX;
export const PRODUCT_SCHEMA = 2;
export const PRODUCT_LIMIT = Object.freeze({ metadata: 1024 * 1024, page: 1024 * 1024, frame: 3 * 1024 * 1024, inFlight: 32 * 1024 * 1024, pageItems: 32 });
export type FrameMetadata = Omit<AnalysisResult, 'blocks'>;
interface ProductMetadata extends FrameMetadata {
  productSchema: 2;
  indexIdentity: ProductIndexIdentity;
  validatedBlockCount: number;
  encoding: 'summary-json-v1' | 'blocks-le12-v1';
}
export interface AnalysisSummary extends ProductMetadata { product: 'summary'; encoding: 'summary-json-v1' }
export interface AnalysisBlocks extends ProductMetadata { product: 'blocks'; encoding: 'blocks-le12-v1'; payload: ArrayBuffer }
export type AnalysisProduct = AnalysisSummary | AnalysisBlocks;
export type AnalysisOutput = AnalysisResult | AnalysisProduct;
export const isProduct = (value: AnalysisOutput): value is AnalysisProduct => 'product' in value;
export const isSummary = (value: AnalysisOutput): value is AnalysisSummary => isProduct(value) && value.product === 'summary';
export const metadata = (value: AnalysisOutput): FrameMetadata => {
  if (isProduct(value)) { const { product, productSchema, encoding, indexIdentity, validatedBlockCount, ...frame } = value; const { payload: _payload, ...rest } = frame as FrameMetadata & {payload?: ArrayBuffer}; return rest; }
  const { blocks, ...frame } = value; return frame;
};
export function productKey(picture: SourcePictureKey, buildId: string, indexIdentity: ProductIndexIdentity | null, product: 'summary' | 'blocks') {
  return JSON.stringify([pictureId(picture), buildId, ANALYSIS_RECIPE, ANALYZER_VERSION, PRODUCT_SCHEMA, product, product === 'summary' ? 'summary-json-v1' : 'blocks-le12-v1', analysisIndexIdentity(indexIdentity)]);
}
export function summaryOf(value: AnalysisOutput, indexIdentity: ProductIndexIdentity | null = null): AnalysisSummary {
  if (isProduct(value)) return { ...metadata(value), product: 'summary', productSchema: 2, encoding: 'summary-json-v1', indexIdentity: value.indexIdentity, validatedBlockCount: value.validatedBlockCount };
  return { ...metadata(value), product: 'summary', productSchema: 2, encoding: 'summary-json-v1', indexIdentity:analysisIndexIdentity(indexIdentity), validatedBlockCount: value.blocks.length };
}
const modes = [undefined, 'intra', 'inter', 'skip'] as const;
export function readBlock(view: DataView, i: number): AnalysisBlock {
  const at = i * 12, q = view.getInt16(at + 8, true);
  return { x: view.getUint16(at, true), y: view.getUint16(at + 2, true), width: view.getUint16(at + 4, true), height: view.getUint16(at + 6, true), qp: q === -32768 ? null : q, mode: modes[view.getUint8(at + 10)]! };
}
/** Validate directly over bounded records, without a retained array of JS blocks. */
export function validateRecords(frame: FrameMetadata, count: number, at: (i: number) => AnalysisBlock) {
  if (!Number.isSafeInteger(count) || count < 0 || count > BUDGET.blocks) throw new AnalysisFailure('resource-limit', 'Analysis block count exceeded');
  const w = frame.width, h = frame.height;
  if (frame.confidence === 'exact' && (!count || w % 4 || h % 4 || frame.reasons.length || frame.capabilities.blocks !== 'ready')) throw new AnalysisFailure('unsupported-picture-layout', 'Incomplete picture');
  // Dimensions are admitted before allocation, independent of producer claims.
  if (![w, h].every(n => Number.isInteger(n) && n > 0) || w > 4096 || h > 2304) throw new AnalysisFailure('resource-limit', 'Invalid analysis geometry');
  const cells = new Uint8Array(Math.ceil(w / 4) * Math.ceil(h / 4));
  let area = 0, sum = 0;
  for (let i = 0; i < count; i++) {
    const b = at(i);
    if (![b.x,b.y,b.width,b.height].every(n => Number.isInteger(n) && n % 4 === 0) || b.x < 0 || b.y < 0 || b.width <= 0 || b.height <= 0 || b.x + b.width > w || b.y + b.height > h || !['intra','inter','skip'].includes(b.mode) || (frame.capabilities.qp==='ready' && b.qp===null) || (b.qp !== null && (!Number.isInteger(b.qp) || b.qp < 0 || b.qp > (frame.codec === 'vvc' ? 63 : 51)))) throw new Error('Invalid packed analysis block');
    for (let y = b.y / 4; y < (b.y + b.height) / 4; y++) for (let x = b.x / 4; x < (b.x + b.width) / 4; x++) { const p = y * Math.ceil(w / 4) + x; if (cells[p]) throw new AnalysisFailure('unsupported-picture-layout', 'Overlapping analysis blocks'); cells[p] = 1; }
    area += b.width * b.height; sum += (b.qp ?? 0) * b.width * b.height;
  }
  if (frame.confidence === 'exact' && area !== w * h) throw new AnalysisFailure('unsupported-picture-layout', 'Incomplete block coverage');
  return frame.capabilities.qp === 'ready' && area ? sum / area : null;
}
/** Conservative JSON/UTF-8 allocation budget without constructing a JSON string. */
export function metadataBudgetBytes(value:unknown) {
  let cost=0,nodes=0;
  const stringBytes=(text:string)=>{let size=2;for(let i=0;i<text.length;i++){const c=text.charCodeAt(i);if(c===34||c===92)size+=2;else if(c<32)size+=[8,9,10,12,13].includes(c)?2:6;else if(c<128)size++;else if(c<2048)size+=2;else if(c>=0xd800&&c<=0xdbff&&i+1<text.length&&text.charCodeAt(i+1)>=0xdc00&&text.charCodeAt(i+1)<=0xdfff){size+=4;i++;}else if(c>=0xd800&&c<=0xdfff)size+=6;else size+=3;}return size;};
  const walk=(v:unknown,depth:number)=>{
    if(depth>12||++nodes>32768)throw new AnalysisFailure('resource-limit','Analysis metadata structure budget exceeded');
    if(typeof v==='string')cost+=stringBytes(v);
    else if(Array.isArray(v)){cost+=2+v.length;for(const child of v)walk(child,depth+1);}
    else if(v!==null&&typeof v==='object'){
      if(Object.getPrototypeOf(v)!==Object.prototype&&Object.getPrototypeOf(v)!==null)throw Error('Invalid metadata object');
      cost+=2;for(const key in v){if(!Object.hasOwn(v,key)||(depth===0&&key==='payload')||(v as Record<string,unknown>)[key]===undefined)continue;cost+=stringBytes(key)+2;walk((v as Record<string,unknown>)[key],depth+1);}
    }else if(v===null||v===undefined)cost+=4;else if(typeof v==='boolean')cost+=v?4:5;else if(typeof v==='number')cost+=Number.isFinite(v)?String(v).length:4;
    else if(v!==undefined)throw Error('Invalid analysis metadata value');
    if(cost>PRODUCT_LIMIT.metadata)throw new AnalysisFailure('resource-limit','Analysis metadata allocation budget exceeded');
  };walk(value,0);return cost;
}
export function validateProduct(value: AnalysisProduct) {
  metadataBudgetBytes(value);
  if (!value || value.productSchema !== PRODUCT_SCHEMA || !['summary','blocks'].includes(value.product) || value.encoding !== (value.product === 'summary' ? 'summary-json-v1' : 'blocks-le12-v1') || 'blocks' in value) throw new Error('Invalid analysis product');
  validateMetadata(value);
  if (value.confidence==='exact' && (value.reasons.length || value.capabilities.blocks!=='ready' || value.capabilities.modes!=='ready' || (value.capabilities.qp==='ready' && (value.qp.bitDepth!==8||value.qp.mean===null))))throw Error('Invalid exact product quality');
  if (!Number.isSafeInteger(value.validatedBlockCount) || value.validatedBlockCount < 0 || value.validatedBlockCount > BUDGET.blocks || (value.confidence === 'exact' && !value.validatedBlockCount)) throw new Error('Invalid validated block count');
  if (!value.indexIdentity)throw Error('Missing analysis index version');
  const id=value.indexIdentity;if(id.kind==='mp4-analysis'){if(JSON.stringify(id)!==JSON.stringify(MP4_ANALYSIS_INDEX))throw Error('Unknown MP4 analysis index version');}else parseMediaIndexIdentity(id.kind,new URLSearchParams({stream:id.streamKey,schema:String(id.schemaVersion),indexer:id.indexerBuild}));
  const { payload, ...header } = value as AnalysisBlocks;
  if (new TextEncoder().encode(JSON.stringify(header)).byteLength > PRODUCT_LIMIT.metadata) throw new AnalysisFailure('resource-limit', 'Analysis metadata budget exceeded');
  if (value.product === 'summary') { if ('payload' in value) throw new Error('Summary cannot contain blocks'); return; }
  if (!(payload instanceof ArrayBuffer) || payload.byteLength !== value.validatedBlockCount * 12 || payload.byteLength + PRODUCT_LIMIT.metadata > PRODUCT_LIMIT.frame) throw new Error('Invalid packed payload length');
  const view = new DataView(payload);
  for (let i = 0; i < value.validatedBlockCount; i++) if (view.getUint8(i * 12 + 11)) throw new Error('Unknown packed reserved byte');
  const mean = validateRecords(value, value.validatedBlockCount, i => readBlock(view, i));
  if (mean !== value.qp.mean) throw new Error('Packed QP mismatch');
}
export function validateOutput(value: AnalysisOutput) { isProduct(value) ? validateProduct(value) : validateResult(value); }
export function packLegacy(value: AnalysisResult, indexIdentity: ProductIndexIdentity | null = null): AnalysisBlocks {
  validateResult(value);return packValidatedLegacy(value,indexIdentity);
}
function packValidatedLegacy(value:AnalysisResult,indexIdentity:ProductIndexIdentity|null):AnalysisBlocks {
  const summary=summaryOf(value,indexIdentity);metadataBudgetBytes(summary);
  const payload = new ArrayBuffer(value.blocks.length * 12), view = new DataView(payload);
  value.blocks.forEach((b, i) => writeBlock(view, i, b));
  return { ...summary, product: 'blocks', encoding: 'blocks-le12-v1', payload };
}
export function writeBlock(view: DataView, i: number, b: AnalysisBlock) {
  const at = i * 12;
  [b.x,b.y,b.width,b.height].forEach((v,j) => view.setUint16(at + j * 2, v, true)); view.setInt16(at + 8, b.qp === null ? -32768 : b.qp, true); view.setUint8(at + 10, modes.indexOf(b.mode)); view.setUint8(at + 11, 0);
}
export function legacyOf(value: AnalysisBlocks): AnalysisResult {
  validateProduct(value); const view = new DataView(value.payload);
  return { ...structuredClone(metadata(value)), blocks: Array.from({length: value.validatedBlockCount}, (_, i) => readBlock(view, i)) };
}
/** Cache ownership never escapes; iteration produces independent records. */
const OWNED_VALIDATION=Symbol("private validated block ownership");
export class OwnedBlocks {
  #value: AnalysisBlocks;
  constructor(value: AnalysisBlocks, proof?:typeof OWNED_VALIDATION) { if(proof!==OWNED_VALIDATION)validateProduct(value); this.#value = structuredClone(value); }
  static fromLegacy(value:AnalysisResult,indexIdentity:ProductIndexIdentity|null=null) {validateResult(value);return new OwnedBlocks(packValidatedLegacy(value,indexIdentity),OWNED_VALIDATION);}
  get byteLength() { return this.#value.payload.byteLength + JSON.stringify(metadata(this.#value)).length * 2; }
  copy() { return structuredClone(this.#value); }
  view(): import('./contract.ts').ReadonlyAnalysisResult {
    const view = new DataView(this.#value.payload), count = this.#value.validatedBlockCount;
    // A frozen sparse array facade preserves the legacy read-only surface while
    // decoding each requested record into an independent frozen object.
    const blocks = new Proxy(Object.freeze(new Array<AnalysisBlock>(count)), {
      get(target, key, receiver) { if(key===Symbol.iterator)return function*(){for(let i=0;i<count;i++)yield Object.freeze(readBlock(view,i));}; if (typeof key === 'string' && /^(0|[1-9][0-9]*)$/.test(key)) return Number(key) < count ? Object.freeze(readBlock(view,Number(key))) : undefined; return Reflect.get(target,key,receiver); },
      has(target,key) { return typeof key === 'string' && /^(0|[1-9][0-9]*)$/.test(key) && Number(key) < count || Reflect.has(target,key); },
    });
    const freeze = (v:any):any => { if(v && typeof v === 'object') { Object.values(v).forEach(freeze); Object.freeze(v); } return v; };
    return Object.freeze({...freeze(structuredClone(metadata(this.#value))), blocks});
  }
  legacy():AnalysisResult { const view=new DataView(this.#value.payload);return {...structuredClone(metadata(this.#value)),blocks:Array.from({length:this.#value.validatedBlockCount},(_,i)=>readBlock(view,i))}; }
  *[Symbol.iterator]() { const view = new DataView(this.#value.payload); for (let i = 0; i < this.#value.validatedBlockCount; i++) yield readBlock(view, i); }
}
/** Checksum covers the canonical serialized header and every payload byte. */
export async function encodeProduct(value: AnalysisProduct): Promise<Uint8Array> {
  validateProduct(value);
  const { payload, ...header } = value as AnalysisBlocks;
  const json = new TextEncoder().encode(JSON.stringify(header)), length = 8 + json.length + (payload?.byteLength ?? 0);
  if (length + 32 > PRODUCT_LIMIT.frame) throw new AnalysisFailure('resource-limit', 'Analysis frame budget exceeded');
  const bytes = new Uint8Array(length + 32); new DataView(bytes.buffer).setUint32(0, 0x31504156, true); new DataView(bytes.buffer).setUint32(4, json.length, true); bytes.set(json, 8); if (payload) bytes.set(new Uint8Array(payload), 8 + json.length);
  bytes.set(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.subarray(0,length))), length); return bytes;
}
export async function decodeProduct(bytes: Uint8Array): Promise<AnalysisProduct> {
  if (bytes.byteLength < 40 || bytes.byteLength > PRODUCT_LIMIT.frame) throw new AnalysisFailure('resource-limit', 'Analysis response budget exceeded');
  const view = new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  if (view.getUint32(0,true) !== 0x31504156) throw new Error('Unknown analysis wire version');
  const length = view.getUint32(4,true);
  if (length > PRODUCT_LIMIT.metadata || length > bytes.length - 40) throw new Error('Invalid analysis header length');
  const end = bytes.length - 32, checksum = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.slice(0,end).buffer));
  if (!checksum.every((b,i) => b === bytes[end+i])) throw new Error('Analysis checksum mismatch');
  const header = parseBudgetedJson(new TextDecoder('utf-8', {fatal:true}).decode(bytes.subarray(8,8+length))) as AnalysisProduct;
  if (header.product === 'blocks') {
    if (!Number.isSafeInteger(header.validatedBlockCount) || header.validatedBlockCount < 0 || header.validatedBlockCount > BUDGET.blocks || end - 8 - length !== header.validatedBlockCount * 12) throw new Error('Invalid analysis payload budget');
    header.payload = bytes.slice(8+length,end).buffer;
  } else if (end !== 8 + length) throw new Error('Unexpected summary payload');
  validateProduct(header); return header;
}
export async function readBoundedResponse(response: Response, max = PRODUCT_LIMIT.frame) {
  const length = Number(response.headers.get('content-length'));
  if (!response.ok || !Number.isSafeInteger(length) || length <= 0 || length > max) throw new AnalysisFailure('resource-limit', 'Analysis result transport budget exceeded');
  const reader = response.body?.getReader(); if (!reader) throw new Error('Missing analysis body');
  const bytes = new Uint8Array(length); let offset = 0;
  try { for (;;) { const next = await reader.read(); if (next.done) break; if (offset + next.value.length > length) throw new Error('Oversized analysis response'); bytes.set(next.value,offset); offset += next.value.length; } }
  finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  if (offset !== length) throw new Error('Incomplete analysis response'); return bytes;
}
