// Comparison viewport state: layout mode, split position, shared zoom and pan.
// Pure math only — DOM wiring lives in main.ts. Conventions mirror the desktop
// LayoutState (VoidPlayer lib/native_player/native_player_protocol.dart):
// one shared zoom/pan applied to every track, pan is not clamped, and zooming
// back to 1x re-centers the view.
//
// Screen model: each track's fitted frame box is drawn at its layout center C;
// with transform-origin at the box center, a content point p (CSS px from the
// box center) lands at C + zoom * p + offset. `offset` is shared by all tracks,
// so panning moves every track by the same screen pixels.

export type LayoutMode = 'side-by-side' | 'split';
export type Arrangement = 'horizontal' | 'grid';
export type PixelSizeMode = 'uniform' | 'fill';
/** Presentation-only YUV channel isolation. Shared by every track like zoom;
 *  only frames with original YUV planes (`yuv` kind) render isolated
 *  channels; browser-managed and RGBA resources stay RGB. */
export type ChannelMode = 'rgb' | 'y' | 'u' | 'v';

export const ZOOM_MIN = 1;
export const ZOOM_MAX = 500;
export const ZOOM_PRESETS = [1, 1.25, 1.5, 2, 3, 4, 5, 10];
/** Splitter hit width in CSS px (the visible line itself is 2 px). */
export const SPLIT_HIT_WIDTH = 28;
/** Wheel units per zoom step, matching the desktop app's 120 = 1.1x. */
export const WHEEL_ZOOM_UNIT = 120;
export const WHEEL_ZOOM_STEP = 1.1;

/** Chromium pinch encodes scale as deltaY = -100 * ln(scale).
 * Pixel-mode ctrl+wheel must invert that mapping, not use mouse notch speed.
 * Safari GestureEvent.scale is already a ratio and bypasses this function.
 */
export function wheelZoomFactor(deltaY: number, deltaMode: number, ctrlKey: boolean): number {
  if (!Number.isFinite(deltaY)) return 1;
  const exponent = ctrlKey && deltaMode === 0
    ? -deltaY / 100
    : -normalizeWheelDelta(deltaY, deltaMode) * Math.log(WHEEL_ZOOM_STEP) / WHEEL_ZOOM_UNIT;
  return Math.exp(Math.max(-Math.log(ZOOM_MAX), Math.min(Math.log(ZOOM_MAX), exponent)));
}

export type ViewportSnapshot = {
  mode: LayoutMode;
  arrangement: Arrangement;
  splitPos: number;
  zoom: number;
  offsetX: number;
  offsetY: number;
  pixelSize: PixelSizeMode;
  channel: ChannelMode;
};

export class Viewport {
  mode: LayoutMode = 'side-by-side';
  arrangement: Arrangement = 'horizontal';
  splitPos = 0.5;
  zoom = 1;
  offsetX = 0;
  offsetY = 0;
  pixelSize: PixelSizeMode = 'uniform';
  channel: ChannelMode = 'rgb';

  snapshot(): ViewportSnapshot {
    return { mode: this.mode, arrangement: this.arrangement, splitPos: this.splitPos, zoom: this.zoom, offsetX: this.offsetX, offsetY: this.offsetY, pixelSize: this.pixelSize, channel: this.channel };
  }

