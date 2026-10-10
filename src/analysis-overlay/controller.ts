import { pictureId } from "../bitstream-analysis/contract.ts";
import type {
  AnalysisResult,
  PresentedFrameToken,
} from "../bitstream-analysis/contract.ts";
import { codedToViewport, viewportToCoded } from "./geometry.ts";
import { observePresentationGeometry } from "../presenter.ts";
import { presentationRect } from "../presentation-surface.ts";
import type { PresentationGeometry } from "../presentation-surface.ts";
import type { ReviewSession } from "../session.ts";
import type { Slot } from "../model.ts";
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
    result: AnalysisResult | null = null,
    geometry: PresentationGeometry | null = null,
    mode: "blocks" | "qp" | "modes" = "blocks";
  const clear = () => {
    result = null;
    canvas.hidden = true;
    const ctx = canvas.getContext("2d");
    ctx?.clearRect(0, 0, canvas.width, canvas.height);
    delete canvas.dataset.picture;
  };
  const draw = () => {
    if (
      !result ||
      !token?.picture ||
      !geometry ||
      result.confidence !== "exact" ||
      pictureId(result.picture) !== pictureId(token.picture)
    ) {
      clear();
      return;
    }
    const g = geometry,
      rect = presentationRect(g);
    if (
      g.width * g.height * g.dpr * g.dpr > 32 * 1024 * 1024 ||
      g.width * g.dpr > 8192 ||
      g.height * g.dpr > 8192
    ) {
      clear();
      return;
    }
    canvas.width = Math.max(1, Math.round(g.width * g.dpr));
    canvas.height = Math.max(1, Math.round(g.height * g.dpr));
    const ctx = canvas.getContext("2d")!;
    ctx.scale(g.dpr, g.dpr);
    ctx.beginPath();
    ctx.rect(rect.x, rect.y, rect.width, rect.height);
    ctx.clip();
    ctx.strokeStyle = "rgba(100,240,255,.8)";
    ctx.lineWidth = 1;
    // Batched path; skip subpixel block strokes at fit, retain detailed hit tests.
    ctx.beginPath();
    for (const b of result.blocks) {
      const a = codedToViewport(b.x, b.y, token, g),
        z = codedToViewport(b.x + b.width, b.y + b.height, token, g),
        x = Math.min(a.x, z.x),
        y = Math.min(a.y, z.y),
        w = Math.abs(z.x - a.x),
        h = Math.abs(z.y - a.y);
      if (mode === "qp" && b.qp !== null) {
        ctx.fillStyle = `hsla(${240 - (b.qp / (result.codec === "vvc" ? 63 : 51)) * 240},90%,50%,.38)`;
        ctx.fillRect(x, y, w, h);
      } else if (mode === "modes") {
        ctx.fillStyle =
          b.mode === "intra"
            ? "rgba(64,200,255,.3)"
            : b.mode === "skip"
              ? "rgba(80,220,110,.3)"
              : "rgba(255,160,60,.3)";
        ctx.fillRect(x, y, w, h);
      }
      if (w >= 2 && h >= 2) ctx.rect(x, y, w, h);
    }
    ctx.stroke();
    canvas.hidden = false;
    canvas.dataset.picture = pictureId(result.picture);
    canvas.dataset.commit = String(token.commit);
    canvas.dataset.blocks = String(result.blocks.length);
  };
  const offGeometry = observePresentationGeometry(source, (g) => {
    geometry = g;
    draw();
  });
  const offFrame = session.subscribePresentedFrames((changed, next) => {
    if (changed !== slot) return;
    clear();
    token = next;
    const hit = session.cachedBitstreamAnalysis(slot, next);
    if (hit) {
      result = hit;
      draw();
    }
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
    if (!result) {
      const hit = session.cachedBitstreamAnalysis(slot);
      if (hit) {
        result = hit;
        draw();
      }
    }
  });
  return {
    setResult(value: AnalysisResult) {
      const current = session.getPresentedFrame(slot);
      if (
        !current ||
        current.commit !== token?.commit ||
        current.generation !== token?.generation ||
        !current.picture ||
        pictureId(current.picture) !== pictureId(value.picture)
      )
        return;
      result = value;
      draw();
    },
    setMode(value: typeof mode) {
      mode = value;
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
