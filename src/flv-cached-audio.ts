import type { FlvIndex } from './flv-demux.ts';
import type { CachedAudioBatch, CachedAudioConfig } from './audio-types.ts';

type CachedBytes = { peek(offset: number, length: number): Uint8Array | undefined };
const u24 = (b: Uint8Array, p: number) => b[p] * 65536 + b[p + 1] * 256 + b[p + 2];
const u32 = (b: Uint8Array) => (b[0] * 16777216 + u24(b, 1));
const rates = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

/** V1 deliberately accepts AAC-LC only; unsupported audio never invokes a fallback. */
export function aacConfig(description: Uint8Array): CachedAudioConfig | undefined {
  if (description.length < 2 || description.length > 64) return;
  const objectType = description[0] >> 3;
  const sampleRate = rates[((description[0] & 7) << 1) | (description[1] >> 7)];
  const channels = (description[1] >> 3) & 15;
  // PCE, explicit rates, HE-AAC, surround layouts and short frames need additional parsing.
  if (objectType !== 2 || !sampleRate || channels < 1 || channels > 2 || (description[1] & 7)) return;
  return { codec: 'mp4a.40.2', sampleRate, numberOfChannels: channels, description: description.slice() };
}

/** Traverses known tag boundaries in already cached blocks, with fixed work/output budgets.
 * No scan, cache mutation, IO or audio index is possible through this interface. */
export class FlvCachedAudio {
  private config?: CachedAudioConfig;
  private configurationChanged = false;
  private bytes: CachedBytes;
  constructor(bytes: CachedBytes) { this.bytes = bytes; }
  private tag(offset: number) {
    const header = this.bytes.peek(offset, 11);
    if (!header || ![8, 9, 18].includes(header[0]) || u24(header, 8) !== 0) return;
    const size = u24(header, 1), end = offset + 15 + size;
    const footer = this.bytes.peek(end - 4, 4);
    if (!footer || u32(footer) !== size + 11) return;
    return { type: header[0], size, start: offset + 11, end,
      ptsUs: (u24(header, 4) + header[7] * 16777216) * 1000 };
  }
  private configuration(tag: NonNullable<ReturnType<FlvCachedAudio['tag']>>) {
    if (tag.type !== 8 || tag.size < 4 || tag.size > 66) return;
    const data = this.bytes.peek(tag.start, tag.size);
    if (!data || data[0] >> 4 !== 10 || data[1] !== 0 || this.configurationChanged) return;
    const next = aacConfig(data.subarray(2));
    if (this.config && (!next || next.description.length !== this.config.description.length
      || next.description.some((value, i) => value !== this.config!.description[i]))) {
      // A video-only index cannot recover historical audio configurations on seek.
      // Stop optional audio for this source rather than decode with the wrong ASC.
      this.configurationChanged = true; this.config = undefined;
    } else this.config = next;
  }
  /** Keep only the tiny ASC before video playback can evict startup blocks. */
  prime() {
    const header = this.bytes.peek(0, 9);
    if (!header || String.fromCharCode(...header.subarray(0, 3)) !== 'FLV') return;
    let offset = u32(header.subarray(5)) + 4;
    for (let n = 0; n < 128 && offset < 64 * 1024; n++) {
      const tag = this.tag(offset); if (!tag) break;
      this.configuration(tag); if (this.config) break;
      offset = tag.end;
    }
  }
  read(index: FlvIndex, ptsUs: number): CachedAudioBatch {
    if (!Number.isSafeInteger(ptsUs)) return { packets: [] };
    if (!this.config) this.prime();
    // Use the existing presentation index to find a preceding video tag. No audio index.
    let lo = 0, hi = index.order.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (index.packets[index.order[m]].pts <= ptsUs - 100000) lo = m + 1; else hi = m; }
    const packet = index.packets[index.order[Math.max(0, lo - 1)]];
    if (!packet) return { config: this.config, packets: [] };
    let offset: number | undefined;
    for (const skip of [5, 8]) {
      const candidate = packet.offset - 11 - skip, tag = this.tag(candidate);
      if (tag?.type === 9 && tag.start + skip === packet.offset && tag.size - skip === packet.size) { offset = candidate; break; }
    }
    const packets: CachedAudioBatch['packets'] = [];
    if (offset === undefined) return { config: this.config, packets };
    const limit = offset + 512 * 1024;
    for (let n = 0; n < 512 && offset < limit && packets.length < 24; n++) {
      const tag = this.tag(offset); if (!tag) break;
      this.configuration(tag);
      if (tag.type === 8 && this.config && tag.size > 2 && tag.size <= 16 * 1024
        && tag.ptsUs >= ptsUs - 100000 && tag.ptsUs <= ptsUs + 400000) {
        const data = this.bytes.peek(tag.start, tag.size);
        if (data && data[0] >> 4 === 10 && data[1] === 1) {
          packets.push({ ptsUs: tag.ptsUs, durationUs: Math.round(1024 / this.config.sampleRate * 1e6), data: data.slice(2) });
        }
      }
      if (tag.ptsUs > ptsUs + 500000) break;
      offset = tag.end;
    }
    return { config: this.config, packets: this.config ? packets : [] };
  }
}
