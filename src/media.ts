import { prepareYuvFrame, createYuvBufferPool } from './yuv-frame.ts';
import type { MediaInfoChange } from './media-state.ts';
import { avcGeometry, nativeAvcCompatible } from './avc-geometry.ts';
import { readMp4Configurations } from './mp4-config.ts';
import { hevcDisplayOrder } from './hevc-timeline.ts';
import { RangeReader } from './range-reader.ts';
import { sampleDescription } from './frame-description.ts';
import type { FrameDescription } from './frame-description.ts';
import type { MediaOpenProgress } from './media-progress.ts';
export type { MediaOpenProgress } from './media-progress.ts';
import { abortableLoad, loadAborted, onLoadAbort } from './media-abort.ts';
import { randomUUID } from './uuid.ts';
import { explainMediaFailure } from './media-diagnostics.ts';
import type { RandomAccessInput } from './range-reader.ts';
import { MediaOpenError } from './media-errors.ts';
import type { OpenStage } from './media-errors.ts';
import { Input, BlobSource, UrlSource, ALL_FORMATS, IsobmffInputFormat, VideoSampleSink, UnsupportedInputFormatError } from 'mediabunny';
import type { VideoSample } from 'mediabunny';
import type { MediaInfo, FrameInfo } from './model.ts';
import { openFFmpegMedia, openFFmpegMediaFromUrl } from './ffmpeg-media.ts';
import { contextLog } from './log.ts';
import { preferredVideoConfig } from './decoder-policy.ts';

const errorText = (e: unknown) => e instanceof Error ? e.message : String(e);

export interface DecodedFrame extends FrameInfo {
  readonly description: FrameDescription;
  readonly copyMs?: number;
  readonly rotation?: number;
  /** Resource form: a WebCodecs sample, YUV planes, or RGBA8 pixels. The presenter decides
   *  how a kind reaches the canvas; backends never paint. */
  readonly kind: 'video-sample' | 'rgba8' | 'yuv';
  readonly width: number;
  readonly height: number;
  /** Approximate bytes held by this frame, for queue memory budgets. */
  readonly byteSize: number;
  readonly sample?: VideoSample;
  readonly pixels?: Uint8ClampedArray;
  close(): void;
}
export interface MediaSource {
  info: MediaInfo;
  /** Background container indexing can extend duration after the first frame. */
  onInfoChange?: (change?:MediaInfoChange) => void;
  ensureIndexed?(ptsUs?: number): Promise<void>;
  frameAt(ptsUs: number): Promise<DecodedFrame>;
  framesAfter(ptsUs: number, count: number): Promise<DecodedFrame[]>;
  /** Sequential presentation-order frames starting at ptsUs, for playback. */
  framesFrom(ptsUs: number): AsyncGenerator<DecodedFrame>;
  dispose(): void;
}
export async function inspectVideoTrack(input: Input) {
  let format;
  try { format = await input.getFormat(); }
  catch (error) {
    if (error instanceof UnsupportedInputFormatError) throw new MediaOpenError('container', '无法识别文件封装：当前原型不支持此格式，或文件已损坏。');
    throw error;
  }
  const track = await input.getPrimaryVideoTrack();
  if (!track) throw new MediaOpenError('container', `已识别 ${format.name}，但未找到当前媒体库可读取的视频轨道。可能没有视频，也可能轨道编码尚不支持。`);
  if (!await track.getCodec()) {
    const id = await track.getInternalCodecId();
    const names: Record<string, string> = { V_FFV1: 'FFV1', vvc1: 'H.266 / VVC', vvi1: 'H.266 / VVC' };
    const codec = id == null ? '未识别的编码' : names[String(id)] ?? String(id);
    throw new MediaOpenError('codec', `已识别 ${format.name}，但当前网页媒体库尚未接入 ${codec} 视频编码。`);
  }
  const codec = await track.getCodecParameterString() ?? (await track.getCodec())!;
  return { track, codec, format: format.name };
}
export interface MediaMeta { name: string; size: number; lastModified: number; }

// Where opening failed decides whether the WASM fallback can help: container
// and codec stages can (mediabunny/WebCodecs gaps); input and resource stages
// cannot (a network error or an oversized file fails identically on retry).
export { MediaOpenError } from './media-errors.ts';
export type { OpenStage } from './media-errors.ts';
const stageOf = (error: unknown): OpenStage =>
  error instanceof MediaOpenError ? error.stage : 'decode';

