import { Input, BlobSource, UrlSource, ALL_FORMATS, VideoSampleSink, UnsupportedInputFormatError } from 'mediabunny';
import type { VideoSample } from 'mediabunny';
import type { MediaInfo, FrameInfo } from './model.ts';
import { openFFmpegMedia } from './ffmpeg-media.ts';
import { contextLog } from './log.ts';

const errorText = (e: unknown) => e instanceof Error ? e.message : String(e);

export interface DecodedFrame extends FrameInfo {
  draw(canvas: HTMLCanvasElement): void;
  close(): void;
}
export interface MediaSource {
  info: MediaInfo;
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
    if (error instanceof UnsupportedInputFormatError) throw new Error('无法识别文件封装：当前原型不支持此格式，或文件已损坏。');
    throw error;
  }
  const track = await input.getPrimaryVideoTrack();
  if (!track) throw new Error(`已识别 ${format.name}，但未找到当前媒体库可读取的视频轨道。可能没有视频，也可能轨道编码尚不支持。`);
  if (!await track.getCodec()) {
    const id = await track.getInternalCodecId();
    const names: Record<string, string> = { V_FFV1: 'FFV1', vvc1: 'H.266 / VVC', vvi1: 'H.266 / VVC' };
    const codec = id == null ? '未识别的编码' : names[String(id)] ?? String(id);
    throw new Error(`已识别 ${format.name}，但当前网页媒体库尚未接入 ${codec} 视频编码。`);
  }
  const codec = await track.getCodecParameterString() ?? (await track.getCodec())!;
  return { track, codec, format: format.name };
}
export interface MediaMeta { name: string; size: number; lastModified: number; }

export async function openMedia(file: File, openFallback: (file: File) => Promise<MediaSource> = openFFmpegMedia): Promise<MediaSource> {
  const log = contextLog();
  if (!(file instanceof File) || file.size === 0) throw new Error('请选择非空的视频文件。');
  try {
    const source = await openWebCodecsInput(new Input({ source: new BlobSource(file), formats: ALL_FORMATS }), file);
    log.info('media', '使用 WebCodecs 解码路径', { name: file.name, codec: source.info.codec });
    return source;
  } catch (nativeError) {
    // Tracks mediabunny cannot demux or WebCodecs cannot decode (FFV1,
    // MPEG-2 TS, codec gaps) fall back to the synchronous FFmpeg WASM path.
    log.info('media', 'WebCodecs 路径不可用，尝试 WASM 回退', { name: file.name, reason: errorText(nativeError) });
    try {
      const source = await openFallback(file);
      log.info('media', 'WASM 回退解码已启用', { name: file.name, codec: source.info.codec });
      return source;
    } catch (fallbackError) {
      log.warn('media', 'WASM 回退也不支持', { name: file.name, error: errorText(fallbackError) });
      throw nativeError;
    }
  }
}

// Library items are read over HTTP range requests; mediabunny's UrlSource
// streams them, so large files are never downloaded whole on the WebCodecs
// path. The WASM fallback still reads the full file into memory (streaming
// AVIO is follow-up work).
export async function openMediaFromUrl(url: string, meta: MediaMeta, openFallback: (file: File) => Promise<MediaSource> = openFFmpegMedia): Promise<MediaSource> {
  const log = contextLog();
  try {
    const source = await openWebCodecsInput(new Input({ source: new UrlSource(url), formats: ALL_FORMATS }), meta);
    log.info('media', '使用 WebCodecs 解码路径（网络媒体库）', { name: meta.name, codec: source.info.codec });
    return source;
  } catch (nativeError) {
    log.info('media', 'WebCodecs 路径不可用，尝试 WASM 回退', { name: meta.name, reason: errorText(nativeError) });
    const response = await fetch(url);
    if (!response.ok) throw nativeError;
    const file = new File([await response.arrayBuffer()], meta.name, { lastModified: meta.lastModified });
    try {
      const source = await openFallback(file);
      log.info('media', 'WASM 回退解码已启用', { name: meta.name, codec: source.info.codec });
      return source;
    } catch (fallbackError) {
      log.warn('media', 'WASM 回退也不支持', { name: meta.name, error: errorText(fallbackError) });
      throw nativeError;
    }
  }
}

async function openWebCodecsInput(input: Input, meta: MediaMeta): Promise<MediaSource> {
  if (!globalThis.isSecureContext || typeof VideoDecoder === 'undefined') {
    throw new Error('当前浏览器不支持 WebCodecs。请通过 localhost 或 HTTPS，在支持的桌面浏览器中打开。');
  }
  try {
    const { track, codec, format } = await inspectVideoTrack(input);
    if (!await track.canDecode()) throw new Error(`已识别 ${format} / ${codec}，但当前浏览器不支持该编码配置的解码。`);
    const first = await track.getFirstTimestamp();
    const end = await track.computeDuration();
    if (!Number.isFinite(first) || !Number.isFinite(end) || end <= first) throw new Error('无法确定视频的有效时间范围。');
    const sink = new VideoSampleSink(track);
    const info: MediaInfo = {
      id: crypto.randomUUID(), name: meta.name, size: meta.size, lastModified: meta.lastModified,
      codec, decoder: 'webcodecs', width: track.displayWidth, height: track.displayHeight,
      firstPtsUs: Math.round(first * 1e6), durationUs: Math.round((end - first) * 1e6),
    };
    const wrap = (sample: VideoSample): DecodedFrame => ({
      ptsUs: Math.round((sample.timestamp - first) * 1e6),
      sourcePtsUs: Math.round(sample.timestamp * 1e6),
      durationUs: Math.round(sample.duration * 1e6),
      draw(canvas) {
        if (canvas.width !== sample.displayWidth) canvas.width = sample.displayWidth;
        if (canvas.height !== sample.displayHeight) canvas.height = sample.displayHeight;
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('浏览器无法创建画布。');
        sample.draw(ctx, 0, 0, canvas.width, canvas.height);
      },
      close: () => sample.close(),
    });
    return {
      info,
      async frameAt(ptsUs) {
        // Resolve timestamps in the same nearest-microsecond domain that we
        // expose in state and exports (e.g. a 30 fps frame starts at .033333…).
        const sample = await sink.getSample(first + (ptsUs + 0.5) / 1e6);
        if (!sample) throw new Error(`时间 ${ptsUs} µs 没有可解码的画面。`);
        return wrap(sample);
      },
      async framesAfter(ptsUs, count) {
        // Iterate presentation order and keep true successors, so VFR and
        // timestamp gaps cannot strand stepping on a duration-based guess.
        // Start just before the current frame: its rounded start may sit a
        // fraction of a microsecond below ptsUs.
        const frames: DecodedFrame[] = [];
        const iterator = sink.samples(first + Math.max(0, ptsUs - 1) / 1e6);
        try {
          for await (const sample of iterator) {
            const frame = wrap(sample);
            if (frame.ptsUs <= ptsUs) { frame.close(); continue; }
            frames.push(frame);
            if (frames.length >= count) break;
          }
        } finally {
          await iterator.return(undefined);
        }
        return frames;
      },
      async *framesFrom(ptsUs) {
        // Sequential iterator: the sink pre-decodes ahead, so playback no
        // longer pays a keyframe seek per frame like sparse getSample does.
        const iterator = sink.samples(first + Math.max(0, ptsUs - 1) / 1e6);
        try {
          for await (const sample of iterator) yield wrap(sample);
        } finally {
          await iterator.return(undefined);
        }
      },
      dispose: () => input.dispose(),
    };
  } catch (error) { input.dispose(); throw error; }
}
