import { FFMPEG_INDEX_RECORD_BYTES, FFMPEG_INDEX_RECORD_LIMIT, FFMPEG_NO_TIMESTAMP, ffmpegTicksToUs } from '../ffmpeg-index-cache.ts';
import { createSourceQuerier, toSample } from './adapters.ts';
import type { PacketView, SourceQueryContext } from './adapters.ts';
import type { AnalysisAxis, AnalysisQuery, AnalysisResult, AnalysisSample } from './types.ts';

export interface FfmpegAnalysisSummary { packetCount: number; hasDts: boolean }

/** Read-only view of the same records imported by the playback core. No IO or decoding. */
export class FfmpegPacketIndex {
  private packets: PacketView[] = [];
  private byOrdinal = new Map<number, number>();
  private missingPts = { sampleCount: 0, totalBytes: 0 };
  private missingDts = { sampleCount: 0, totalBytes: 0 };
  private querier = createSourceQuerier();

  append(records: Uint8Array, num: number, den: number): void {
    if (!Number.isSafeInteger(num) || num <= 0 || !Number.isSafeInteger(den) || den <= 0
      || this.packets.length + records.byteLength / FFMPEG_INDEX_RECORD_BYTES > FFMPEG_INDEX_RECORD_LIMIT
      || records.byteLength % FFMPEG_INDEX_RECORD_BYTES) throw new Error('FFmpeg 包索引记录长度无效。');
    const view = new DataView(records.buffer, records.byteOffset, records.byteLength);
    const added: PacketView[] = [], ordinals = new Set<number>();
    for (let offset = 0; offset < records.byteLength; offset += FFMPEG_INDEX_RECORD_BYTES) {
      const ticks = view.getBigInt64(offset, true), dts = view.getBigInt64(offset + 8, true);
      const ordinal = Number(view.getBigUint64(offset + 40, true));
      const size = view.getInt32(offset + 32, true);
      if (!Number.isSafeInteger(ordinal) || ordinal < 0 || ordinal >= FFMPEG_INDEX_RECORD_LIMIT || size < 0
        || ordinals.has(ordinal) || this.byOrdinal.has(ordinal)) throw new Error('FFmpeg 包索引身份无效或重复。');
      ordinals.add(ordinal);
      added.push({ ordinal, size, key: (view.getUint32(offset + 36, true) & 1) !== 0,
        pts: ticks === FFMPEG_NO_TIMESTAMP ? null : ffmpegTicksToUs(ticks, num, den),
        dts: dts === FFMPEG_NO_TIMESTAMP ? null : ffmpegTicksToUs(dts, num, den) });
    }
    for (const packet of added) {
      this.byOrdinal.set(packet.ordinal!, this.packets.length);
      this.packets.push(packet);
      if (packet.pts == null) { this.missingPts.sampleCount++; this.missingPts.totalBytes += packet.size; }
      if (packet.dts == null) { this.missingDts.sampleCount++; this.missingDts.totalBytes += packet.size; }
    }
  }

  get summary(): FfmpegAnalysisSummary {
    return { packetCount: this.packets.length, hasDts: this.packets.length > 0 && this.missingDts.sampleCount === 0 };
  }

  query(ctx: SourceQueryContext, query: AnalysisQuery & { requestId: number }): AnalysisResult {
    const untimed = query.axis === 'pts' ? this.missingPts : this.missingDts;
    const result = this.querier(this.packets, {
      ...ctx, sourceVersion: `${ctx.mediaId}@${this.packets.length}`, indexRevision: this.packets.length,
      // Missing axis timestamps make full-window byte coverage unknown.
      coverageUs: untimed.sampleCount ? null : ctx.coverageUs,
    }, query);
    return { ...result, untimed: { ...untimed } };
  }

  locate(mediaId: string, firstPtsUs: number, sampleId: string): AnalysisSample | null {
    const prefix = `${mediaId}:v:`;
    if (!sampleId.startsWith(prefix)) return null;
    const ordinal = Number(sampleId.slice(prefix.length));
    if (!Number.isSafeInteger(ordinal) || sampleId !== `${prefix}${ordinal}`) return null;
    const position = this.byOrdinal.get(ordinal);
    return position === undefined ? null : toSample(this.packets, { mediaId, firstPtsUs }, position);
  }

  rank(firstPtsUs: number, axis: AnalysisAxis, tUs: number) {
    return this.querier.rank(this.packets, firstPtsUs, axis, tUs);
  }

  sampleAtNumber(firstPtsUs: number, axis: AnalysisAxis, number: number): number | null {
    if (axis === 'pts') return this.querier.sampleAtNumber(this.packets, firstPtsUs, axis, number);
    const position = this.byOrdinal.get(number);
    const pts = position === undefined ? null : this.packets[position].pts;
    return pts == null ? null : pts - firstPtsUs;
  }
}
