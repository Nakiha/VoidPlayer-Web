import type { MediaSource } from './media.ts';
import type { AudioStatus, CachedAudioBatch, CachedAudioConfig } from './audio-types.ts';

// WebCodecs audio is not in every TypeScript DOM declaration or browser.
interface AudioFrame {
  timestamp: number; sampleRate: number; numberOfChannels: number; numberOfFrames: number;
  copyTo(destination: Float32Array, options: { planeIndex: number; format: 'f32-planar' }): void;
  close(): void;
}
interface Decoder {
  state: string; decodeQueueSize: number;
  configure(config: CachedAudioConfig): void; decode(chunk: unknown): void; close(): void;
}
interface AudioPlatform {
  AudioContext?: new () => AudioContext;
  AudioDecoder?: {
    new (init: { output(frame: AudioFrame): void; error(error: unknown): void }): Decoder;
    isConfigSupported(config: CachedAudioConfig): Promise<{ supported?: boolean }>;
  };
  EncodedAudioChunk?: new (init: { type: 'key'; timestamp: number; duration: number; data: Uint8Array }) => unknown;
}
type Pcm = { ptsUs: number; buffer: AudioBuffer };

/** One optional output, driven by the video session clock. All requests are fire-and-forget
 * cache observations. Missing/unsupported audio never changes video state or its clock. */
