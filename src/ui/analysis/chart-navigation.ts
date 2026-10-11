/** Desktop chart navigation: Ctrl+wheel pinch and Safari's native gesture
 * events share the same anchor and range operation. Plain wheel pans. */
export function installChartNavigation(options: {
  canvas: HTMLCanvasElement; signal: AbortSignal; enabled(): boolean;
  plotWidth(): number; zoom(factor: number, clientX: number): void; pan(pixels: number): void;
}) {
  const { canvas, signal, enabled, plotWidth, zoom, pan } = options;
  let gestureScale: number | null = null;
  let gestureX = 0;
  canvas.addEventListener('wheel', event => {
    if (!enabled()) return;
    // A stack scrolls vertically; horizontal wheel (or Shift+wheel) pans time.
    const stack = canvas.closest<HTMLElement>('.analysis-charts.multiple');
    if (!event.ctrlKey && !event.shiftKey && Math.abs(event.deltaY) > Math.abs(event.deltaX) && stack && stack.scrollHeight > stack.clientHeight) return;
    event.preventDefault();
    event.stopPropagation();
    // A browser may emit both representations during one native pinch.
    if (gestureScale !== null) return;
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? plotWidth() : 1;
    if (event.ctrlKey) zoom(Math.exp(Math.max(-4, Math.min(4, event.deltaY * unit / 280))), event.clientX);
    else pan((event.deltaX + event.deltaY) * unit);
  }, { signal, passive: false });
  for (const type of ['gesturestart', 'gesturechange', 'gestureend'] as const) {
    canvas.addEventListener(type, event => {
      if (!enabled()) { gestureScale = null; return; }
      event.preventDefault();
      event.stopPropagation();
      const gesture = event as Event & { scale?: number; clientX?: number };
      const scale = gesture.scale;
      if (type === 'gestureend') { gestureScale = null; return; }
      if (scale === undefined || !Number.isFinite(scale) || scale <= 0) return;
      if (type === 'gesturestart') {
        gestureScale = scale;
        const rect = canvas.getBoundingClientRect();
        gestureX = gesture.clientX ?? rect.left + rect.width / 2;
        return;
      }
      if (gestureScale === null) return;
      zoom(gestureScale / scale, gesture.clientX ?? gestureX);
      gestureScale = scale;
    }, { signal, passive: false });
  }
}
