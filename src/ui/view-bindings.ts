import type { ViewportTrace } from './viewport-trace.ts';
import { SLOTS } from '../../shared/review/model.ts';
import type { Slot } from '../../shared/review/model.ts';
import { setPresentationGeometry } from '../presentation/presenter.ts';
import type { ReviewSession } from '../session.ts';
import { setAnnotationViewport } from './annotation-svg.ts';
import { installPixelGrid } from './pixel-grid.ts';
import { needsViewRecovery } from './view-recovery.ts';
import { Viewport, fitReference, fittedSize, gridArrangement, splitPixelGeometry, unobscuredFitArea } from '../../shared/presentation/viewport.ts';
import type { GridDirection, ViewportSnapshot, PanBasis } from '../../shared/presentation/viewport.ts';

export type FittedTrack = { width: number; height: number; sourceWidth: number; sourceHeight: number; centerY: number };

export type ViewBindingDeps = {
  changed?(): void;
  $<T extends Element = HTMLElement>(id: string): T;
  screens: HTMLElement;
  canvases: Record<Slot, HTMLCanvasElement>;
  grids: Record<Slot, ReturnType<typeof installPixelGrid>>;
  viewport: Viewport;
  session: ReviewSession;
  trace: ViewportTrace;
  drawingEditor: { viewChanged(): void };
};

