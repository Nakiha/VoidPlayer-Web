import type { ReviewSession } from '../../session.ts';
import type { Slot } from '../../model.ts';
import type { AnalysisResult } from '../../analysis/types.ts';
import type { DirectTarget, InspectionState } from '../../analysis/inspection.ts';
import { panTimeRange, zoomTimeRange } from '../../analysis/projection.ts';
import { t, msg } from '../../i18n.ts';
import { plotGeometry, tOf, xOf } from '../analysis-canvas.ts';
import type { CanvasModel } from '../analysis-canvas.ts';
import type { AnalysisGlyph, SampleGlyph, BucketGlyph } from '../analysis-geometry.ts';
import type { createInspectionController } from './inspection-state.ts';
import { MIN_ANALYSIS_SPAN_US as MIN_SPAN_US } from './shared.ts';
import type { AnalysisAction } from './shared.ts';

export interface AnalysisGestureScene {
  readonly open: boolean; readonly lastModel: CanvasModel | null;
  readonly lastGeom: { gutter: number; plotW: number; width: number } | null;
  readonly positionUs: number; readonly results: Map<Slot, AnalysisResult>;
  rubber: { a: number; b: number } | null;
  selectedTracks(): readonly { slot: Slot }[];
  viewRange(): { start: number; end: number }; domainBounds(): { start: number; end: number }; plotWidthCss(): number;
}
/** Pointer/keyboard input owns capture, selection and pending animation frames.
 * It invokes session actions and feeds the independent inspection controller. */
