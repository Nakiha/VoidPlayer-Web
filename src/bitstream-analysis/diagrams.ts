import type { AnalysisAxis } from '../analysis/types.ts';
import type { AnalysisResult, SourcePictureKey } from './contract.ts';
import { BUDGET, pictureId } from './contract.ts';
export interface NaluRecord { offset: number; size: number; type: number; temporalId: number; layer: number }
export interface PictureReferences {
  kind: 'active-lists'; state: 'ready' | 'unsupported'; poc: number;
  frameType: 'I' | 'P' | 'B'; edges: { au: number; list: 0 | 1 }[];
}
export type DiagramPicture = Pick<AnalysisResult, 'picture' | 'sourcePtsUs' | 'sourceDtsUs' | 'codec' | 'gop'> & {
  qpMean?: number | null; nalus: NaluRecord[]; references?: PictureReferences; referenceLayer?: ReferenceLayer;
};
export interface ReferenceLayer { level: number; source: 'temporal-id' | 'inferred'; provisional?: boolean }

/** This is a display hierarchy, not proof of block-level prediction or SVC.
 * Use signaled VCL temporal IDs when available. Otherwise keep each interval
 * between consecutive I/P anchors independent of older active-list candidates.
 * Work from retained source records, not the viewport, so zoom cannot change levels. */
export function referenceLayers(pictures: readonly DiagramPicture[]): Map<number, ReferenceLayer> {
  const ready = pictures.filter(p => p.references?.state === 'ready');
  const byAu = new Map(ready.map(p => [p.picture.au, p]));
  const anchors = new Map<number, DiagramPicture[]>();
  for (const p of ready) if (p.references!.frameType !== 'B') {
    const group = anchors.get(p.picture.configuration) ?? [];
    group.push(p); anchors.set(p.picture.configuration, group);
  }
  for (const group of anchors.values()) group.sort((a, b) => a.sourcePtsUs - b.sourcePtsUs || a.picture.au - b.picture.au);
  const intervals = new Map<number, { key: string; complete: boolean }>();
  for (const p of ready) {
    const group = anchors.get(p.picture.configuration) ?? [];
    let lo = 0, hi = group.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (group[mid].sourcePtsUs <= p.sourcePtsUs) lo = mid + 1; else hi = mid; }
    const left = group[lo - 1], right = group[lo];
    intervals.set(p.picture.au, {
      key: `${p.picture.configuration}:${left?.picture.au ?? '-'}:${right?.picture.au ?? '-'}`,
      complete: !!left && !!right && left.sourcePtsUs < p.sourcePtsUs,
    });
  }
  const output = new Map<number, ReferenceLayer>();
  for (const p of [...ready].sort((a, b) => a.picture.au - b.picture.au)) {
    const vcl = p.nalus.filter(n => p.codec === 'hevc' ? n.type <= 31 : p.codec === 'vvc' && n.type <= 11);
    if (vcl.length && vcl.every(n => n.temporalId === vcl[0].temporalId)) {
      output.set(p.picture.au, { level: vcl[0].temporalId, source: 'temporal-id' });
      continue;
    }
    if (p.references!.frameType !== 'B') { output.set(p.picture.au, { level: 0, source: 'inferred' }); continue; }
    const interval = intervals.get(p.picture.au)!;
    let level = 1, provisional = !interval.complete;
    for (const edge of p.references!.edges) {
      const ref = byAu.get(edge.au), parent = output.get(edge.au);
      if (!ref) { provisional = true; continue; }
      if (interval.complete && ref.references!.frameType === 'B' && intervals.get(edge.au)?.key === interval.key) {
        if (parent) { level = Math.max(level, parent.level + 1); provisional ||= !!parent.provisional; }
        else provisional = true;
      }
    }
    output.set(p.picture.au, { level, source: 'inferred', ...(provisional ? { provisional: true } : {}) });
  }
  return output;
}
/** MP4 length-prefixed NALs. Sizes include the NAL header and exclude the
 * container length prefix; offsets are relative to the compressed AU. */
