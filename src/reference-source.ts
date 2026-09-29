import type { MediaSource, DecodedFrame } from './media.ts';
import { MediaOpenError } from './media-errors.ts';
import { isHdrTransfer } from './presentation-color.ts';
import { resolveYuvColor } from './yuv-color.ts';
import { contextLog } from './log.ts';

/** Give the verified origin frame to the session's first presentation. */
function offerVerifiedFrame(source: MediaSource, firstFrame: DecodedFrame): MediaSource {
  const frameAt = source.frameAt.bind(source);
  const dispose = source.dispose.bind(source);
  let pending: DecodedFrame | undefined = firstFrame;
  const release = () => {
    const frame = pending;
    pending = undefined;
    try { frame?.close(); } catch {}
  };
  source.frameAt = async ptsUs => {
    if (pending) {
      const frame = pending;
      pending = undefined;
      if (ptsUs === 0) return frame;
      try { frame.close(); } catch {}
    }
    return frameAt(ptsUs);
  };
  source.dispose = () => { release(); dispose(); };
  return source;
}

/** Common frame contract, independent of container, input location and decoder. */
export function referenceSource(source: MediaSource): MediaSource {
  const verify = (frame: DecodedFrame) => {
    if (frame.kind !== 'yuv' || !resolveYuvColor(frame.description).supported) {
      const hdr = isHdrTransfer(frame.description.color.transfer) || isHdrTransfer(source.info.color?.transfer);
      frame.close();
      throw new MediaOpenError('decode', hdr
        ? '自有色彩目前仅支持 SDR，无法处理此 HDR 视频。请在“色彩与解码”中切换为“浏览器色彩”后重试。'
        : '自有色彩无法处理此视频的像素格式或颜色信息。请在“色彩与解码”中切换为“浏览器色彩”后重试。');
    }
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

  let candidate = source;
  let candidateDisposed = false;
  let witness: MediaSource | undefined;
  let reference: DecodedFrame | undefined;
  let probe: DecodedFrame | undefined;
  let returnWitness = false;
  const disposeCandidate = () => {
    if (candidateDisposed) return;
    candidateDisposed = true;
    candidate.dispose();
  };

  try {
    witness = referenceSource(await software());
    reference = await witness.frameAt(0);
    try {
      const { nativeYuvSource, verifyNativeWitness } = await import('./native-yuv-source.ts');
      candidate = referenceSource(nativeYuvSource(source, depth, reference.description.yuv?.chromaLocation ?? null));
      probe = await candidate.frameAt(0);
      verifyNativeWitness(probe, reference);
      const firstFrame = probe;
      probe = undefined;
      return offerVerifiedFrame(candidate, firstFrame);
    } catch (error) {
      // A successful software first frame is already the fallback source. If
      // native readback or its witness check fails, keep it instead of opening
      // and indexing the same media a second time.
      if (error instanceof DOMException && error.name === 'AbortError') throw error;
      disposeCandidate();
      returnWitness = true;
      contextLog().warn('media', '硬件首帧核验失败，复用已就绪的软件解码源', {
        error: error instanceof Error ? error.message : String(error),
      });
      const firstFrame = reference!;
      reference = undefined;
      return offerVerifiedFrame(witness!, firstFrame);
    } finally {
      probe?.close();
      reference.close();
    }
  } catch (error) {
    disposeCandidate();
    throw error;
  } finally {
    if (!returnWitness) witness?.dispose();
  }
}
