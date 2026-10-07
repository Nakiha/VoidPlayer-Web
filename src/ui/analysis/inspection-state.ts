import type { Slot } from '../../model.ts';
import type { AnalysisCapability, AnalysisResult } from '../../analysis/types.ts';
import { buildInspection } from '../../analysis/inspection.ts';
import type { DirectTarget, InspectionState } from '../../analysis/inspection.ts';
import type { AnalysisGlyph } from '../analysis-geometry.ts';

export function createInspectionController(snapshot: () => {
  axis: 'pts' | 'dts'; windowUs: number; stepUs: number;
  selected: readonly { slot: Slot }[]; results: Map<Slot, AnalysisResult>; caps: Map<Slot, AnalysisCapability>;
  domain: { start: number; end: number };
}) {
  const state = { hoverUs: null as number | null, lastInspection: null as InspectionState | null,
    pinned: null as InspectionState | null, kbInspect: false, kbTrack: null as Slot | null,
    lastClient: null as { x: number; y: number } | null };
  function directTargetFromGlyph(g: AnalysisGlyph | null): DirectTarget | null {
    if (!g) return null;
    if (g.kind === 'sample') {
      // 聚合标记（含跨组局部聚合）：按区间检查，不冒充单帧。
      if (g.stackedCount > 1 && g.clusterStartUs != null && g.clusterEndUs != null) {
        return { kind: 'bucket', slot: g.slot, bucketStartUs: g.clusterStartUs, bucketEndUs: g.clusterEndUs };
      }
      if (g.stackedCount > 1) return null;
      return { kind: 'sample', slot: g.slot, sampleId: g.sampleId };
    }
    return { kind: 'bucket', slot: g.slot, bucketStartUs: g.startUs, bucketEndUs: g.endUs };
  }

  /** 直接命中的样本及其真实轴时间（吸附用）。 */
  function resolveDirectSample(direct: DirectTarget | null): { axisUs: number; sampleId: string } | null {
    if (!direct || direct.kind !== 'sample' || !direct.sampleId) return null;
    const r = snapshot().results.get(direct.slot);
    const s = r?.samples.find(v => v.sampleId === direct.sampleId);
    if (!s) return null;
    const axisT = snapshot().axis === 'pts' ? s.effectivePtsUs : s.dtsUs;
    if (axisT == null || !Number.isFinite(axisT)) return null;
    return { axisUs: Math.round(axisT), sampleId: s.sampleId };
  }

  /**
   * 统一检查状态：曲线/空白用公共 T；真正命中单样本柱时整次检查吸附到该样本
   * 的真实轴时间，表头、检查线、码率圆点、参考样本一起更新，被命中轨道强制
   * 使用该柱的准确 sampleId（相同 PTS 下不另选）。吸附只改变检查锚点。
   */
  function inspectAt(tUs: number, direct: DirectTarget | null): InspectionState {
    const sel = snapshot().selected;
    let t = Math.round(tUs);
    const hit = resolveDirectSample(direct);
    if (hit) t = hit.axisUs;
    const insp = buildInspection({
      axis: snapshot().axis, inspectionTimeUs: t, windowUs: snapshot().windowUs,
      stepUs: snapshot().stepUs, order: sel.map(t => t.slot),
      results: snapshot().results, caps: snapshot().caps, domain: snapshot().domain, directTarget: direct,
    });
    if (hit && direct?.kind === 'sample') {
      const r = snapshot().results.get(direct.slot);
      const s = r?.samples.find(v => v.sampleId === hit.sampleId);
      const ti = insp.tracks.find(tr => tr.slot === direct.slot);
      if (s && ti && ti.coverageState === 'known') {
        ti.reference = { sample: s, axisUs: hit.axisUs, dtUs: 0, relation: 'exact' };
      }
    }
    return insp;
  }

  function pin(direct: DirectTarget | null) {
    if (state.pinned) { state.pinned = null; return; }
    if (state.hoverUs == null) return;
    state.pinned = state.lastInspection = inspectAt(state.hoverUs, direct);
    state.hoverUs = state.pinned.inspectionTimeUs;
  }
  function invalidate() {
    state.hoverUs = null; state.lastInspection = null; state.pinned = null;
    state.kbInspect = false; state.kbTrack = null; state.lastClient = null;
  }
  return { state, inspectAt, directTargetFromGlyph, pin, unpin: () => { state.pinned = null; }, invalidate };
}
