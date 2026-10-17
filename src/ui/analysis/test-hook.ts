import type { InspectionState } from '../../analysis/inspection.ts';
import type { AnalysisAxis, AnalysisResult } from '../../../shared/analysis/metadata/types.ts';
import type { Slot } from '../../../shared/review/model.ts';
import type { AnalysisGlyph, BucketGlyph, SampleGlyph } from '../analysis-geometry.ts';

export interface AnalysisTestHookSnapshot {
  view: { start: number; end: number };
  axis: AnalysisAxis;
  pendingSlots: Slot[];
  results: ReadonlyMap<Slot, AnalysisResult>;
  pinned: boolean;
  plot: HTMLElement;
  visibleCard: HTMLElement | undefined;
  active: InspectionState | null;
  glyphs: AnalysisGlyph[];
}

/**
 * 只读测试快照：布局 glyph 身份与当前检查状态，供浏览器回归精确断言。
 * 只在 QA 钩子启用时构建：生产 hover 不为 2000 条 glyph 摘要与 DOM 几何读取付费。
 */
export function publishAnalysisTestHook(snapshot: () => AnalysisTestHookSnapshot) {
  try {
    const w = window as unknown as { __vpAnalysis?: unknown; __vpAnalysisQA?: boolean };
    if (!w.__vpAnalysisQA) return;
    const { view, axis, pendingSlots, results, pinned, plot, visibleCard, active, glyphs } = snapshot();
    const plotRect = plot.getBoundingClientRect();
    const flRect = visibleCard?.getBoundingClientRect() ?? null;
    w.__vpAnalysis = {
      view,
      axis,
      queryPending: pendingSlots,
      queryResults: [...results].map(([slot, result]) => ({
        slot,
        requestId: result.requestId,
        bucketGrid: result.bucketGrid,
        samples: result.samples.length,
        truncated: result.truncated,
      })),
      pinned,
      plot: { x: plotRect.x, y: plotRect.y, width: plotRect.width, height: plotRect.height },
      float: flRect ? { x: flRect.x, y: flRect.y, width: flRect.width, height: flRect.height } : null,
      inspection: active ? {
        t: active.inspectionTimeUs,
        tracks: active.tracks.map(t => ({
          slot: t.slot,
          bitrate: t.bitrate.value,
          rate: t.localRate.value,
          refId: t.reference?.sample.sampleId ?? null,
          refAxis: t.reference?.axisUs ?? null,
          coverage: t.coverageState,
        })),
        direct: active.directTarget,
      } : null,
      glyphs: glyphs.slice(0, 2000).map(g => {
        if (g.kind === 'sample') {
          const s = g as SampleGlyph;
          return {
            kind: 'sample', slot: s.slot, id: s.sampleId, axisUs: s.axisUs,
            stacked: s.stackedCount > 1, width: s.rect.width,
            cx: s.interactionRect.x + s.interactionRect.width / 2,
            cy: s.interactionRect.y + s.interactionRect.height / 2,
          };
        }
        const b = g as BucketGlyph;
        return {
          kind: 'bucket', slot: b.slot, startUs: b.startUs, endUs: b.endUs, width: b.rect.width,
          cx: b.interactionRect.x + b.interactionRect.width / 2,
          cy: b.interactionRect.y + b.interactionRect.height / 2,
        };
      }),
    };
  } catch { /* 测试钩子不得影响面板。 */ }
}
