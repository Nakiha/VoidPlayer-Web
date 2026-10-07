import type { Slot } from '../../model.ts';
import type { InspectionState } from '../../analysis/inspection.ts';
import { computeLayout } from '../analysis-canvas.ts';
import type { CanvasModel } from '../analysis-canvas.ts';
import type { AnalysisGlyph, SampleGlyph, BucketGlyph } from '../analysis-geometry.ts';

export function drawAnalysisOverlay(overlayCtx: CanvasRenderingContext2D | null, lastModel: CanvasModel | null,
  lastGlyphs: readonly AnalysisGlyph[], active: InspectionState | null, hoverUs: number | null,
  slotColors: ReadonlyMap<Slot, string>, devicePixelRatio: number) {
    if (!lastModel || !overlayCtx) return;
    const dpr = Math.min(2, devicePixelRatio);
    overlayCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    overlayCtx.clearRect(0, 0, lastModel.width, lastModel.height);
    if (hoverUs == null || !active) return;
    const model = lastModel;
    const geom = computeLayout(model);
    const ctx = overlayCtx;
    const span = model.viewEnd - model.viewStart || 1;
    const xOfT = geom.gutter + ((active.inspectionTimeUs - model.viewStart) / span) * geom.plotW;
    // 码率曲线圆点（轨道色），只在码率行可见时绘制，与表内值同一评价规则。
    if (geom.bitrate && model.showBitrate && model.yMaxBitrate > 0) {
      for (const t of active.tracks) {
        if (t.bitrate.value == null) continue;
        const track = model.tracks.find(m => m.slot === t.slot);
        if (!track) continue;
        const { y, h } = geom.bitrate;
        const yy = y + h - 4 - (Math.min(t.bitrate.value, model.yMaxBitrate) / (model.yMaxBitrate || 1)) * (h - 8);
        ctx.beginPath();
        ctx.arc(Math.min(Math.max(xOfT, geom.gutter), geom.gutter + geom.plotW), yy, 3.5, 0, Math.PI * 2);
        ctx.fillStyle = track.color;
        ctx.fill();
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = '#fff';
        ctx.stroke();
        ctx.lineWidth = 1;
      }
    }
    // 参考样本轮廓高亮，直接命中更明显。
    for (const t of active.tracks) {
      const refId = t.reference?.sample.sampleId;
      if (refId) {
        const g = lastGlyphs.find(v => v.kind === 'sample' && (v as SampleGlyph).sampleId === refId) as SampleGlyph | undefined;
        if (g) {
          ctx.lineWidth = 1.5;
          ctx.strokeStyle = slotColors.get(t.slot) ?? '#888';
          ctx.strokeRect(g.rect.x - 0.5, g.rect.y - 0.5, g.rect.width + 1, g.rect.height + 1);
          ctx.lineWidth = 1;
        } else if (t.reference) {
          const bg = lastGlyphs.find(v => v.kind === 'bucket' && v.slot === t.slot
            && (v as BucketGlyph).startUs <= t.reference!.axisUs && t.reference!.axisUs < (v as BucketGlyph).endUs);
          if (bg) {
            ctx.lineWidth = 1.5;
            ctx.strokeStyle = slotColors.get(t.slot) ?? '#888';
            ctx.strokeRect(bg.rect.x - 0.5, bg.rect.y - 0.5, bg.rect.width + 1, bg.rect.height + 1);
            ctx.lineWidth = 1;
          }
        }
      }
    }
    const d = active.directTarget;
    if (d?.kind === 'sample') {
      const g = lastGlyphs.find(v => v.kind === 'sample' && (v as SampleGlyph).sampleId === d.sampleId) as SampleGlyph | undefined;
      if (g) {
        ctx.lineWidth = 2.5;
        ctx.strokeStyle = '#fff';
        ctx.strokeRect(g.rect.x - 1.5, g.rect.y - 1.5, g.rect.width + 3, g.rect.height + 3);
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = slotColors.get(g.slot) ?? '#888';
        ctx.strokeRect(g.rect.x - 0.5, g.rect.y - 0.5, g.rect.width + 1, g.rect.height + 1);
        ctx.lineWidth = 1;
      }
    }
}
