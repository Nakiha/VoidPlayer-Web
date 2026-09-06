import { pixelGrid } from './pixel-grid-model.ts';
import type { GridView } from './pixel-grid-model.ts';

/** Background-only canvas. No video readback, no frame-loop work, and multiple
 * pointer events coalesce into one redraw. Geometry-identical updates are free. */
export function installPixelGrid(canvas: HTMLCanvasElement, label: HTMLElement) {
  const ctx = canvas.getContext('2d');
  let current: GridView | null = null;
  let signature = '';
  let pending = 0;
  let draws = 0;
  let disposed = false;
  function paint() {
    pending = 0;
    if (!ctx || disposed || !current) return;
    const styles = getComputedStyle(canvas);
    const grid = pixelGrid(current);
    if (!grid) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const width = Math.round(current.width * dpr), height = Math.round(current.height * dpr);
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, current.width, current.height);
    ctx.strokeStyle = styles.getPropertyValue('--viewport-grid-line').trim();
    ctx.lineWidth = 1 / dpr;
    const crisp = (n: number) => (Math.round(n * dpr) + .5) / dpr;
    ctx.beginPath();
    for (let x = grid.startX; x <= current.width; x += grid.spacingX) { ctx.moveTo(crisp(x), 0); ctx.lineTo(crisp(x), current.height); }
    for (let y = grid.startY; y <= current.height; y += grid.spacingY) { ctx.moveTo(0, crisp(y)); ctx.lineTo(current.width, crisp(y)); }
    ctx.stroke();
    label.textContent = grid.label;
    // Read-only QA evidence, never a visible performance counter.
    canvas.dataset.gridDraws = String(++draws);
    canvas.dataset.gridPixels = `${grid.cellWidth}x${grid.cellHeight}`;
  }
  function schedule() { if (!pending && current && !disposed) pending = requestAnimationFrame(paint); }
  const themeChanges = new MutationObserver(schedule);
  themeChanges.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] });
  themeChanges.observe(document.head, { childList: true, subtree: true, characterData: true });
  return {
    update(next: GridView | null) {
      canvas.hidden = label.hidden = !next;
      const key = next ? [next.width, next.height, next.imageWidth, next.imageHeight, next.sourceWidth, next.sourceHeight, next.zoom, next.panX, next.panY, window.devicePixelRatio].join('/') : '';
      current = next;
      if (key === signature) return;
      signature = key; schedule();
    },
    dispose() { disposed = true; if (pending) cancelAnimationFrame(pending); themeChanges.disconnect(); },
  };
}
