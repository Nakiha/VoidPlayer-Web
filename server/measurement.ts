import { randomBytes, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { AdminError } from './admin-error.ts';
import { MediaLibraryIndex, fileVersion } from './library.ts';

const MiB = 1024 * 1024;
export type MeasurementKind = 'download' | 'upload' | 'storage' | 'concurrent';
export type MeasurementResult = {
  id: string; kind: MeasurementKind; owner: string;
  state: 'preparing' | 'running' | 'stopping' | 'completed' | 'cancelled' | 'failed';
  seconds: number; limitBytes: number; concurrency: number; startedAt: string;
  bytes: number; requests: number; errors: number; elapsedMs: number; activeRequests: number;
  reason?: 'duration' | 'limit' | 'user' | 'client' | 'error' | 'shutdown'; error?: string;
  media?: { id: string; name: string; root: string; size: number; version: string };
  client?: { bytes: number; requests: number; elapsedMs: number };
};
type Job = { result: MeasurementResult; controller: AbortController; timer: ReturnType<typeof setTimeout>; at: number; reserved: number; offset: number; preparing: boolean; file?: string; data?: Buffer; done: Promise<void>; resolve: () => void };
export const measurementActive = (r: MeasurementResult) => ['preparing', 'running', 'stopping'].includes(r.state);

/** One bounded, explicitly started task per server. Results live for this process
 * only. Storage uses normal cached reads; it never writes or drops OS caches. */
export class Measurements {
  private library: MediaLibraryIndex;
  private job: Job | null = null;
  private closed = false;
  constructor(library: MediaLibraryIndex) { this.library = library; }
  status() {
    if (!this.job) return { job: null };
    const { result, at } = this.job;
    return { job: { ...result, elapsedMs: measurementActive(result) ? Math.max(0, performance.now() - at) : result.elapsedMs } };
  }
  start(input: unknown, owner: string) {
    if (this.closed) throw new AdminError(503, '服务正在关闭。');
    if (this.job && measurementActive(this.job.result)) throw new AdminError(409, '已有测速任务，请等待完成或由发起者取消。');
    const value = input as { kind?: MeasurementKind; seconds?: number; limitMiB?: number; mediaId?: string; version?: string } | null;
    if (!value || !['download', 'upload', 'storage', 'concurrent'].includes(value.kind!) || ![5, 10, 15].includes(value.seconds!) || ![64, 256, 1024].includes(value.limitMiB!)) throw new AdminError(400, '请选择测速类型、5/10/15 秒时长与 64/256/1024 MiB 上限。');
    const kind = value.kind!;
    const media = ['storage', 'concurrent'].includes(kind) ? this.library.metadata(value.mediaId ?? '') : null;
    if (['storage', 'concurrent'].includes(kind) && (!media || media.state !== 'ready' || media.size <= 0 || !media.version || media.version !== value.version)) throw new AdminError(409, '请选择当前可读的非空媒体，文件版本改变后需要重新选择。');
    let resolve!: () => void;
    const done = new Promise<void>(r => { resolve = r; });
    const job: Job = {
      result: { id: randomUUID(), kind, owner, state: 'preparing', seconds: value.seconds!, limitBytes: value.limitMiB! * MiB, concurrency: kind === 'concurrent' ? 4 : 1, startedAt: new Date().toISOString(), bytes: 0, requests: 0, errors: 0, elapsedMs: 0, activeRequests: 0, ...(media ? { media: { id: media.id, name: media.name, root: media.root, size: media.size, version: media.version! } } : {}) },
      controller: new AbortController(), at: performance.now(), reserved: 0, offset: 0, preparing: true, done, resolve,
      timer: setTimeout(() => this.stop(job, 'error', '准备媒体超时。'), 5000),
    };
    job.timer.unref(); this.job = job;
    void this.prepare(job);
    return this.status();
  }
  private async prepare(job: Job) {
    try {
      if (job.result.media) {
        job.file = await this.library.resolve(job.result.media.id, job.result.media.version) ?? undefined;
        if (!job.file) throw new Error('媒体已离线或发生改变，请重新选择。');
      } else if (job.result.kind === 'download') job.data = randomBytes(MiB);
      if (job.controller.signal.aborted) return;
      clearTimeout(job.timer); job.at = performance.now(); job.result.startedAt = new Date().toISOString(); job.result.state = 'running';
      job.timer = setTimeout(() => this.stop(job, 'duration'), job.result.seconds * 1000); job.timer.unref();
      if (job.result.kind === 'storage') await this.storage(job);
    } catch (error) { if (!job.controller.signal.aborted) this.stop(job, 'error', (error as Error).message); }
    finally { job.preparing = false; this.settle(job); }
  }
  private settle(job: Job) {
    if (!job.result.reason || job.preparing || job.result.activeRequests) return;
    clearTimeout(job.timer);
    job.result.state = job.result.reason === 'error' ? 'failed' : ['user', 'shutdown'].includes(job.result.reason) ? 'cancelled' : 'completed';
    job.result.elapsedMs = Math.max(0, performance.now() - job.at);
    job.data = undefined; job.resolve();
  }
  private stop(job: Job, reason: MeasurementResult['reason'], error?: string, abort = true) {
    if (!measurementActive(job.result)) return;
    if (!job.result.reason) { if (reason === 'error') job.result.errors++; job.result.reason = reason; job.result.error = error; job.result.state = 'stopping'; }
    if (abort) job.controller.abort();
    this.settle(job);
  }
  private owned(id: string, owner: string) {
    if (!this.job || this.job.result.id !== id) throw new AdminError(404, '测速任务不存在或已被新的任务替代。');
    if (this.job.result.owner !== owner) throw new AdminError(403, '只有发起者可以操作此测速任务。');
    return this.job;
  }
  cancel(id: string, owner: string) { this.stop(this.owned(id, owner), 'user'); return this.status(); }
  finish(id: string, owner: string, input: unknown) {
    const job = this.owned(id, owner), value = input as MeasurementResult['client'];
    if (job.result.kind === 'storage') throw new AdminError(400, '存储任务由服务器完成。');
    if (!value || !Number.isSafeInteger(value.bytes) || value.bytes < 0 || value.bytes > job.reserved || !Number.isSafeInteger(value.requests) || value.requests < 0 || value.requests > job.result.requests || !Number.isFinite(value.elapsedMs) || value.elapsedMs <= 0 || value.elapsedMs > (job.result.seconds + 30) * 1000) throw new AdminError(400, '浏览器测量结果无效。');
    if (job.result.activeRequests) throw new AdminError(409, '仍有读取正在结束，请稍后完成。');
    job.result.client = { bytes: value.bytes, requests: value.requests, elapsedMs: value.elapsedMs };
    this.stop(job, 'client'); return this.status();
  }
  private reserve(job: Job, size: number) {
    if (job.result.state !== 'running') throw new AdminError(410, '测速已结束。');
    if (job.result.activeRequests >= job.result.concurrency) throw new AdminError(429, '已达到本次任务的并发数。');
    if (size <= 0 || job.reserved + size > job.result.limitBytes) { this.stop(job, 'limit', undefined, false); throw new AdminError(410, '已达到数据量上限。'); }
    job.reserved += size; job.result.activeRequests++;
  }
  private release(job: Job) {
    job.result.activeRequests--;
    if (job.reserved >= job.result.limitBytes) this.stop(job, 'limit', undefined, false);
    this.settle(job);
  }
  private async read(job: Job, size: number) {
    const media = job.result.media!;
    const position = job.offset, length = Math.min(size, media.size - position);
    job.offset = (position + length) % media.size;
    const handle = await fs.open(job.file!, 'r');
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || fileVersion(stat) !== media.version) throw new Error('媒体已改变，停止测量。');
      const data = Buffer.allocUnsafe(length);
      let read = 0;
      while (read < length && !job.controller.signal.aborted) {
        const part = await handle.read(data, read, length - read, position + read);
        if (!part.bytesRead) throw new Error('媒体在读取过程中被截断。');
        read += part.bytesRead;
      }
      job.controller.signal.throwIfAborted();
      if (fileVersion(await handle.stat()) !== media.version) throw new Error('媒体已改变，停止测量。');
      return data;
    } finally { await handle.close(); }
  }
  private async storage(job: Job) {
    // A shared descriptor is not retained across loops: every block revalidates
    // the selected media version, just as a fresh HTTP Range request does.
    while (job.result.state === 'running' && !job.controller.signal.aborted) {
      const size = Math.min(MiB, job.result.media!.size - job.offset, job.result.limitBytes - job.reserved);
      this.reserve(job, size);
      try { const data = await this.read(job, size); job.result.bytes += data.length; job.result.requests++; }
      finally { this.release(job); }
    }
  }
  async transfer(req: IncomingMessage, res: ServerResponse, id: string, owner: string) {
    const job = this.owned(id, owner);
    if (job.result.kind === 'storage') throw new AdminError(400, '存储任务不接受客户端传输。');
    const upload = job.result.kind === 'upload';
    const length = Number(req.headers['content-length'] ?? 0);
    if (upload && (req.headers['content-type'] !== 'application/octet-stream' || !Number.isSafeInteger(length) || length < 1 || length > MiB)) throw new AdminError(400, '上传测试每次提交 1–1048576 字节二进制数据。');
    if (!upload && (length || req.headers['transfer-encoding'])) throw new AdminError(400, '下载测试不接受请求正文。');
    const size = upload ? length : Math.min(MiB, job.result.media ? job.result.media.size - job.offset : MiB, job.result.limitBytes - job.reserved);
    this.reserve(job, size);
    const disconnected = () => { if (!res.writableFinished) this.stop(job, 'user'); };
    res.once('close', disconnected);
    const interrupted = () => {
      // Aborting IncomingMessage through pipeline alone can leave the HTTP
      // socket alive with an unfinished body. Cancel the connection explicitly.
      if (job.result.reason !== 'error' || res.headersSent) { req.destroy(); res.destroy(); }
    };
    job.controller.signal.addEventListener('abort', interrupted, { once: true });
    try {
      if (upload) {
        let received = 0;
        await pipeline(req, new Writable({ write(chunk: Buffer, _encoding, next) { received += chunk.length; next(received > size ? new Error('上传数据超过本次请求上限。') : undefined); } }), { signal: job.controller.signal });
        if (received !== size) throw new Error('上传测试数据不完整。');
        job.result.bytes += received; job.result.requests++;
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify({ bytes: received }));
      } else {
        const data = job.result.kind === 'concurrent' ? await this.read(job, size) : job.data!.subarray(0, size);
        job.controller.signal.throwIfAborted();
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': data.length, 'cache-control': 'no-store, no-transform', 'content-encoding': 'identity', 'x-voidplayer-measurement': job.result.id });
        await pipeline(Readable.from([data]), res, { signal: job.controller.signal });
        job.result.bytes += data.length; job.result.requests++;
      }
    } catch (error) {
      if (!job.controller.signal.aborted) { this.stop(job, 'error', (error as Error).message); }
      if (!res.headersSent && !res.destroyed) { res.setHeader('connection', 'close'); throw error; }
    } finally { job.controller.signal.removeEventListener('abort', interrupted); res.removeListener('close', disconnected); this.release(job); }
  }
  async close() { this.closed = true; if (this.job) { this.stop(this.job, 'shutdown'); await this.job.done; } }
}