interface OpenPlan {
  meta: MediaMeta;
  input: RandomAccessInput;
  nativeInput(): Input;
  fallback(): Promise<MediaSource>;
  onProgress?: MediaOpenProgress;
  signal?: AbortSignal;
}

function openWithFallback(plan: OpenPlan): Promise<MediaSource> {
  const log = contextLog();
  return abortableLoad((async () => {
    loadAborted(plan.signal);
    let nativeError: unknown;
    try {
      plan.onProgress?.('decode');
      const source = await openWebCodecsInput(plan.nativeInput(), plan.meta, plan.signal, plan.onProgress,plan.input);
      log.info('media', '使用 WebCodecs 解码路径', { name: plan.meta.name, codec: source.info.codec });
      return source;
    } catch (error) {
      loadAborted(plan.signal);
      nativeError = error;
    }
    const stage = stageOf(nativeError);
    if (stage === 'input' || stage === 'resource') throw nativeError;
    log.info('media', 'WebCodecs 路径不可用，尝试 WASM 回退', { name: plan.meta.name, stage, reason: errorText(nativeError) });
    try {
      plan.onProgress?.('decode');
      const source = await plan.fallback();
      log.info('media', 'WASM 回退解码已启用', { name: plan.meta.name, codec: source.info.codec });
      return source;
    } catch (fallbackError) {
      loadAborted(plan.signal);
      log.warn('media', 'WASM 回退也不支持', { name: plan.meta.name, error: errorText(fallbackError) });
      // Preserve input/resource failures and the actual decoder failure; the
      // initial capability error cannot explain a failed download or timeout.
      throw await explainMediaFailure(plan.input, nativeError, fallbackError, plan.signal);
    }
  })(), plan.signal, source => source.dispose());
}

export async function openMedia(file: File, openFallback: ((file: File) => Promise<MediaSource>) | undefined = undefined, onProgress?: MediaOpenProgress, signal?: AbortSignal): Promise<MediaSource> {
  loadAborted(signal);
  if (!(file instanceof File) || file.size === 0) throw new MediaOpenError('input', '请选择非空的视频文件。');
  if (await isFlvFile(file)) {
    const { openFlvMedia } = await import('./flv-media.ts');
    return openFlvMedia({ file }, file, { signal, onProgress });
  }
  return openWithFallback({
    meta: file, input: { file },
    onProgress, signal,
    nativeInput: () => new Input({ source: new BlobSource(file), formats: ALL_FORMATS }),
    fallback: () => openFallback ? openFallback(file) : openLocalFallback(file,{signal,onProgress}),
  });
}

// Both native and WASM library paths read compressed bytes on demand.
export async function openMediaFromUrl(url: string, meta: MediaMeta, openFallback: ((url: string, meta: MediaMeta) => Promise<MediaSource>) | undefined = undefined, onProgress?: MediaOpenProgress, signal?: AbortSignal): Promise<MediaSource> {
  loadAborted(signal);
  if (!meta.size) {
    const head = await fetch(url, { method: 'HEAD', signal });
    if (!head.ok) throw new MediaOpenError('input', `读取媒体文件信息失败（${head.status}）。`);
    meta = { ...meta, size: Number(head.headers.get('content-length')) };
  }
  if (!Number.isSafeInteger(meta.size) || meta.size <= 0) throw new MediaOpenError('input', '媒体文件长度无效。');
  if (/\.flv$/i.test(meta.name)) {
    const { openFlvMedia } = await import('./flv-media.ts');
    return openFlvMedia({ url, size: meta.size }, meta, { signal, onProgress });
  }
  return openWithFallback({
    meta, input: { url, size: meta.size }, onProgress, signal,
    nativeInput: () => new Input({ source: new UrlSource(url), formats: ALL_FORMATS }),
    fallback: () => openFallback ? openFallback(url, meta) : openFFmpegMediaFromUrl(url, meta, { signal, onProgress }),
  });
}

async function openLocalFallback(file:File,deps:import('./ffmpeg-media.ts').FallbackDeps):Promise<MediaSource>{
  const {openPacketMedia}=await import('./packet-media.ts');
  try{return await openPacketMedia('mp4',{file},file,{...deps,forceWasm:true});}
  catch(error){loadAborted(deps.signal);if(!(error instanceof MediaOpenError)||!['container','codec'].includes(error.stage))throw error;}
  return openFFmpegMedia(file,deps);
}