  /** Patch application for the automation surface (`window.voidPlayer`). */
  apply(patch: Partial<ViewportSnapshot>) {
    if (patch.arrangement !== undefined) {
      if (!['horizontal', 'grid'].includes(patch.arrangement)) throw new Error('排列方式必须是 horizontal 或 grid。');
      this.arrangement = patch.arrangement;
    }
    if (patch.mode !== undefined) {
      if (patch.mode !== 'side-by-side' && patch.mode !== 'split') throw new Error('布局模式必须是 side-by-side 或 split。');
      this.mode = patch.mode;
    }
    if (patch.pixelSize !== undefined) {
      if (patch.pixelSize !== 'uniform' && patch.pixelSize !== 'fill') throw new Error('像素尺寸模式必须是 uniform 或 fill。');
      this.pixelSize = patch.pixelSize;
    }
    if (patch.channel !== undefined) {
      if (!['rgb', 'y', 'u', 'v'].includes(patch.channel)) throw new Error('通道模式必须是 rgb、y、u 或 v。');
      this.channel = patch.channel;
    }
    if (patch.splitPos !== undefined) this.setSplitPos(Number(patch.splitPos), true);
    if (patch.zoom !== undefined) {
      const zoom = Number(patch.zoom);
      if (!Number.isFinite(zoom)) throw new Error('缩放比例无效。');
      this.zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom));
    }
    for (const key of ['offsetX', 'offsetY'] as const) {
      if (patch[key] !== undefined) {
        const value = Number(patch[key]);
        if (!Number.isFinite(value)) throw new Error('平移偏移无效。');
        this[key] = value;
      }
    }
  }

  setMode(mode: LayoutMode) { this.mode = mode; }
  setPixelSize(pixelSize: PixelSizeMode) { this.pixelSize = pixelSize; }
  setChannel(channel: ChannelMode) {
    if (!['rgb', 'y', 'u', 'v'].includes(channel)) throw new Error('通道模式必须是 rgb、y、u 或 v。');
    this.channel = channel;
  }

  /** Pass clamp=true to constrain a position to the normalized viewport. */
  setSplitPos(pos: number, clamp = false) {
    if (!Number.isFinite(pos)) return;
    this.splitPos = clamp ? Math.min(1, Math.max(0, pos)) : pos;
  }

  panBy(dx: number, dy: number) {
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
    this.offsetX += dx;
    this.offsetY += dy;
  }

  /** Zoom by `factor`, keeping the content point under the cursor fixed.
   *  anchorX/anchorY is the cursor relative to the layout (untransformed)
   *  center of the wrap under it. Zooming to or further out at 1x clears pan. */
  zoomAt(factor: number, anchorX = 0, anchorY = 0): boolean {
    if (!Number.isFinite(factor) || factor <= 0) return false;
    const zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, this.zoom * factor));
    if (zoom === ZOOM_MIN && factor < 1) {
      const changed = this.zoom !== zoom || this.offsetX !== 0 || this.offsetY !== 0;
      this.reset();
      return changed;
    }
    if (zoom === this.zoom) return false;
    const actual = zoom / this.zoom;
    this.offsetX = actual * this.offsetX + (1 - actual) * anchorX;
    this.offsetY = actual * this.offsetY + (1 - actual) * anchorY;
    this.zoom = zoom;
    return true;
  }

  /** Preset picker zoom: anchored at the view center; 1x re-centers. */
  setZoom(zoom: number): boolean {
    if (!Number.isFinite(zoom) || zoom <= 0) return false;
    if (zoom === 1) { const changed = this.zoom !== 1 || this.offsetX !== 0 || this.offsetY !== 0; this.reset(); return changed; }
    return this.zoomAt(zoom / this.zoom, 0, 0);
  }

  reset() {
    this.zoom = 1;
    this.offsetX = 0;
    this.offsetY = 0;
  }

  /** After a relayout (resize, mode switch, pixel-size change, track change)
   *  scales the pan offset by the primary track's display-size ratio, keeping
   *  the viewed content center stable (desktop `_rescaleViewOffsetForResize`). */
  rescaleOffset(fx: number, fy: number) {
    if (!Number.isFinite(fx) || !Number.isFinite(fy) || fx <= 0 || fy <= 0) return;
    this.offsetX *= fx;
    this.offsetY *= fy;
  }
}

export type TrackGeometry = { slotW: number; slotH: number; videoW: number; videoH: number };

