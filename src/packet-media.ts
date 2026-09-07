import { loadAborted, onLoadAbort } from './media-abort.ts';
import { randomUUID } from './uuid.ts';
import { MediaOpenError } from './media-errors.ts';
import { VideoSample } from 'mediabunny';
import { WorkerRpc, floorIndex, nextIndex, WASM_CORE_GLUE_PATH, WASM_CORE_GLUE_PATH_MT, reserveFallbackThreads } from './ffmpeg-media.ts';
import type { FallbackDeps } from './ffmpeg-media.ts';
import type { MediaMeta, MediaSource, DecodedFrame } from './media.ts';
import type { FlvInput } from './flv-demux.ts';
import type { FlvFrame } from './flv-decoder.ts';
import { contextLog } from './log.ts';
import type { MediaInfo } from './model.ts';

export async function openPacketMedia(container: 'flv' | 'mp4', input: FlvInput, meta: MediaMeta, deps: FallbackDeps & { forceWasm?: boolean } = {}): Promise<MediaSource> {
  loadAborted(deps.signal);
  const reservation = reserveFallbackThreads();
  let rpc: WorkerRpc | undefined;
  try {
    const single = deps.glueURL ?? new URL(WASM_CORE_GLUE_PATH, document.baseURI).href;
    const candidates = !deps.glueURL && !deps.wasmBinary && globalThis.crossOriginIsolated && typeof SharedArrayBuffer !== 'undefined'
      ? [new URL(WASM_CORE_GLUE_PATH_MT, document.baseURI).href, single] : [single];
    type Init = Pick<MediaInfo, 'color' | 'colorSource' | 'pixelFormat' | 'decodedPixelFormat' | 'hardwareAcceleration'> & { codec: string; decoder: 'webcodecs' | 'ffmpeg-wasm'; width: number; height: number; firstPtsUs: number; durationUs: number; times: number[]; durations: number[] };
    let init: Init | undefined, selected = single, failure: unknown;
    for (const glueURL of candidates) {
      loadAborted(deps.signal);
      const worker = deps.workerFactory ? deps.workerFactory() : typeof Worker !== 'undefined'
        ? new Worker(new URL('./packet-worker.ts', import.meta.url), { type: 'module' })
        : new (await import('node:worker_threads')).Worker(new URL('./packet-worker.ts', import.meta.url)) as unknown as Worker;
      rpc = new WorkerRpc(worker, undefined, deps.onProgress);
      const currentRpc = rpc;
      const detachAbort = onLoadAbort(deps.signal, () => currentRpc.terminate(deps.signal!.reason));
      try {
        deps.onProgress?.('inspect');
        init = await rpc.call<Init>('init', { input, glueURL, wasmBinary: deps.wasmBinary, forceWasm: deps.forceWasm, container, threads: reservation.threads }, [], glueURL.includes('core-mt.') ? 10000 : 60000);
        selected = glueURL; break;
      } catch (error) {
        rpc.terminate(); failure = error;
        loadAborted(deps.signal);
        if (error instanceof MediaOpenError && error.stage !== 'decode') throw error;
      } finally { detachAbort(); }
    }
    if (!init || !rpc) throw failure;
    const activeRpc = rpc;
    if (init.decoder === 'webcodecs') reservation.release();
    const { times, durations, ...details } = init;
    const info = { id: randomUUID(), name: meta.name, size: meta.size, lastModified: meta.lastModified, ...details, ...(init.decoder === 'ffmpeg-wasm' ? { coreVariant: selected.includes('core-mt.') ? 'multi-thread' as const : 'single-thread' as const } : {}) };
    contextLog().info('media', `${container.toUpperCase()} 已通过 TS 解封装载入`, { name: meta.name, codec: init.codec, decoder: init.decoder, packets: times.length, io: 'file' in input ? 'blob-chunks' : 'http-range' });
    let disposed = false, spare: ArrayBuffer | undefined;
    let serial = Promise.resolve();
    const extract = (position: number): Promise<DecodedFrame> => {
      const task = serial.then(async () => {
        if (disposed) throw new Error('媒体已释放。');
        const recycle = spare; spare = undefined;
        const frame = await activeRpc.call<FlvFrame>('extract', { position, recycle }, recycle ? [recycle] : []);
        if (disposed) { frame.frame?.close(); throw new Error('媒体已释放。'); }
        const sample = frame.frame ? new VideoSample(frame.frame) : undefined;
        const pixels = frame.pixels ? new Uint8ClampedArray(frame.pixels) : undefined;
        let closed = false;
        return { kind: sample ? 'video-sample' : 'rgba8', width: frame.width, height: frame.height,
          ptsUs: times[position], sourcePtsUs: frame.pts, durationUs: durations[position],
          byteSize: frame.width * frame.height * 4, sample, pixels,
          close() { if (closed) return; closed = true; sample?.close(); if (!disposed && pixels) spare = pixels.buffer as ArrayBuffer; },
        } satisfies DecodedFrame;
      });
      serial = task.then(() => {}, () => {});
      return task;
    };
    return {
      info,
      frameAt: pts => extract(floorIndex(times, pts)),
      async framesAfter(pts, count) {
        const result: DecodedFrame[] = [], start = nextIndex(times, pts);
        if (start < 0) return result;
        try { for (let i = start; i < Math.min(times.length, start + count); i++) result.push(await extract(i)); }
        catch (error) { result.forEach(f => f.close()); throw error; }
        return result;
      },
      async *framesFrom(pts) { for (let i = floorIndex(times, pts); i < times.length && !disposed; i++) yield await extract(i); },
      dispose() { if (!disposed) { disposed = true; spare = undefined; reservation.release(); void activeRpc.call('dispose', {}, [], 1000).catch(() => {}).finally(() => activeRpc.terminate()); } },
    };
  } catch (error) { reservation.release(); rpc?.terminate(); throw error; }
}
