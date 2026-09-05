import { Input, BlobSource, ALL_FORMATS, VideoSampleSink, UnsupportedInputFormatError } from 'mediabunny';
import type { VideoSample } from 'mediabunny';
import type { MediaInfo, FrameInfo } from './model.ts';
import { openFFmpegMedia } from './ffmpeg-media.ts';

export interface DecodedFrame extends FrameInfo {
  draw(canvas: HTMLCanvasElement): void;
  close(): void;
}
export interface MediaSource {
  info: MediaInfo;
  frameAt(ptsUs: number): Promise<DecodedFrame>;
  framesAfter(ptsUs: number, count: number): Promise<DecodedFrame[]>;
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
export async function openMedia(file: File, openFallback: (file: File) => Promise<MediaSource> = openFFmpegMedia): Promise<MediaSource> {
  if (!(file instanceof File) || file.size === 0) throw new Error('请选择非空的视频文件。');
  try {
    return await openWebCodecsMedia(file);
  } catch (nativeError) {
    // Tracks mediabunny cannot demux or WebCodecs cannot decode (FFV1,
    // MPEG-2 TS, codec gaps) fall back to the synchronous FFmpeg WASM path.
    try { return await openFallback(file); }
    catch { throw nativeError; }
  }
}
async function openWebCodecsMedia(file: File): Promise<MediaSource> {
  if (!globalThis.isSecureContext || typeof VideoDecoder === 'undefined') {
    throw new Error('当前浏览器不支持 WebCodecs。请通过 localhost 或 HTTPS，在支持的桌面浏览器中打开。');
  }
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  try {
    const { track, codec, format } = await inspectVideoTrack(input);
    if (!await track.canDecode()) throw new Error(`已识别 ${format} / ${codec}，但当前浏览器不支持该编码配置的解码。`);
    const first = await track.getFirstTimestamp();
    const end = await track.computeDuration();
    if (!Number.isFinite(first) || !Number.isFinite(end) || end <= first) throw new Error('无法确定视频的有效时间范围。');
    const sink = new VideoSampleSink(track);
    const info: MediaInfo = {
      id: crypto.randomUUID(), name: file.name, size: file.size, lastModified: file.lastModified,
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
      dispose: () => input.dispose(),
    };
  } catch (error) { input.dispose(); throw error; }
}
