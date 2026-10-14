import type { IncomingMessage, ServerResponse } from 'node:http';
import { JS_TS_INDEX_BYTES } from '../../src/ts-packet-index.ts';
import { FLV_INDEX_BYTES } from '../../src/flv-index-cache.ts';
import { FFMPEG_INDEX_BYTES } from '../../src/ffmpeg-index-cache.ts';
import { FLV_MEDIA_INDEX_IDENTITY, parseMediaIndexIdentity } from '../../src/media-index-identity.ts';
import type { MediaIndexIdentity, MediaIndexKind } from '../../src/media-index-identity.ts';
import { AdminError, adminWriteAllowed } from '../admin.ts';
import { adminErrorBody } from '../admin-error.ts';
import { sendJson } from '../http-utils.ts';
import type { RouteContext } from './context.ts';
import { INDEX_STREAM_BATCH_BYTES, INDEX_STREAM_LEASE_MS, requestsMediaIndexStream, beginMediaIndexStream,
  writeMediaIndexEvent, sendMediaIndexStream, sendFfmpegRecordStream } from './index-stream.ts';

/** Frame index identity, request limits and response lifecycle belong here.
 * The transport owns NDJSON framing, backpressure, resume and stream leases. */
export async function handleFrameIndexRoute(library: RouteContext['library'], req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const indexMatch = /^\/api\/media\/([0-9a-f]{24})\/frame-index$/.exec(url.pathname);
  if (indexMatch) {
    let indexStreamStarted = false;
    let indexStreamTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      const kindParam = url.searchParams.get('kind') ?? 'flv';
      if (kindParam !== 'flv' && kindParam !== 'ffmpeg' && kindParam !== 'js-ts' && kindParam!=='js-matroska') throw new AdminError(400, '未知帧索引类型。');
      const kind = kindParam as MediaIndexKind;
      let identity: MediaIndexIdentity;
      try {
        identity = kind === 'flv' && !url.searchParams.has('stream') && !url.searchParams.has('schema') && !url.searchParams.has('indexer')
          ? FLV_MEDIA_INDEX_IDENTITY
          : parseMediaIndexIdentity(kind, url.searchParams);
      } catch (error) { throw new AdminError(400, (error as Error).message); }
      if (!['GET', 'POST'].includes(req.method ?? '')) throw new AdminError(405, '不支持的帧索引操作。');
      if (req.method === 'POST' && (kind === 'js-ts'||kind==='js-matroska')) throw new AdminError(405,'JS TS 索引只能由服务端完整扫描构建。');
      if (req.method === 'POST' && !adminWriteAllowed(req, 'frame-index')) throw new AdminError(403, '请从同源播放器提交帧索引。');
      const version = url.searchParams.get('v'), entry = library.metadata(indexMatch[1]);
      if (!version) throw new AdminError(400, '帧索引需要媒体版本。');
      if (!entry || !await library.resolve(indexMatch[1], version)) throw new AdminError(409, '媒体不可用或已改变。');
      const streamingGet = req.method === 'GET' && requestsMediaIndexStream(req);
      let after = -1;
      if (streamingGet && url.searchParams.has('after')) {
        const rawAfter = url.searchParams.get('after')!;
        if (!/^-?\d+$/.test(rawAfter) || !Number.isSafeInteger(Number(rawAfter)) || Number(rawAfter) < -1) {
          throw new AdminError(400, '索引流续传序号无效。');
        }
        after = Number(rawAfter);
      }
      let releaseUpload: (() => void) | undefined;
      try {
        if (req.method === 'GET') {
          const cached = await library.indexJobs.call('has', { id: entry.id, version, identity });
          if (kind === 'ffmpeg' && streamingGet && (cached || url.searchParams.get('build') === '1')) {
            const shouldBuild = !cached && url.searchParams.get('build') === '1';
            const resolvedPath = shouldBuild ? await library.resolve(entry.id, version) : undefined;
            if (shouldBuild && !resolvedPath) throw new AdminError(409, '媒体已改变，未建立旧版本索引。');
            const filePath = resolvedPath ?? undefined;
            const requestedBuildId = url.searchParams.get('buildId') ?? undefined;
            if (requestedBuildId !== undefined && !/^[0-9a-f-]{36}$/i.test(requestedBuildId)) throw new AdminError(400, '索引流 buildId 无效。');
            await sendFfmpegRecordStream(res, library, entry.id, version, identity, after, requestedBuildId,
              shouldBuild, filePath, entry.size);
            return true;
          }
          if (url.searchParams.get('build') === '1' && !cached) {
            const filePath = await library.resolve(entry.id, version);
            if (!filePath) throw new AdminError(409, '媒体已改变，未建立旧版本索引。');
            const epoch = await library.indexJobs.call('epoch');
            if (streamingGet) {
              beginMediaIndexStream(res);
              indexStreamStarted = true;
              indexStreamTimer = setTimeout(() => res.destroy(), INDEX_STREAM_LEASE_MS);
              await writeMediaIndexEvent(res, {
                type: 'manifest', protocol: 1, epoch, kind, state: 'building',
                batchBytes: INDEX_STREAM_BATCH_BYTES,
              });
            }
            let progressTail = Promise.resolve();
            let pendingProgress: { phase: 'scan'; packets: number; scannedBytes: number; totalBytes: number } | undefined;
            let pumpingProgress = false;
            let onProgress: ((progress: {
              phase: 'scan'; packets: number; scannedBytes: number; totalBytes: number;
            }) => void) | undefined;
            if (streamingGet) onProgress = progress => {
              if (res.destroyed) return;
              pendingProgress = progress;
              if (pumpingProgress) return;
              pumpingProgress = true;
              progressTail = progressTail.then(async () => {
                while (pendingProgress && !res.destroyed) {
                  const current = pendingProgress;
                  pendingProgress = undefined;
                  await writeMediaIndexEvent(res, { type: 'progress', ...current });
                }
              }).catch(() => {}).finally(() => {
                pumpingProgress = false;
                if (pendingProgress && !res.destroyed) onProgress?.(pendingProgress);
              });
            };
            const built = await library.indexJobs.buildIndex({
              id: entry.id, version, size: entry.size, filePath, epoch, identity,
            }, { onProgress }) as { built: boolean; epoch: number };
            await progressTail;
            if (built.built && (res.destroyed || !await library.resolve(entry.id, version))) {
              throw new AdminError(409, '媒体已改变，未保存旧索引。');
            }
          }
          const bytes = await library.indexJobs.call('get', { id: entry.id, version, identity });
          if (res.destroyed) return true;
          if (streamingGet) {
            const envelope = JSON.parse(Buffer.from(bytes).toString('utf8')) as { epoch?: unknown };
            if (!Number.isSafeInteger(envelope.epoch) || Number(envelope.epoch) < 0) throw new AdminError(500, '索引缓存 epoch 无效。');
            await sendMediaIndexStream(res, bytes, Number(envelope.epoch), kind, after, indexStreamStarted);
          } else {
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
            await new Promise<void>(resolve => {
              const timer = setTimeout(() => res.destroy(), 30000);
              const done = () => { clearTimeout(timer); res.off('close', done); resolve(); };
              res.once('close', done); res.end(bytes, done);
            });
          }
          return true;
        }
        releaseUpload = library.indexJobs.acquireUpload();
        if (!String(req.headers['content-type']).startsWith('application/json')) throw new AdminError(400, '请提交 JSON 索引。');
        const limit = (kind === 'ffmpeg' ? FFMPEG_INDEX_BYTES : (kind === 'js-ts'||kind==='js-matroska') ? JS_TS_INDEX_BYTES : FLV_INDEX_BYTES) + 1024;
        if (Number(req.headers['content-length']) > limit) throw new AdminError(413, '帧索引过大。');
        const chunks: Buffer[] = []; let size = 0;
        const timeout = setTimeout(() => req.destroy(new Error('索引上传超时。')), 30000);
        try {
          for await (const chunk of req) {
            size += (chunk as Buffer).length;
            if (size > limit) throw new AdminError(413, '帧索引过大。');
            chunks.push(chunk as Buffer);
          }
        } finally { clearTimeout(timeout); }
        const bytes = new Uint8Array(size); let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
        chunks.length = 0;
        if (res.destroyed || !await library.resolve(entry.id, version)) throw new AdminError(409, '媒体已改变，未保存旧索引。');
        const result = await library.indexJobs.call('put', {
          bytes, size: entry.size, id: entry.id, version, identity,
        }, [bytes.buffer]);
        sendJson(res, 201, result);
      } finally {
        releaseUpload?.();
      }
      return true;
    } catch (error) {
      if (indexStreamStarted && !res.destroyed) {
        try {
          await writeMediaIndexEvent(res, { type: 'error', message: (error as Error).message || '服务端索引构建失败。',...(error instanceof AdminError?{code:error.code}:{}) });
          res.end();
        } catch {}
      } else if (!res.headersSent && !res.destroyed) {
        if (error instanceof AdminError && error.status === 503) res.setHeader('retry-after', '1');
        sendJson(res, error instanceof AdminError ? error.status : 500, adminErrorBody(error));
      }
      return true;
    } finally {
      if (indexStreamTimer) clearTimeout(indexStreamTimer);
    }
  }
  return false;
}
