import { pictureId, matchesAnalysisLayout } from "../../../../shared/analysis/bitstream/contract.ts";
import type {
  AnalysisBlock,
  ReadonlyAnalysisResult,
  PresentedFrameToken,
} from "../../../../shared/analysis/bitstream/contract.ts";
import { codedToViewport, viewportToCoded } from "./geometry.ts";
import { observePresentationGeometry } from "../../../presentation/presenter.ts";
import { presentationRect } from "../../../presentation/presentation-surface.ts";
import type { PresentationGeometry } from "../../../presentation/presentation-surface.ts";
import type { ReviewSession } from "../../../session.ts";
import type { Slot } from "../../../../shared/review/model.ts";
import { t, msg } from "../../../i18n.ts";
import { blockColor, blockKey } from './block-display.ts';
import type { BlockFilter, FillMode } from './block-display.ts';
type Point = { x: number; y: number };

export function createAnalysisOverlay(
  session: ReviewSession,
  slot: Slot,
  source: HTMLCanvasElement,
  geometryChanged?: () => void,
) {
  const canvas = document.createElement("canvas");
  canvas.className = "analysis-picture-overlay";
  canvas.id = `bitstream-overlay-${slot}`;
  canvas.setAttribute("aria-hidden", "true");
  canvas.hidden = true;
  const hover = document.createElement('div'), edge = document.createElement('div');
  hover.id = `bitstream-hover-${slot}`;
  hover.className = 'analysis-picture-hover';
  hover.style.setProperty('--hover-track-color', `var(--slot-${slot.toLowerCase()})`);
  hover.setAttribute('aria-hidden', 'true');
  hover.hidden = true;
  edge.className = 'analysis-picture-hover-edge';
  hover.append(edge);
  source.closest('.frame-stage')!.append(canvas, hover);
  let token: PresentedFrameToken | null = session.getPresentedFrame(slot),
    result: ReadonlyAnalysisResult | null = null,
    geometry: PresentationGeometry | null = null,
    filter: BlockFilter | null = null,
    fill: FillMode = "none",
    boundaries = true,
    labels = false;
  let lastDraw: {
    result: ReadonlyAnalysisResult;
    geometry: string;
    filter: BlockFilter | null;
    fill: FillMode;
    boundaries: boolean;
    labels: boolean;
  } | null = null;
  let hitCells: { result: ReadonlyAnalysisResult; columns: number; cells: Uint32Array } | null = null;
  const metrics = {
    presentations: 0,
    cacheHits: 0,
    draws: 0,
    skippedDraws: 0,
    resizes: 0,
    drawTimesMs: [] as number[],
  };
  // Bounded diagnostics, read only on explicit inspection by the perf harness.
  Object.defineProperty(canvas, "analysisMetrics", {
    get: () => ({ ...metrics, drawTimesMs: [...metrics.drawTimesMs] }),
  });
  const clear = () => {
    result = null;
    lastDraw = null;
    hitCells = null;
    hover.hidden = true;
    canvas.hidden = true;
    delete canvas.dataset.picture;
    delete canvas.dataset.labels;
  };
  const draw = () => {
    if (
      !result ||
      !token?.picture ||
      result.confidence !== "exact" ||
      result.sourcePtsUs !== token.sourcePtsUs || !matchesAnalysisLayout(result,token) ||
      pictureId(result.picture) !== pictureId(token.picture)
    ) {
      clear();
      return;
    }
    // Cached results may arrive before the initial geometry observation.
    // Retain the verified picture so that observation can draw it directly.
    if (!geometry) { canvas.hidden = true; hover.hidden = true; return; }
    const g = geometry,
      rect = presentationRect(g);
    const signature = JSON.stringify([g, token.geometry, labels ? document.documentElement.lang : ""]);
    if (
      lastDraw?.result === result &&
      lastDraw.geometry === signature &&
      lastDraw.fill === fill && lastDraw.filter === filter &&
      lastDraw.boundaries === boundaries && lastDraw.labels === labels
    ) {
      metrics.skippedDraws++;
      canvas.dataset.commit = String(token.commit);
      return;
    }
    if (
      g.width * g.height * g.dpr * g.dpr > 32 * 1024 * 1024 ||
      g.width * g.dpr > 8192 ||
      g.height * g.dpr > 8192
    ) {
      clear();
      return;
    }
    if (hitCells?.result !== result) hitCells = null;
    const started = performance.now();
    const width = Math.max(1, Math.round(g.width * g.dpr));
    const height = Math.max(1, Math.round(g.height * g.dpr));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
      metrics.resizes++;
    }
    const ctx = canvas.getContext("2d")!;
    ctx.setTransform(g.dpr, 0, 0, g.dpr, 0, 0);
    ctx.clearRect(0, 0, g.width, g.height);
    ctx.save();
    ctx.beginPath();
    ctx.rect(rect.x, rect.y, rect.width, rect.height);
    ctx.clip();
    // Canvas colors are opaque; the toolbar's single CSS opacity controls
    // the final mix with the video, including the 0% and 100% endpoints.
    ctx.strokeStyle = "rgb(100,240,255)";
    ctx.lineWidth = 1;
    const textLabels: { text: string; x: number; y: number }[] = [];
    const textWidths = new Map<string, number>();
    const modeLabels = {
      intra: t(msg('bitstream.intra', '帧内')),
      inter: t(msg('bitstream.inter', '帧间')),
      skip: t(msg('bitstream.skip', '跳过')),
    };
    ctx.font = '600 11px sans-serif';
    // Keep every real edge, including subpixel blocks at fit. Discarding small
    // blocks creates holes exactly where partitioning is most detailed.
    // One batched stroke keeps shared edges from accumulating opacity.
    ctx.beginPath();
    const colors = new Map<string, string>();
    const highlight = filter?.picture === result ? filter : null;
    for (const b of result.blocks) {
      const a = codedToViewport(b.x, b.y, token, g),
        z = codedToViewport(b.x + b.width, b.y + b.height, token, g),
        x = Math.min(a.x, z.x),
        y = Math.min(a.y, z.y),
        w = Math.abs(z.x - a.x),
        h = Math.abs(z.y - a.y);
      const key = fill === 'none' ? null : blockKey(b, fill);
      const match = highlight && blockKey(b, highlight.dimension) === highlight.key;
      if (match) {
        ctx.fillStyle = 'rgb(255,224,76)';
        ctx.fillRect(x, y, w, h);
      } else if (!highlight && key !== null && fill !== 'none') {
        let color = colors.get(key);
        if (!color) { color = blockColor(fill, key); colors.set(key, color); }
        ctx.fillStyle = color;
        ctx.fillRect(x, y, w, h);
      }
      if (boundaries) ctx.rect(x, y, w, h);
      if (labels && h >= 18) {
        const text = fill === 'none' ? blockKey(b, 'sizes') : fill === 'modes' ? modeLabels[b.mode] :
          fill === 'bits' && b.bits !== undefined ? `${b.bits} bit` : key;
        if (text) {
          let textWidth = textWidths.get(text);
          if (textWidth === undefined) { textWidth = ctx.measureText(text).width; textWidths.set(text, textWidth); }
          const centerX = x + w / 2, centerY = y + h / 2;
          // Test screen-space fit and visibility before retaining a label.
          // Zoomed/panned offscreen blocks must not add invisible text work.
          if (w >= textWidth + 8 && centerX - textWidth / 2 >= Math.max(0, rect.x) + 3 &&
            centerX + textWidth / 2 <= Math.min(g.width, rect.x + rect.width) - 3 &&
            centerY >= Math.max(0, rect.y) + 8 && centerY <= Math.min(g.height, rect.y + rect.height) - 8) {
            textLabels.push({ text, x: centerX, y: centerY });
          }
        }
      }
    }
    if (boundaries) ctx.stroke();
    // Paint after all fills/edges so adjacent blocks cannot cover the text.
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.lineJoin = 'round';
    ctx.strokeStyle = '#000'; ctx.fillStyle = '#fff'; ctx.lineWidth = 2.5;
    for (const label of textLabels) {
      ctx.strokeText(label.text, label.x, label.y);
      ctx.fillText(label.text, label.x, label.y);
    }
    ctx.restore();
    canvas.hidden = false;
    canvas.dataset.picture = pictureId(result.picture);
    canvas.dataset.commit = String(token.commit);
    canvas.dataset.blocks = String(result.blocks.length);
    canvas.dataset.labels = String(textLabels.length);
    lastDraw = { result, geometry: signature, fill, boundaries, labels, filter };
    metrics.draws++;
    if (metrics.drawTimesMs.length >= 2048) metrics.drawTimesMs.shift();
    metrics.drawTimesMs.push(performance.now() - started);
  };
  function findBlock(x: number, y: number) {
    if (canvas.hidden || !result || !token || !geometry || x < 0 || y < 0 || x >= geometry.width || y >= geometry.height) return null;
    const rect = presentationRect(geometry);
    if (x < rect.x || y < rect.y || x >= rect.x + rect.width || y >= rect.y + rect.height) return null;
    const p = viewportToCoded(x, y, token, geometry);
    if (p.x < 0 || p.y < 0 || p.x >= result.width || p.y >= result.height) return null;
    if (!hitCells || hitCells.result !== result) {
      // Exact results cover the coded picture on a 4×4 grid. Build once on
      // demand so moving over dense partitions does not scan the frame.
      const columns = result.width / 4;
      const cells = new Uint32Array(columns * result.height / 4);
      let id = 0;
      for (const b of result.blocks) {
        id++;
        for (let row = b.y / 4; row < (b.y + b.height) / 4; row++) {
          const left = row * columns + b.x / 4;
          cells.fill(id, left, left + b.width / 4);
        }
      }
      hitCells = { result, columns, cells };
    }
    const cell = hitCells.cells[Math.floor(p.y / 4) * hitCells.columns + Math.floor(p.x / 4)];
    const block = result.blocks[cell - 1];
    return block ? { block, coded: p } : null;
  }
  function imageCenter() {
    return geometry ? { x: geometry.width / 2 + geometry.offsetX, y: geometry.height / 2 + geometry.offsetY } : null;
  }
  function setHoveredBlock(block: AnalysisBlock | null) {
    if (!block || !boundaries || canvas.hidden || !token || !geometry) { hover.hidden = true; return; }
    const rect = presentationRect(geometry);
    const a = codedToViewport(block.x, block.y, token, geometry);
    const b = codedToViewport(block.x + block.width, block.y + block.height, token, geometry);
    const left = Math.max(0, rect.x), top = Math.max(0, rect.y);
    const width = Math.min(geometry.width, rect.x + rect.width) - left;
    const height = Math.min(geometry.height, rect.y + rect.height) - top;
    hover.style.left = `${left}px`;
    hover.style.top = `${top}px`;
    hover.style.width = `${width}px`;
    hover.style.height = `${height}px`;
    edge.style.left = `${Math.min(a.x, b.x) - left}px`;
    edge.style.top = `${Math.min(a.y, b.y) - top}px`;
    edge.style.width = `${Math.abs(a.x - b.x)}px`;
    edge.style.height = `${Math.abs(a.y - b.y)}px`;
    hover.hidden = false;
  }
  const offGeometry = observePresentationGeometry(source, (g) => {
    geometry = g;
    draw();
    geometryChanged?.();
  });
  const offFrame = session.subscribePresentedFrames((changed, next) => {
    if (changed !== slot) return;
    const samePicture =
      token?.generation === next.generation &&
      token?.picture &&
      next.picture &&
      pictureId(token.picture) === pictureId(next.picture);
    if (!samePicture) clear();
    token = next;
    metrics.presentations++;
    const hit = session.cachedBitstreamAnalysis(slot, next);
    if (hit) {
      metrics.cacheHits++;
      result = hit;
      draw();
    } else clear();
  });
  const offState = session.subscribe(() => {
    const next = session.getPresentedFrame(slot);
    if (
      !next ||
      next.commit !== token?.commit ||
      next.generation !== token?.generation
    ) {
      clear();
      token = next;
    }
    const hit=session.cachedBitstreamAnalysis(slot,next ?? undefined);
    if(!hit)clear();else if(result!==hit){result=hit;draw();}

  });
  return {
    setResult(value: ReadonlyAnalysisResult) {
      const current = session.getPresentedFrame(slot);
      if (
        !current ||
        current.commit !== token?.commit ||
        current.generation !== token?.generation ||
        !current.picture ||
        pictureId(current.picture) !== pictureId(value.picture)
      )
        return;
      result = session.cachedBitstreamAnalysis(slot, current);
      draw();
    },
    setDisplay(value: { fill: FillMode; boundaries: boolean; labels: boolean; filter?: BlockFilter | null }) {
      filter = value.filter ?? null;
      fill = value.fill;
      boundaries = value.boundaries;
      if (!boundaries) hover.hidden = true;
      labels = value.labels;
      draw();
    },
    hit: (x: number, y: number) => findBlock(x, y)?.block ?? null,
    hitWithDisplacement(x: number, y: number) {
      const center = imageCenter(), hit = center && findBlock(x, y);
      return center && hit ? {...hit, displacement: {x: x - center.x, y: y - center.y}} : null;
    },
    hitDisplacement(point: Point) {
      const center = imageCenter();
      return center ? findBlock(center.x + point.x, center.y + point.y) : null;
    },
    setHoveredBlock,
    setOpacity(value: number) {
      canvas.style.opacity = hover.style.opacity = String(value);
    },
    dispose() {
      offFrame();
      offState();
      offGeometry();
      canvas.remove();
      hover.remove();
    },
  };
}

export type ReturnOverlay = ReturnType<typeof createAnalysisOverlay>;