export function installAnalysisGestures(options: {
  signal: AbortSignal; canvas: HTMLCanvasElement; session: ReviewSession; act: AnalysisAction;
  live: HTMLElement; hoverEl: HTMLElement; inspection: ReturnType<typeof createInspectionController>;
  scene: AnalysisGestureScene;
  setView(start: number | null, end?: number, follow?: boolean): void;
  render(): void; renderRubber(): void; positionHover(): void;
  updateInspection(x: number, y: number): void; renderFloat(snapshot: InspectionState | null, x: number | null): void;
  refreshOverlay(): void; publishTestHook(): void; pickAt(x: number, y: number): AnalysisGlyph | null;
  pinInspection(target: DirectTarget | null): void; unpinInspection(focus?: boolean): void;
}) {
  const { signal, canvas, session, act, live, hoverEl, inspection, scene,
    setView, render, renderRubber, positionHover, updateInspection, renderFloat, refreshOverlay,
    publishTestHook, pickAt, pinInspection, unpinInspection } = options;
  const { inspectAt, directTargetFromGlyph } = inspection;
  let hoverRaf = 0;
  let pendingHover: { x: number; y: number; t: number } | null = null;
  // ---- 指针交互 ----
  let pressX: number | null = null;
  let pressT = 0;
  let selecting = false;

  const canvasT = (clientX: number) => {
    const rect = canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    if (scene.lastGeom && scene.lastModel) {
      return tOf({ ...scene.lastModel, width: scene.lastGeom.width } as CanvasModel, {
        gutter: scene.lastGeom.gutter, plotW: scene.lastGeom.plotW,
      } as never, x);
    }
    // 首帧数据到达前用纯视图几何定位，手势不依赖数据。
    const g = plotGeometry(scene.plotWidthCss());
    const range = scene.viewRange();
    const span = Math.max(1, range.end - range.start);
    return range.start + ((x - g.gutter) / g.plotW) * span;
  };

  canvas.addEventListener('pointerdown', event => {
    if (event.button !== 0 || !scene.open || !scene.selectedTracks().length) return;
    canvas.focus();
    pressX = event.clientX;
    pressT = canvasT(event.clientX);
    selecting = false;
    canvas.setPointerCapture(event.pointerId);
  }, { signal });

  canvas.addEventListener('pointermove', event => {
    if (!scene.open || !scene.selectedTracks().length) return;
    if (pressX != null) {
      if (!selecting && Math.abs(event.clientX - pressX) > 4) selecting = true;
      if (selecting) {
        scene.rubber = { a: pressT, b: canvasT(event.clientX) };
        renderRubber();
        return;
      }
    }
    // rAF 合并取本帧最新坐标，不保留首个事件丢弃后续；冻结期间不跟随。
    if (inspection.state.pinned) return;
    pendingHover = { x: event.clientX, y: event.clientY, t: canvasT(event.clientX) };
    if (hoverRaf) return;
    hoverRaf = requestAnimationFrame(() => {
      hoverRaf = 0;
      if (signal.aborted || !scene.open) return;
      const p = pendingHover;
      pendingHover = null;
      if (!p) return;
      inspection.state.hoverUs = Math.round(p.t);
      inspection.state.kbInspect = false;
      inspection.state.lastClient = { x: p.x, y: p.y };
      positionHover();
      updateInspection(p.x, p.y);
    });
  }, { signal });

  canvas.addEventListener('pointerup', event => {
    if (pressX == null) return;
    const wasSelecting = selecting;
    selecting = false;
    pressX = null;
    if (wasSelecting && scene.rubber) {
      const a = Math.min(scene.rubber.a, scene.rubber.b), b = Math.max(scene.rubber.a, scene.rubber.b);
      scene.rubber = null;
      if (b - a > MIN_SPAN_US) setView(Math.floor(a), Math.ceil(b), false);
      else render();
      // 框选拖拽藏起了悬浮条；冻结中恢复快照显示。
      if (inspection.state.pinned) renderFloat(inspection.state.pinned, inspection.state.lastClient?.x ?? null);
      return;
    }
    scene.rubber = null;
    const picked = pickAt(event.clientX, event.clientY);
    // Shift+单击冻结/解冻当前检查，不改变播放状态：已冻结时只解冻，
    // 不在点击位置重新冻结（再次 Shift+单击必须可逆）。
    if (event.shiftKey) {
      if (inspection.state.pinned) { unpinInspection(); return; }
      inspection.state.hoverUs = Math.round(canvasT(event.clientX));
      inspection.state.lastClient = { x: event.clientX, y: event.clientY };
      positionHover();
      updateInspection(event.clientX, event.clientY);
      pinInspection(directTargetFromGlyph(picked));
      return;
    }
    // 单击只定位到展示 PTS，不改变视图范围（缩放走框选/滚轮/双击）；
    // 样本与区间桶都按其主样本定位（桶峰值走 session 有界定位）；空白不定位。
    if (picked && picked.kind === 'sample') {
      const g = picked as SampleGlyph;
      const r = scene.results.get(g.slot);
      const s = r?.samples.find(v => v.sampleId === g.sampleId);
      const resolved = session.resolveAnalysisSeek(g.slot, { effectivePtsUs: s?.effectivePtsUs ?? g.sessionPtsUs });
      if ('sessionPtsUs' in resolved) {
        inspection.state.kbTrack = g.slot;
        void act(() => session.seek(resolved.sessionPtsUs), 'analysis.seek', { slot: g.slot, ptsUs: resolved.sessionPtsUs });
      } else {
        live.textContent = t(msg("analysis.seekReason", "轨道 {slot}：{reason}"), { slot: g.slot, reason: resolved.reason });
      }
    } else if (picked && picked.kind === 'bucket') {
      const g = picked as BucketGlyph;
      // 区间桶一律按峰值样本定位到展示帧，不改变视图。峰值身份经 session 有界
      // 定位解析：不依赖本次查询是否恰好返回 raw 样本，也不从 id 字符串猜时间。
      const peakId = g.maxSampleId;
      if (!peakId) {
        live.textContent = t(msg("analysis.noLocatablePeak", "轨道 {slot}：该区间没有可定位的峰值样本。"), { slot: g.slot });
      } else {
        const inView = scene.results.get(g.slot)?.samples.find(v => v.sampleId === peakId);
        if (inView) {
          const resolved = session.resolveAnalysisSeek(g.slot, { effectivePtsUs: inView.effectivePtsUs });
          if ('sessionPtsUs' in resolved) {
            inspection.state.kbTrack = g.slot;
            void act(() => session.seek(resolved.sessionPtsUs), 'analysis.seek', { slot: g.slot, ptsUs: resolved.sessionPtsUs });
          } else {
            live.textContent = t(msg("analysis.seekReason", "轨道 {slot}：{reason}"), { slot: g.slot, reason: resolved.reason });
          }
        } else {
          // 慢路径：样本不在当前视口结果中，走 session 统一动作入口
          // （反查 → 校验实例/offset/最新意图 → seek）。旧定位结果不得
          // 覆盖新点击/拖动/换片/改 offset 之后的用户意图； stale 结果静默丢弃。
          void act(async () => {
            let res: { sessionPtsUs: number } | { reason: string };
            try {
              res = await session.seekAnalysisSample(g.slot, peakId, { signal });
            } catch {
              if (!signal.aborted) live.textContent = t(msg("analysis.peakSeekFailed", "轨道 {slot}：峰值样本定位失败。"), { slot: g.slot });
              return;
            }
            if (signal.aborted || !scene.open) return;
            if ('sessionPtsUs' in res) {
              inspection.state.kbTrack = g.slot;
            } else if (res.reason !== '定位已被更新的请求取代。') {
              live.textContent = t(msg("analysis.seekReason", "轨道 {slot}：{reason}"), { slot: g.slot, reason: res.reason });
            }
          }, 'analysis.seek', { slot: g.slot, sampleId: peakId });
        }
      }
    }
    // 单击不重绘底图；高亮随 hover 已在覆盖层更新。
    refreshOverlay();
  }, { signal });

  canvas.addEventListener('pointerleave', () => {
    if (pressX != null) return;
    if (inspection.state.pinned) {
      // 冻结快照不随指针移出消失：卡片与检查线保持，只藏 hover 悬浮条。
      // 否则 inspection.state.pinned 保留而卡片隐藏后，pointermove 的 inspection.state.pinned 提前返回会形成死状态。
      pendingHover = null;
      hoverEl.hidden = true;
      return;
    }
    // 移出隐藏顶层卡片，只隐藏检查线并清空覆盖层，不重绘底图。
    inspection.state.hoverUs = null;
    inspection.state.kbInspect = false;
    pendingHover = null;
    hoverEl.hidden = true;
    renderFloat(null, null);
    refreshOverlay();
    publishTestHook();
  }, { signal });

  // 滚轮左右平移；Ctrl+滚轮（触摸板捏合）以 hover 点为中心缩放坐标轴。
  // 触摸板双指滑动直接产生带 deltaX/Y 的 wheel 事件，走同一条平移路径。
  canvas.addEventListener('wheel', event => {
    if (!scene.open || !scene.selectedTracks().length) return;
    event.preventDefault();
    const range = scene.viewRange();
    const span = Math.max(1, range.end - range.start);
    const db = scene.domainBounds();
    // Firefox 行/页模式换算为像素当量；页模式一页约 1/4 视图。
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? span / 4 : 1;
    if (event.ctrlKey) {
      const factor = Math.exp((event.deltaY * unit) / 280);
      const center = canvasT(event.clientX);
      const z = zoomTimeRange(range.start, range.end, center, factor, MIN_SPAN_US, db);
      setView(z.start, z.end, false);
    } else {
      const px = (scene.lastGeom && scene.lastGeom.plotW > 0 ? scene.lastGeom.plotW : plotGeometry(scene.plotWidthCss()).plotW) || 1;
      const shift = Math.round((event.deltaX * unit + event.deltaY * unit) * (span / px));
      if (!shift) return;
      const p = panTimeRange(range.start, range.end, shift, db);
      setView(p.start, p.end, false);
    }
  }, { signal, passive: false });

  canvas.addEventListener('dblclick', () => setView(null, undefined, true), { signal });

  canvas.addEventListener('keydown', event => {
    if (!scene.lastModel) return;
    const range = scene.viewRange();
    const sel = scene.selectedTracks();
    if (!sel.length) return;
    if (!inspection.state.kbTrack || !sel.some(t => t.slot === inspection.state.kbTrack)) inspection.state.kbTrack = sel[0].slot;
    const step = Math.max(1, Math.floor((range.end - range.start) / 100));
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      if (inspection.state.pinned) return;
      const base = inspection.state.hoverUs ?? scene.positionUs;
      inspection.state.hoverUs = Math.round(base + (event.key === 'ArrowRight' ? step : -step));
      inspection.state.kbInspect = true;
      positionHover();
      const rect = canvas.getBoundingClientRect();
      updateInspection(rect.left + (scene.lastGeom ? xOf(scene.lastModel, {
        gutter: scene.lastGeom.gutter, plotW: scene.lastGeom.plotW,
      } as never, inspection.state.hoverUs) : 0), rect.top + 20);
    } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      // 键盘轨道焦点：上下切换，不总是第一轨。
      event.preventDefault();
      const idx = sel.findIndex(t => t.slot === inspection.state.kbTrack);
      const next = event.key === 'ArrowDown'
        ? sel[(idx + 1) % sel.length].slot
        : sel[(idx - 1 + sel.length) % sel.length].slot;
      inspection.state.kbTrack = next;
      inspection.state.kbInspect = true;
      if (inspection.state.hoverUs != null) {
        const rect = canvas.getBoundingClientRect();
        updateInspection(rect.left + (scene.lastGeom ? xOf(scene.lastModel, {
          gutter: scene.lastGeom.gutter, plotW: scene.lastGeom.plotW,
        } as never, inspection.state.hoverUs) : 0), rect.top + 20);
        live.textContent = t(msg("analysis.trackFocusWithContext", "轨道焦点 {slot}。{rest}"), { slot: inspection.state.kbTrack, rest: live.textContent ?? '' });
      } else {
        live.textContent = t(msg("analysis.trackFocus", "轨道焦点 {slot}"), { slot: inspection.state.kbTrack });
      }
    } else if (event.key === 'Enter' && inspection.state.hoverUs != null) {
      event.preventDefault();
      // 键盘 Enter 定位当前焦点轨道在检查点的参考样本（与鼠标统一口径），不总是第一轨。
      const focus = inspection.state.kbTrack ?? sel[0].slot;
      const insp = inspectAt(inspection.state.hoverUs, inspection.state.lastInspection?.directTarget ?? null);
      const ref = insp.tracks.find(t => t.slot === focus)?.reference;
      if (ref) {
        const resolved = session.resolveAnalysisSeek(focus, { effectivePtsUs: ref.sample.effectivePtsUs });
        if ('sessionPtsUs' in resolved) void act(() => session.seek(resolved.sessionPtsUs), 'analysis.seek', {});
        else { live.textContent = resolved.reason; }
        return;
      }
      live.textContent = t(msg("analysis.noSampleAtTime", "轨道 {slot} 在该时间无可定位样本。"), { slot: focus });
    } else if (event.key === 'i' || event.key === 'I') {
      // 冻结/解冻当前检查，不改变播放。
      event.preventDefault();
      inspection.state.kbInspect = true;
      if (inspection.state.pinned) unpinInspection();
      else if (inspection.state.hoverUs != null) {
        const rect = canvas.getBoundingClientRect();
        updateInspection(rect.left + (scene.lastGeom ? xOf(scene.lastModel, {
          gutter: scene.lastGeom.gutter, plotW: scene.lastGeom.plotW,
        } as never, inspection.state.hoverUs) : 0), rect.top + 20);
        pinInspection(inspection.state.lastInspection?.directTarget ?? null);
      }
    } else if (event.key === 'Escape') {
      if (inspection.state.pinned) { unpinInspection(true); return; }
      inspection.state.hoverUs = null; scene.rubber = null; inspection.state.kbInspect = false;
      inspection.state.lastInspection = null;
      hoverEl.hidden = true;
      renderFloat(null, null);
      refreshOverlay();
      publishTestHook();
    }
  }, { signal });

  function cancel() {
    if (hoverRaf) cancelAnimationFrame(hoverRaf);
    hoverRaf = 0; pendingHover = null;
    const wasSelecting = selecting;
    pressX = null; selecting = false; scene.rubber = null;
    if (wasSelecting && !signal.aborted) render();
  }
  canvas.addEventListener('pointercancel', cancel, { signal });
  canvas.addEventListener('lostpointercapture', () => { if (pressX != null) cancel(); }, { signal });
  signal.addEventListener('abort', cancel, { once: true });
  return { cancel };
}
