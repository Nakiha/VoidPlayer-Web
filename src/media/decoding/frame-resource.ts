import {validateDescription} from '../../../shared/media/frame-description.ts';
import type {FrameDescription} from '../../../shared/media/frame-description.ts';
import type {VideoSample} from 'mediabunny';
/** Describe a borrowed resource without cloning, copying, or closing it.
 * Opaque hardware surfaces remain valid renderable frames. Their storage layout
 * is unavailable, so charge an RGBA16-sized budget estimate using coded pixels.
 * allocationSize is a copy-buffer size, never total decoder/GPU memory usage. */
export function videoFrameDescription(frame: VideoFrame, displayWidth = frame.displayWidth, displayHeight = frame.displayHeight, byteLength?: number): FrameDescription {
  let byteLengthEstimated = false;
  if (byteLength === undefined) {
    if (frame.format === null) byteLengthEstimated = true;
    else {
      try { byteLength = frame.allocationSize(); }
      catch (error) {
        if (!(error instanceof Error) || error.name !== 'NotSupportedError') throw error;
        byteLengthEstimated = true;
      }
    }
    if (byteLengthEstimated) byteLength = frame.codedWidth * frame.codedHeight * 8;
  }
  const rect = frame.visibleRect ?? { x: 0, y: 0, width: frame.codedWidth, height: frame.codedHeight };
  const color = frame.colorSpace;
  const description: FrameDescription = { revision: 1, width: rect.width, height: rect.height,
    codedWidth: frame.codedWidth, codedHeight: frame.codedHeight,
    visibleRect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, displayWidth, displayHeight,
    stride: null, byteLength: byteLength!, byteLengthEstimated, format: frame.format,
    color: { primaries: color.primaries, transfer: color.transfer, matrix: color.matrix, fullRange: color.fullRange } };
  validateDescription(description);
  return description;
}
export function sampleDescription(sample: VideoSample, byteLength?: number): FrameDescription {
  const frame = sample.toVideoFrame();
  try { return videoFrameDescription(frame, sample.displayWidth, sample.displayHeight, byteLength); }
  finally { frame.close(); }
}
