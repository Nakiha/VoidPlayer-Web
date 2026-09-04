import { Input, BlobSource, ALL_FORMATS, VideoSampleSink } from 'mediabunny';
import type { MediaInfo, FrameInfo } from './model.ts';

export interface DecodedFrame extends FrameInfo {
  draw(canvas: HTMLCanvasElement): void;
  close(): void;
}
export interface MediaSource {
  info: MediaInfo;
  frameAt(ptsUs: number): Promise<DecodedFrame>;
  dispose(): void;
}
export async function openMedia(file: File): Promise<MediaSource> {
  if (!globalThis.isSecureContext || typeof VideoDecoder === 'undefined') {
    throw new Error('当前浏览器不支持 WebCodecs。请通过 localhost 或 HTTPS，在支持的桌面浏览器中打开。');
  }
  if (!(file instanceof File) || file.size === 0) throw new Error('请选择非空的视频文件。');
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new Error('文件中没有可读取的视频轨道。');
    const codec = await track.getCodecParameterString() ?? 'unknown';
    if (!await track.canDecode()) throw new Error(`当前浏览器无法解码 ${codec}。原型不会转码或替换原片。`);
    const first = await track.getFirstTimestamp();
    const end = await track.computeDuration();
    if (!Number.isFinite(first) || !Number.isFinite(end) || end <= first) throw new Error('无法确定视频的有效时间范围。');
    const sink = new VideoSampleSink(track);
    const info: MediaInfo = {
      id: crypto.randomUUID(), name: file.name, size: file.size, lastModified: file.lastModified,
      codec, width: track.displayWidth, height: track.displayHeight,
      firstPtsUs: Math.round(first * 1e6), durationUs: Math.round((end - first) * 1e6),
    };
    return {
      info,
      async frameAt(ptsUs) {
        // Resolve timestamps in the same nearest-microsecond domain that we
        // expose in state and exports (e.g. a 30 fps frame starts at .033333…).
        const sample = await sink.getSample(first + (ptsUs + 0.5) / 1e6);
        if (!sample) throw new Error(`时间 ${ptsUs} µs 没有可解码的画面。`);
        return {
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
        };
      },
      dispose: () => input.dispose(),
    };
  } catch (error) { input.dispose(); throw error; }
}
