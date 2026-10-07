// 顶部码流分析面板：工具条 + Canvas + 覆盖层 + 会话共用查询。
// 数据全部走 ReviewSession.queryAnalysis（与 Agent 同一入口）；悬停只读
// 索引，不解码、不 seek；单击可显示帧经 resolveAnalysisSeek 定位到展示 PTS。
// 面板开关与高度由 workbench 统一管理（右上功能区、拖拽手势与子轨道同契约）；
// 本模块只负责内容、查询与绘制。下拉全部使用项目 choice-menu 控件。

import { SLOTS } from '../model.ts';
import type { Slot } from '../model.ts';
import type { ReviewSession } from '../session.ts';
import type { AnalysisCapability } from '../analysis/types.ts';
import { BITRATE_WINDOW_OPTIONS_US, DEFAULT_BITRATE_WINDOW_US } from '../analysis/statistics.ts';
import type { TimeGroup } from '../analysis/grouping.ts';
import type { DirectTarget, InspectionState } from '../analysis/inspection.ts';
import { pickGlyph } from './analysis-geometry.ts';
import type { AnalysisGlyph, BucketGlyph, SampleGlyph } from './analysis-geometry.ts';
import { installChoiceMenu } from './choice-menu.ts';
import { onLanguageChange, t, th, msg } from '../i18n.ts';
import { reconcileTrackSelection } from './track-selection.ts';
import type { AnalysisViewState } from '../workspace-file.ts';
import {
  computeLayout, drawAnalysis, formatAxis, plotGeometry, tOf,
} from './analysis-canvas.ts';
import type { CanvasColors, CanvasModel } from './analysis-canvas.ts';
import { loadAnalysisPreferences as loadPrefs, PREF_KEY } from './analysis/preferences.ts';
import type { AnalysisPreferences as Prefs } from './analysis/preferences.ts';
import { buildAnalysisModel } from './analysis/model.ts';
import { createAnalysisQueries } from './analysis/queries.ts';
import type { AnalysisQueryTrack } from './analysis/queries.ts';
import { installAnalysisStatus } from './analysis/status.ts';
import { installAnalysisCard } from './analysis/card.ts';
import { createInspectionController } from './analysis/inspection-state.ts';
import { drawAnalysisOverlay } from './analysis/overlay.ts';
import { installAnalysisGestures } from './analysis/gestures.ts';
import './analysis-panel.css';

import type { AnalysisAction as Action } from './analysis/shared.ts';

export interface AnalysisHooks {
  signal: AbortSignal;
  isOpen: () => boolean;
}

import { MIN_ANALYSIS_SPAN_US as MIN_SPAN_US } from './analysis/shared.ts';

const WINDOW_LABELS: Record<number, string> = Object.fromEntries(
  BITRATE_WINDOW_OPTIONS_US.map(w => [w, w >= 1_000_000 ? `${w / 1_000_000}s` : `${w / 1000}ms`]),
);
// 合并为默认：同一基线按时间交错，不以严格配对为前提；分轨只作主动选择。
const layoutLabel = (mode: 'merged' | 'rows') => t(mode === 'merged' ? msg("analysis.layoutMerged", "合并") : msg("analysis.layoutRows", "分轨"));


interface TrackEntry extends AnalysisQueryTrack { name: string }

