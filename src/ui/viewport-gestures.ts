import type { ViewportTrace } from './viewport-trace.ts';
import { SLOTS } from '../../shared/review/model.ts';
import type { ReviewSession } from '../session.ts';
import { log } from '../logging/log.ts';
import { Viewport, WheelGesture, type WheelBehavior, ZOOM_MIN, normalizeWheelDelta, wheelZoomFactor } from '../../shared/presentation/viewport.ts';

export type ViewportGestureDeps = {
  $<T extends Element = HTMLElement>(id: string): T;
  screens: HTMLElement;
  trace?: ViewportTrace;
  viewport: Viewport;
  session: ReviewSession;
  getTrigger(): string;
  wheelBehavior(): WheelBehavior;
  applyViewTransform(): void;
  zoomAnchor(target: Element | null, clientX: number, clientY: number): { x: number; y: number };
  syncSplitGeometry(): void;
  syncZoomSelect(loaded: boolean): void;
  render(): void;
};

// Viewport gestures (desktop parity): right-drag pans, wheel/pinch zooms at the
// cursor, trackpad two-finger scroll pans. Pan/zoom are shared by both tracks.
export function installViewportGestures(deps: ViewportGestureDeps) {
  const { $, screens, viewport, session, trace, getTrigger, applyViewTransform, zoomAnchor, syncSplitGeometry, syncZoomSelect, render } = deps;

  let gestureLogTimer: ReturnType<typeof setTimeout> | undefined;
  // Safari.app has been observed leaving stale composited tiles ("trails") in the
  // stage area after zoom/pan gestures on a transformed canvas. Not reproducible
  // in Playwright WebKit; as a mitigation, force the view to re-composite once
  // when a gesture settles.
  let flushScheduled = false;
  function flushView() {
    if (flushScheduled) return;
    flushScheduled = true;
    requestAnimationFrame(() => {
      trace?.settle();
      screens.style.transform = 'translateZ(0)';
      requestAnimationFrame(() => { screens.style.transform = ''; flushScheduled = false; });
    });
  }
  function logViewSettled(msg: string) {
    clearTimeout(gestureLogTimer);
    gestureLogTimer = setTimeout(() => {
      log.info('ui', msg, { zoom: Math.round(viewport.zoom * 1000) / 1000, offsetX: Math.round(viewport.offsetX), offsetY: Math.round(viewport.offsetY), trigger: getTrigger() });
      flushView();
    }, 400);
  }

  const wheelGesture = new WheelGesture();
  let viewFrame: number | null = null;
  let pendingPanX = 0, pendingPanY = 0, zoomChanged = false;
  function paintPendingView() {
    viewFrame = null;
    if (pendingPanX || pendingPanY) viewport.panBy(pendingPanX, pendingPanY);
    pendingPanX = pendingPanY = 0;
    applyViewTransform();
    if (zoomChanged && session.trackCount) syncZoomSelect(true);
    zoomChanged = false;
  }
  function scheduleView() {
    if (viewFrame === null) viewFrame = requestAnimationFrame(paintPendingView);
  }
  function flushPendingView() {
    if (viewFrame === null) return;
    cancelAnimationFrame(viewFrame);
    paintPendingView();
  }

  function applyZoom(event: Event & { clientX?: number; clientY?: number; scale?: number }, factor: number) {
    const anchor = zoomAnchor(event.target as Element | null, event.clientX ?? 0, event.clientY ?? 0);
    const changed = viewport.zoomAt(factor, anchor.x, anchor.y);
    trace?.input(event.type === 'wheel' ? 'wheel-zoom' : 'pinch', event, changed ? 'apply' : 'unchanged');
    if (!changed) return false;
    zoomChanged = true;
    scheduleView();
    // At 1× the picture snaps home, including its offscreen recovery control.
    if (viewport.zoom === ZOOM_MIN && !pendingPanX && !pendingPanY) flushPendingView();
    return true;
  }

  // `contextmenu` may target the element under the pointer rather than the
  // captured stage in some browser/input sequences. Keep a short, gesture-
  // scoped document guard through pointerup so a release over another part of
  // the page cannot open the browser's page context menu.
  let activePanPointer: number | null = null;
  let suppressPanContextMenu = false;
  let contextMenuExpiry: ReturnType<typeof setTimeout> | undefined;
  function clearPanContextMenuSuppression() {
    suppressPanContextMenu = false;
    clearTimeout(contextMenuExpiry);
    contextMenuExpiry = undefined;
  }
  document.addEventListener('pointerdown', () => {
    if (activePanPointer === null && suppressPanContextMenu) clearPanContextMenuSuppression();
  }, true);
  document.addEventListener('keydown', () => {
    if (activePanPointer === null && suppressPanContextMenu) clearPanContextMenuSuppression();
  }, true);
  document.addEventListener('contextmenu', e => {
    if (!suppressPanContextMenu) return;
    e.preventDefault();
    clearPanContextMenuSuppression();
  }, true);

  for (const slot of SLOTS) {
    const stage = $(`stage-${slot}`);
    stage.addEventListener('contextmenu', e => e.preventDefault());
    let pan: { pointer: number; x: number; y: number; moved: boolean } | null = null;
    stage.addEventListener('pointerdown', e => {
      if (e.button !== 2 || !session.trackCount) return;
      e.preventDefault();
      pan = { pointer: e.pointerId, x: e.clientX, y: e.clientY, moved: false };
      activePanPointer = e.pointerId;
      suppressPanContextMenu = true;
      clearTimeout(contextMenuExpiry);
      contextMenuExpiry = undefined;
      trace?.input('drag-start', e, 'boundary', slot);
      stage.setPointerCapture(e.pointerId);
    });
    stage.addEventListener('pointermove', e => {
      if (!pan || pan.pointer !== e.pointerId) return;
      const dx = e.clientX - pan.x, dy = e.clientY - pan.y;
      if (!dx && !dy) return;
      trace?.input('drag', e, 'apply', slot);
      pan.x = e.clientX;
      pan.y = e.clientY;
      if (pan.moved) {
        pendingPanX += dx; pendingPanY += dy;
        scheduleView();
      } else {
        pan.moved = true;
        viewport.panBy(dx, dy);
        applyViewTransform();
      }
    });
    const endPan = (e: PointerEvent) => {
      if (!pan || pan.pointer !== e.pointerId) return;
      trace?.input(e.type, e, 'boundary', slot);
      flushPendingView();
      pan = null;
      activePanPointer = null;
      if (suppressPanContextMenu) {
        contextMenuExpiry = setTimeout(clearPanContextMenuSuppression, 500);
      }
      log.info('ui', '视口平移', { offsetX: Math.round(viewport.offsetX), offsetY: Math.round(viewport.offsetY) });
      flushView();
    };
    stage.addEventListener('pointerup', endPan);
    stage.addEventListener('pointercancel', endPan);
    stage.addEventListener('lostpointercapture', endPan);
  }

  screens.addEventListener('wheel', e => {
    if (!session.trackCount) return;
    e.preventDefault();
    const intent = wheelGesture.classify(e, deps.wheelBehavior());
    if (intent === 'pan') {
      const dx = -normalizeWheelDelta(e.deltaX, e.deltaMode);
      const dy = -normalizeWheelDelta(e.deltaY, e.deltaMode);
      trace?.input('wheel-pan', e, 'apply');
      viewport.panBy(dx, dy);
      scheduleView();
      logViewSettled('触控板滚动平移');
      return;
    }
    const factor = wheelZoomFactor(e.deltaY, e.deltaMode, e.ctrlKey);
    if (applyZoom(e, factor)) logViewSettled('视口缩放');
  }, { passive: false });

  // Safari delivers trackpad pinch as gesture events instead of ctrl+wheel.
  let gestureScale = 1;
  for (const type of ['gesturestart', 'gesturechange', 'gestureend'] as const) {
    screens.addEventListener(type, e => {
      e.preventDefault();
      const event = e as Event & { scale?: number; clientX?: number; clientY?: number };
      const scale = event.scale ?? 1;
      if (type === 'gesturestart') { gestureScale = scale; return; }
      if (type === 'gestureend') { logViewSettled('视口缩放'); return; }
      if (!session.trackCount) { gestureScale = scale; return; }
      applyZoom(event, scale / gestureScale);
      gestureScale = scale;
    });
  }

  // Drag and keyboard updates share the grip bounds in syncSplitGeometry.
  const divider = $<HTMLElement>('divider');
  let dividerDrag: number | null = null;
  divider.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    e.preventDefault();
    dividerDrag = e.pointerId;
    divider.setPointerCapture(e.pointerId);
  });
  divider.addEventListener('pointermove', e => {
    if (dividerDrag !== e.pointerId) return;
    const rect = screens.getBoundingClientRect();
    viewport.setSplitPos((e.clientX - rect.left) / rect.width);
    syncSplitGeometry();
    applyViewTransform();
  });
  const endDividerDrag = (e: PointerEvent) => {
    if (dividerDrag !== e.pointerId) return;
    dividerDrag = null;
    log.info('ui', '分割线拖拽结束', { splitPos: Math.round(viewport.splitPos * 1000) / 1000 });
  };
  divider.addEventListener('pointerup', endDividerDrag);
  divider.addEventListener('pointercancel', endDividerDrag);
  divider.addEventListener('keydown', e => {
    if (e.code !== 'ArrowLeft' && e.code !== 'ArrowRight') return;
    e.preventDefault();
    e.stopPropagation();
    viewport.setSplitPos(viewport.splitPos + (e.code === 'ArrowRight' ? 0.05 : -0.05), true);
    syncSplitGeometry();
    applyViewTransform();
    log.info('ui', '分割线键盘调整', { splitPos: Math.round(viewport.splitPos * 1000) / 1000, trigger: 'keyboard' });
  });

  $('arrangement').onclick = () => {
    viewport.apply({ arrangement: viewport.arrangement === 'grid' ? 'horizontal' : 'grid', mode: 'side-by-side' });
    render();
  };
  for (const button of document.querySelectorAll<HTMLButtonElement>('#layout-mode button')) {
    button.onclick = () => {
      const mode = button.dataset.mode as Viewport['mode'];
      if (viewport.mode === mode) return;
      viewport.setMode(mode);
      log.info('ui', '切换布局模式', { mode, trigger: getTrigger() });
      render();
    };
  }
}
