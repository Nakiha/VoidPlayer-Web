import { SLOTS } from '../model.ts';
import type { ReviewSession } from '../session.ts';
import { log } from '../log.ts';
import { PanMomentumFilter, Viewport, classifyWheel, normalizeWheelDelta, wheelZoomFactor } from '../viewport.ts';

export type ViewportGestureDeps = {
  $<T extends Element = HTMLElement>(id: string): T;
  screens: HTMLElement;
  viewport: Viewport;
  session: ReviewSession;
  getTrigger(): string;
  applyViewTransform(): void;
  syncSplitGeometry(): void;
  syncZoomSelect(loaded: boolean): void;
  render(): void;
};

// Viewport gestures (desktop parity): right-drag pans, wheel/pinch zooms at the
// cursor, trackpad two-finger scroll pans. Pan/zoom are shared by both tracks.
export function installViewportGestures(deps: ViewportGestureDeps) {
  const { $, screens, viewport, session, getTrigger, applyViewTransform, syncSplitGeometry, syncZoomSelect, render } = deps;

  function wrapAnchor(target: Element | null, clientX: number, clientY: number) {
    const wrap = (target?.closest('.image-wrap') ?? target?.closest('.video-card')?.querySelector('.image-wrap') ?? document.querySelector('.image-wrap:not([hidden])')) as HTMLElement | null;
    if (!wrap) return { x: 0, y: 0 };
    const rect = wrap.getBoundingClientRect();
    // The rect center is post-transform (C + offset); recover the layout center.
    return { x: clientX - (rect.left + rect.width / 2) + viewport.offsetX, y: clientY - (rect.top + rect.height / 2) + viewport.offsetY };
  }

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

  const panMomentum = new PanMomentumFilter();
  for (const slot of SLOTS) {
    const stage = $(`stage-${slot}`);
    stage.addEventListener('contextmenu', e => e.preventDefault());
    let pan: { pointer: number; x: number; y: number } | null = null;
    stage.addEventListener('pointerdown', e => {
      if (e.button !== 2 || !session.getState().tracks.length) return;
      e.preventDefault();
      pan = { pointer: e.pointerId, x: e.clientX, y: e.clientY };
      stage.setPointerCapture(e.pointerId);
    });
    stage.addEventListener('pointermove', e => {
      if (!pan || pan.pointer !== e.pointerId) return;
      viewport.panBy(e.clientX - pan.x, e.clientY - pan.y);
      pan.x = e.clientX;
      pan.y = e.clientY;
      applyViewTransform();
    });
    const endPan = (e: PointerEvent) => {
      if (!pan || pan.pointer !== e.pointerId) return;
      pan = null;
      log.info('ui', '视口平移', { offsetX: Math.round(viewport.offsetX), offsetY: Math.round(viewport.offsetY) });
      flushView();
    };
    stage.addEventListener('pointerup', endPan);
    stage.addEventListener('pointercancel', endPan);
  }

  screens.addEventListener('wheel', e => {
    if (!session.getState().tracks.length) return;
    e.preventDefault();
    const inverted = (e as WheelEvent & { webkitDirectionInvertedFromDevice?: boolean }).webkitDirectionInvertedFromDevice;
    if (classifyWheel(e.deltaY, e.deltaMode, e.ctrlKey, inverted) === 'pan') {
      const dx = -normalizeWheelDelta(e.deltaX, e.deltaMode);
      const dy = -normalizeWheelDelta(e.deltaY, e.deltaMode);
      if (!panMomentum.accept(dx, dy, e.timeStamp)) return;
      viewport.panBy(dx, dy);
      applyViewTransform();
      logViewSettled('触控板滚动平移');
      return;
    }
    const factor = wheelZoomFactor(e.deltaY, e.deltaMode, e.ctrlKey);
    const anchor = wrapAnchor(e.target as Element | null, e.clientX, e.clientY);
    if (viewport.zoomAt(factor, anchor.x, anchor.y)) { applyViewTransform(); syncZoomSelect(true); logViewSettled('视口缩放'); }
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
      if (!session.getState().tracks.length) { gestureScale = scale; return; }
      const anchor = wrapAnchor(e.target as Element | null, event.clientX ?? 0, event.clientY ?? 0);
      if (viewport.zoomAt(scale / gestureScale, anchor.x, anchor.y)) { applyViewTransform(); syncZoomSelect(true); }
      gestureScale = scale;
    });
  }

  // Splitter: draggable divider (unclamped while dragging, clamped on release,
  // like the desktop) with a 5% keyboard step.
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
    viewport.setSplitPos(viewport.splitPos, true);
    syncSplitGeometry();
    divider.setAttribute('aria-valuenow', String(Math.round(viewport.splitPos * 100)));
    applyViewTransform();
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
    divider.setAttribute('aria-valuenow', String(Math.round(viewport.splitPos * 100)));
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