export function readNalus(codec: AnalysisResult['codec'], description: Uint8Array, bytes: Uint8Array): NaluRecord[] {
  const lengthSize = ((description[codec === 'h264' ? 4 : codec === 'hevc' ? 21 : 0] ?? 0) & 3) + 1;
  const records: NaluRecord[] = [];
  for (let at = 0; at < bytes.length;) {
    if (at + lengthSize > bytes.length) throw new Error('Truncated NAL length');
    let size = 0;
    for (let i = 0; i < lengthSize; i++) size = size * 256 + bytes[at++];
    if (size < (codec === 'h264' ? 1 : 2) || at + size > bytes.length) throw new Error('Truncated NAL payload');
    if (records.length >= 4096) throw new Error('NAL count budget exceeded');
    if (bytes[at] & 128 || (codec !== 'h264' && !(bytes[at + 1] & 7))) throw new Error('Invalid NAL header');
    records.push({ offset: at, size,
      type: codec === 'h264' ? bytes[at] & 31 : codec === 'hevc' ? (bytes[at] >> 1) & 63 : bytes[at + 1] >> 3,
      temporalId: codec === 'h264' ? 0 : (bytes[at + 1] & 7) - 1,
      layer: codec === 'h264' ? 0 : codec === 'hevc' ? ((bytes[at] & 1) << 5) | (bytes[at + 1] >> 3) : bytes[at] & 63 });
    at += size;
  }
  return records;
}
export interface ContainerHeader {
  box: 'avcC' | 'hvcC' | 'vvcC'; byteLength: number; nalus: NaluRecord[];
}
/** Configuration NALs remain out of band; offsets are relative to the record,
 * sizes exclude its two-byte length fields. No payload is retained or injected. */
