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

export const ZOOM_MIN = 1;
export const ZOOM_MAX = 50;
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
};

export class Viewport {
  mode: LayoutMode = 'side-by-side';
  arrangement: Arrangement = 'horizontal';
  splitPos = 0.5;
  zoom = 1;
  offsetX = 0;
  offsetY = 0;
  pixelSize: PixelSizeMode = 'uniform';

  snapshot(): ViewportSnapshot {
    return { mode: this.mode, arrangement: this.arrangement, splitPos: this.splitPos, zoom: this.zoom, offsetX: this.offsetX, offsetY: this.offsetY, pixelSize: this.pixelSize };
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

  /** While dragging the splitter the position is NOT clamped (the divider may
   *  leave the stage); pass clamp=true when the gesture ends. */
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
   *  center of the wrap under it. Zooming to 1x clears the pan offset. */
  zoomAt(factor: number, anchorX = 0, anchorY = 0): boolean {
    if (!Number.isFinite(factor) || factor <= 0) return false;
    const zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, this.zoom * factor));
    if (zoom === this.zoom) return false;
    if (zoom === ZOOM_MIN) {
      this.zoom = zoom;
      this.offsetX = 0;
      this.offsetY = 0;
      return true;
    }
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

/** fit-contain: largest video-sized box centered inside the slot. */
export function fitContain(slotW: number, slotH: number, videoW: number, videoH: number): { width: number; height: number } {
  const width = Math.max(1, Math.min(slotW, slotH * videoW / videoH));
  return { width, height: width * videoH / videoW };
}

/** Fitted display size for one track. In `uniform` pixel mode (desktop
 *  uniformVideoPixels) one video pixel occupies the same screen size on every
 *  track: the track with the most pixels fills its slot, the rest shrink. */
export function fittedSize(track: TrackGeometry, reference: TrackGeometry | null, pixelSize: PixelSizeMode): { width: number; height: number } {
  const base = fitContain(track.slotW, track.slotH, track.videoW, track.videoH);
  if (pixelSize !== 'uniform' || !reference) return base;
  const density = Math.min(track.slotW / track.videoW, track.slotH / track.videoH);
  const refDensity = Math.min(reference.slotW / reference.videoW, reference.slotH / reference.videoH);
  const scale = refDensity / density;
  return { width: base.width * scale, height: base.height * scale };
}

export type WheelIntent = 'zoom' | 'pan';

export function normalizeWheelDelta(delta: number, deltaMode: number): number {
  return deltaMode === 1 ? delta * 40 : deltaMode === 2 ? delta * 800 : delta;
}

/** Browsers cannot reliably tell a mouse wheel from trackpad scrolling.
 *  Known signals first: ctrl+wheel is trackpad pinch on Chromium/Firefox, and
 *  WebKit tags trackpad-originated scrolls with directionInvertedFromDevice.
 *  Otherwise fall back to a heuristic: mouse notches are large integer deltas,
 *  trackpad pixel scrolling is small and usually fractional (dpr-scaled). */
export function classifyWheel(deltaY: number, deltaMode: number, ctrlKey: boolean, webkitDirectionInverted?: boolean): WheelIntent {
  if (ctrlKey) return 'zoom';
  if (webkitDirectionInverted === true) return 'pan';
  if (webkitDirectionInverted === false) return 'zoom';
  const dy = normalizeWheelDelta(deltaY, deltaMode);
  return Math.abs(dy) >= 50 && Number.isInteger(dy) ? 'zoom' : 'pan';
}

/** macOS sends synthetic "momentum" wheel events after the fingers leave the
 *  trackpad, and no web API flags them. Their signature is a smooth decay
 *  tail: same direction, regular frame cadence, each step a near-constant
 *  fraction of the previous one. Direct manipulation is irregular. This
 *  filter lets the first couple of decay steps through (they are usually
 *  still fingers slowing down) and cuts the rest of the tail, so a fling
 *  stops almost immediately after lift-off — matching the desktop app's
 *  inertia-free pan. */
export class PanMomentumFilter {
  private lastT = 0;
  private lastMag = 0;
  private lastDir = 0;
  private streak = 0;

  /** Returns true when the event should be applied. */
  accept(dx: number, dy: number, now: number): boolean {
    const mag = Math.hypot(dx, dy);
    const dir = mag === 0 ? 0 : Math.abs(dx) >= Math.abs(dy) ? Math.sign(dx) : Math.sign(dy) * 2;
    const dt = now - this.lastT;
    const decaying = this.lastMag > 0 && mag > 0 && dir === this.lastDir &&
      dt >= 2 && dt <= 40 && mag <= this.lastMag * 0.995 && mag >= this.lastMag * 0.4;
    this.streak = decaying ? this.streak + 1 : 0;
    this.lastT = now;
    this.lastMag = mag;
    this.lastDir = dir;
    return this.streak < 3;
  }
}


/** One shared seam snapped in screen space, including a fractional panel origin. */
export function splitPixelGeometry(fraction:number, width:number, left:number, dpr:number) {
  const scale=Number.isFinite(dpr)&&dpr>0?dpr:1;
  const x=Math.round((left+fraction*width)*scale)/scale-left;
  // Two physical pixels straddle the clip boundary without half-pixel line edges.
  return {x,strokeWidth:2/scale};
}
