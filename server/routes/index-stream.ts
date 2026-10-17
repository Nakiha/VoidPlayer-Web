import type { IncomingMessage, ServerResponse } from 'node:http';
import { FFMPEG_INDEX_RECORD_BYTES, lastFfmpegPts, FFMPEG_NO_TIMESTAMP } from '../../shared/media/indexing/ffmpeg-index-cache.ts';
import type { MediaIndexIdentity } from '../../shared/media/indexing/media-index-identity.ts';
import { AdminError } from '../admin.ts';
import type { RouteContext } from './context.ts';

export const INDEX_STREAM_BATCH_BYTES = 64 * 1024;
export const INDEX_STREAM_LEASE_MS = 90_000;

export function requestsMediaIndexStream(req: IncomingMessage): boolean {
  return String(req.headers.accept ?? '').split(',').some(value => value.trim().split(';', 1)[0] === 'application/x-ndjson');
}

export async function writeMediaIndexEvent(res: ServerResponse, event: unknown): Promise<void> {
  if (res.destroyed) throw new Error('索引客户端已断开。');
  if (res.write(JSON.stringify(event) + '\n')) return;
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => { res.off('drain', onDrain); res.off('close', onClose); };
    const onDrain = () => { cleanup(); resolve(); };
    const onClose = () => { cleanup(); reject(new Error('索引客户端已断开。')); };
    res.once('drain', onDrain);
    res.once('close', onClose);
    if (res.destroyed) onClose();
  });
}

export function beginMediaIndexStream(res: ServerResponse) {
  res.writeHead(200, {
    'content-type': 'application/x-ndjson; charset=utf-8',
    'cache-control': 'no-store',
    'x-accel-buffering': 'no',
  });
}

export async function sendMediaIndexStream(
  res: ServerResponse,
  bytes: Uint8Array,
  epoch: number,
  kind: string,
  after: number,
  alreadyStarted = false,
): Promise<void> {
  const lastSeq = Math.ceil(bytes.byteLength / INDEX_STREAM_BATCH_BYTES) - 1;
  if (after > lastSeq) throw new AdminError(416, '索引流续传序号超过当前索引。');
  if (res.destroyed) return;
  if (!alreadyStarted) beginMediaIndexStream(res);
  const timeout = setTimeout(() => res.destroy(), INDEX_STREAM_LEASE_MS);
  try {
    await writeMediaIndexEvent(res, {
      type: 'manifest', protocol: 1, epoch, kind,
      encoding: 'json-utf8-base64', state: 'complete',
      totalBytes: bytes.byteLength, batchBytes: INDEX_STREAM_BATCH_BYTES, lastSeq,
    });
    for (let seq = after + 1; seq <= lastSeq; seq++) {
      const start = seq * INDEX_STREAM_BATCH_BYTES;
      const end = Math.min(bytes.byteLength, start + INDEX_STREAM_BATCH_BYTES);
      const data = Buffer.from(bytes.subarray(start, end)).toString('base64');
      await writeMediaIndexEvent(res, { type: 'batch', seq, safePresentationUs: null, data });
      await writeMediaIndexEvent(res, {
        type: 'progress', phase: 'transfer', seq, bytesSent: end, totalBytes: bytes.byteLength,
      });
    }
    await writeMediaIndexEvent(res, { type: 'complete', lastSeq, totalBytes: bytes.byteLength });
  } catch {
    if (!res.destroyed) {
      try { await writeMediaIndexEvent(res, { type: 'error', message: '索引传输中断，可从最后收到的序号续传。' }); } catch {}
    }
  } finally {
    clearTimeout(timeout);
  }
  if (res.destroyed) return;
  await new Promise<void>(resolve => {
    const done = () => { res.off('finish', done); res.off('close', done); resolve(); };
    res.once('finish', done);
    res.once('close', done);
    res.end();
  });
}

function ticksToUs(ticks: bigint, num: number, den: number): number {
  return Math.floor(Number(ticks) * 1_000_000 * num / den);
}