export function readContainerHeader(codec: AnalysisResult['codec'], description: Uint8Array): ContainerHeader {
  let at = 0;
  const take = (count: number) => { if (at + count > description.length) throw new Error('Truncated container configuration'); const start = at; at += count; return start; };
  const byte = () => description[take(1)];
  const word = () => (byte() << 8) | byte();
  const nalus: NaluRecord[] = [];
  const units = (count: number, expected: number) => {
    for (let i = 0; i < count; i++) {
      const size = word(), offset = take(size);
      if (size < (codec === 'h264' ? 1 : 2) || nalus.length >= 256) throw new Error('Invalid configuration NAL size/count');
      const type = codec === 'h264' ? description[offset] & 31 : codec === 'hevc' ? (description[offset] >> 1) & 63 : description[offset + 1] >> 3;
      if (type !== expected || description[offset] & 128 || codec !== 'h264' && !(description[offset + 1] & 7)) throw new Error('Invalid configuration NAL header');
      nalus.push({ offset, size, type, temporalId: codec === 'h264' ? 0 : (description[offset + 1] & 7) - 1,
        layer: codec === 'h264' ? 0 : codec === 'hevc' ? ((description[offset] & 1) << 5) | (description[offset + 1] >> 3) : description[offset] & 63 });
    }
  };
  if (description.length > 1024 * 1024) throw new Error('Container configuration budget exceeded');
  if (codec === 'h264') {
    if (byte() !== 1) throw new Error('Invalid avcC version');
    take(4); units(byte() & 31, 7); units(byte(), 8);
    // High-profile records may carry sequence parameter set extensions.
    if (at < description.length) { take(3); units(byte(), 13); }
  } else {
    let arrays: number;
    if (codec === 'hevc') { if (byte() !== 1) throw new Error('Invalid hvcC version'); take(21); arrays = byte(); }
    else {
      const flags = byte();
      if (flags & 1) {
        const sublayers = (word() >> 4) & 7; take(1);
        const constraints = byte() & 63; take(2 + Math.max(1, constraints));
        if (sublayers > 1) { const present = byte(); for (let i = 0; i < sublayers - 1; i++) if (present & (128 >> i)) take(1); }
        take(byte() * 4); take(6);
      }
      arrays = byte();
    }
    for (let i = 0; i < arrays; i++) {
      const type = byte() & (codec === 'hevc' ? 63 : 31);
      units(codec === 'vvc' && (type === 12 || type === 13) ? 1 : word(), type);
    }
  }
  if (at !== description.length) throw new Error('Trailing container configuration bytes');
  return { box: codec === 'h264' ? 'avcC' : codec === 'hevc' ? 'hvcC' : 'vvcC', byteLength: description.length, nalus };
}
export function validateContainerHeader(codec: AnalysisResult['codec'], header: ContainerHeader) {
  if (!header || header.box !== (codec === 'h264' ? 'avcC' : codec === 'hevc' ? 'hvcC' : 'vvcC') ||
      !Number.isSafeInteger(header.byteLength) || header.byteLength < 1 || header.byteLength > 1024 * 1024 || !Array.isArray(header.nalus) || header.nalus.length > 256) throw new Error('Invalid container header');
  let end = 0;
  for (const n of header.nalus) {
    if (![n.offset, n.size, n.type, n.temporalId, n.layer].every(Number.isSafeInteger) || n.offset < end || n.size < 1 || n.offset + n.size > header.byteLength ||
        n.type < 0 || n.type > (codec === 'hevc' ? 63 : 31) || n.temporalId < 0 || n.temporalId > 6 || n.layer < 0 || n.layer > 63) throw new Error('Invalid container NAL');
    end = n.offset + n.size;
  }
}
export function validateDiagram(result: DiagramPicture) {
  if (result.qpMean != null && (!Number.isFinite(result.qpMean) || result.qpMean < 0 || result.qpMean > (result.codec === 'vvc' ? 63 : 51))) throw new Error('Invalid mean QP');
  if (result.sourceDtsUs != null && !Number.isSafeInteger(result.sourceDtsUs)) throw new Error('Invalid source DTS');
  if (!Array.isArray(result.nalus) || !result.nalus.length || result.nalus.length > 4096) throw new Error('Invalid NAL records');
  let end = 0;
  for (const n of result.nalus) {
    if (![n.offset, n.size, n.type, n.temporalId, n.layer].every(Number.isSafeInteger) || n.offset < end || n.size < 1 || n.offset + n.size > BUDGET.packetBytes ||
      n.type < 0 || n.type > (result.codec === 'h264' ? 31 : result.codec === 'hevc' ? 63 : 31) || n.temporalId < 0 || n.temporalId > 6 || n.layer < 0 || n.layer > 63) throw new Error('Invalid NAL record');
    end = n.offset + n.size;
  }
  const r = result.references;
  if (r) {
    if (r.kind !== 'active-lists' || !['ready', 'unsupported'].includes(r.state) || !['I', 'P', 'B'].includes(r.frameType) || !Number.isSafeInteger(r.poc) || !Array.isArray(r.edges) || r.edges.length > 64) throw new Error('Invalid picture references');
    const seen = new Set<string>();
    for (const e of r.edges) {
      const id = `${e.au}:${e.list}`;
      if (!Number.isSafeInteger(e.au) || e.au < 0 || e.au >= result.picture.au || ![0, 1].includes(e.list) || seen.has(id)) throw new Error('Invalid reference edge');
      seen.add(id);
    }
    if (r.state !== 'ready' && r.edges.length) throw new Error('Unsupported reference edges');
  }
}
export interface DiagramBucket {
  startUs: number; endUs: number; pictures: number; naluBytes: number[]; naluCounts: number[];
  qpSum?: number; qpCount?: number; maxPictureBytes: number; frames: { I: number; P: number; B: number }; references: number;
}
interface DiagramAxisSummary {
  width: number; count: number; seen: Uint8Array; qpSeen: Uint8Array; bins: Map<number, DiagramBucket>;
  min: number; max: number;
}
interface DiagramSummary {
  codec: AnalysisResult['codec']; axes: Record<AnalysisAxis, DiagramAxisSummary>;
  containerHeaders: Map<number, ContainerHeader>;
}
const emptyAxisSummary = (): DiagramAxisSummary => ({ width: 1000, count: 0, seen: new Uint8Array(250001), qpSeen: new Uint8Array(250001), bins: new Map(), min: Infinity, max: -Infinity });
export const diagramTime = (picture: DiagramPicture, axis: AnalysisAxis): number | null => axis === 'pts' ? picture.sourcePtsUs : picture.sourceDtsUs ?? null;
const emptyBucket = (startUs: number, endUs: number): DiagramBucket => ({ startUs, endUs, pictures: 0,
  naluBytes: Array(64).fill(0), naluCounts: Array(64).fill(0), qpSum: 0, qpCount: 0, maxPictureBytes: 0, frames: { I: 0, P: 0, B: 0 }, references: 0 });
function mergeBucket(target: DiagramBucket, input: DiagramBucket) {
  target.pictures += input.pictures; target.maxPictureBytes = Math.max(target.maxPictureBytes, input.maxPictureBytes);
  target.references += input.references;
  target.qpSum = (target.qpSum ?? 0) + (input.qpSum ?? 0); target.qpCount = (target.qpCount ?? 0) + (input.qpCount ?? 0);
  for (const type of ['I', 'P', 'B'] as const) target.frames[type] += input.frames[type];
  for (let i = 0; i < 64; i++) { target.naluBytes[i] += input.naluBytes[i]; target.naluCounts[i] += input.naluCounts[i]; }
}
/** Retain lightweight chart records independently of the block LRU. Entries
 * are source/config/AU owned; bounded queries never clone a whole film. */