export function installAnalysisPanel(session: ReviewSession, act: Action, hooks: AnalysisHooks): {
  setOpen(open: boolean): void;
  getAnalysisState(): AnalysisViewState;
  restoreAnalysisState(s: AnalysisViewState): void;
} {
  const { signal } = hooks;
  let open = hooks.isOpen();
  const prefs = loadPrefs();
  const save = () => {
    try {
      localStorage.setItem(PREF_KEY, JSON.stringify(prefs));
    } catch { /* 面板偏好不影响播放入口。 */ }
  };

  const section = document.getElementById('analysis-panel')!;
  section.insertAdjacentHTML('afterbegin', `
    <header class="analysis-head">
      <div class="analysis-tools" role="group" aria-label="${th(msg("analysis.tools", "分析选项"))}">
        <button type="button" class="seg" data-seg="bitrate" title="${th(msg("analysis.bitrateTitle", "视频样本负载码率，按 PTS/DTS 归集的滑动时间窗"))}">${th(msg("analysis.bitrate", "码率"))}</button>
        <button type="button" class="seg" data-seg="size" title="${th(msg("analysis.frameSizeTitle", "压缩样本字节（demux 负载），非解码内存"))}">${th(msg("analysis.frameSize", "帧大小"))}</button>
        <span id="analysis-tracks" class="analysis-tracks" role="group" aria-label="${th(msg("analysis.compareTracks", "对比轨道"))}"></span>
        <button type="button" id="analysis-axis" class="choice-trigger" aria-label="${th(msg("analysis.timeBase", "时间基准"))}" title="${th(msg("analysis.timeBaseTitle", "PTS 为展示时间，DTS 为解码时间；无可靠 DTS 的轨道不支持 DTS 视图"))}"></button>
        <button type="button" id="analysis-window" class="choice-trigger" aria-label="${th(msg("analysis.bitrateWindow", "码率窗口"))}" title="${th(msg("analysis.bitrateWindowTitle", "码率窗口：视频样本负载码率的滑动时间窗（真实时间窗，非 N 帧窗）"))}"></button>
        <button type="button" id="analysis-layout" class="choice-trigger" aria-label="${th(msg("analysis.multiTrackLayout", "多轨布局"))}" title="${th(msg("analysis.multiTrackLayoutTitle", "合并：多轨同一基线按时间交错；分轨：各轨独立行"))}"></button>
        <button type="button" class="seg" data-seg="follow" title="${th(msg("analysis.followTitle", "跟随播放范围；框选放大后自动关闭，不强制跳回播放位置"))}">${th(msg("analysis.followOn", "跟随：开"))}</button>
        <button type="button" class="seg" data-seg="full" title="${th(msg("analysis.fullRangeTitle", "双击图也可恢复完整范围"))}">${th(msg("analysis.fullRange", "完整范围"))}</button>
      </div>
      <div class="analysis-status" id="analysis-status" role="group" aria-label="${th(msg("analysis.currentFrameNumbers", "当前上屏帧号"))}">
        <div class="segmented" id="analysis-num-axis" role="group" aria-label="${th(msg("analysis.frameNumberOrder", "帧号顺序"))}">
          <button type="button" data-num-axis="pts">PTS</button>
          <button type="button" data-num-axis="dts">DTS</button>
        </div>
        <span class="st-items" id="analysis-status-items"></span>
      </div>
    </header>
    <div class="analysis-notice" role="status" aria-live="polite" hidden></div>
    <div class="analysis-body" id="analysis-body">
      <div class="analysis-plot" id="analysis-plot">
        <canvas id="analysis-canvas" tabindex="0" role="img" aria-label="${th(msg("analysis.canvasLabel", "码流分析图：码率曲线与帧大小柱。方向键移动检查位置，回车定位，Escape 退出检查。"))}"></canvas>
        <canvas id="analysis-overlay" aria-hidden="true"></canvas>
        <div class="analysis-line analysis-playhead" hidden></div>
        <div class="analysis-line analysis-hover" hidden></div>
        <div class="analysis-empty" role="status" aria-live="polite" hidden></div>
      </div>
    </div>
    <output class="sr-only" aria-live="polite"></output>`);

  const $ = <T extends Element = HTMLElement>(sel: string) => section.querySelector(sel) as unknown as T;
  const tools = $<HTMLElement>('.analysis-tools');
  const tracksEl = $<HTMLElement>('#analysis-tracks');
  const statusEl = $<HTMLElement>('#analysis-status');
  const numAxisEl = $<HTMLElement>('#analysis-num-axis');
  const itemsEl = $<HTMLElement>('#analysis-status-items');
  const body = $<HTMLElement>('.analysis-body');
  const plot = $<HTMLElement>('#analysis-plot');
  const canvas = $<HTMLCanvasElement>('#analysis-canvas');
  const ctx = canvas.getContext('2d');
  const overlay = $<HTMLCanvasElement>('#analysis-overlay');
  const overlayCtx = overlay.getContext('2d');
  const playheadEl = $<HTMLElement>('.analysis-playhead');
  const hoverEl = $<HTMLElement>('.analysis-hover');
  const emptyEl = $<HTMLElement>('.analysis-empty');
  const noticeEl = $<HTMLElement>('.analysis-notice');
  // 悬浮卡片挂在 body 顶层（fixed），彻底脱离分析面板的 overflow 裁剪；
  // abort 时移除，平时 pointer-events:none 不拦截输入。
  const card = installAnalysisCard(canvas, { signal, colors: () => slotColors, pinned: () => inspection.state.pinned != null });
  const cardEl = card.element;
  const renderFloat = (snapshot: InspectionState | null, x: number | null) => card.render(snapshot, x);
  const positionFloat = (x: number) => card.position(x);
  const live = $<HTMLElement>('output');
  // 查询与检查状态分别由独立模块持有。

  let tracks: TrackEntry[] = [];
  let caps = new Map<Slot, AnalysisCapability>();
  const queries = createAnalysisQueries({
    signal,
    snapshot: () => ({ open, tracks, selected: selectedTracks(), capabilities: caps,
      axis: prefs.axis, windowUs: prefs.windowUs, range: viewRange(), domain: domainBounds(),
      pixelWidth: Math.max(1, plotWidthCss() - 46) }),
    query: (slot, query) => session.queryAnalysis(slot, query),
    onChange: () => render(),
    onResult: () => updateStatus(),
    onQueryStart: () => { canvas.dataset.analysisQueries = String((Number(canvas.dataset.analysisQueries ?? 0) || 0) + 1); },
    onQueryComplete: ms => { canvas.dataset.analysisQueryMs = ms.toFixed(1); },
  });
  const results = queries.results;
  const queryErrors = queries.errors;
  let view: { start: number; end: number } | null = null;
  let rubber: { a: number; b: number } | null = null;
  let positionUs = 0;
  let durationUs = 0;
  let buildingTimer = 0;
  let lastGeom: { gutter: number; plotW: number; width: number } | null = null;
  let lastModel: CanvasModel | null = null;
  let colors: CanvasColors = { key: '', delta: '', unknown: '', grid: '', text: '', axisText: '' };
  let slotColors = new Map<Slot, string>();
  let trackSig = '';
  // 选择集只随轨道身份（slot+mediaId）对账：新增身份默认加入，移除即遗忘；
  // 时长/偏移等元数据更新不得触碰用户的显隐选择。
  const knownTrackIds = new Set<string>();
  let lastViewSig = '';
  let lastGlyphs: AnalysisGlyph[] = [];
  let lastGroups: TimeGroup[] = [];
  // 有序轴派生索引由 inspection.ts 按快照身份缓存（WeakMap），此处不再自建键控缓存。

  const readColors = () => {
    const styles = getComputedStyle(section);
    const pick = (name: string) => styles.getPropertyValue(name).trim();
    colors = {
      key: pick('--analysis-key') || '#b45309',
      delta: pick('--analysis-delta') || '#2563eb',
      unknown: pick('--analysis-unknown') || '#8a8f98',
      grid: pick('--analysis-grid') || '#8080802e',
      text: pick('--text') || '#333',
      axisText: pick('--analysis-text') || pick('--text-secondary') || '#666',
    };
    const root = getComputedStyle(document.documentElement);
    slotColors = new Map(SLOTS.map(s => [s, root.getPropertyValue(`--slot-${s.toLowerCase()}`).trim() || '#888'] as [Slot, string]));
  };
  readColors();

  /** 会话时间域：各轨偏移起点到会话终点；DTS 下界取实际观测最小值，不猜固定 -1s。 */
  function domainBounds(): { start: number; end: number } {
    const lo = tracks.length ? Math.min(0, ...tracks.map(t => t.offsetUs)) : 0;
    const hi = Math.max(1, durationUs - 1);
    if (prefs.axis !== 'dts') return { start: Math.floor(lo), end: Math.ceil(hi) };
    let dtsMin: number | null = null;
    for (const t of selectedTracks()) {
      const r = results.get(t.slot);
      if (!r) continue;
      if (r.samples.length && !r.truncated) {
        // DTS 轴下样本按 DTS 有序，首项即最小；PTS 轴下需扫描最小 DTS。
        if (r.axis === 'dts') {
          const v = r.samples[0].dtsUs;
          if (v != null && Number.isFinite(v) && (dtsMin == null || v < dtsMin)) dtsMin = v;
        } else {
          for (const s of r.samples) {
            if (s.dtsUs != null && Number.isFinite(s.dtsUs) && (dtsMin == null || s.dtsUs < dtsMin)) dtsMin = s.dtsUs;
          }
        }
      } else if (r.buckets) {
        for (const b of r.buckets) {
          if (!b.count) continue;
          if (dtsMin == null || b.startUs < dtsMin) dtsMin = b.startUs;
        }
      }
    }
    const start = dtsMin == null ? lo : Math.min(lo, dtsMin);
    return { start: Math.floor(start), end: Math.ceil(hi) };
  }

  const fullRange = () => domainBounds();
  const viewRange = () => view ?? fullRange();

  /** 设置可视区间（null 回到完整范围），统一钳制、跟随状态与重查调度。 */
  function setView(start: number | null, end?: number, follow?: boolean) {
    if (start == null) view = null;
    else {
      const db = domainBounds();
      const span = Math.max(MIN_SPAN_US, (end ?? start) - start);
      if (span >= db.end - db.start) view = { start: db.start, end: db.end };
      else {
        const s = Math.min(Math.max(start, db.start), db.end - span);
        view = { start: Math.floor(s), end: Math.ceil(s + span) };
      }
    }
    if (follow !== undefined) prefs.follow = follow;
    save(); refreshTools(); requestRender(); scheduleQuery();
  }

  let viewRaf = 0;
  /** 高频手势（滚轮/捏合）合并为一帧一次重绘；数据查询走 100ms 节流。 */
  function requestRender() {
    if (viewRaf || signal.aborted) return;
    viewRaf = requestAnimationFrame(() => { viewRaf = 0; if (!signal.aborted) render(); });
  }

  const selectedTracks = () => tracks.filter(t => prefs.selected.includes(t.slot));

  const allHaveDts = () => {
    const sel = selectedTracks();
    return sel.length > 0 && sel.every(t => caps.get(t.slot)?.hasDts);
  };

  const status = installAnalysisStatus({ session, act, signal, prefs, statusEl, numAxisEl, itemsEl, live,
    tracks: () => tracks, colors: () => slotColors, save });
  const updateStatus = () => status.update();
  const refreshNumAxis = () => status.refreshAxis();

  // ---- 工具条：静态控件一次装配，动态部分（轨道、菜单标签）按需刷新 ----
  const segButtons = new Map<string, HTMLButtonElement>();
  for (const b of tools.querySelectorAll<HTMLButtonElement>('[data-seg]')) segButtons.set(b.dataset.seg!, b);
  const setSeg = (key: string, pressed: boolean, text?: string) => {
    const b = segButtons.get(key);
    if (!b) return;
    b.setAttribute('aria-pressed', String(pressed));
    if (text !== undefined) b.textContent = text;
  };
  segButtons.get('bitrate')!.onclick = () => { prefs.showBitrate = !prefs.showBitrate; save(); refreshTools(); render(); };
  segButtons.get('size')!.onclick = () => { prefs.showSize = !prefs.showSize; save(); refreshTools(); render(); };
  segButtons.get('follow')!.onclick = () => {
    if (prefs.follow) { prefs.follow = false; save(); refreshTools(); render(); }
    else setView(null, undefined, true);
  };
  segButtons.get('full')!.onclick = () => setView(null, undefined, true);
  const axisMenu = installChoiceMenu('analysis-axis', [{ value: 'pts', label: 'PTS' }], value => {
    prefs.axis = value as 'pts' | 'dts'; save(); refreshTools(); scheduleQuery(true);
  });
  const windowMenu = installChoiceMenu('analysis-window',
    BITRATE_WINDOW_OPTIONS_US.map(w => ({ value: String(w), label: WINDOW_LABELS[w] })), value => {
      prefs.windowUs = Number(value); save(); refreshTools(); scheduleQuery(true);
    });
  const layoutMenu = installChoiceMenu('analysis-layout',
    () => (['merged', 'rows'] as const).map(v => ({ value: v, label: layoutLabel(v) })), value => {
      prefs.layoutMode = value as Prefs['layoutMode']; save(); refreshTools(); render();
    });

  let toolsSig = '';
  let lastDtsOk: boolean | null = null;
  function refreshTools() {
    setSeg('bitrate', prefs.showBitrate);
    setSeg('size', prefs.showSize);
    setSeg('follow', prefs.follow, t(prefs.follow ? msg("analysis.followOn", "跟随：开") : msg("analysis.followOff", "跟随：关")));
    // 高频手势每 tick 都经过这里：DOM 重建只在签名变化时做，label 同步很便宜。
    const sig = JSON.stringify([prefs.axis, prefs.windowUs, prefs.layoutMode, prefs.selected,
      tracks.map(t => t.slot)]);
    if (sig !== toolsSig) {
      toolsSig = sig;
      tracksEl.replaceChildren();
      for (const entry of tracks) {
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'analysis-chip';
        const on = prefs.selected.includes(entry.slot);
        b.setAttribute('aria-pressed', String(on));
        b.title = on ? t(msg("analysis.hideTrack", "隐藏轨道 {slot}"), { slot: entry.slot }) : t(msg("analysis.showTrack", "显示轨道 {slot}（{name}）"), { slot: entry.slot, name: entry.name });
        const dot = document.createElement('span');
        dot.className = 'dot';
        dot.style.background = slotColors.get(entry.slot) ?? '#888';
        b.append(dot, document.createTextNode(entry.slot));
        b.onclick = () => {
          prefs.selected = on ? prefs.selected.filter(s => s !== entry.slot) : [...prefs.selected, entry.slot];
          if (prefs.axis === 'dts' && !allHaveDts()) prefs.axis = 'pts';
          save(); refreshTools(); scheduleQuery(true);
        };
        tracksEl.append(b);
      }
    }
    // DTS 只在所选轨道全部可靠时提供；不可用时从菜单移除，不伪造。
    const dtsOk = allHaveDts();
    if (dtsOk !== lastDtsOk) {
      lastDtsOk = dtsOk;
      axisMenu.setOptions(dtsOk
        ? [{ value: 'pts', label: 'PTS' }, { value: 'dts', label: 'DTS' }]
        : [{ value: 'pts', label: 'PTS' }]);
    }
    axisMenu.sync(prefs.axis, prefs.axis.toUpperCase(), selectedTracks().length > 0);
    windowMenu.sync(String(prefs.windowUs), WINDOW_LABELS[prefs.windowUs] ?? '', selectedTracks().length > 0);
    layoutMenu.sync(prefs.layoutMode, layoutLabel(prefs.layoutMode), true);
  }

  /** Static chrome follows the UI language; dynamic parts re-render below. */
  function localizeChrome() {
    tools.setAttribute('aria-label', t(msg("analysis.tools", "分析选项")));
    const bitrate = segButtons.get('bitrate');
    if (bitrate) { bitrate.textContent = t(msg("analysis.bitrate", "码率")); bitrate.title = t(msg("analysis.bitrateTitle", "视频样本负载码率，按 PTS/DTS 归集的滑动时间窗")); }
    const size = segButtons.get('size');
    if (size) { size.textContent = t(msg("analysis.frameSize", "帧大小")); size.title = t(msg("analysis.frameSizeTitle", "压缩样本字节（demux 负载），非解码内存")); }
    tracksEl.setAttribute('aria-label', t(msg("analysis.compareTracks", "对比轨道")));
    // Choice menus mirror the trigger label into the popup; refresh both ends
    // (the menu's own language listener runs before this one).
    const triggers = [
      ['analysis-axis', msg("analysis.timeBase", "时间基准"), msg("analysis.timeBaseTitle", "PTS 为展示时间，DTS 为解码时间；无可靠 DTS 的轨道不支持 DTS 视图")],
      ['analysis-window', msg("analysis.bitrateWindow", "码率窗口"), msg("analysis.bitrateWindowTitle", "码率窗口：视频样本负载码率的滑动时间窗（真实时间窗，非 N 帧窗）")],
      ['analysis-layout', msg("analysis.multiTrackLayout", "多轨布局"), msg("analysis.multiTrackLayoutTitle", "合并：多轨同一基线按时间交错；分轨：各轨独立行")],
    ] as const;
    for (const [id, key, title] of triggers) {
      const trigger = section.querySelector(`#${id}`);
      trigger?.setAttribute('aria-label', t(key));
      trigger?.setAttribute('title', t(title));
      // Popups live on document.body, outside the panel section.
      document.getElementById(`${id}-menu`)?.setAttribute('aria-label', t(key));
    }
    const follow = segButtons.get('follow');
    if (follow) { follow.textContent = t(prefs.follow ? msg("analysis.followOn", "跟随：开") : msg("analysis.followOff", "跟随：关")); follow.title = t(msg("analysis.followTitle", "跟随播放范围；框选放大后自动关闭，不强制跳回播放位置")); }
    const full = segButtons.get('full');
    if (full) { full.textContent = t(msg("analysis.fullRange", "完整范围")); full.title = t(msg("analysis.fullRangeTitle", "双击图也可恢复完整范围")); }
    statusEl.setAttribute('aria-label', t(msg("analysis.currentFrameNumbers", "当前上屏帧号")));
    numAxisEl.setAttribute('aria-label', t(msg("analysis.frameNumberOrder", "帧号顺序")));
    canvas.setAttribute('aria-label', t(msg("analysis.canvasLabel", "码流分析图：码率曲线与帧大小柱。方向键移动检查位置，回车定位，Escape 退出检查。")));
  }

  function localize() {
    toolsSig = ''; lastDtsOk = null; status.invalidate();
    card.reset();
    localizeChrome();
    refreshTools();
    refreshNumAxis();
    updateStatus();
    render();
  }

  /** 绘图区真实宽度：查询/x 换算/命中统一用它。 */
  const plotWidthCss = () => Math.max(1, Math.floor(plot.clientWidth || body.clientWidth));
  const scheduleQuery = (immediate = false) => queries.schedule(immediate);

  // ---- 绘制：时间分组 → 统一几何 → 绘图与命中共用 ----

  function buildModel() {
    return buildAnalysisModel({ sel: selectedTracks(), results, prefs, range: viewRange(), width: plotWidthCss(),
      availableHeight: body.clientHeight, slotColors, colors, rubber });
  }

  function render() {
    window.clearTimeout(buildingTimer);
    if (!open || !ctx) return;
    const renderStart = performance.now();
    const model = buildModel();
    const builtMs = performance.now() - renderStart;
    const sel = selectedTracks();
    const problems = sel.flatMap(track => {
      const cap = caps.get(track.slot);
      if (cap?.indexState === 'error') return [t(msg("analysis.indexFailed", "轨道 {slot} 索引失败：{error}"), {
        slot: track.slot, error: cap.indexError ?? t(msg("analysis.unknownError", "未知错误")),
      })];
      if (cap?.hasSize === false) return [t(msg("analysis.trackUnsupported", "轨道 {slot}：当前片源路径暂不支持码流分析。"), { slot: track.slot })];
      const error = queryErrors.get(track.slot);
      if (error !== undefined) return [t(msg("analysis.queryFailed", "轨道 {slot} 查询失败：{error}"), { slot: track.slot, error })];
      const untimed = results.get(track.slot)?.untimed;
      return untimed?.sampleCount ? [t(msg("analysis.untimedPackets", "轨道 {slot}：{count} 个包缺少时间戳（{bytes} 字节），无法计入时间轴码率。"), { slot: track.slot, count: untimed.sampleCount, bytes: untimed.totalBytes })] : [];
    }).join('\n');
    // Keep failures visible beside any healthy tracks, or in the empty state.
    // The screen-reader output is also used by hover and cannot own error state.
    if (noticeEl.textContent !== problems) noticeEl.textContent = problems;
    noticeEl.hidden = !model || !problems;
    if (!model) {
      canvas.hidden = true;
      overlay.hidden = true;
      // 空态画布无高度，plot 按 body 撑满，提示文字才有地方居中，不从 0px 盒溢出。
      plot.style.minHeight = '100%';
      emptyEl.hidden = false;
      emptyEl.textContent = !tracks.length ? t(msg("analysis.emptyNoVideo", "尚未载入视频。载入后可在此检查码率与帧大小走向。"))
        : !sel.length ? t(msg("analysis.emptyAllHidden", "已全部隐藏，请在工具条中选择要对比的轨道。"))
        : problems || t(msg("analysis.emptyQuerying", "正在查询统计…"));
      playheadEl.hidden = true;
      hoverEl.hidden = true;
      lastModel = null;
      lastGeom = null;
      lastGlyphs = [];
      lastGroups = [];
      lastViewSig = '';
      inspection.state.lastInspection = null;
      renderFloat(null, null);
      publishTestHook();
      return;
    }
    canvas.hidden = false;
    overlay.hidden = false;
    emptyEl.hidden = true;
    plot.style.minHeight = '';
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const cssH = Math.max(80, model.height);
    canvas.style.height = `${cssH}px`;
    overlay.style.height = `${cssH}px`;
    const w = Math.round(model.width * dpr), h = Math.round(cssH * dpr);
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    if (overlay.width !== w) overlay.width = w;
    if (overlay.height !== h) overlay.height = h;
    ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
    const drawn: CanvasModel = { ...model, height: cssH };
    // 基础图层只在这里绘制；检查线/圆点/高亮走独立覆盖层，不触发底图重绘。
    drawAnalysis(ctx!, drawn);
    // 只读 QA 证据（对齐 pixel-grid 的 dataset 计数），不作可见计数器。
    canvas.dataset.analysisDrawMs = (performance.now() - renderStart).toFixed(2);
    canvas.dataset.analysisBuiltMs = builtMs.toFixed(2);
    lastModel = drawn;
    const geom = computeLayout(drawn);
    lastGeom = { gutter: geom.gutter, plotW: geom.plotW, width: drawn.width };
    lastGlyphs = (model as { glyphs?: AnalysisGlyph[] }).glyphs ?? [];
    lastGroups = (model as { groups?: TimeGroup[] }).groups ?? [];
    positionPlayhead();
    // 视图变化后把检查点重锚到光标（滚轮/捏合只动视图，不产生 pointermove），
    // 不展示过期内容；键盘检查中不抢夺焦点位置。
    const viewSig = `${drawn.viewStart}:${drawn.viewEnd}`;
    if (!inspection.state.kbInspect && inspection.state.hoverUs != null && inspection.state.lastClient) {
      if (viewSig !== lastViewSig) {
        inspection.state.hoverUs = Math.round(tOf(drawn, geom, inspection.state.lastClient.x - canvas.getBoundingClientRect().left));
        const range = viewRange();
        if (inspection.state.hoverUs < range.start || inspection.state.hoverUs > range.end) {
          inspection.state.hoverUs = null;
          hoverEl.hidden = true;
        }
      }
      if (inspection.state.hoverUs != null) { positionHover(); updateInspection(inspection.state.lastClient.x, inspection.state.lastClient.y); }
    }
    lastViewSig = viewSig;
    publishTestHook();
    refreshOverlay();
    // 底图重绘后卡片按最后光标重新限位（仍在坞内横向滑动，不跟随翻边）。
    if (inspection.state.hoverUs != null && inspection.state.lastClient && !inspection.state.pinned) positionFloat(inspection.state.lastClient.x);
    // 索引构建中渐进重查（仅面板打开时）；完成后自动停止。
    if (selectedTracks().some(t => caps.get(t.slot)?.indexState === 'building' && !queryErrors.has(t.slot))) {
      buildingTimer = window.setTimeout(() => {
        if (open && !signal.aborted) queries.refresh();
      }, 1000);
    }
  }

  const fracToPx = (t: number) => {
    const g = lastGeom ?? plotGeometry(plotWidthCss());
    const v = lastModel ? { start: lastModel.viewStart, end: lastModel.viewEnd } : viewRange();
    const span = Math.max(1, v.end - v.start);
    return g.gutter + ((t - v.start) / span) * g.plotW;
  };

  function positionPlayhead() {
    // DTS 轴无稳定 sampleId→展示帧→DTS 映射时隐藏播放标记，不用 PTS 冒充解码时间。
    if (prefs.axis === 'dts') {
      playheadEl.hidden = true;
      return;
    }
    if (positionUs < viewRange().start || positionUs >= viewRange().end) {
      playheadEl.hidden = true;
      return;
    }
    playheadEl.hidden = false;
    playheadEl.style.left = `${fracToPx(positionUs)}px`;
  }

  function positionHover() {
    if (inspection.state.hoverUs == null || inspection.state.hoverUs < viewRange().start || inspection.state.hoverUs > viewRange().end) {
      hoverEl.hidden = true;
      return;
    }
    hoverEl.hidden = false;
    hoverEl.style.left = `${fracToPx(inspection.state.hoverUs)}px`;
  }

  // ---- 悬停/固定检查：绘图与命中共用统一几何 ----
  // 有序轴派生索引按不可变快照身份缓存（inspection.ts 内 WeakMap）：
  // 换范围/换 offset/切轴必然产生新结果对象，不复用旧轴数组。
  /** 画布 CSS 坐标下的直接命中：返回唯一 glyph 身份。 */
  function pickAt(clientX: number, clientY: number): AnalysisGlyph | null {
    if (!lastGlyphs.length) return null;
    const rect = canvas.getBoundingClientRect();
    return pickGlyph(lastGlyphs, clientX - rect.left, clientY - rect.top);
  }

  /** 当前视图步长（span/pixelWidth）：码率最近邻的保真上限。 */
  function viewStepUs(): number {
    const range = viewRange();
    const span = Math.max(1, range.end - range.start);
    const plotW = lastGeom && lastGeom.plotW > 0 ? lastGeom.plotW : plotGeometry(plotWidthCss()).plotW;
    return span / Math.max(1, plotW);
  }

  const inspection = createInspectionController(() => ({ axis: prefs.axis, windowUs: prefs.windowUs,
    stepUs: viewStepUs(), selected: selectedTracks(), results, caps, domain: domainBounds() }));
  const inspectAt = (time: number, target: DirectTarget | null) => inspection.inspectAt(time, target);
  const directTargetFromGlyph = (glyph: AnalysisGlyph | null) => inspection.directTargetFromGlyph(glyph);

  /** 检查更新：冻结期间不跟随；命中单样本时吸附锚点并同步检查线与悬浮条。 */
  function updateInspection(clientX: number, clientY: number) {
    if (inspection.state.hoverUs == null) { inspection.state.lastInspection = null; renderFloat(null, null); refreshOverlay(); publishTestHook(); return; }
    const sel = selectedTracks();
    if (!sel.length) { inspection.state.lastInspection = null; renderFloat(null, null); refreshOverlay(); publishTestHook(); return; }
    if (inspection.state.pinned) return;
    const direct = directTargetFromGlyph(pickAt(clientX, clientY));
    const insp = inspectAt(inspection.state.hoverUs, direct);
    // 吸附后的真实检查时间同步到检查线与悬浮条，不保留另一时刻的过期读数。
    inspection.state.hoverUs = insp.inspectionTimeUs;
    inspection.state.lastInspection = insp;
    positionHover();
    renderFloat(insp, clientX);
    // 辅助技术播报只在键盘步进/固定时更新，不每个鼠标帧推送整段文本。
    if (inspection.state.kbInspect) live.textContent = cardEl.textContent ?? '';
    refreshOverlay();
    publishTestHook();
  }

  /**
   * 独立覆盖层：检查圆点与样本高亮只画在 overlay canvas 上，
   * 不重绘基础图层（hover 扫描不增加底图绘制次数）。
   */
  function refreshOverlay() {
    drawAnalysisOverlay(overlayCtx, lastModel, lastGlyphs, inspection.state.pinned ?? inspection.state.lastInspection,
      inspection.state.hoverUs, slotColors, window.devicePixelRatio || 1);
  }

  /** 只读测试快照：布局 glyph 身份与当前检查状态，供浏览器回归精确断言。
   * 只在 QA 钩子启用时构建：生产 hover 不为 2000 条 glyph 摘要与 DOM 几何读取付费。 */
  function publishTestHook() {
    try {
      const w = window as unknown as { __vpAnalysis?: unknown; __vpAnalysisQA?: boolean };
      if (!w.__vpAnalysisQA) return;
      const active = inspection.state.pinned ?? inspection.state.lastInspection;
      const plotRect = plot.getBoundingClientRect();
      const flRect = cardEl.hidden ? null : cardEl.getBoundingClientRect();
      w.__vpAnalysis = {
        view: viewRange(),
        axis: prefs.axis,
        pinned: inspection.state.pinned != null,
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
        glyphs: lastGlyphs.slice(0, 2000).map(g => {
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

  /**
   * 冻结/解冻当前检查（Shift+单击 / I 切换，Escape 解除）：
   * 悬浮条停在快照上，不跟随后续 hover；换片/清轨即失效。
   */
  function pinInspection(direct: DirectTarget | null) {
    if (inspection.state.pinned) { unpinInspection(); return; }
    if (inspection.state.hoverUs == null) return;
    inspection.pin(direct);
    renderFloat(inspection.state.pinned, inspection.state.lastClient?.x ?? null);
    refreshOverlay();
    publishTestHook();
    // 固定状态做节制播报；普通 hover 不推送整段文本。
    live.textContent = cardEl.textContent ?? '';
  }

  function unpinInspection(focusCanvas = false) {
    if (!inspection.state.pinned) return;
    inspection.unpin();
    renderFloat(inspection.state.lastInspection, inspection.state.lastClient?.x ?? null);
    refreshOverlay();
    publishTestHook();
    if (focusCanvas) canvas.focus();
  }

  function renderRubber() {
    if (!lastModel || !ctx) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawAnalysis(ctx, { ...lastModel, height: lastModel.height, rubber });
  }

  const gestures = installAnalysisGestures({ signal, canvas, session, act, live, hoverEl, inspection,
    scene: { get open() { return open; }, get lastModel() { return lastModel; }, get lastGeom() { return lastGeom; },
      get positionUs() { return positionUs; }, results,
      get rubber() { return rubber; }, set rubber(value) { rubber = value; },
      selectedTracks, viewRange, domainBounds, plotWidthCss },
    setView, render, renderRubber, positionHover, updateInspection, renderFloat, refreshOverlay, publishTestHook,
    pickAt, pinInspection, unpinInspection });

  // ---- 会话联动（开关与高度由 workbench 统一管理） ----
  function setOpen(next: boolean) {
    if (open === next) return;
    open = next;
    render();
    if (open) { refreshTools(); scheduleQuery(true); }
    else {
      cardEl.hidden = true;
      gestures.cancel();
      queries.suspend();
      window.clearTimeout(buildingTimer);
    }
  }

  /** 工作区快照：可视区间（null 为完整范围）+ 显示偏好 + 对比轨道。 */
  function getAnalysisState(): AnalysisViewState {
    return {
      view: view == null ? null : { start: Math.floor(view.start), end: Math.ceil(view.end) },
      axis: prefs.axis, windowUs: prefs.windowUs, layoutMode: prefs.layoutMode,
      showBitrate: prefs.showBitrate, showSize: prefs.showSize,
      follow: prefs.follow, selected: [...prefs.selected],
      numAxis: prefs.numAxis,
    };
  }

  /** 工作区还原：偏好立即生效；视图等轨道落定后按当时域钳制应用。 */
  let pendingAnalysisView: { start: number; end: number } | null | undefined;
  function applyPendingAnalysisView() {
    if (pendingAnalysisView === undefined) return;
    const v = pendingAnalysisView;
    pendingAnalysisView = undefined;
    if (v) setView(v.start, v.end, prefs.follow);
    else setView(null, undefined, prefs.follow);
  }
  function restoreAnalysisState(s: AnalysisViewState) {
    prefs.showBitrate = s.showBitrate;
    prefs.showSize = s.showSize;
    prefs.axis = s.axis === 'dts' ? 'dts' : 'pts';
    prefs.windowUs = BITRATE_WINDOW_OPTIONS_US.includes(s.windowUs) ? s.windowUs : DEFAULT_BITRATE_WINDOW_US;
    prefs.layoutMode = s.layoutMode === 'rows' ? 'rows' : 'merged';
    prefs.follow = s.follow;
    prefs.selected = s.selected.filter(x => SLOTS.includes(x as Slot)) as Slot[];
    prefs.numAxis = s.numAxis === 'dts' ? 'dts' : 'pts';
    // 以当前轨道身份为选择基准，避免后续元数据事件把快照里隐藏的轨道加回来。
    for (const e of tracks) knownTrackIds.add(`${e.slot}|${e.mediaId}`);
    save();
    refreshTools();
    refreshNumAxis();
    updateStatus();
    pendingAnalysisView = s.view ? { start: s.view.start, end: s.view.end } : null;
    if (tracks.length) applyPendingAnalysisView();
    else { render(); scheduleQuery(); }
  }

  const onSession = () => {
    if (signal.aborted) return;
    const state = session.getState();
    positionUs = state.positionUs;
    durationUs = state.durationUs;
    status.syncFrames(state.tracks);
    const entries: TrackEntry[] = state.tracks.map(t => ({
      slot: t.slot as Slot, mediaId: t.id as string, offsetUs: t.offsetUs as number,
      durationUs: t.durationUs as number, name: (t.name as string) ?? '',
      sourceGen: (t.sourceGen as number) ?? 0,
    }));
    // 内容签名含 source 实例 generation：同 mediaId 重建实例也算内容变化，
    // 触发结果失效与重查；纯索引进度变化走下方轻量分支。
    const sig = JSON.stringify(entries.map(e => [e.slot, e.mediaId, e.offsetUs, e.durationUs, e.sourceGen]));
    // 选择集与轨道身份对账（独立于内容签名）：只有新增身份默认加入对比、
    // 移除身份清理选择；时长延伸/偏移调整/索引进度不覆盖用户显隐。
    {
      const reconciled = reconcileTrackSelection(prefs.selected, entries, knownTrackIds);
      if (reconciled.changed) {
        prefs.selected = reconciled.selected as Slot[];
        save();
        refreshTools();
      }
    }
    if (sig !== trackSig) {
      trackSig = sig;
      for (const previous of tracks) {
        const current = entries.find(t => t.slot === previous.slot);
        if (!current || current.mediaId !== previous.mediaId || current.sourceGen !== previous.sourceGen || current.offsetUs !== previous.offsetUs) status.invalidate(previous.slot);
      }
      queries.reconcile(tracks, entries);
      tracks = entries;
      caps = new Map(session.getAnalysisCapabilities().map(c => [c.slot as Slot, c.capability]));
      if (prefs.axis === 'dts' && !allHaveDts()) prefs.axis = 'pts';
      // 换片/清轨后旧检查与冻结快照失效，不拿旧 sampleId 定位新片源。
      inspection.invalidate();
      renderFloat(null, null);
      save();
      refreshTools();
      applyPendingAnalysisView();
      updateStatus();
      scheduleQuery(true);
    } else {
      // 索引构建会改变 duration 与能力，轻量跟进。能力比较覆盖完整字段
      // （hasDts/hasSize 等），不只看 indexState：能力变化同样要求重查。
      const nextCaps = new Map(session.getAnalysisCapabilities().map(c => [c.slot as Slot, c.capability]));
      const capSig = JSON.stringify([...nextCaps]);
      const prevSig = JSON.stringify([...caps]);
      if (capSig !== prevSig) {
        caps = nextCaps;
        refreshTools();
        scheduleQuery(true);
      }
      positionPlayhead();
      updateStatus();
    }
  };

  const onProgress = (pos: number) => {
    positionUs = pos;
    if (open) positionPlayhead(); // 只移动标记，不重算整张图
  };

  const offSession = session.subscribe(onSession);
  const offProgress = session.subscribeProgress(onProgress);

  let resizeRaf = 0;
  const resizer_obs = new ResizeObserver(() => {
    if (!open || resizeRaf) return;
    // Notices and the empty/chart transition change the observed body height.
    // Apply layout writes next frame, outside ResizeObserver delivery.
    resizeRaf = requestAnimationFrame(() => {
      resizeRaf = 0;
      if (!open || signal.aborted) return;
      render();
      scheduleQuery();
    });
  });
  resizer_obs.observe(body);
  resizer_obs.observe(plot);
  // 换行检测：状态区是否被挤到工具条下一行（直接比几何位置，不猜阈值）。
  // 同行靠右（margin-left:auto），换行独占一行时左对齐。margin 翻转不改变
  // 换行判定本身（只吸收/释放空白），不会形成布局抖动回路。
  const headEl = section.querySelector('.analysis-head')!;
  const wrapObs = new ResizeObserver(() => {
    if (signal.aborted) return;
    const toolsBottom = tools.getBoundingClientRect().bottom;
    const statusTop = statusEl.getBoundingClientRect().top;
    headEl.classList.toggle('status-wrapped', statusTop - toolsBottom > 2);
  });
  wrapObs.observe(tools);
  wrapObs.observe(statusEl);

  const themeChanges = new MutationObserver(() => { readColors(); status.invalidate(); updateStatus(); render(); });
  themeChanges.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] });
  const stopLanguage = onLanguageChange(() => { if (!signal.aborted) localize(); }, signal);

  refreshTools();
  refreshNumAxis();
  onSession();
  render();

  signal.addEventListener('abort', () => {
    queries.dispose();
    window.clearTimeout(buildingTimer);
    if (viewRaf) cancelAnimationFrame(viewRaf);
    if (resizeRaf) cancelAnimationFrame(resizeRaf);
    offSession();
    offProgress();
    stopLanguage();
    resizer_obs.disconnect();
    wrapObs.disconnect();
    themeChanges.disconnect();
    axisMenu.dispose();
    windowMenu.dispose();
    layoutMenu.dispose();
  }, { once: true });

  return { setOpen, getAnalysisState, restoreAnalysisState };
}