export type GridDirection = 'horizontal' | 'vertical';
export type GridCell = { column: number; row: number; bottomHeading: boolean; bottomRow: boolean };
export type GridArrangement = { direction: GridDirection; columns: number; rows: number; cells: GridCell[] };

/** Keep each four-track group in reading order. Place the second group beside
 *  or below the first, maximizing fitted picture area after reserving chrome.
 *  A five-percent improvement is required to change direction during resize. */
export function gridArrangement(width: number, height: number, tracks: { width: number; height: number }[],
  pixelSize: PixelSizeMode, headingHeight: number, transportHeight: number, previous: GridDirection = 'vertical'): GridArrangement {
  const count = tracks.length;
  const candidate = (direction: GridDirection): GridArrangement => {
    const horizontal = count > 4 && direction === 'horizontal';
    const columns = horizontal ? 2 + Math.min(2, count - 4) : Math.min(2, Math.max(1, count));
    const rows = horizontal ? 2 : Math.max(1, Math.ceil(count / 2));
    const cells = tracks.map((_, index) => {
      const column = horizontal ? Math.floor(index / 4) * 2 + index % 2 : index % 2;
      const row = horizontal ? Math.floor(index % 4 / 2) : Math.floor(index / 2);
      return { column, row, bottomHeading: index % 4 >= 2, bottomRow: row === rows - 1 };
    });
    return { direction, columns, rows, cells };
  };
  if (count <= 4) return candidate('vertical');
  const score = (layout: GridArrangement) => {
    const sizes = tracks.map(track => track.width > 0 && track.height > 0 ? track : { width: 16, height: 9 });
    const slotW = width / layout.columns, slotH = height / layout.rows;
    const densities = sizes.map((track, index) => {
      const cell = layout.cells[index];
      const top = cell.bottomHeading ? slotH - headingHeight - (cell.bottomRow ? transportHeight : 0) : 0;
      const overlays = [{ left: 0, right: slotW, top, bottom: top + headingHeight }];
      if (cell.bottomRow && transportHeight > 0) {
        overlays.push({ left: 0, right: slotW, top: slotH - transportHeight, bottom: slotH });
      }
      const area = unobscuredFitArea(slotW, slotH, overlays);
      return Math.min(area.width / track.width, area.height / track.height);
    });
    const uniformDensity = Math.min(...densities);
    return sizes.reduce((area, track, index) => area + track.width * track.height
      * (pixelSize === 'uniform' ? uniformDensity : densities[index]) ** 2, 0);
  };
  const current = candidate(previous), alternative = candidate(previous === 'vertical' ? 'horizontal' : 'vertical');
  return score(alternative) > score(current) * 1.05 ? alternative : current;
}

/** fit-contain: largest video-sized box centered inside the slot. */
export function fitContain(slotW: number, slotH: number, videoW: number, videoH: number): { width: number; height: number } {
  const width = Math.max(1, Math.min(slotW, slotH * videoW / videoH));
  return { width, height: width * videoH / videoW };
}

/** Fitted display size for one track. In `uniform` pixel mode (desktop
 *  uniformVideoPixels) one video pixel occupies the same screen size on every
 *  track: the reference supplies the shared density; fitReference chooses the
 *  tightest constraint so every source remains contained. */
export function fittedSize(track: TrackGeometry, reference: TrackGeometry | null, pixelSize: PixelSizeMode): { width: number; height: number } {
  const base = fitContain(track.slotW, track.slotH, track.videoW, track.videoH);
  if (pixelSize !== 'uniform' || !reference) return base;
  const density = Math.min(track.slotW / track.videoW, track.slotH / track.videoH);
  const refDensity = Math.min(reference.slotW / reference.videoW, reference.slotH / reference.videoH);
  const scale = refDensity / density;
  return { width: base.width * scale, height: base.height * scale };
}

export type WheelIntent = 'zoom' | 'pan';
export type WheelBehavior = 'auto' | 'pan' | 'vertical-zoom';

