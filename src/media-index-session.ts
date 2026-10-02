import { FFMPEG_INDEX_BYTES } from './ffmpeg-index-cache.ts';
import { MediaIndexClient } from './media-index-client.ts';
import type { MediaIndexClientTrace, MediaIndexRecordBatch, MediaIndexRecordManifest, MediaIndexScanProgress } from './media-index-types.ts';
import type { MediaIndexIdentity } from './media-index-identity.ts';

export type MediaIndexSessionState = 'building' | 'complete' | 'error';

export interface MediaIndexSession {
  readonly identity: MediaIndexIdentity | null;
  readonly state: MediaIndexSessionState;
  readonly firstPtsUs: number | null;
  readonly durationUs: number | null;
  readonly stableCoverageUs: number;
  ensure(targetUs?: number): Promise<void>;
  updateCoverage(stableCoverageUs: number, durationUs?: number): void;
  markComplete(durationUs: number): void;
  fail(message: string, notifySink?: boolean): void;
  onChange(listener: () => void): () => void;
  dispose(): void;
}

export interface ContainerSession {
  readonly container: 'ffmpeg';
  readonly index: MediaIndexSession;
  dispose(): void;
}

export interface FfmpegIndexRecordSink {
  manifest(manifest: MediaIndexRecordManifest, trace: MediaIndexClientTrace): void;
  batch(batch: MediaIndexRecordBatch, trace: MediaIndexClientTrace): void;
  complete(manifest: MediaIndexRecordManifest, frames: number, trace: MediaIndexClientTrace): void;
  legacy(index: unknown, trace: MediaIndexClientTrace): void;
  fallback(): void;
  progress(progress: MediaIndexScanProgress): void;
  error(message: string): void;
}

/** Main-thread owner for a server FFmpeg index stream. It shares validated
 * container records with a decoder sink but owns transport lifetime itself. */
export class FfmpegMediaIndexSession implements MediaIndexSession {
  readonly container = 'ffmpeg' as const;
  private client: MediaIndexClient;
  private listeners = new Set<() => void>();
  private currentState: MediaIndexSessionState = 'building';
  private currentFirstPtsUs: number | null;
  private currentDurationUs: number | null;
  private currentStableCoverageUs: number;
  private currentIdentity: MediaIndexIdentity | null;
  private disposed = false;
  private sink: FfmpegIndexRecordSink;
  private currentError?: string;

  constructor(options: {
    url?: string;
    identity: MediaIndexIdentity;
    firstPtsUs: number;
    durationUs: number;
    sink: FfmpegIndexRecordSink;
  }) {
    this.sink = options.sink;
    this.currentIdentity = options.identity;
    this.currentFirstPtsUs = options.firstPtsUs;
    this.currentDurationUs = options.durationUs;
    this.currentStableCoverageUs = Math.max(1, options.durationUs);
    this.client = new MediaIndexClient(options.url, 'ffmpeg', FFMPEG_INDEX_BYTES + 1024, 120_000, true, options.identity,
      progress => { options.sink.progress(progress); this.notify(); },
      manifest => {
        this.currentIdentity = manifest.identity;
        const firstPts = Number(BigInt(String(manifest.metadata.firstPts)));
        const num = Number(manifest.metadata.timeBaseNum), den = Number(manifest.metadata.timeBaseDen);
        if (Number.isFinite(firstPts) && num > 0 && den > 0) this.currentFirstPtsUs = Math.round(firstPts * 1_000_000 * num / den);
        options.sink.manifest(manifest, this.client.diagnostics());
        this.notify();
      },
      batch => {
        // Transport receipt is diagnostic progress only. Seek coverage advances
        // exclusively when the decoder acknowledges importing these records.
        options.sink.batch(batch, this.client.diagnostics());
        this.notify();
      },
      (manifest, frames) => options.sink.complete(manifest, frames, this.client.diagnostics()));

    void this.client.read().then(index => {
      if (this.disposed) return;
      if (!index) {
        options.sink.fallback();
      } else if ((index as { streamed?: unknown }).streamed !== true) {
        options.sink.legacy(index, this.client.diagnostics());
      }
    }, error => {
      if (!this.disposed) this.fail(error instanceof Error ? error.message : String(error));
    });
  }

  get identity() { return this.currentIdentity; }
  get state() { return this.currentState; }
  get error() { return this.currentError; }
  get firstPtsUs() { return this.currentFirstPtsUs; }
  get durationUs() { return this.currentDurationUs; }
  get stableCoverageUs() { return this.currentStableCoverageUs; }

  ensure(targetUs = Infinity): Promise<void> {
    if (this.disposed) return Promise.reject(new Error('媒体已释放。'));
    if (this.currentState === 'error' && targetUs >= this.currentStableCoverageUs) {
      return Promise.reject(new Error(this.currentError ?? 'FFmpeg 索引失败。'));
    }
    if (this.currentState !== 'building' || targetUs < this.currentStableCoverageUs) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const check = () => {
        if (this.disposed) { off(); reject(new Error('媒体已释放。')); }
        else if (this.currentState === 'error' && targetUs >= this.currentStableCoverageUs) { off(); reject(new Error(this.currentError ?? 'FFmpeg 索引失败。')); }
        else if (this.currentState !== 'building' || targetUs < this.currentStableCoverageUs) { off(); resolve(); }
      };
      const off = this.onChange(check);
    });
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  updateCoverage(stableCoverageUs: number, durationUs?: number) {
    if (this.disposed || this.currentState !== 'building' || !Number.isFinite(stableCoverageUs) || stableCoverageUs < 0) return;
    this.currentStableCoverageUs = Math.max(this.currentStableCoverageUs, stableCoverageUs);
    if (durationUs !== undefined && Number.isFinite(durationUs)) this.currentDurationUs = Math.max(this.currentDurationUs ?? 0, durationUs);
    this.notify();
  }

  markComplete(durationUs: number) {
    if (this.disposed || this.currentState !== 'building') return;
    this.currentState = 'complete';
    this.currentDurationUs = Math.max(1, durationUs);
    this.currentStableCoverageUs = Math.max(this.currentStableCoverageUs, this.currentDurationUs);
    this.notify();
  }

  diagnostics() { return this.client.diagnostics(); }

  fail(message: string, notifySink = true) {
    if (this.disposed || this.currentState !== 'building') return;
    this.currentState = 'error';
    this.currentError = message;
    this.client.close();
    if (notifySink) this.sink.error(message);
    this.notify();
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.client.close();
    this.notify();
    this.listeners.clear();
  }

  private notify() { for (const listener of this.listeners) { try { listener(); } catch {} } }
}

export class FfmpegContainerSession implements ContainerSession {
  readonly container = 'ffmpeg' as const;
  readonly index: MediaIndexSession;
  constructor(index: MediaIndexSession) { this.index = index; }
  dispose() { this.index.dispose(); }
}