export async function sendFfmpegRecordStream(
  res: ServerResponse,
  library: RouteContext['library'],
  id: string,
  version: string,
  identity: MediaIndexIdentity,
  after: number,
  requestedBuildId: string | undefined,
  startBuild: boolean,
  filePath?: string,
  size?: number,
): Promise<void> {
  let wakeListener: (() => void) | undefined;
  let wakePromise: Promise<void> | undefined;
  const wake = () => { wakeListener?.(); wakeListener = undefined; wakePromise = undefined; };
  const waitForChange = () => {
    if (!wakePromise) wakePromise = new Promise<void>(resolve => { wakeListener = resolve; });
    return Promise.race([wakePromise, new Promise<void>(resolve => setTimeout(resolve, 1000))]);
  };
  let build: ReturnType<RouteContext['library']['indexJobs']['startBuild']> | undefined;
  let buildError: Error | undefined;
  let buildAlreadyPresent = false;
  if (startBuild) {
    if (!filePath || size === undefined) throw new AdminError(409, '媒体已改变，未建立旧版本索引。');
    build = library.indexJobs.startBuild({ id, version, size, filePath,
      epoch: await library.indexJobs.call('epoch'), identity }, { onUpdate: wake });
    void build.promise.then((value: { built?: boolean }) => { if (!value?.built) buildAlreadyPresent = true; wake(); }, error => {
      buildError = error instanceof Error ? error : new Error(String(error)); wake();
    });
  }
  if (!res.headersSent) beginMediaIndexStream(res);
  const streamTimer = setTimeout(() => res.destroy(), INDEX_STREAM_LEASE_MS);
  let seq = after;
  let sentManifest = false, sentFinalManifest = false;
  let sentReset = false;
  let sentScanProgress = -1;
  let lastKnownTick: bigint | undefined;
  try {
    for (;;) {
      if (res.destroyed) return;
      const snapshot = await library.indexJobs.call('stream-manifest', { id, version, identity });
      const manifest = snapshot.manifest;
      if (manifest && manifest.metadata && (!build || manifest.buildId === build.buildId || buildAlreadyPresent)) {
        if (requestedBuildId && requestedBuildId !== manifest.buildId && !sentReset) {
          await writeMediaIndexEvent(res, { type: 'reset', protocol: 2, buildId: manifest.buildId });
          sentReset = true;
          seq = -1;
          lastKnownTick = undefined;
        }
        if (seq > manifest.lastSeq) throw new AdminError(416, '索引流续传序号超过当前 build。');
        if (!sentManifest || (manifest.complete && !sentFinalManifest)) {
          await writeMediaIndexEvent(res, {
            type: 'manifest', protocol: 2, epoch: snapshot.epoch, kind: 'ffmpeg', encoding: 'ffmpeg-records-base64',
            state: manifest.state, buildId: manifest.buildId, identity, metadata: manifest.metadata,
            recordBytes: FFMPEG_INDEX_RECORD_BYTES, lastSeq: manifest.lastSeq, frames: manifest.frames,
            scannedBytes: manifest.scannedBytes, stablePresentationUs: manifest.stablePresentationUs,
          });
          sentManifest = true;
          sentFinalManifest = manifest.complete;
        }
        if (!manifest.complete && manifest.scannedBytes > 0 && manifest.scannedBytes !== sentScanProgress && size && size > 0) {
          sentScanProgress = manifest.scannedBytes;
          await writeMediaIndexEvent(res, { type: 'progress', phase: 'scan', packets: manifest.packets,
            scannedBytes: manifest.scannedBytes, totalBytes: size });
        }
        const page = await library.indexJobs.call('stream-batches', { id, version, identity, after: seq, limit: 16 });
        for (const row of page) {
          if (row.seq !== seq + 1) throw new AdminError(500, '服务端索引 batch 序号不连续。');
          const records = Buffer.from(row.payload, 'base64');
          if (!row.frames || records.byteLength !== row.frames * FFMPEG_INDEX_RECORD_BYTES) throw new AdminError(500, '服务端索引 batch 长度无效。');
          let lastPts = lastFfmpegPts(records, lastKnownTick);
          // Resume may begin inside an untimed tail: recover its finite frontier.
          if (lastPts === FFMPEG_NO_TIMESTAMP && lastKnownTick === undefined) {
            for (let previousSeq = seq; previousSeq >= 0 && lastPts === FFMPEG_NO_TIMESTAMP; previousSeq--) {
              const previous = await library.indexJobs.call('stream-batches', { id, version, identity, after: previousSeq - 1, limit: 1 });
              if (previous[0]?.seq !== previousSeq) throw new AdminError(500, '服务端索引续传缺少前序 batch。');
              lastPts = lastFfmpegPts(Buffer.from(previous[0].payload, 'base64'));
            }
          }
          lastKnownTick = lastPts;
          const firstPts = BigInt(String(manifest.metadata.firstPts ?? '0'));
          const timeBaseNum = Number(manifest.metadata.timeBaseNum), timeBaseDen = Number(manifest.metadata.timeBaseDen);
          const safePresentationUs = lastPts === FFMPEG_NO_TIMESTAMP ? 0 : Math.max(0, ticksToUs(lastPts - firstPts, timeBaseNum, timeBaseDen));
          await writeMediaIndexEvent(res, { type: 'batch', buildId: manifest.buildId, seq: row.seq,
            count: row.frames, safePresentationUs, data: row.payload });
          seq = row.seq;
        }
        if (manifest.state === 'failed' || buildError) {
          throw buildError ?? new AdminError(500, 'FFmpeg 索引扫描失败。');
        }
        if (manifest.complete && seq === manifest.lastSeq) {
          await writeMediaIndexEvent(res, { type: 'complete', buildId: manifest.buildId, lastSeq: manifest.lastSeq,
            frames: manifest.frames, stablePresentationUs: manifest.stablePresentationUs });
          break;
        }
      } else if (buildError) {
        throw buildError;
      } else if (manifest && manifest.complete && !manifest.metadata) {
        // Older complete documents remain readable through the legacy transport.
        const bytes = await library.indexJobs.call('get', { id, version, identity });
        const envelope = JSON.parse(Buffer.from(bytes).toString('utf8')) as { epoch?: unknown };
        if (!Number.isSafeInteger(envelope.epoch)) throw new AdminError(500, '索引缓存 epoch 无效。');
        await sendMediaIndexStream(res, bytes, Number(envelope.epoch), 'ffmpeg', after, true);
        return;
      }
      await waitForChange();
    }
  } catch (error) {
    if (!res.destroyed) {
      try { await writeMediaIndexEvent(res, { type: 'error', buildId: build?.buildId, message: (error as Error).message }); } catch {}
    }
  } finally {
    clearTimeout(streamTimer);
    build?.unsubscribe();
  }
  if (res.destroyed) return;
  await new Promise<void>(resolve => {
    const done = () => { res.off('finish', done); res.off('close', done); resolve(); };
    res.once('finish', done);
    res.once('close', done);
    res.end();
  });
}
