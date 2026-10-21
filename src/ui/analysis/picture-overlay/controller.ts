import { pictureId, matchesAnalysisLayout } from "../../../../shared/analysis/bitstream/contract.ts";
import type {
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
type FillMode = "none" | "qp" | "modes";
export function createAnalysisOverlay(
  session: ReviewSession,
  slot: Slot,
  source: HTMLCanvasElement,
) {
  const canvas = document.createElement("canvas");
  canvas.className = "analysis-picture-overlay";
  canvas.id = `bitstream-overlay-${slot}`;
  canvas.setAttribute("aria-hidden", "true");
  canvas.hidden = true;
  source.closest(".frame-stage")!.append(canvas);
  let token: PresentedFrameToken | null = session.getPresentedFrame(slot),
    result: ReadonlyAnalysisResult | null = null,
    geometry: PresentationGeometry | null = null,
    fill: FillMode = "none",
    boundaries = true,
    labels = false;
  let lastDraw: {
    result: ReadonlyAnalysisResult;
    geometry: string;
    fill: FillMode;
    boundaries: boolean;
    labels: boolean;
  } | null = null;
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
    if (!geometry) { canvas.hidden = true; return; }
    const g = geometry,
      rect = presentationRect(g);
    const signature = JSON.stringify([g, token.geometry, labels ? document.documentElement.lang : ""]);
    if (
      lastDraw?.result === result &&
      lastDraw.geometry === signature &&
      lastDraw.fill === fill &&
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
    for (const b of result.blocks) {
      const a = codedToViewport(b.x, b.y, token, g),
        z = codedToViewport(b.x + b.width, b.y + b.height, token, g),
        x = Math.min(a.x, z.x),
        y = Math.min(a.y, z.y),
        w = Math.abs(z.x - a.x),
        h = Math.abs(z.y - a.y);
      if (fill === "qp" && b.qp !== null) {
        ctx.fillStyle = `hsl(${240 - (b.qp / (result.codec === "vvc" ? 63 : 51)) * 240},90%,50%)`;
        ctx.fillRect(x, y, w, h);
      } else if (fill === "modes") {
        ctx.fillStyle =
          b.mode === "intra"
            ? "rgb(64,200,255)"
            : b.mode === "skip"
              ? "rgb(80,220,110)"
              : "rgb(255,160,60)";
        ctx.fillRect(x, y, w, h);
      }
      if (boundaries) ctx.rect(x, y, w, h);
      if (labels && fill !== "none" && h >= 18) {
        const text = fill === "qp" ? (b.qp === null ? null : String(b.qp)) : modeLabels[b.mode];
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
    lastDraw = { result, geometry: signature, fill, boundaries, labels };
    metrics.draws++;
    if (metrics.drawTimesMs.length >= 2048) metrics.drawTimesMs.shift();
    metrics.drawTimesMs.push(performance.now() - started);
  };
  const offGeometry = observePresentationGeometry(source, (g) => {
    geometry = g;
    draw();
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
    setDisplay(value: { fill: FillMode; boundaries: boolean; labels: boolean }) {
      fill = value.fill;
      boundaries = value.boundaries;
      labels = value.labels;
      draw();
    },
    hit(x: number, y: number) {
      if (!result || !token || !geometry) return null;
      const rect = presentationRect(geometry);
      if (
        x < rect.x ||
        y < rect.y ||
        x >= rect.x + rect.width ||
        y >= rect.y + rect.height
      )
        return null;
      const p = viewportToCoded(x, y, token, geometry);
      return (
        result.blocks.find(
          (b) =>
            p.x >= b.x &&
            p.y >= b.y &&
            p.x < b.x + b.width &&
            p.y < b.y + b.height,
        ) ?? null
      );
    },
    dispose() {
      offFrame();
      offState();
      offGeometry();
      canvas.remove();
    },
  };
}

export type ReturnOverlay = ReturnType<typeof createAnalysisOverlay>;
