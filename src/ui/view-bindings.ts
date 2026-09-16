import { SLOTS } from '../model.ts';
import type { Slot } from '../model.ts';
import { setPresentationGeometry } from '../presenter.ts';
import type { ReviewSession } from '../session.ts';
import { setAnnotationViewport } from './annotation-svg.ts';
import { installPixelGrid } from './pixel-grid.ts';
import { needsViewRecovery } from './view-recovery.ts';
import { Viewport, fitReference, fittedSize, splitPixelGeometry, unobscuredFitArea } from '../viewport.ts';

export type FittedTrack = { width: number; height: number; sourceWidth: number; sourceHeight: number; centerY: number };

export type ViewBindingDeps = {
  $<T extends Element = HTMLElement>(id: string): T;
  screens: HTMLElement;
  canvases: Record<Slot, HTMLCanvasElement>;
  grids: Record<Slot, ReturnType<typeof installPixelGrid>>;
  viewport: Viewport;
  session: ReviewSession;
  drawingEditor: { viewChanged(): void };
};

/** Viewport geometry wiring: fit, transform, split seam. Pure DOM reads/writes, no decode. */
export function createViewBindings(deps: ViewBindingDeps) {
  const { $, screens, canvases, grids, viewport, session, drawingEditor } = deps;
  const fittedTracks = new Map<Slot, FittedTrack>();
  let primaryFitted: { width: number; height: number } | null = null;

  function trackGeometry(track: { slot: Slot; width: number; height: number }) {
    const stage = $(`stage-${track.slot}`), rect = stage.getBoundingClientRect();
    // Measure actual bands: lower grid headings live at the bottom, and the
    // global transport overlaps only the grid cells it physically intersects.
    // Visibility-hidden focus chrome retains its geometry to avoid image jumps.
    const overlays = [...document.querySelectorAll<HTMLElement>('.viewport-surface .card-heading, .viewport-surface .transport')]
      .filter(el => !el.hidden && getComputedStyle(el).display !== 'none')
      .map(el => { const box = el.getBoundingClientRect(); return { left: box.left - rect.left, right: box.right - rect.left, top: box.top - rect.top, bottom: box.bottom - rect.top }; });
    const area = unobscuredFitArea(rect.width, rect.height, overlays);
    return { slotW: area.width, slotH: area.height, videoW: track.width, videoH: track.height, centerY: area.centerY };
  }

  function applyViewTransform() {
    const { zoom, offsetX, offsetY } = viewport;
    const value = zoom === 1 && !offsetX && !offsetY ? '' : `translate(${offsetX}px, ${offsetY}px) scale(${zoom})`;
    for (const slot of SLOTS) {
      const image = $(`image-${slot}`);
      if (image.style.transform !== value) image.style.transform = value;
      const stage = $(`stage-${slot}`);
      const fitted = fittedTracks.get(slot);
      const displayOffsetY = offsetY + (fitted?.centerY ?? 0);
      const presentation = fitted ? { width: stage.clientWidth, height: stage.clientHeight, imageWidth: fitted.width, imageHeight: fitted.height, zoom, offsetX, offsetY: displayOffsetY, dpr: devicePixelRatio } : null;
      setPresentationGeometry(canvases[slot], presentation);
      for (const prefix of ['annotations', 'drawing']) setAnnotationViewport($<SVGSVGElement>(`${prefix}-${slot}`), presentation, fitted ? fitted.sourceWidth / fitted.sourceHeight : 1);
      const split = viewport.mode === 'split' && fittedTracks.size === 2;
      const first = stage.closest('.video-card')!.classList.contains('view-first');
      const cut = Math.max(0, Math.min(1, viewport.splitPos));
      const left = split && !first ? cut : 0, right = split && first ? cut : 1;
      const recovery = $(`recover-${slot}`);
      recovery.hidden = !fitted || right - left < .08 || !needsViewRecovery({ width: stage.clientWidth, height: stage.clientHeight, imageWidth: fitted?.width ?? 0, imageHeight: fitted?.height ?? 0, zoom, offsetX, offsetY: displayOffsetY }, left, right);
      recovery.style.left = `${(left + right) / 2 * 100}%`;
      grids[slot].update(fitted ? { width: stage.clientWidth, height: stage.clientHeight, imageWidth: fitted.width, imageHeight: fitted.height, sourceWidth: fitted.sourceWidth, sourceHeight: fitted.sourceHeight, zoom, panX: offsetX, panY: displayOffsetY } : null);
    }
    drawingEditor.viewChanged();
  }

  function syncSplitGeometry() {
    const rect = screens.getBoundingClientRect();
    const seam = splitPixelGeometry(viewport.splitPos, rect.width, rect.left, devicePixelRatio);
    for (const [name, value] of [['--split-x', `${seam.x}px`], ['--split-stroke-width', `${seam.strokeWidth}px`]]) {
      if (screens.style.getPropertyValue(name) !== value) screens.style.setProperty(name, value);
    }
  }

  function fitAll() {
    syncSplitGeometry();
    fittedTracks.clear();
    const allTracks = session.getState().tracks;
    const tracks = viewport.mode === 'split' ? allTracks.slice(0, 2) : allTracks;
    if (!tracks.length) { primaryFitted = null; applyViewTransform(); return; }
    const geometries = new Map(tracks.map(track => [track.slot, trackGeometry(track)]));
    const referenceGeometry = fitReference([...geometries.values()]);
    for (const track of tracks) {
      const geometry = geometries.get(track.slot)!;
      const size = fittedSize(geometry, referenceGeometry, viewport.pixelSize);
      fittedTracks.set(track.slot, { ...size, sourceWidth: track.width, sourceHeight: track.height, centerY: geometry.centerY });
      const image = $(`image-${track.slot}`);
      const width = `${size.width}px`, height = `${size.height}px`;
      const top = `${geometry.centerY}px`;
      if (image.style.top !== top) image.style.top = top;
      if (image.style.width !== width) image.style.width = width;
      if (image.style.height !== height) image.style.height = height;
      if (track === (tracks.find(t => t.slot === 'A') ?? tracks[0])) {
        if (primaryFitted && (viewport.zoom !== 1 || viewport.offsetX || viewport.offsetY) &&
          (Math.abs(primaryFitted.width - size.width) > 0.5 || Math.abs(primaryFitted.height - size.height) > 0.5)) {
          viewport.rescaleOffset(size.width / primaryFitted.width, size.height / primaryFitted.height);
        }
        primaryFitted = size;
      }
    }
    applyViewTransform();
  }

  return { fittedTracks, applyViewTransform, syncSplitGeometry, fitAll };
}
