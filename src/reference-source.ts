import type { MediaSource, DecodedFrame } from './media.ts';
import { MediaOpenError } from './media-errors.ts';
import { resolveYuvColor } from './yuv-color.ts';

/** Common frame contract, independent of container, input location and decoder. */
export function referenceSource(source: MediaSource): MediaSource {
  const verify = (frame: DecodedFrame) => {
    if (frame.kind !== 'yuv' || !resolveYuvColor(frame.description).supported) { frame.close(); throw new MediaOpenError('decode', '正确颜色模式目前仅支持可读取原始平面的 SDR 视频。请使用匹配浏览器模式查看此资源。'); }
    return frame;
  };
  const at = source.frameAt.bind(source), after = source.framesAfter.bind(source), from = source.framesFrom.bind(source), following = source.framesFollowing?.bind(source);
  source.frameAt = async pts => verify(await at(pts));
  source.framesAfter = async (pts, count) => { const frames = await after(pts, count); try { return frames.map(verify); } catch (error) { frames.forEach(f => f.close()); throw error; } };
  source.framesFrom = async function* (pts) { for await (const frame of from(pts)) yield verify(frame); };
  if (following) source.framesFollowing = async function* (pts) { for await (const frame of following(pts)) yield verify(frame); };
  return source;
}

export async function admitReferenceSource(source: MediaSource, software: () => Promise<MediaSource>, depth: number): Promise<MediaSource> {
  if (source.info.decoder !== 'webcodecs') return referenceSource(source);
  try {
    const witness = referenceSource(await software());
    let reference: DecodedFrame | undefined, probe: DecodedFrame | undefined;
    try {
      reference = await witness.frameAt(0);
      const { nativeYuvSource, verifyNativeWitness } = await import('./native-yuv-source.ts');
      source = referenceSource(nativeYuvSource(source, depth, reference.description.yuv?.chromaLocation ?? null));
      probe = await source.frameAt(0); verifyNativeWitness(probe, reference);
      return source;
    } finally { probe?.close(); reference?.close(); witness.dispose(); }
  } catch (error) { source.dispose(); throw error; }
}
