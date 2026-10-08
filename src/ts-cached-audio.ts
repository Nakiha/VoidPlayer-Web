import { aacConfig } from './flv-cached-audio.ts';
import type { CachedAudioBatch, CachedAudioConfig, CachedWindow } from './audio-types.ts';
import type { AudioPeek } from './cached-container-audio.ts';

/** AAC/ADTS in cached TS packets. Only scans video-owned windows, never seeks IO. */
export class TsCachedAudio {
  private pmt?: number;
  private pid?: number;
  private config?: CachedAudioConfig;
  private disabled = false;
  private cursor = 0;
  private peek: AudioPeek;
  private windows: () => Promise<CachedWindow[]>;
  constructor(peek: AudioPeek, windows: () => Promise<CachedWindow[]>) { this.peek = peek; this.windows = windows; }
  async read(ptsUs: number): Promise<CachedAudioBatch> {
    if (this.disabled) return { packets: [] };
    const ranges = await this.windows(), packets: CachedAudioBatch['packets'] = [];
    if (!ranges.length) return { packets };
    // Revisit startup for PAT/PMT, then rotate through a fixed cache-only budget.
    const chosen = [ranges[0]];
    for (let n = 0; n < Math.min(7, ranges.length); n++) chosen.push(ranges[this.cursor++ % ranges.length]);
    chosen.sort((a, b) => a.offset - b.offset);
    let parts: Uint8Array[] = [], pesTime: number | undefined, previousEnd = -1, continuity: number | undefined;
    const flush = () => {
      if (pesTime === undefined || !parts.length) { parts = []; return; }
      const data = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
      let at = 0; for (const p of parts) { data.set(p, at); at += p.length; }
      let time = pesTime;
      for (let p = 0; p + 7 <= data.length && packets.length < 24;) {
        if (data[p] !== 255 || (data[p + 1] & 0xf6) !== 0xf0) { p++; continue; }
        const frequency = (data[p + 2] >> 2) & 15, objectType = (data[p + 2] >> 6) + 1;
        const channels = ((data[p + 2] & 1) << 2) | (data[p + 3] >> 6);
        const config = aacConfig(Uint8Array.of((objectType << 3) | (frequency >> 1), ((frequency & 1) << 7) | (channels << 3)));
        const length = ((data[p + 3] & 3) << 11) | (data[p + 4] << 3) | (data[p + 5] >> 5), header = data[p + 1] & 1 ? 7 : 9;
        if (!config || (data[p + 6] & 3) || length <= header || length > 16384 || p + length > data.length) break;
        if (this.config && config.description.some((byte, i) => byte !== this.config!.description[i])) {
          this.disabled = true; break;
        }
        this.config = config;
        const durationUs = Math.round(1024 / config.sampleRate * 1e6);
        if (time + durationUs > ptsUs - 100000 && time <= ptsUs + 400000)
          packets.push({ ptsUs: Math.round(time), durationUs, data: data.slice(p + header, p + length) });
        time += 1024 / config.sampleRate * 1e6; p += length;
      }
      parts = []; pesTime = undefined;
    };
    for (const range of [...new Map(chosen.map(r => [r.offset, r])).values()]) {
      const bytes = await this.peek(range.offset, Math.min(range.length, 65536)); if (!bytes) continue;
      if (range.offset !== previousEnd) { parts = []; pesTime = undefined; continuity = undefined; }
      previousEnd = range.offset + bytes.length;
      let sync = -1, stride = 188;
      findSync: for (let p = 0; p < Math.min(204, bytes.length); p++) for (const step of [188, 192, 204])
        if (bytes[p] === 0x47 && bytes[p + step] === 0x47 && bytes[p + step * 2] === 0x47) { sync = p; stride = step; break findSync; }
      if (sync < 0) continue;
      for (let start = sync; start + 188 <= bytes.length; start += stride) {
        if (bytes[start] !== 0x47 || bytes[start + 1] & 0x80 || bytes[start + 3] & 0xc0) continue;
        const pid = ((bytes[start + 1] & 31) << 8) | bytes[start + 2], unit = !!(bytes[start + 1] & 64);
        const adaptation = (bytes[start + 3] >> 4) & 3, count = bytes[start + 3] & 15;
        if (!(adaptation & 1)) continue;
        let p = start + 4; if (adaptation & 2) p += 1 + bytes[p];
        const end = start + 188; if (p >= end) continue;
        if ((pid === 0 || pid === this.pmt) && unit) {
          p += 1 + bytes[p]; if (p + 12 > end) continue;
          const sectionEnd = p + 3 + (((bytes[p + 1] & 15) << 8) | bytes[p + 2]) - 4;
          if (sectionEnd > end) continue;
          if (pid === 0 && bytes[p] === 0) {
            for (let q = p + 8; q + 4 <= sectionEnd; q += 4) if (bytes[q] || bytes[q + 1]) { this.pmt = ((bytes[q + 2] & 31) << 8) | bytes[q + 3]; break; }
          } else if (bytes[p] === 2) {
            let q = p + 12 + (((bytes[p + 10] & 15) << 8) | bytes[p + 11]);
            while (q + 5 <= sectionEnd) {
              if (bytes[q] === 0x0f) { this.pid = ((bytes[q + 1] & 31) << 8) | bytes[q + 2]; break; }
              q += 5 + (((bytes[q + 3] & 15) << 8) | bytes[q + 4]);
            }
          }
          continue;
        }
        if (pid !== this.pid) continue;
        if (continuity !== undefined && count !== (continuity + 1) % 16) { parts = []; pesTime = undefined; }
        continuity = count;
        if (unit) {
          flush();
          if (p + 14 > end || bytes[p] || bytes[p + 1] || bytes[p + 2] !== 1 || !(bytes[p + 7] & 128)) continue;
          const t = p + 9;
          if (!(bytes[t] & 1) || !(bytes[t + 2] & 1) || !(bytes[t + 4] & 1)) continue;
          let ticks = ((bytes[t] & 14) * 536870912) + bytes[t + 1] * 4194304 + (bytes[t + 2] & 254) * 16384 + bytes[t + 3] * 128 + (bytes[t + 4] >> 1);
          const targetTicks = ptsUs * 0.09; ticks += Math.round((targetTicks - ticks) / 8589934592) * 8589934592;
          pesTime = ticks / 0.09; p += 9 + bytes[p + 8];
        }
        if (pesTime !== undefined && p < end) {
          if (parts.length < 128) parts.push(bytes.subarray(p, end)); else { parts = []; pesTime = undefined; }
        }
      }
    }
    flush(); packets.sort((a, b) => a.ptsUs - b.ptsUs);
    if (this.disabled) return { packets: [] };
    return { config: this.config, packets };
  }
}