/** Viewport geometry wiring: fit, transform, split seam. Pure DOM reads/writes, no decode. */
export function createViewBindings(deps: ViewBindingDeps) {
  const { $, screens, canvases, grids, viewport, session, drawingEditor } = deps;
  const divider = $('divider'), grip = divider.querySelector<HTMLElement>('.divider-grip')!;
  const fittedTracks = new Map<Slot, FittedTrack>();
  let primaryFitted: { width: number; height: number } | null = null;
  let gridDirection: GridDirection = 'vertical';

  function imageTransform() {
    const { zoom, offsetX, offsetY } = viewport;
    return zoom === 1 && !offsetX && !offsetY ? '' : `translate(${offsetX}px, ${offsetY}px) scale(${zoom})`;
  }
  function zoomAnchor(target: Element | null, clientX: number, clientY: number) {
    const wrap = target?.closest('.image-wrap') ?? target?.closest('.video-card')?.querySelector('.image-wrap') ?? screens.querySelector('.image-wrap:not([hidden])');
    if (!(wrap instanceof HTMLElement)) return { x: 0, y: 0 };
    // Read the browser's actual transformed rectangle, including its subpixel rounding.
    // Earlier inputs in this frame may have moved this anchor before the canvases repaint.
    const value = imageTransform();
    if (wrap.style.transform !== value) wrap.style.transform = value;
    const rect = wrap.getBoundingClientRect();
    return { x: clientX - (rect.left + rect.width / 2) + viewport.offsetX, y: clientY - (rect.top + rect.height / 2) + viewport.offsetY };
  }

  function syncTrackLayout(tracks: ReturnType<ReviewSession['getViewportTracks']>) {
    const split = viewport.mode === 'split' && tracks.length > 1;
    const grid = viewport.arrangement === 'grid' && !split;
    const rect = screens.getBoundingClientRect(), style = getComputedStyle(screens);
    const layout = grid ? gridArrangement(rect.width, rect.height, tracks, viewport.pixelSize,
      Number.parseFloat(style.getPropertyValue('--row-height')),
      Number.parseFloat(style.getPropertyValue('--transport-height')) + Number.parseFloat(style.getPropertyValue('--transport-inset')),
      gridDirection) : null;
    if (layout) gridDirection = layout.direction;
    const columns = layout?.columns ?? Math.max(1, tracks.length), rows = layout?.rows ?? 1;
    for (const [name, value] of [['--view-columns', String(columns)], ['--view-rows', String(rows)]]) {
      if (screens.style.getPropertyValue(name) !== value) screens.style.setProperty(name, value);
    }
    for (const slot of SLOTS) {
      const card = $(`stage-${slot}`).closest<HTMLElement>('.video-card')!;
      const index = tracks.findIndex(track => track.slot === slot), cell = layout?.cells[index];
      const column = cell?.column ?? Math.max(0, index), row = cell?.row ?? 0;
      const gridColumn = grid ? String(column + 1) : '', gridRow = grid ? String(row + 1) : '';
      if (card.style.gridColumn !== gridColumn) card.style.gridColumn = gridColumn;
      if (card.style.gridRow !== gridRow) card.style.gridRow = gridRow;
      card.classList.toggle('column-divider', index >= 0 && column > 0);
      card.classList.toggle('bottom-heading', !!cell?.bottomHeading);
      card.classList.toggle('bottom-row', index >= 0 && (cell?.bottomRow ?? true));
    }
  }

  function trackGeometry(track: { slot: Slot; width: number; height: number }) {
    const stage = $(`stage-${track.slot}`), rect = stage.getBoundingClientRect();
    // Measure actual bands: lower grid headings live at the bottom, and the
    // global transport overlaps only the grid cells it physically intersects.
    // Visibility-hidden focus chrome retains its geometry to avoid image jumps.
    const overlays = [...document.querySelectorAll<HTMLElement>('.viewport-surface .card-heading, .viewport-surface .transport-dock')]
      .filter(el => !el.hidden && getComputedStyle(el).display !== 'none')
      .map(el => { const box = el.getBoundingClientRect(); return { left: box.left - rect.left, right: box.right - rect.left, top: box.top - rect.top, bottom: box.bottom - rect.top }; });
    const area = unobscuredFitArea(rect.width, rect.height, overlays);
    return { slotW: area.width, slotH: area.height, videoW: track.width, videoH: track.height, centerY: area.centerY };
  }

  function applyViewTransform() {
    const trace = deps.trace.active ? deps.trace : undefined;
    const begin = trace ? performance.now() : 0;
    let presenterMs = 0, gridMs = 0;
    const { zoom, offsetX, offsetY } = viewport;
    const value = imageTransform();
    // Read stage sizes together, before transforms, overlays or canvases write to the DOM.
    const sizes = Array.from(fittedTracks, ([slot, fitted]) => {
      const stage = $(`stage-${slot}`);
      return { slot, fitted, stage, width: stage.clientWidth, height: stage.clientHeight };
    });
    for (const { slot, fitted, stage, width, height } of sizes) {
      const image = $(`image-${slot}`);
      if (image.style.transform !== value) image.style.transform = value;
      const displayOffsetY = offsetY + fitted.centerY;
      const presentation = { width, height, imageWidth: fitted.width, imageHeight: fitted.height, zoom, offsetX, offsetY: displayOffsetY, dpr: devicePixelRatio };
      const beforePresent = trace ? performance.now() : 0;
      setPresentationGeometry(canvases[slot], presentation);
      if (trace) { presenterMs += performance.now() - beforePresent; trace.geometry(slot, presentation); }
      for (const prefix of ['annotations', 'drawing']) setAnnotationViewport($<SVGSVGElement>(`${prefix}-${slot}`), presentation, fitted.sourceWidth / fitted.sourceHeight);
      const split = viewport.mode === 'split' && fittedTracks.size === 2;
      const first = stage.closest('.video-card')!.classList.contains('view-first');
      const cut = Math.max(0, Math.min(1, viewport.splitPos));
      const left = split && !first ? cut : 0, right = split && first ? cut : 1;
      const recovery = $(`recover-${slot}`);
      // Wiping hides a portion intentionally; recovery concerns pan/zoom outside
      // the whole stage. Keep the control within the track's exposed portion.
      const hidden = right - left < .08 || !needsViewRecovery(presentation);
      if (recovery.hidden !== hidden) recovery.hidden = hidden;
      const position = `${(left + right) / 2 * 100}%`;
      if (recovery.style.left !== position) recovery.style.left = position;
      const beforeGrid = trace ? performance.now() : 0;
      grids[slot].update({ width, height, imageWidth: fitted.width, imageHeight: fitted.height, sourceWidth: fitted.sourceWidth, sourceHeight: fitted.sourceHeight, zoom, panX: offsetX, panY: displayOffsetY });
      if (trace) gridMs += performance.now() - beforeGrid;
    }
    drawingEditor.viewChanged();
    trace?.commit(begin, presenterMs, gridMs);
    deps.changed?.();
  }

  function syncSplitGeometry() {
    const rect = screens.getBoundingClientRect();
    const inset = !divider.hidden && rect.width > 0 ? grip.getBoundingClientRect().width / 2 + 4 : 0;
    if (inset > 0) {
      const min = Math.min(.5, inset / rect.width);
      viewport.setSplitPos(Math.max(min, Math.min(1 - min, viewport.splitPos)));
    }
    divider.setAttribute('aria-valuenow', String(Math.round(viewport.splitPos * 100)));
    const seam = splitPixelGeometry(viewport.splitPos, rect.width, rect.left, devicePixelRatio, inset);
    for (const [name, value] of [['--split-x', `${seam.x}px`], ['--split-stroke-width', `${seam.strokeWidth}px`]]) {
      if (screens.style.getPropertyValue(name) !== value) screens.style.setProperty(name, value);
    }
  }

  function fitAll() {
    const loaded = session.getViewportTracks();
    const allTracks = loaded.filter(track => track.visible);
    syncTrackLayout(allTracks);
    syncSplitGeometry();
    fittedTracks.clear();
    const tracks = viewport.mode === 'split' ? allTracks.slice(0, 2) : allTracks;
    for (const slot of SLOTS) {
      if (tracks.some(track => track.slot === slot)) continue;
      // Hiding a loaded slot must retain its paused frame. Only unload releases it.
      if (!loaded.some(track => track.slot === slot)) setPresentationGeometry(canvases[slot], null);
      grids[slot].update(null);
      const recovery = $(`recover-${slot}`);
      if (!recovery.hidden) recovery.hidden = true;
    }
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
          (primaryFitted.width !== size.width || primaryFitted.height !== size.height)) {
          viewport.rescaleOffset(size.width / primaryFitted.width, size.height / primaryFitted.height);
        }
        primaryFitted = size;
      }
    }
    applyViewTransform();
  }

  return { fittedTracks, applyViewTransform, syncSplitGeometry, fitAll, zoomAnchor,
    capturePanBasis: () => primaryFitted && (viewport.offsetX || viewport.offsetY) ? { ...primaryFitted } : undefined,
    restoreViewport(snapshot: ViewportSnapshot, basis?: PanBasis) {
      viewport.apply(snapshot);
      // Restore against the sender's fitted image, never an unrelated intermediate recipient layout.
      primaryFitted = basis ? { ...basis } : null;
    } };
}