export class DiagramStore {
  private sources = new Map<string, Map<number, { value: DiagramPicture; bytes: number; id: string }>>();
  private fifo = new Map<string, { source: string; au: number; bytes: number }>();
  private bytes = 0;
  private maxBytes: number;
  constructor(maxBytes = BUDGET.cacheBytes) { this.maxBytes = maxBytes; }
  // Whole-source summaries survive detailed-record eviction. At most eight
  // sources, 1024 adaptive time bins and a 2M-AU dedup bitset per source.
  private summaries = new Map<string, DiagramSummary>();
  revision = 0;
  private bounds = new Map<string, { min: number; max: number }>();
  private layersDirty = new Set<string>();
  private ensureLayers(source: string) {
    if (!this.layersDirty.has(source)) return;
    const entries = this.sources.get(source);
    if (entries) {
      const layers = referenceLayers([...entries.values()].map(entry => entry.value));
      for (const [au, entry] of entries) entry.value.referenceLayer = layers.get(au);
    }
    this.layersDirty.delete(source);
  }
  put(result: AnalysisResult) {
    if (!result.nalus) return;
    validateDiagram(result as DiagramPicture);
    if (result.containerHeader) validateContainerHeader(result.codec, result.containerHeader);
    const value: DiagramPicture = structuredClone({ picture: result.picture, sourcePtsUs: result.sourcePtsUs, sourceDtsUs: result.sourceDtsUs, codec: result.codec, gop: result.gop, qpMean: result.confidence === 'exact' && result.capabilities.qp === 'ready' ? result.qp.mean : null, nalus: result.nalus, references: result.references });
    // Reserve space for derived layout metadata without retaining another source-sized map.
    const source = value.picture.sourceVersion, au = value.picture.au, id = pictureId(value.picture), bytes = JSON.stringify(value).length * 2 + 256;
    let entries = this.sources.get(source);
    this.summarize(value);
    if (result.containerHeader) { this.summaries.get(source)?.containerHeaders.set(result.picture.configuration, structuredClone(result.containerHeader)); }
    const previous = entries?.get(au);
    if (previous) { this.bytes -= previous.bytes; this.fifo.delete(previous.id); }
    while (this.bytes + bytes > this.maxBytes && this.fifo.size) {
      const [key, old] = this.fifo.entries().next().value!;
      this.sources.get(old.source)?.delete(old.au); this.bounds.delete(old.source); this.fifo.delete(key); this.bytes -= old.bytes;
      this.layersDirty.add(old.source);
      if (!this.sources.get(old.source)?.size) { this.sources.delete(old.source); this.layersDirty.delete(old.source); }
    }
    entries = this.sources.get(source) ?? new Map(); this.sources.set(source, entries);
    const bounds = this.bounds.get(source); if (bounds) { bounds.min = Math.min(bounds.min, au); bounds.max = Math.max(bounds.max, au); }
    entries.set(au, { value, bytes, id }); this.fifo.set(id, { source, au, bytes }); this.bytes += bytes; this.revision++;
    this.layersDirty.add(source);
  }
  private summarize(value: DiagramPicture) {
    const source = value.picture.sourceVersion, au = value.picture.au;
    if (au > 2_000_000) return; // Matches the stream/core AU identity ceiling.
    let summary = this.summaries.get(source);
    if (!summary) {
      if (this.summaries.size >= 8) this.summaries.delete(this.summaries.keys().next().value!);
      summary = { codec: value.codec, axes: { pts: emptyAxisSummary(), dts: emptyAxisSummary() }, containerHeaders: new Map() };
      this.summaries.set(source, summary);
    }
    for (const axis of ['pts', 'dts'] as const) {
      const time = diagramTime(value, axis); if (time == null) continue;
      this.summarizeAxis(summary.axes[axis], value, time);
    }
  }
  private summarizeAxis(summary: DiagramAxisSummary, value: DiagramPicture, time: number) {
    const au = value.picture.au;
    // Same immutable source/AU can arrive again through single-frame analysis,
    // rechecking or cache hits; its compressed NAL records do not change.
    const mask = 1 << (au % 8), index = Math.floor(au / 8);
    if (summary.seen[index] & mask) {
      // A later exact result may fill QP missing from an earlier partial record.
      if (value.qpMean != null && !(summary.qpSeen[index] & mask)) {
        const bucket=summary.bins.get(Math.floor(time/summary.width));
        if(bucket) {bucket.qpSum=(bucket.qpSum ?? 0)+value.qpMean;bucket.qpCount=(bucket.qpCount ?? 0)+1;summary.qpSeen[index]|=mask;}
      }
      return;
    }
    summary.seen[index] |= mask; summary.count++;
    summary.min = Math.min(summary.min, time); summary.max = Math.max(summary.max, time);
    const key = Math.floor(time / summary.width);
    let bucket = summary.bins.get(key);
    if (!bucket) { bucket = emptyBucket(key * summary.width, (key + 1) * summary.width); summary.bins.set(key, bucket); }
    bucket.pictures++;
    if (value.qpMean != null) { summary.qpSeen[index]|=mask; bucket.qpSum = (bucket.qpSum ?? 0) + value.qpMean; bucket.qpCount = (bucket.qpCount ?? 0) + 1; }
    let bytes = 0;
    for (const n of value.nalus) { bucket.naluBytes[n.type] += n.size; bucket.naluCounts[n.type]++; bytes += n.size; }
    bucket.maxPictureBytes = Math.max(bucket.maxPictureBytes, bytes);
    if (value.references?.state === 'ready') { bucket.frames[value.references.frameType]++; bucket.references += value.references.edges.length; }
    while (summary.bins.size > 1024) {
      summary.width *= 2;
      const bins = new Map<number, DiagramBucket>();
      for (const bin of summary.bins.values()) {
        const key = Math.floor(bin.startUs / summary.width);
        let merged = bins.get(key);
        if (!merged) { merged = emptyBucket(key * summary.width, (key + 1) * summary.width); bins.set(key, merged); }
        mergeBucket(merged, bin);
      }
      summary.bins = bins;
    }
  }
  queryChart(source: string, startUs: number, endUs: number, pixelWidth = 512, axis: AnalysisAxis = 'pts') {
    const sourceSummary = this.summaries.get(source), summary = sourceSummary?.axes[axis];
    const base = { revision: this.revision, count: summary?.count ?? 0, codec: sourceSummary?.codec ?? null,
      containerHeaders: [...(sourceSummary?.containerHeaders ?? [])].sort(([a], [b]) => a - b).map(([configuration, header]) => ({ configuration, ...structuredClone(header) })),
      types: [] as number[], pictures: [] as DiagramPicture[], buckets: [] as DiagramBucket[], aggregated: false, detailMissing: false };
    if (!summary) return base;
    const bins = [...summary.bins.values()].filter(b => b.endUs > startUs && b.startUs < endUs);
    const types = new Set<number>();
    for (const bin of summary.bins.values()) for (let i = 0; i < 64; i++) if (bin.naluCounts[i]) types.add(i);
    base.types = [...types].sort((a, b) => a - b);
    const count = bins.reduce((sum, b) => sum + b.pictures, 0);
    // Read only the viewport, but verify full intersecting-bin coverage before
    // trusting the raw cache. This also lets sub-bin zoom resolve recent frames
    // after the whole-film summary has coarsened for a long source.
    if (count > 0) {
      const first = Math.min(...bins.map(b => b.startUs)), last = Math.max(...bins.map(b => b.endUs));
      const coverage = new Map<number, number>(); let bytes = 0, rawCount = 0;
      for (const entry of this.sources.get(source)?.values() ?? []) {
        const time = diagramTime(entry.value, axis);
        if (time == null || time < first || time >= last) continue;
        const key = Math.floor(time / summary.width); coverage.set(key, (coverage.get(key) ?? 0) + 1);
        if (time >= startUs && time < endUs) {
          rawCount++; bytes += entry.bytes;
          if (rawCount <= 256 && bytes <= 2 * 1024 * 1024) base.pictures.push(entry.value);
        }
      }
      const complete = bins.every(b => coverage.get(Math.floor(b.startUs / summary.width)) === b.pictures);
      if (complete && rawCount <= 256 && bytes <= 2 * 1024 * 1024) {
        this.ensureLayers(source);
        base.pictures.sort((a, b) => diagramTime(a, axis)! - diagramTime(b, axis)! || a.picture.au - b.picture.au);
        return structuredClone(base);
      }
      base.detailMissing = !complete;
      base.pictures = [];
    }
    // Group to the display's resolution; totals/counts are additive and an
    // independent maximum retains size peaks. Coarse bins are explicit.
    const target = Math.max(1, Math.min(256, Math.floor(pixelWidth / 5)));
    let width = summary.width;
    while (width < (endUs - startUs) / target) width *= 2;
    const output = new Map<number, DiagramBucket>();
    for (const bin of bins) {
      const key = Math.floor(bin.startUs / width);
      let merged = output.get(key);
      if (!merged) { merged = emptyBucket(key * width, (key + 1) * width); output.set(key, merged); }
      mergeBucket(merged, bin);
    }
    base.buckets = [...output.values()].sort((a, b) => a.startUs - b.startUs); base.aggregated = !!count;
    return structuredClone(base);
  }
  chartBounds(source: string, axis: AnalysisAxis) {
    const summary = this.summaries.get(source)?.axes[axis];
    return summary?.count ? { start: summary.min, end: summary.max + 1 } : null;
  }
  query(source: string, anchorAu: number | null, sourcePtsUs: number, startAu?: number, limit = 128) {
    this.ensureLayers(source);
    const entries = this.sources.get(source);
    if (!entries?.size) return { revision: this.revision, count: 0, startAu: 0, endAu: 0, pictures: [] as DiagramPicture[], anchor: null as DiagramPicture | null };
    // Seek lookup is linear only on explicit navigation/current-picture change.
    let anchor = anchorAu === null ? undefined : entries.get(anchorAu)?.value;
    let { min, max } = this.bounds.get(source) ?? { min: Infinity, max: -1 };
    if (min === Infinity || anchorAu === null) for (const [au, entry] of entries) {
      min = Math.min(min, au); max = Math.max(max, au);
      if (anchorAu === null && (!anchor || Math.abs(entry.value.sourcePtsUs - sourcePtsUs) < Math.abs(anchor.sourcePtsUs - sourcePtsUs))) anchor = entry.value;
    }
    this.bounds.set(source, { min, max });
    const start = Math.max(0, startAu ?? anchor?.gop?.startAu ?? Math.max(min, (anchor?.picture.au ?? min) - 16));
    const pictures: DiagramPicture[] = []; let queryBytes = anchor ? entries.get(anchor.picture.au)?.bytes ?? 0 : 0;
    for (let au = start; au < start + Math.max(1, Math.min(256, limit)); au++) { const entry = entries.get(au); if (entry) { if (pictures.length && queryBytes + entry.bytes > 2 * 1024 * 1024) break; queryBytes += entry.bytes; pictures.push(entry.value); } }
    return structuredClone({ revision: this.revision, count: entries.size, startAu: min, endAu: max + 1, pictures, anchor: anchor ?? null });
  }
  clear() { this.summaries.clear(); this.sources.clear(); this.bounds.clear(); this.layersDirty.clear(); this.fifo.clear(); this.bytes = 0; this.revision++; }
}
const names: Record<string, Record<number, string>> = {
  h264: { 1: 'SLICE', 5: 'IDR', 6: 'SEI', 7: 'SPS', 8: 'PPS', 9: 'AUD', 10: 'EOS', 11: 'EOB', 12: 'FILLER' },
  hevc: { 0: 'TRAIL_N', 1: 'TRAIL_R', 2: 'TSA_N', 3: 'TSA_R', 4: 'STSA_N', 5: 'STSA_R', 6: 'RADL_N', 7: 'RADL_R', 8: 'RASL_N', 9: 'RASL_R', 16: 'BLA_W_LP', 17: 'BLA_W_RADL', 18: 'BLA_N_LP', 19: 'IDR_W_RADL', 20: 'IDR_N_LP', 21: 'CRA', 32: 'VPS', 33: 'SPS', 34: 'PPS', 35: 'AUD', 36: 'EOS', 37: 'EOB', 38: 'FILLER', 39: 'PREFIX_SEI', 40: 'SUFFIX_SEI' },
  vvc: { 0: 'TRAIL', 1: 'STSA', 2: 'RADL', 3: 'RASL', 7: 'IDR_W_RADL', 8: 'IDR_N_LP', 9: 'CRA', 10: 'GDR', 12: 'OPI', 13: 'DCI', 14: 'VPS', 15: 'SPS', 16: 'PPS', 17: 'PREFIX_APS', 18: 'SUFFIX_APS', 19: 'PH', 20: 'AUD', 21: 'EOS', 22: 'EOB', 23: 'PREFIX_SEI', 24: 'SUFFIX_SEI', 25: 'FILLER' },
};
export const naluName = (codec: string, type: number) => names[codec]?.[type] ?? `NAL ${type}`;
export type DiagramQuery = ReturnType<DiagramStore['query']>;
export type DiagramIdentity = SourcePictureKey;
