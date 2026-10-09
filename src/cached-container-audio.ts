import { Input, CustomSource, MP4, QTFF, MATROSKA, WEBM, MPEG_TS, EncodedPacketSink, MpegTsInputFormat } from 'mediabunny';
import type { CachedAudioBatch, CachedAudioConfig, CachedWindow } from './audio-types.ts';

export type AudioPeek = (offset: number, length: number) => Promise<Uint8Array | undefined>;
import { TsCachedAudio } from './ts-cached-audio.ts';
class CacheMiss extends Error {}

/** Runs in a separate optional worker. The only byte API observes the video cache.
 * No URL/Blob source, decoder, full packet iteration or media IO is available. */
export class CachedContainerAudio {
  private input?: Input;
  private ts?: TsCachedAudio;
  private sink?: EncodedPacketSink;
  private config?: CachedAudioConfig;
  private budget = 0;
  private calls = 0;
  private retryAt = 0;
  private size: number;
  private peek: AudioPeek;
  private windows: () => Promise<CachedWindow[]>;
  constructor(size: number, peek: AudioPeek, windows: () => Promise<CachedWindow[]> = async () => [], container?: string) {
    this.size = size; this.peek = peek; this.windows = windows;
    if (container === 'mpegts') this.ts = new TsCachedAudio(peek, windows);
  }
  private createInput() {
    return new Input({ formats: [MP4, QTFF, MATROSKA, WEBM, MPEG_TS], source: new CustomSource({
      getSize: () => this.size, maxCacheSize: 0,
      read: async (start, end) => {
        const length = end - start;
        if (!Number.isSafeInteger(length) || length < 0 || length > this.budget || ++this.calls > 128) throw new CacheMiss();
        this.budget -= length;
        const parts: Uint8Array[] = [];
        for (let at = start; at < end; at += 65536) {
          const bytes = await this.peek(at, Math.min(65536, end - at));
          if (!bytes) throw new CacheMiss();
          parts.push(bytes);
        }
        const result = new Uint8Array(length); let at = 0;
        for (const bytes of parts) { result.set(bytes, at); at += bytes.length; }
        return result;
      },
    }) });
  }
  async read(ptsUs: number): Promise<CachedAudioBatch> {
    const packets: CachedAudioBatch['packets'] = [];
    if (!Number.isSafeInteger(ptsUs) || performance.now() < this.retryAt) return { packets };
    this.budget = this.sink ? 512 * 1024 : 4 * 1024 * 1024; this.calls = 0;
    try {
      if (this.ts) return await this.ts.read(ptsUs);
      if (!this.sink) {
        this.input ??= this.createInput();
        if (await this.input.getFormat() instanceof MpegTsInputFormat) {
          this.ts ??= new TsCachedAudio(this.peek, this.windows); return await this.ts.read(ptsUs);
        }
        const track = await this.input.getPrimaryAudioTrack();
        const config = await track?.getDecoderConfig();
        if (!track || !config || config.numberOfChannels > 2) { this.retryAt = Infinity; return { packets }; }
        const raw = config.description;
        const description = !raw ? new Uint8Array() : ArrayBuffer.isView(raw)
          ? new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength).slice() : new Uint8Array(raw).slice();
        this.config = { codec: config.codec, sampleRate: config.sampleRate, numberOfChannels: config.numberOfChannels, description };
        this.sink = new EncodedPacketSink(track);
      }
      let packet = await this.sink.getPacket(Math.max(0, ptsUs - 100000) / 1e6);
      packet ??= await this.sink.getFirstPacket();
      for (let n = 0; packet && n < 24; n++) {
        const timestamp = Math.round(packet.timestamp * 1e6), duration = Math.round(packet.duration * 1e6);
        if (timestamp > ptsUs + 400000) break;
        if (packet.data.length > 16384) break;
        if (timestamp + duration > ptsUs - 100000) packets.push({ ptsUs: timestamp, durationUs: duration, data: packet.data.slice() });
        packet = await this.sink.getNextPacket(packet);
      }
    } catch {
      // Failed initialization promises cannot be reused when video later fills a gap.
      if (!this.sink) { this.input?.dispose(); this.input = undefined; this.retryAt = performance.now() + 500; }
    }
    return { config: this.config, packets };
  }
  dispose() { this.input?.dispose(); this.input = undefined; this.sink = undefined; this.config = undefined; this.ts = undefined; }
}
