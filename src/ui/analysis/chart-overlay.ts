import type { InspectionState } from '../../../shared/analysis/metadata/inspection.ts';
import { computeLayout, drawHitRect, drawHitPoint } from './canvas.ts';
import type { CanvasModel } from './canvas.ts';
import type { AnalysisGlyph, SampleGlyph, BucketGlyph } from './geometry.ts';

/** Use the card's reference frame, selecting the curve nearest the pointer in
 * multi-track plots. Empty coverage and axis/margin clicks have no target. */
export function pickLoadCurve(model: CanvasModel, snapshot: InspectionState, x: number, y: number,
  qpAt: (slot: import('../../../shared/review/model.ts').Slot, time: number) => number | null) {
  const geometry = computeLayout(model), row = geometry.bitrate;
  if (!row || x < geometry.gutter || x > geometry.gutter + geometry.plotW || y < row.y || y >= row.y + row.h) return null;
  let nearest: InspectionState['tracks'][number] | null = null, distance = Infinity;
  for (const track of snapshot.tracks) {
    if (!track.reference || !model.tracks.some(entry => entry.slot === track.slot)) continue;
    const values = [
      ...(!model.loadMetrics || model.loadMetrics.includes('bitrate') ? [[track.bitrate.value, model.yMaxBitrate]] : []),
      ...(model.loadMetrics?.includes('qp') ? [[qpAt(track.slot, snapshot.inspectionTimeUs), model.qpMax ?? 51]] : []),
    ];
    for (const [value, maximum] of values) {
      if (value == null || maximum == null || maximum <= 0) continue;
      const yy = row.y + row.h - 4 - Math.min(value, maximum) / maximum * (row.h - 8);
      const delta = Math.abs(y - yy);
      if (delta < distance) { nearest = track; distance = delta; }
    }
  }
  return nearest;
}

export function drawAnalysisOverlay(overlayCtx: CanvasRenderingContext2D | null, lastModel: CanvasModel | null,
  lastGlyphs: readonly AnalysisGlyph[], active: InspectionState | null, hoverUs: number | null,
  devicePixelRatio: number) {
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
        drawHitPoint(ctx, Math.min(Math.max(xOfT, geom.gutter), geom.gutter + geom.plotW), yy, 3.5, track.color, model.colors.text);
      }
    }
    // 各轨命中的样本统一描边，保留柱体本来的轨道色。
    for (const t of active.tracks) {
      const refId = t.reference?.sample.sampleId;
      if (refId) {
        const g = lastGlyphs.find(v => v.kind === 'sample' && (v as SampleGlyph).sampleId === refId) as SampleGlyph | undefined;
        if (g) {
          drawHitRect(ctx, g.rect, model.colors.text);
        } else if (t.reference) {
          const bg = lastGlyphs.find(v => v.kind === 'bucket' && v.slot === t.slot
            && (v as BucketGlyph).startUs <= t.reference!.axisUs && t.reference!.axisUs < (v as BucketGlyph).endUs);
          if (bg) {
            drawHitRect(ctx, bg.rect, model.colors.text);
          }
        }
      }
    }
    const d = active.directTarget;
    if (d?.kind === 'sample') {
      const g = lastGlyphs.find(v => v.kind === 'sample' && (v as SampleGlyph).sampleId === d.sampleId) as SampleGlyph | undefined;
      if (g) {
        // The direct target may also be a track's reference; outline it only once.
        if (!active.tracks.some(t => t.reference?.sample.sampleId === g.sampleId)) drawHitRect(ctx, g.rect, model.colors.text);
      }
    }
}