export class OpportunisticAudio {
  status: AudioStatus = 'muted';
  playedPackets = 0;
  private context?: AudioContext;
  private source?: MediaSource;
  private decoder?: Decoder;
  private decoderKey = '';
  private configuring = false;
  private generation = 0;
  private decoderGeneration = 0;
  private offsetUs = 0;
  private positionUs = 0;
  private advancing = false;
  private requestMs = -Infinity;
  private submittedUs = -Infinity;
  private pcm: Pcm[] = [];
  private nodes = new Map<AudioBufferSourceNode, Pcm>();
  private disposed = false;
  private changed: () => void;
  private platform: AudioPlatform;
  constructor(changed: () => void = () => {}, platform: AudioPlatform = globalThis as unknown as AudioPlatform) {
    this.changed = changed; this.platform = platform;
  }
  private setStatus(status: AudioStatus) {
    if (this.status !== status) { this.status = status; this.changed(); }
  }
  /** Must run synchronously inside the speaker click, before any await. */
  select(source?: MediaSource) {
    this.pause();
    if (this.source) this.source.onCachedAudio = undefined;
    this.source = source;
    if (!source) { void this.context?.suspend?.().catch(() => {}); this.setStatus('muted'); return; }
    this.playedPackets = 0;
    if (!source.requestCachedAudio || !this.platform.AudioContext || !this.platform.AudioDecoder || !this.platform.EncodedAudioChunk) {
      this.setStatus('unsupported'); return;
    }
    try {
      this.context ??= new this.platform.AudioContext();
      const context = this.context, generation = this.generation;
      // User activation is available here; the playback loop never tries to unlock audio.
      void context.resume().then(() => {
        if (!this.disposed && this.source === source && this.generation === generation)
          this.setStatus(context.state === 'running' ? 'waiting' : 'blocked');
      }, () => { if (this.generation === generation) this.setStatus('blocked'); });
      source.onCachedAudio = (generation, batch) => {
        if (this.source === source && generation === this.generation && this.advancing) void this.receive(batch, generation);
      };
      this.setStatus('waiting');
    } catch { this.setStatus('unsupported'); }
  }
  private clearNodes(requeue: boolean) {
    for (const [node, item] of this.nodes) {
      node.onended = null;
      try { node.stop(); } catch {}
      node.disconnect();
      if (requeue && item.ptsUs + item.buffer.duration * 1e6 > this.positionUs) this.pcm.push(item);
    }
    this.nodes.clear(); this.pcm.sort((a, b) => a.ptsUs - b.ptsUs);
  }
  pause() {
    ++this.generation; ++this.decoderGeneration;
    this.advancing = false; this.configuring = false;
    this.clearNodes(false); this.pcm = [];
    try { this.decoder?.close(); } catch {}
    this.decoder = undefined; this.decoderKey = '';
    this.submittedUs = -Infinity; this.requestMs = -Infinity;
    if (this.source && this.status !== 'unsupported' && this.status !== 'blocked') this.setStatus('waiting');
  }
  tick(positionUs: number, offsetUs: number, advancing: boolean) {
    if (!this.source || !this.context || this.disposed || this.status === 'unsupported' || this.status === 'blocked') return;
    this.positionUs = positionUs; this.offsetUs = offsetUs; this.advancing = advancing;
    if (!advancing || positionUs < offsetUs || positionUs >= offsetUs + this.source.info.durationUs) {
      this.clearNodes(true); this.setStatus('waiting'); return;
    }
    if (this.context.state !== 'running') { this.setStatus('blocked'); return; }
    const now = performance.now();
    if (now - this.requestMs >= 80) {
      this.requestMs = now;
      try { this.source.requestCachedAudio?.(positionUs - offsetUs, this.generation); } catch { /* optional */ }
    }
    this.schedule();
  }
  private async receive(batch: CachedAudioBatch, generation: number) {
    const config = batch.config, context = this.context;
    if (!config || !context || !batch.packets.length || this.configuring || this.disposed) return;
    const key = `${config.codec}/${config.sampleRate}/${config.numberOfChannels}/${Array.from(config.description)}`;
    if (key !== this.decoderKey) {
      this.configuring = true;
      try {
        const supported = await this.platform.AudioDecoder!.isConfigSupported(config);
        if (generation !== this.generation || this.disposed) return;
        if (!supported.supported) { this.setStatus('unsupported'); return; }
        ++this.decoderGeneration;
        const decoderGeneration = this.decoderGeneration;
        try { this.decoder?.close(); } catch {}
        this.clearNodes(false); this.pcm = []; this.submittedUs = -Infinity;
        this.decoder = new this.platform.AudioDecoder!({
          output: frame => {
            try {
              if (generation !== this.generation || decoderGeneration !== this.decoderGeneration || this.disposed) return;
              if (frame.timestamp + frame.numberOfFrames / frame.sampleRate * 1e6 <= this.positionUs
                || frame.timestamp > this.positionUs + 500000 || this.pcm.length >= 32) return;
              const buffer = context.createBuffer(frame.numberOfChannels, frame.numberOfFrames, frame.sampleRate);
              for (let channel = 0; channel < frame.numberOfChannels; channel++)
                frame.copyTo(buffer.getChannelData(channel), { planeIndex: channel, format: 'f32-planar' });
              this.pcm.push({ ptsUs: frame.timestamp, buffer });
              this.pcm.sort((a, b) => a.ptsUs - b.ptsUs);
            } catch { if (generation === this.generation) this.setStatus('unsupported'); }
            finally { frame.close(); }
          },
          error: () => { if (generation === this.generation && decoderGeneration === this.decoderGeneration) {
            this.clearNodes(false); this.pcm = []; this.setStatus('unsupported');
          } },
        });
        this.decoder.configure(config); this.decoderKey = key;
      } catch { if (generation === this.generation) this.setStatus('unsupported'); }
      finally { if (generation === this.generation) this.configuring = false; }
    }
    if (generation !== this.generation || !this.decoder || this.decoder.state === 'closed' || this.status === 'unsupported') return;
    for (const packet of batch.packets) {
      const ptsUs = packet.ptsUs - this.source!.info.firstPtsUs + this.offsetUs;
      if (ptsUs <= this.submittedUs || ptsUs + packet.durationUs <= this.positionUs || ptsUs > this.positionUs + 400000) continue;
      if (this.decoder.decodeQueueSize >= 24) break;
      try {
        this.decoder.decode(new this.platform.EncodedAudioChunk!({ type: 'key', timestamp: ptsUs, duration: packet.durationUs, data: packet.data }));
        this.submittedUs = ptsUs;
      } catch { this.setStatus('unsupported'); break; }
    }
  }
  private schedule() {
    const context = this.context!;
    while (this.pcm.length) {
      const item = this.pcm[0], endUs = item.ptsUs + item.buffer.duration * 1e6;
      if (endUs <= this.positionUs) { this.pcm.shift(); continue; }
      if (item.ptsUs > this.positionUs + 60000 || this.nodes.size >= 8) break;
      this.pcm.shift();
      const node = context.createBufferSource(); node.buffer = item.buffer;
      node.connect(context.destination); this.nodes.set(node, item);
      node.onended = () => { this.nodes.delete(node); node.disconnect(); };
      const delay = Math.max(0, (item.ptsUs - this.positionUs) / 1e6);
      const offset = Math.max(0, (this.positionUs - item.ptsUs) / 1e6);
      try { node.start(context.currentTime + delay, offset); ++this.playedPackets; }
      catch { this.nodes.delete(node); node.disconnect(); }
    }
    this.setStatus(this.nodes.size ? 'playing' : 'waiting');
  }
  dispose() {
    this.select(); this.disposed = true;
    void this.context?.close().catch(() => {}); this.context = undefined;
  }
}
