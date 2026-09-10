import { prepareYuvFrame, createYuvBufferPool } from './yuv-frame.ts';
import { updateMediaInfo } from './media-state.ts';
import { validateDescription } from './frame-description.ts';
import { loadAborted, onLoadAbort } from './media-abort.ts';
import { randomUUID } from './uuid.ts';
import { MediaOpenError } from './media-errors.ts';
import { VideoSample } from 'mediabunny';
import { WorkerRpc, floorIndex, WASM_CORE_GLUE_PATH, WASM_CORE_GLUE_PATH_MT, reserveFallbackThreads } from './ffmpeg-media.ts';
import type { FallbackDeps } from './ffmpeg-media.ts';
import type { MediaMeta, MediaSource, DecodedFrame } from './media.ts';
import type { FlvInput } from './flv-demux.ts';
import type { PreparedFlv } from './flv-engine.ts';
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
    type Init = Pick<MediaInfo, 'timelineSource' | 'indexWarning' | 'indexSource' | 'indexState' | 'color' | 'colorSource' | 'pixelFormat' | 'decodedPixelFormat' | 'hardwareAcceleration'> & { codec: string; decoder: 'webcodecs' | 'ffmpeg-wasm'; width: number; height: number; firstPtsUs: number; durationUs: number; times: number[]; durations: number[] };
    let init: Init | null | undefined, selected = single, failure: unknown;
    let prepared: PreparedFlv | undefined;
    const createRpc = async () => {
      const worker = deps.workerFactory ? deps.workerFactory() : typeof Worker !== 'undefined'
        ? new Worker(new URL('./packet-worker.ts', import.meta.url), { type: 'module' })
        : new (await import('node:worker_threads')).Worker(new URL('./packet-worker.ts', import.meta.url)) as unknown as Worker;
      return new WorkerRpc(worker, undefined, deps.onProgress);
    };
    // Read the startup packet outside every decoder deadline. Only actual index
    // progress renews the idle deadline; stalled IO and cancellation still stop.
    if (container === 'flv') {
      rpc = await createRpc();
      const currentRpc = rpc;
      const detachAbort = onLoadAbort(deps.signal, () => currentRpc.terminate(deps.signal!.reason));
      try {
        deps.onProgress?.('inspect');
        prepared = await rpc.call<PreparedFlv>('prepare', { input }, [], 60000, true);
        if (!deps.forceWasm) init = await rpc.call<Init | null>('native', {}, [], 60000);
      } finally { detachAbort(); }
    }
    for (const glueURL of candidates) {
      if (init) break;
      loadAborted(deps.signal);
      const restore = rpc ? undefined : prepared;
      rpc ??= await createRpc();
      const currentRpc = rpc;
      const detachAbort = onLoadAbort(deps.signal, () => currentRpc.terminate(deps.signal!.reason));
      try {
        if (container !== 'flv') deps.onProgress?.('inspect');
        init = await rpc.call<Init>('init', { input, prepared: restore, glueURL, wasmBinary: deps.wasmBinary,
          forceWasm: container === 'flv' || !!deps.forceWasm, container, threads: reservation.threads }, [],
          container === 'flv' && glueURL.includes('core-mt.') ? 10000 : 60000);
        selected = glueURL;
      } catch (error) {
        rpc.terminate(); rpc = undefined; failure = error;
        loadAborted(deps.signal);
        if (error instanceof MediaOpenError && error.stage !== 'decode') throw error;
        contextLog().warn('media', '压缩包解码器初始化失败，尝试下一个 core', {
          coreVariant: glueURL.includes('core-mt.') ? 'multi-thread' : 'single-thread',
          indexReused: !!prepared, error: error instanceof Error ? error.message : String(error),
        });
      } finally { detachAbort(); }
    }
    if (!init || !rpc) throw failure;
    prepared = undefined;
    const activeRpc = rpc;
    if (init.decoder === 'webcodecs') reservation.release();
    let { times, durations, ...details } = init;
    const info: MediaInfo = { id: randomUUID(), name: meta.name, size: meta.size, lastModified: meta.lastModified, ...details, ...(init.decoder === 'ffmpeg-wasm' ? { coreVariant: selected.includes('core-mt.') ? 'multi-thread' as const : 'single-thread' as const } : {}) };
    contextLog().info('media', `${container.toUpperCase()} 已通过 TS 解封装载入`, { name: meta.name, codec: init.codec, decoder: init.decoder, packets: times.length, io: 'file' in input ? 'blob-chunks' : 'http-range',timelineSource:init.timelineSource,indexWarning:init.indexWarning,hardwareAcceleration:init.hardwareAcceleration, coreVariant: info.coreVariant, requestedThreads: init.decoder === 'ffmpeg-wasm' ? reservation.threads : undefined });
    const yuvPool=createYuvBufferPool();
    let disposed = false, spare: ArrayBuffer | undefined;
    let serial = Promise.resolve();
    let indexing: Promise<void> | undefined;
    const indexWaiters = new Set<() => void>();
    const wakeIndex = () => { for (const resolve of indexWaiters) resolve(); indexWaiters.clear(); };
    activeRpc.onIndexWaiting = indexWaiting => { if (!disposed) updateMediaInfo(source, { indexWaiting }, 'index'); };
    activeRpc.onIndexProgress = ({ durationUs, ...indexProgress }) => {
      if (disposed) return;
      updateMediaInfo(source, { durationUs, indexProgress }, 'index');
      wakeIndex();
    };
    const completeIndex = () => {
      if (indexing) return indexing;
      if (container !== 'flv') return Promise.resolve();
      if (info.indexState === 'error') return Promise.reject(new Error(info.indexError));
      indexing = activeRpc.call<Pick<Init, 'indexWarning' | 'indexSource' | 'times' | 'durations' | 'firstPtsUs' | 'durationUs'>>('complete-index', {}, [], 60000, true).then(result => {
        if (disposed) return;
        contextLog().info('media', 'FLV 后台索引完成', { name: meta.name, originPtsUs: result.firstPtsUs,
          earliestRelativePtsUs: result.times[0], packets: result.times.length,
          durationBeforeUs: info.durationUs, durationUs: result.durationUs, indexSource: result.indexSource });
        times = result.times; durations = result.durations;
        updateMediaInfo(source,{firstPtsUs:result.firstPtsUs,durationUs:result.durationUs,indexState:'complete',indexSource:result.indexSource,indexWarning:result.indexWarning},'index');
        wakeIndex();
      }, error => {
        if (!disposed) {
          updateMediaInfo(source,{indexState:'error',indexError:error instanceof Error?error.message:String(error)},'index');
          wakeIndex();
          contextLog().warn('media', 'FLV 后台索引失败', { error: info.indexError });
        }
        throw error;
      });
      // Observed background failures remain visible in metadata and reject
      // subsequent requests beyond the already displayed startup frame.
      void indexing.catch(() => {});
      return indexing;
    };
    let backgroundTimer: ReturnType<typeof setTimeout> | undefined;
    const ensureIndexed = async (ptsUs = Infinity) => {
      if (disposed) throw new Error('媒体已释放。');
      if (info.indexState === 'error') throw new Error(info.indexError);
      if (info.indexState !== 'building' || (ptsUs === 0 && !indexing)) return;
      void completeIndex().catch(() => {});
      while (!disposed && info.indexState === 'building' && ptsUs >= info.durationUs) await new Promise<void>(resolve => indexWaiters.add(resolve));
      if (disposed) throw new Error('媒体已释放。');
      if ((info.indexState as string) === 'error') throw new Error(info.indexError);
    };
    const extract = (pts:number, next=false): Promise<DecodedFrame|null> => {
      const task = serial.then(async () => {
        if (disposed) throw new Error('媒体已释放。');
        const recycle = spare; spare = undefined;
        const frame = await activeRpc.call<FlvFrame|null>(next?'next':'at', {pts:pts+info.firstPtsUs,recycle}, recycle ? [recycle] : [], 60000, true);
        if(!frame)return null;
        const position=floorIndex(times,frame.pts-info.firstPtsUs);
        if (disposed) { frame.frame?.close(); throw new Error('媒体已释放。'); }
        const sample = frame.frame ? new VideoSample(frame.frame) : undefined;
        const pixels = frame.pixels ? new Uint8ClampedArray(frame.pixels) : undefined;
        try { validateDescription(frame.description,pixels?.byteLength); } catch(error) {sample?.close();throw error;}
        if (container === 'flv' && !indexing && backgroundTimer === undefined) backgroundTimer = setTimeout(() => { if (!disposed) void completeIndex().catch(() => {}); }, 0);
        let closed = false;
        const decoded = await prepareYuvFrame({ description:frame.description,kind: sample ? 'video-sample' : frame.description.yuv ? 'yuv' : 'rgba8', width: frame.width, height: frame.height,
          ptsUs: frame.pts-info.firstPtsUs, sourcePtsUs: frame.pts, durationUs: frame.durationUs ?? durations[position],
          byteSize: frame.description.byteLength, sample, pixels,
          close() { if (closed) return; closed = true; sample?.close(); if (!disposed && pixels) spare = pixels.buffer as ArrayBuffer; },
        } satisfies DecodedFrame,yuvPool,deps.preserveNativeSample);
        if(disposed){decoded.close();throw new Error("媒体已释放。");}
        return decoded;
      });
      serial = task.then(() => {}, () => {});
      return task;
    };
    const source: MediaSource = {
      info, ensureIndexed,
      async frameAt(pts) { await ensureIndexed(pts);const frame=await extract(pts);if(!frame)throw new MediaOpenError('decode','没有可显示帧。');return frame; },
      async framesAfter(pts,count){
        if(count<=0)return [];
        if (info.indexState === 'building') void completeIndex().catch(() => {});
        await ensureIndexed(pts);
        const result:DecodedFrame[]=[];
        try{for(let i=0;i<count;i++){const f=await extract(pts,true);if(!f)break;result.push(f);pts=f.ptsUs;}}catch(error){result.forEach(f=>f.close());throw error;}
        return result;
      },
      async *framesFrom(pts){
        await ensureIndexed(pts);let frame=await extract(pts);
        while(frame&&!disposed){
          const after=frame.ptsUs;yield frame;
          if (info.indexState === 'building') void completeIndex().catch(() => {});
          await ensureIndexed(after); // Wait only for the requested prefix; worker waits at its live decode frontier.
          frame=await extract(after,true);
        }
        if(frame&&disposed)frame.close();
      },
      dispose() { if (!disposed) { disposed = true; yuvPool.dispose(); wakeIndex(); activeRpc.onIndexProgress = undefined; activeRpc.onIndexWaiting = undefined; clearTimeout(backgroundTimer); source.onInfoChange = undefined; spare = undefined; reservation.release(); activeRpc.terminate(); } },
    };
    return source;
  } catch (error) { reservation.release(); rpc?.terminate(); throw error; }
}
