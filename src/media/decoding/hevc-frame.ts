import type {HevcGeometry} from '../../../shared/media/codecs/hevc-geometry.ts';
/** Never relabel a landscape pixel rectangle as portrait: lost/cropped pixels
 * cannot be repaired by changing canvas dimensions. Only a browser visibleRect
 * that fully contains the SPS conformance window may be narrowed with
 * metadata-only VideoFrame crop; anything smaller, shifted or coded-mismatched
 * still falls back to software decoding. Exception: a resource the browser
 * already cropped to the conformance window (coded equals the SPS visible
 * size, e.g. WebKit reporting coded=visible=320×180 for SPS coded 320×192).
 * Every expected pixel is present there, so it is accepted with a diagnostic
 * instead of forcing software decoding. */
export function verifyHevcFrame(frame: VideoFrame, geometry: HevcGeometry, diagnostic: (event: Record<string, unknown>) => void = () => {}): VideoFrame {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rect = frame.visibleRect as any;
  const expected = { x: geometry.x, y: geometry.y, width: geometry.width, height: geometry.height };
  const displayWidth = Math.max(1, Math.round(geometry.width * geometry.sarNum / geometry.sarDen)), displayHeight = geometry.height;
  const rectWellFormed = !!rect && Number.isSafeInteger(rect.width) && Number.isSafeInteger(rect.height);
  const rx = Number.isSafeInteger(rect?.x) ? rect.x : 0, ry = Number.isSafeInteger(rect?.y) ? rect.y : 0;
  const exactVisible = rectWellFormed && rx === expected.x && ry === expected.y && rect.width === expected.width && rect.height === expected.height;
  // 1. The decoded resource itself must be trustworthy. A coded mismatch that
  // cannot be explained (e.g. portrait reported as landscape) can never be
  // fixed with crop metadata.
  if (frame.codedWidth !== geometry.codedWidth || frame.codedHeight !== geometry.codedHeight) {
    const insideCoded = Number.isSafeInteger(frame.codedWidth) && Number.isSafeInteger(frame.codedHeight) &&
      frame.codedWidth >= expected.x + expected.width && frame.codedHeight >= expected.y + expected.height;
    if (!exactVisible || !insideCoded) {
      throw new Error(`HEVC 解码输出编码尺寸与 SPS 不一致：期望 coded=${geometry.codedWidth}×${geometry.codedHeight}、期望可见 ${geometry.width}×${geometry.height}，实际 coded=${frame.codedWidth}×${frame.codedHeight}, visible=${rect?.width}×${rect?.height}, display=${frame.displayWidth}×${frame.displayHeight}。`);
    }
    diagnostic({ reason: 'hevc-coded-size-pre-cropped',
      spsCoded: [geometry.codedWidth, geometry.codedHeight], coded: [frame.codedWidth, frame.codedHeight],
      spsVisible: [expected.x, expected.y, expected.width, expected.height] });
  }
  if (!rectWellFormed) {
    throw new Error(`HEVC 解码输出裁剪尺寸与 SPS 不一致：期望 ${geometry.width}×${geometry.height}，实际 coded=${frame.codedWidth}×${frame.codedHeight}, visible=${rect?.width}×${rect?.height}, display=${frame.displayWidth}×${frame.displayHeight}。`);
  }
  // 2. Browser already applied the SPS conformance crop.
  if (rx === expected.x && ry === expected.y && rect.width === expected.width && rect.height === expected.height) {
    if (frame.displayWidth === displayWidth && frame.displayHeight === displayHeight) return frame;
    // The pixel rectangle was verified; only its display aspect needs correction.
    const corrected = new VideoFrame(frame, { displayWidth, displayHeight });
    frame.close();
    return corrected;
  }
  // 3. Only narrowing is safe: the SPS visible area must be fully contained in
  // what the browser handed out (e.g. Edge reporting 720×1272 instead of the
  // SPS 720×1270). Missing or shifted pixels cannot be invented.
  const containsExpected =
    expected.x >= rx && expected.y >= ry &&
    expected.x + expected.width <= rx + rect.width &&
    expected.y + expected.height <= ry + rect.height;
  if (!containsExpected) {
    throw new Error(`HEVC 解码可见区域无法安全修正：期望 ${expected.x},${expected.y} ${expected.width}×${expected.height}，实际 coded=${frame.codedWidth}×${frame.codedHeight}, visible=${rx},${ry} ${rect.width}×${rect.height}, display=${frame.displayWidth}×${frame.displayHeight}。`);
  }
  // Metadata-only crop over the same underlying media resource (no pixel copy).
  const browserVisible = { x: rx, y: ry, width: rect.width, height: rect.height };
  const corrected = new VideoFrame(frame, { visibleRect: expected, displayWidth, displayHeight });
  frame.close();
  diagnostic({ reason: 'hevc-visible-rect-repaired',
    coded: [frame.codedWidth, frame.codedHeight], browserVisible: [browserVisible.x, browserVisible.y, browserVisible.width, browserVisible.height],
    spsVisible: [expected.x, expected.y, expected.width, expected.height] });
  return corrected;
}