export function normalizeWheelDelta(delta: number, deltaMode: number): number {
  return deltaMode === 1 ? delta * 40 : deltaMode === 2 ? delta * 800 : delta;
}

type WheelSample = { deltaX: number; deltaY: number; deltaMode: number; ctrlKey: boolean; timeStamp: number; momentum?: boolean };

/** Pixel-mode wheel events can come from either device. Keep a continuous pan
 * through acceleration, reversals and vertical-only portions of the gesture. */
export class WheelGesture {
  private lastAt = -Infinity;
  private lastIntent: WheelIntent | null = null;
  private lastBehavior: WheelBehavior = 'auto';

  classify(event: WheelSample, behavior: WheelBehavior = 'auto'): WheelIntent {
    // Read the unit before the deltas: some browsers expose different values
    // depending on whether a wheel handler has inspected deltaMode.
    const { deltaMode, deltaX, deltaY, ctrlKey, timeStamp, momentum } = event;
    if (ctrlKey) { this.lastIntent = null; return 'zoom'; }
    const gap = timeStamp - this.lastAt;
    const previous = behavior === this.lastBehavior && gap >= 0 && gap < 160 ? this.lastIntent : null;
    let intent: WheelIntent;
    if (behavior === 'pan') intent = 'pan';
    else if (momentum && previous) intent = previous;
    else if (behavior === 'vertical-zoom') intent = deltaY !== 0 && Math.abs(deltaY) >= Math.abs(deltaX) ? 'zoom' : 'pan';
    else if (momentum) intent = 'pan';
    else if (deltaMode !== 0) intent = deltaY !== 0 ? 'zoom' : 'pan';
    else intent = previous === 'pan' || deltaX !== 0 || Math.abs(deltaY) < 50 ? 'pan' : 'zoom';

    this.lastAt = timeStamp;
    this.lastIntent = intent;
    this.lastBehavior = behavior;
    return intent;
  }
}

/** One shared seam snapped in screen space, including a fractional panel origin. */
export function splitPixelGeometry(fraction: number, width: number, left: number, dpr: number, inset = 0) {
  const scale = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
  let pixel = Math.round((left + fraction * width) * scale);
  if (inset > 0) {
    const min = Math.ceil((left + inset) * scale), max = Math.floor((left + width - inset) * scale);
    pixel = min <= max ? Math.max(min, Math.min(max, pixel)) : Math.round((left + width / 2) * scale);
  }
  // Two physical pixels straddle the clip boundary without half-pixel line edges.
  return { x: pixel / scale - left, strokeWidth: 2 / scale };
}


export type OverlayBounds = { left: number; right: number; top: number; bottom: number };
/** Reserve visible overlay bands for fit/centering only. The stage remains full
 * size so zoomed video can still pass underneath the translucent controls. */
export function unobscuredFitArea(width: number, height: number, overlays: OverlayBounds[], gap = 4) {
  let top = 0, bottom = height;
  for (const box of overlays) {
    if (box.right <= 0 || box.left >= width || box.bottom <= 0 || box.top >= height) continue;
    if ((box.top + box.bottom) / 2 <= height / 2) top = Math.max(top, Math.min(height, box.bottom + gap));
    else bottom = Math.min(bottom, Math.max(0, box.top - gap));
  }
  const available = Math.max(1, bottom - top);
  return { width: Math.max(1, width), height: available, centerY: (top + bottom) / 2 - height / 2 };
}
/** Equal pixel density must fit every track, including mixed portrait/landscape
 * sources and grid rows with different amounts of overlay chrome. */
export function fitReference(tracks: TrackGeometry[]): TrackGeometry | null {
  return tracks.reduce<TrackGeometry | null>((reference, track) => !reference ||
    Math.min(track.slotW / track.videoW, track.slotH / track.videoH) < Math.min(reference.slotW / reference.videoW, reference.slotH / reference.videoH) ? track : reference, null);
}
