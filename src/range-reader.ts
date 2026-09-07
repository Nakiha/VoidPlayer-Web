import { MediaOpenError } from './media-errors.ts';

export type RandomAccessInput = { file: Blob } | { url: string; size: number };
const BLOCK = 256 * 1024;
const CACHE_BYTES = 8 * 1024 * 1024;

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
  constructor(input: RandomAccessInput, blockSize = BLOCK) {
    this.blockSize = blockSize;
    this.input = input;
    this.size = 'file' in input ? input.file.size : input.size;
    if (!Number.isSafeInteger(this.size) || this.size <= 0) throw new MediaOpenError('input', '媒体文件长度无效。');
  }
  read(offset: number, length: number): Promise<Uint8Array> {
    const task = this.serial.then(() => this.readInner(offset, length));
    this.serial = task.catch(() => {});
    return task;
  }
  private async readInner(offset: number, length: number): Promise<Uint8Array> {
    if (this.controller.signal.aborted) throw new MediaOpenError('input', '媒体读取已取消。');
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > this.size) throw new MediaOpenError('input', '媒体读取范围越界。');
    if (length > 64 * 1024 * 1024) throw new MediaOpenError('resource', '单次媒体读取超过 64 MiB 上限。');
    const output = new Uint8Array(length);
    for (let position = offset; position < offset + length;) {
      const start = Math.floor(position / this.blockSize) * this.blockSize;
      let bytes = this.cache.get(start);
      if (!bytes) bytes = await this.load(start, Math.min(start + this.blockSize, this.size));
      this.cache.delete(start); this.cache.set(start, bytes);
      while (this.cache.size > CACHE_BYTES / this.blockSize) this.cache.delete(this.cache.keys().next().value!);
      const count = Math.min(bytes.length - (position - start), offset + length - position);
      output.set(bytes.subarray(position - start, position - start + count), position - offset);
      position += count;
    }
    return output;
  }
  private async load(start: number, end: number): Promise<Uint8Array> {
    try {
      if ('file' in this.input) return new Uint8Array(await this.input.file.slice(start, end).arrayBuffer());
      const response = await fetch(this.input.url, { headers: { Range: `bytes=${start}-${end - 1}`, ...(this.ifRange ? { 'If-Range': this.ifRange } : {}) }, signal: this.controller.signal });
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
  close() { this.controller.abort(); this.cache.clear(); }
}
