import { MediaOpenError } from './media-errors.ts';
import { BASE_CACHE_BYTES, PlaybackReadAhead } from './playback-read-ahead.ts';

export type RandomAccessInput = { file: Blob } | { url: string; size: number; library?:import('./library-reference-types.ts').LibraryIndexReference };
export interface RangeVersion { validator?: string; ifRange?: string; }
const BLOCK = 256 * 1024;
type ReadAhead = { start: number; end: number; controller: AbortController; pending: boolean; task: Promise<void>; error?: unknown };

/** Bounded compressed-byte cache, shared by async demux and the synchronous AVIO bridge. */
export class RangeReader {
  readonly size: number;
  private cache = new Map<number, Uint8Array>();
  private controller = new AbortController();
  private validator: string | undefined;
  private ifRange: string | undefined;
  private serial: Promise<unknown> = Promise.resolve();
  readonly input: RandomAccessInput;
  private blockSize: number;
  private readAheadBlocks = 1;
  private playbackReadAhead = false;
  private ahead?: ReadAhead;
  private pendingAhead?: ReadAhead;
  private policy: PlaybackReadAhead;
  private playbackPosition?: number;
  constructor(input: RandomAccessInput, blockSize = BLOCK, version?: RangeVersion) {
    this.blockSize = blockSize;
    this.policy = new PlaybackReadAhead(blockSize);
    this.input = input;
    this.size = 'file' in input ? input.file.size : input.size;
    this.validator = version?.validator; this.ifRange = version?.ifRange;
    if (!Number.isSafeInteger(this.size) || this.size <= 0) throw new MediaOpenError('input', '媒体文件长度无效。');
  }
  /** Preserve the source version when a decoder worker is replaced. */
  get version(): RangeVersion { return { validator: this.validator, ifRange: this.ifRange }; }
  /** Cache-only observation: never loads, queues IO, or promotes/evicts blocks. */
  cachedWindows() {
    if (this.controller.signal.aborted) return [];
    return [...this.cache].flatMap(([offset, bytes]) => {
      const windows = [];
      for (let at = 0; at < bytes.length; at += 65536) windows.push({ offset: offset + at, length: Math.min(65536, bytes.length - at) });
      return windows;
    }).sort((a, b) => a.offset - b.offset);
  }
  /** Cache-only observation: never loads, queues IO, or promotes/evicts blocks. */
  peek(offset: number, length: number): Uint8Array | undefined {
    if (this.controller.signal.aborted || !Number.isSafeInteger(offset) || !Number.isSafeInteger(length)
      || offset < 0 || length < 0 || length > 64 * 1024 || offset + length > this.size) return;
    for (let p = Math.floor(offset / this.blockSize) * this.blockSize; p < offset + length; p += this.blockSize) {
      if (!this.cache.has(p)) return;
    }
    const output = new Uint8Array(length);
    for (let position = offset; position < offset + length;) {
      const start = Math.floor(position / this.blockSize) * this.blockSize;
      const bytes = this.cache.get(start)!;
      const count = Math.min(bytes.length - (position - start), offset + length - position);
      output.set(bytes.subarray(position - start, position - start + count), position - offset);
      position += count;
    }
    return output;
  }
  protected setReadAheadBlocks(blocks: number) { this.readAheadBlocks = Math.max(1, Math.min(blocks, Math.floor(BASE_CACHE_BYTES / this.blockSize))); }
  /** Cache-only diagnostics. Refill time includes callback scheduling; growth
   * additionally requires actual input starvation, never presentation waiting. */
  readAheadSnapshot() {
    return {...this.policy.snapshot(),enabled:this.playbackReadAhead,
      cachedBytes:[...this.cache.values()].reduce((sum,bytes) => sum+bytes.length,0),
      inFlightBytes:this.pendingAhead?.pending ? this.pendingAhead.end-this.pendingAhead.start : 0};
  }
  /** Only sequential playback opts in. Each consumed window can start one
   * bounded fetch; an idle/paused consumer never keeps filling the cache. */
  setPlaybackReadAhead(enabled: boolean) {
    this.playbackReadAhead = enabled;
    if (!this.playbackReadAhead) {
      this.ahead?.controller.abort();
      this.ahead = undefined;
      this.playbackPosition = undefined;
      this.policy = new PlaybackReadAhead(this.blockSize);
      this.trimCache();
    }
  }
  read(offset: number, length: number): Promise<Uint8Array> {
    const run = async () => {
      const bytes = await this.readInner(offset, length);
      if (this.playbackReadAhead && length) {
        this.playbackPosition = offset+length-1;
        this.policy.consumed(offset+length,performance.now());
        this.trimCache();
      }
      if (length) this.prefetchAfter(offset + length);
      return bytes;
    };
    // A slow background scan must not hold already cached startup frames
    // behind a pending network request. Cache hits need no IO serialization.
    if (!this.controller.signal.aborted && Number.isSafeInteger(offset) && Number.isSafeInteger(length)
      && offset >= 0 && length >= 0 && length <= 64 * 1024 * 1024 && offset + length <= this.size) {
      let cached = true;
      for (let p = Math.floor(offset / this.blockSize) * this.blockSize; p < offset + length; p += this.blockSize) {
        if (!this.cache.has(p)) { cached = false; break; }
      }
      if (cached) return run();
    }
    const task = this.serial.then(run);
    this.serial = task.catch(() => {});
    return task;
  }
  /** Sparse fragment metadata must not fetch a 256 KiB payload block for each
   * moof header. Reuse already cached bytes, otherwise load only the requested
   * range with the same version, bounds and cancellation checks. */
  readMetadata(offset: number, length: number): Promise<Uint8Array> {
    const run = async () => {
      if (this.controller.signal.aborted) throw new MediaOpenError('input', '媒体读取已取消。');
      if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > this.size)
        throw new MediaOpenError('input', '媒体读取范围越界。');
      if (length > 24 * 1024 * 1024) throw new MediaOpenError('resource', '单次 metadata 读取超过上限。');
      if (!length) return new Uint8Array();
      const bytes = this.peek(offset, length) ?? await this.load(offset, offset + length);
      if (this.controller.signal.aborted) throw new MediaOpenError('input', '媒体读取已取消。');
      return bytes;
    };
    const task = this.serial.then(run); this.serial = task.catch(() => {}); return task;
  }
  private async readInner(offset: number, length: number): Promise<Uint8Array> {
    if (this.controller.signal.aborted) throw new MediaOpenError('input', '媒体读取已取消。');
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > this.size) throw new MediaOpenError('input', '媒体读取范围越界。');
    if (length > 64 * 1024 * 1024) throw new MediaOpenError('resource', '单次媒体读取超过 64 MiB 上限。');
    if (this.playbackReadAhead && length) this.policy.begin(offset,performance.now());
    const output = new Uint8Array(length);
    for (let position = offset; position < offset + length;) {
      if (this.playbackReadAhead) this.playbackPosition = position;
      const start = Math.floor(position / this.blockSize) * this.blockSize;
      let bytes = this.cache.get(start);
      const ahead = this.ahead;
      if (!bytes && ahead && start >= ahead.start && start < ahead.end) {
        // Join the speculative request instead of fetching the same bytes twice.
        const waitedAt = performance.now();
        await ahead.task;
        if (this.controller.signal.aborted || ahead.controller.signal.aborted) throw new MediaOpenError('input', '媒体读取已取消。');
        if (ahead.error) throw ahead.error;
        if (this.playbackReadAhead) this.policy.waited(performance.now()-waitedAt,performance.now());
        bytes = this.cache.get(start);
      }
      if (!bytes) {
        // Coalesce scan windows into one request, keeping the same bounded
        // block cache and all Range/version/body checks. Never prefetch during
        // ordinary playback unless the caller explicitly enables it.
        const required = Math.ceil((offset+length-start)/this.blockSize);
        const blocks = this.playbackReadAhead ? Math.max(this.readAheadBlocks,Math.min(required,this.policy.batchBytes/this.blockSize))
          : this.readAheadBlocks;
        let end = Math.min(start+this.blockSize*blocks,this.size);
        if (ahead?.pending && ahead.start > start) end = Math.min(end,ahead.start);
        if (this.playbackReadAhead) for (let at = start+this.blockSize; at < end; at += this.blockSize) {
          if (this.cache.has(at)) { end = at; break; }
        }
        const waitedAt = performance.now();
        const window = await this.load(start, end);
        if (this.controller.signal.aborted) throw new MediaOpenError('input', '媒体读取已取消。');
        if (this.playbackReadAhead) this.policy.waited(performance.now()-waitedAt,performance.now());
        this.cacheWindow(start, window);
        bytes = this.cache.get(start)!;
      }
      this.cache.delete(start); this.cache.set(start, bytes);
      this.trimCache();
      const count = Math.min(bytes.length - (position - start), offset + length - position);
      output.set(bytes.subarray(position - start, position - start + count), position - offset);
      position += count;
    }
    return output;
  }
  private cacheWindow(start: number, window: Uint8Array) {
    for (let at = 0; at < window.length; at += this.blockSize) {
      // Copy blocks so an evicted window cannot stay pinned by one slice.
      this.cache.delete(start + at);
      this.cache.set(start + at, window.slice(at, at + this.blockSize));
      this.trimCache();
    }
  }
  private trimCache() {
    const limit = this.playbackReadAhead ? this.policy.cacheBytes : BASE_CACHE_BYTES;
    while (this.cache.size > limit / this.blockSize) {
      let victim = this.cache.keys().next().value!;
      if (this.playbackPosition !== undefined) {
        const current = Math.floor(this.playbackPosition/this.blockSize)*this.blockSize;
        const end = current+this.policy.lowWaterBytes+this.policy.batchBytes+this.blockSize;
        let consumed = false;
        for (const start of this.cache.keys()) {
          if (start < current) { victim = start; consumed = true; break; }
        }
        if (!consumed) for (const start of this.cache.keys()) {
          if (start >= end) { victim = start; break; }
        }
      }
      this.cache.delete(victim);
    }
  }
  private prefetchAfter(position: number) {
    if (!this.playbackReadAhead || this.controller.signal.aborted || this.pendingAhead?.pending || this.ahead?.error) return;
    let start = Math.ceil(position / this.blockSize) * this.blockSize;
    while (this.cache.has(start)) start += this.blockSize;
    // Keep roughly one complete request available for decoding while the next
    // is in flight, including on links only moderately faster than the media.
    if (start >= this.size || start - position >= this.policy.lowWaterBytes) return;
    let end = Math.min(start + this.policy.batchBytes, this.size);
    for (let at = start + this.blockSize; at < end; at += this.blockSize) {
      if (this.cache.has(at)) { end = at; break; }
    }
    const ahead: ReadAhead = { start, end, controller: new AbortController(), pending: true, task: Promise.resolve() };
    this.ahead = this.pendingAhead = ahead;
    ahead.task = (async () => {
      try {
        const started = performance.now();
        const bytes = await this.load(start, end, ahead.controller.signal);
        if (this.ahead === ahead && !ahead.controller.signal.aborted && !this.controller.signal.aborted) {
          this.policy.refilled(bytes.length,performance.now()-started);
          this.cacheWindow(start, bytes);
        }
      } catch (error) {
        // Preserve failures for the first actual consumer of this range, with
        // no detached rejection or automatic retry of a changed source.
        if (!ahead.controller.signal.aborted) ahead.error = error;
      } finally {
        ahead.pending = false;
        if (this.pendingAhead === ahead) this.pendingAhead = undefined;
      }
    })();
  }
  private async load(start: number, end: number, signal = this.controller.signal): Promise<Uint8Array> {
    try {
      signal.throwIfAborted();
      if ('file' in this.input) {
        const bytes = new Uint8Array(await this.input.file.slice(start, end).arrayBuffer());
        signal.throwIfAborted();
        if (bytes.length !== end - start) throw new MediaOpenError('input', '文件读取被截断。');
        return bytes;
      }
      const response = await fetch(this.input.url, { headers: { Range: `bytes=${start}-${end - 1}`, ...(this.ifRange ? { 'If-Range': this.ifRange } : {}) }, signal });
      signal.throwIfAborted();
      const validator = response.headers.get('etag') ?? response.headers.get('last-modified') ?? undefined;
      if (response.status !== 206 || response.headers.get('content-range') !== `bytes ${start}-${end - 1}/${this.size}` || (this.validator && validator !== this.validator)) {
        await response.body?.cancel();
        throw new MediaOpenError('input', `媒体服务必须提供正确的 HTTP Range 响应，且文件不能在播放中改变（${response.status}）。`);
      }
      this.validator ??= validator;
      // Weak ETags are useful for change detection but invalid in If-Range.
      this.ifRange ??= response.headers.get('etag')?.startsWith('W/')
        ? response.headers.get('last-modified') ?? undefined : validator;
      const declared = response.headers.get('content-length');
      if (declared !== null && Number(declared) !== end - start) {
        await response.body?.cancel(); throw new MediaOpenError('input', 'Range 响应长度与声明不一致。');
      }
      const reader = response.body?.getReader();
      if (!reader) throw new MediaOpenError('input', 'Range 响应为空。');
      const bytes = new Uint8Array(end - start);
      let count = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (count + value.length > bytes.length) throw new MediaOpenError('input', 'Range 响应超过请求范围。');
          bytes.set(value, count); count += value.length;
        }
        if (count !== bytes.length) throw new MediaOpenError('input', 'Range 响应被截断。');
        return bytes;
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    } catch (error) {
      if (error instanceof MediaOpenError) throw error;
      throw new MediaOpenError('input', `读取媒体失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  close() { this.setPlaybackReadAhead(false); this.controller.abort(); this.cache.clear(); }
}