async function openWebCodecsInput(input: Input, meta: MediaMeta, signal?: AbortSignal, onProgress?: MediaOpenProgress, access?:RandomAccessInput): Promise<MediaSource> {
  const detachAbort = onLoadAbort(signal, () => input.dispose());
  let primed: VideoSample | null = null;
  try {
    loadAborted(signal);
    if (!globalThis.isSecureContext || typeof VideoDecoder === 'undefined') {
    // No WebCodecs at all is a decode-capability gap, not an input error:
    // the WASM fallback exists precisely for that case.
    throw new MediaOpenError('decode', '当前浏览器不支持 WebCodecs。请通过 localhost 或 HTTPS，在支持的桌面浏览器中打开。');
    }
    onProgress?.('inspect');
    const { track, codec, format } = await inspectVideoTrack(input);
    if (!await track.canDecode()) throw new MediaOpenError('decode', `已识别 ${format} / ${codec}，但当前浏览器不支持该编码配置的解码。`);
    const rawConfig = await track.getDecoderConfig();
    if(rawConfig?.codec.startsWith('avc')&&rawConfig.description){
      const raw=rawConfig.description;
      const bytes=ArrayBuffer.isView(raw)?new Uint8Array(raw.buffer,raw.byteOffset,raw.byteLength):new Uint8Array(raw);
      if(!nativeAvcCompatible(avcGeometry(bytes)))throw new MediaOpenError('decode','此 AVC 配置需要保守软件重排/隔行解码，浏览器能力探测不足以保证完整输出。');
    }
    let indexWarning: string | undefined;
    if(access&&(await input.getFormat()) instanceof IsobmffInputFormat){
      const reader=new RangeReader(access);
      const detach=onLoadAbort(signal,()=>reader.close());
      try{
        const configs=await readMp4Configurations(reader,track.id);
        indexWarning = configs.warning;
        if(configs.descriptions.length>1)throw new MediaOpenError('codec','多配置 MP4 需要按 sample description 切换解码器。');
        if ((configs.availableSamples !== undefined && configs.availableSamples < configs.sampleSizes!.length)
          || (await track.getCodec()==='hevc'&&await hevcDisplayOrder(reader,configs,()=>onProgress?.('index')))) {
          input.dispose();
          const {openPacketMedia}=await import('./packet-media.ts');
          return await openPacketMedia('mp4',access,meta,{signal,onProgress});
        }
      } finally{detach();reader.close();}
    }
    const config = rawConfig ? await preferredVideoConfig(rawConfig) : null;
    if (!config) throw new MediaOpenError('decode', `浏览器无法解码 ${codec}，将尝试软件回退。`);
    onProgress?.('index');
    let first = await track.getFirstTimestamp();
    const end = await track.computeDuration();
    if (!Number.isFinite(first) || !Number.isFinite(end) || end <= first) throw new MediaOpenError('container', '无法确定视频的有效时间范围。');
    const sink = new VideoSampleSink(track, { hardwareAcceleration: config.hardwareAcceleration });
    // A TS capture may start before a decodable keyframe. Capability alone
    // does not prove frame 0 exists: prime inside the staged open operation.
    onProgress?.('first-frame');
    primed = await firstDecodableSample(sink, first);
    loadAborted(signal);
    first = primed.timestamp;
    if (!Number.isFinite(first) || first >= end) throw new MediaOpenError('decode', '首个可解码画面不在有效时间范围内。');
    // Color metadata comes from the container (mediabunny), not from decoded
    // frames: WebKit resolves VideoFrame.colorSpace to presentation values.
    const color = await track.getColorSpace().catch(() => null);
    const info: MediaInfo = {
      id: randomUUID(), name: meta.name, size: meta.size, lastModified: meta.lastModified,
      codec, decoder: 'webcodecs', width: track.displayWidth, height: track.displayHeight,
      hardwareAcceleration: config.hardwareAcceleration,
      firstPtsUs: Math.round(first * 1e6), durationUs: Math.round((end - first) * 1e6),
      colorSource: 'container', ...(indexWarning ? { indexWarning } : {}),
      ...(color ? { color: { primaries: color.primaries ?? null, transfer: color.transfer ?? null, matrix: color.matrix ?? null, fullRange: color.fullRange ?? null } } : {}),
    };
    // Frames carry their resource and kind; the presenter (src/presenter.ts)
    // decides how to paint them.
    const yuvPool=createYuvBufferPool();
    const wrap = async (sample: VideoSample): Promise<DecodedFrame> => {
      let description: FrameDescription;
      try { description=sampleDescription(sample);if(info.color)description.sourceColor={...info.color}; } catch(error) {sample.close();throw error;}
      const byteSize=description.byteLength;
      const frame = await prepareYuvFrame({
      description,
      kind: 'video-sample',
      width: sample.displayWidth,
      height: sample.displayHeight,
      byteSize,
      sample,
      ptsUs: Math.round((sample.timestamp - first) * 1e6),
      sourcePtsUs: Math.round(sample.timestamp * 1e6),
      durationUs: Math.round(sample.duration * 1e6),
      close: () => sample.close(),
      },yuvPool);
      if(disposed) {frame.close(); throw new DOMException("媒体已释放。", "AbortError");}
      return frame;
    };
    let disposed = false;
    const iterators = new Set<AsyncGenerator<VideoSample>>();
    const samples = (time: number) => { const iterator = sink.samples(time); iterators.add(iterator); return iterator; };
    return {
      info,
      async frameAt(ptsUs) {
        // Resolve timestamps in the same nearest-microsecond domain that we
        // expose in state and exports (e.g. a 30 fps frame starts at .033333…).
        if (ptsUs === 0 && primed) return wrap(primed.clone());
        const sample = await sink.getSample(first + (ptsUs + 0.5) / 1e6);
        if (disposed) { sample?.close(); throw new DOMException('媒体已释放。', 'AbortError'); }
        if (!sample) throw new Error(`时间 ${ptsUs} µs 没有可解码的画面。`);
        return wrap(sample);
      },
      async framesAfter(ptsUs, count) {
        // Iterate presentation order and keep true successors, so VFR and
        // timestamp gaps cannot strand stepping on a duration-based guess.
        // Start just before the current frame: its rounded start may sit a
        // fraction of a microsecond below ptsUs.
        const frames: DecodedFrame[] = [];
        const iterator = samples(first + Math.max(0, ptsUs - 1) / 1e6);
        try {
          for await (const sample of iterator) {
            const frame = await wrap(sample);
            if (frame.ptsUs <= ptsUs) { frame.close(); continue; }
            frames.push(frame);
            if (frames.length >= count) break;
          }
        } catch (error) { frames.forEach(frame => frame.close()); throw error; }
        finally {
          iterators.delete(iterator);
          await iterator.return(undefined);
        }
        return frames;
      },
      async *framesFrom(ptsUs) {
        // Sequential iterator: the sink pre-decodes ahead, so playback no
        // longer pays a keyframe seek per frame like sparse getSample does.
        const iterator = samples(first + Math.max(0, ptsUs - 1) / 1e6);
        try {
          for await (const sample of iterator) yield wrap(sample);
        } finally {
          iterators.delete(iterator);
          await iterator.return(undefined);
        }
      },
      dispose: () => {
        if (disposed) return; disposed = true;yuvPool.dispose();
        // Return the sink iterators directly, even if an outer queue is waiting
        // on next(). This wakes the sink pump so its finally closes the decoder.
        for (const iterator of iterators) void iterator.return(undefined).catch(() => {});
        iterators.clear(); primed?.close(); primed = null; input.dispose();
      },
    };
  } catch (error) { primed?.close(); input.dispose(); loadAborted(signal); throw error; }
  finally { detachAbort(); }
}

async function isFlvFile(file: File): Promise<boolean> {
  const header = new Uint8Array(await file.slice(0, 3).arrayBuffer());
  return /\.flv$/i.test(file.name) || header[0] === 70 && header[1] === 76 && header[2] === 86;
}

/** Preserve the real source timestamp when the capture starts before a GOP. */
export async function firstDecodableSample(sink: Pick<VideoSampleSink, 'getSample' | 'samples'>, first: number): Promise<VideoSample> {
  const sample = await sink.getSample(first + 0.5 / 1e6);
  if (sample) return sample;
  const frames = sink.samples(first);
  let decoded: VideoSample | undefined;
  try {
    const next = await frames.next();
    decoded = next.done ? undefined : next.value;
    if (decoded) return decoded;
    throw new MediaOpenError('decode', '视频没有可解码的首帧。');
  } finally {
    try { await frames.return(undefined); }
    catch (error) { decoded?.close(); throw error; }
  }
}
