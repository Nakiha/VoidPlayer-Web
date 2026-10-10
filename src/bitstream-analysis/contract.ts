import type { FrameDescription } from '../frame-description.ts';
export const ANALYSIS_SCHEMA = 1;
export const ANALYSIS_RECIPE = 'blocks-basic-v1';
export const ANALYZER_VERSION = '0.1.0';
export interface SourcePictureKey { sourceVersion: string; stream: string; configuration: number; au: number; picture: 0; layer: 0; field: 'frame'; }
export interface PresentedFrameToken {
  slot: string; generation: number; commit: number;
  picture: SourcePictureKey | null; identityReason?: string;
  sourcePtsUs: number; normalizedMediaUs: number;
  timeMapping: 'source-microseconds-minus-first-pts';
  geometry: Pick<FrameDescription, 'codedWidth' | 'codedHeight' | 'visibleRect' | 'displayWidth' | 'displayHeight'> & { rotation: number };
}
export interface AnalysisBlock { x: number; y: number; width: number; height: number; qp: number | null; mode: 'intra' | 'inter' | 'skip'; }
export interface AnalysisResult {
  schema: 1; analyzerVersion: string; buildId: string; recipe: string;
  picture: SourcePictureKey; sourcePtsUs: number; width: number; height: number;
  confidence: 'exact' | 'partial'; reasons: string[];
  capabilities: { blocks: 'ready' | 'unsupported'; qp: 'ready' | 'unsupported'; modes: 'ready' | 'unsupported'; motion: 'unsupported' };
  qp: { component: 'luma'; bitDepth: number; weighting: 'pixel-area'; mean: number | null };
  blocks: AnalysisBlock[];
  metrics: { startAu: number; packets: number; bytesRead: number; elapsedMs: number; recordBytes: number; heapBytes: number };
}
export interface AnalysisTarget { sourceVersion: string; sourcePtsUs: number; normalizedMediaUs: number; picture?: SourcePictureKey; }
export interface AnalysisRangeTarget { sourceVersion:string; firstPtsUs:number; startUs:number; endUs:number; }
export function validateRange(target:AnalysisRangeTarget){if(!target||typeof target.sourceVersion!=='string'||!target.sourceVersion||target.sourceVersion.length>256||![target.firstPtsUs,target.startUs,target.endUs].every(Number.isSafeInteger)||target.startUs<0||target.endUs<=target.startUs||target.endUs-target.startUs>1000000)throw new Error('Invalid bounded analysis range');}
export const BUDGET = Object.freeze({ packets: 300, inputBytes: 32 * 1024 * 1024, packetBytes: 8 * 1024 * 1024, blocks: 131072, resultBytes: 8 * 1024 * 1024, cacheBytes: 32 * 1024 * 1024, requests: 32, leaseMs: 30000 });
export function pictureId(key: SourcePictureKey): string { return JSON.stringify([key.sourceVersion,key.stream,key.configuration,key.au,key.picture,key.layer,key.field]); }
export function validateTarget(target: AnalysisTarget): void {
  if (!target || typeof target.sourceVersion !== 'string' || !target.sourceVersion || target.sourceVersion.length > 256 || !Number.isSafeInteger(target.sourcePtsUs) || !Number.isSafeInteger(target.normalizedMediaUs) || target.normalizedMediaUs < 0) throw new Error('Invalid analysis target');
  if (target.picture && (target.picture.sourceVersion !== target.sourceVersion || !Number.isSafeInteger(target.picture.au) || target.picture.au < 0 || target.picture.au >= 2000000 || !Number.isInteger(target.picture.configuration) || target.picture.configuration < 0 || target.picture.configuration > 255 || target.picture.layer !== 0 || target.picture.field !== 'frame' || target.picture.picture !== 0 || typeof target.picture.stream !== 'string' || target.picture.stream.length > 64)) throw new Error('Invalid picture identity');
}
/** Validate before renderer/cache use, including count, geometry and overlap.
 * 4px grid is an explicit MVP admission limit, not a guessed completion flag. */
export function validateResult(result: AnalysisResult): void {
  if (!result || result.schema !== 1 || result.recipe !== ANALYSIS_RECIPE || result.analyzerVersion !== ANALYZER_VERSION || typeof result.buildId !== 'string' || result.buildId.length > 128 || !['exact','partial'].includes(result.confidence) || !Array.isArray(result.reasons) || result.reasons.length > 32 || result.reasons.some(r => typeof r !== 'string' || r.length > 256)) throw new Error('Invalid analysis result');
  validateTarget({sourceVersion:result.picture?.sourceVersion,sourcePtsUs:result.sourcePtsUs,normalizedMediaUs:0,picture:result.picture});
  const { width:w,height:h,blocks } = result;
  if (![w,h].every(n => Number.isInteger(n) && n > 0) || w > 4096 || h > 2304 || !Array.isArray(blocks) || blocks.length > BUDGET.blocks) throw new Error('Analysis resource limit');
  if (result.confidence !== 'exact') return;
  if (!blocks.length || w % 4 || h % 4 || result.reasons.length || !result.capabilities || result.capabilities.blocks !== 'ready') throw new Error('Incomplete picture');
  const cells = new Uint8Array(w * h / 16); let area = 0;
  for (const b of blocks) {
    if (![b.x,b.y,b.width,b.height].every(n => Number.isInteger(n) && n % 4 === 0) || b.x < 0 || b.y < 0 || b.width <= 0 || b.height <= 0 || b.x+b.width > w || b.y+b.height > h || !['intra','inter','skip'].includes(b.mode) || b.qp !== null && (!Number.isInteger(b.qp) || b.qp < 0 || b.qp > 51)) throw new Error('Invalid analysis block');
    area += b.width*b.height;
    for(let y=b.y/4;y<(b.y+b.height)/4;y++) for(let x=b.x/4;x<(b.x+b.width)/4;x++) { const i=y*(w/4)+x;if(cells[i])throw new Error('Overlapping analysis blocks');cells[i]=1; }
  }
  if (area !== w*h) throw new Error('Incomplete block coverage');
}
