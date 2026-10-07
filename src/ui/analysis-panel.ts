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
import { panTimeRange, zoomTimeRange } from '../analysis/projection.ts';
import type { TimeGroup } from '../analysis/grouping.ts';
import { buildInspection } from '../analysis/inspection.ts';
import type { DirectTarget, InspectionState, TrackInspection } from '../analysis/inspection.ts';
import { pickGlyph } from './analysis-geometry.ts';
import type { AnalysisGlyph, BucketGlyph, SampleGlyph } from './analysis-geometry.ts';
import { installChoiceMenu } from './choice-menu.ts';
import { getLocale, onLanguageChange, t, th, msg } from '../i18n.ts';
import { reconcileTrackSelection } from './track-selection.ts';
import type { AnalysisViewState } from '../workspace-file.ts';
import {
  computeLayout, drawAnalysis, formatAxis, plotGeometry, tOf, xOf,
} from './analysis-canvas.ts';
import type { CanvasColors, CanvasModel } from './analysis-canvas.ts';
import { loadAnalysisPreferences as loadPrefs, PREF_KEY } from './analysis/preferences.ts';
import type { AnalysisPreferences as Prefs } from './analysis/preferences.ts';
import { buildAnalysisModel } from './analysis/model.ts';
import { createAnalysisQueries } from './analysis/queries.ts';
import type { AnalysisQueryTrack } from './analysis/queries.ts';
import './analysis-panel.css';

type Action = (action: () => unknown | Promise<unknown>, name?: string, data?: unknown) => Promise<void>;

export interface AnalysisHooks {
  signal: AbortSignal;
  isOpen: () => boolean;
}

const MIN_SPAN_US = 10_000;

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
  const floatLayer = document.createElement('div');
  floatLayer.className = 'analysis-float-layer';
  floatLayer.setAttribute('aria-hidden', 'true');
  const cardEl = document.createElement('div');
  cardEl.className = 'analysis-card';
  cardEl.hidden = true;
  floatLayer.append(cardEl);
  document.body.append(floatLayer);
  const live = $<HTMLElement>('output');
  let lastInspection: InspectionState | null = null;
  /** 冻结的检查快照（Shift+单击 / I 切换，Escape 解除）；换片/清轨时失效。 */
  let pinned: InspectionState | null = null;

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
  let hoverUs: number | null = null;
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
  let hoverRaf = 0;
  let pendingHover: { x: number; y: number; t: number } | null = null;
  let lastClient: { x: number; y: number } | null = null;
  let kbInspect = false;
  let kbTrack: Slot | null = null;
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

  // ---- 右侧状态区：当前上屏帧 PTS + 双帧号（展示序 / 解码序） ----
  // PTS 取会话真实上屏帧（frame.ptsUs + offsetUs），与各视口 canvas 一致；
  // PTS序是展示序排名（PTS 严格小于该帧的样本数，0-based），DTS序是解码
  // 顺序号（包表下标）。两者经 session.rankAnalysisFrame 一次只读查询返回，
  // 复用各后端包表的有序轴缓存，O(log N)，不解码、不物化样本。重复 PTS
  // 共享展示排名；无精确 PTS 匹配时 DTS序显示 —；索引构建中为暂定值（~）。
  const framesBySlot = new Map<Slot, { ptsUs: number; sourcePtsUs: number } | null>();
  const rankCache = new Map<Slot, { pts: number; rank: number | null; total: number | null; ordinal: number | null; complete: boolean; note?: string }>();
  const rankSeq = new Map<Slot, number>();
  let lastStatusSig = '';
  let editingNumber = false;
  /** 展示序排名按（slot，会话 PTS）缓存；换片/重建时由调用方清理。 */
  function fetchRank(slot: Slot, sessionPts: number) {
    const seq = (rankSeq.get(slot) ?? 0) + 1;
    rankSeq.set(slot, seq);
    void session.rankAnalysisFrame(slot, sessionPts, 'pts').then(res => {
      if (signal.aborted || rankSeq.get(slot) !== seq) return;
      const entry = tracks.find(t => t.slot === slot);
      const f = framesBySlot.get(slot);
      // 只接受仍是当前上屏帧的结果，旧帧的迟到回答直接丢弃。
      if (!entry || !f || f.ptsUs + entry.offsetUs !== sessionPts) return;
      rankCache.set(slot, 'rank' in res
        ? { pts: sessionPts, rank: res.rank, total: res.total, ordinal: res.ordinal, complete: res.complete }
        : { pts: sessionPts, rank: null, total: null, ordinal: null, complete: false, note: res.reason });
      renderStatus();
    }).catch(() => { /* RPC 异常不覆盖显示，保留占位，下次帧变化再试。 */ });
  }
  function statusEntry(slot: Slot, offsetUs: number) {
    const f = framesBySlot.get(slot);
    const sessionPts = f ? f.ptsUs + offsetUs : null;
    const cached = rankCache.get(slot);
    const hit = sessionPts != null && cached?.pts === sessionPts ? cached : undefined;
    return { frame: f ?? null, sessionPts, hit };
  }
  /** 同步渲染：只显示主题色点 + 槽位 + 帧号（PTS序/解码序由切换决定），时间只进 tooltip。 */
  function renderStatus() {
    if (editingNumber) return;
    const sig = [prefs.numAxis, ...tracks.map(t => {
      const { sessionPts, hit } = statusEntry(t.slot, t.offsetUs);
      const num = hit ? (prefs.numAxis === 'pts' ? hit.rank : hit.ordinal) : undefined;
      return `${t.slot}:${sessionPts ?? 'x'}:${num ?? (hit ? 'x' : '-')}${hit && !hit.complete ? '~' : ''}`;
    })].join('|');
    if (sig === lastStatusSig) return;
    lastStatusSig = sig;
    itemsEl.replaceChildren();
    const axisLabel = prefs.numAxis === 'pts' ? t(msg("analysis.ptsOrder", "PTS序")) : t(msg("analysis.dtsOrder", "DTS序"));
    if (!tracks.length) {
      const empty = document.createElement('span');
      empty.className = 'st-empty';
      empty.textContent = '—';
      empty.title = t(msg("analysis.noVideoYet", "尚未载入视频"));
      itemsEl.append(empty);
      statusEl.setAttribute('aria-label', t(msg("analysis.currentFrameNumbersEmpty", "当前上屏帧号：尚未载入视频")));
      return;
    }
    const summary: string[] = [];
    for (const entry of tracks) {
      const { frame: f, sessionPts, hit } = statusEntry(entry.slot, entry.offsetUs);
      const wrap = document.createElement('span');
      wrap.className = 'st-item';
      const dot = document.createElement('span');
      dot.className = 'dot';
      dot.style.background = slotColors.get(entry.slot) ?? '#888';
      const label = document.createElement('span');
      label.className = 'st-slot';
      label.textContent = entry.slot;
      const num = document.createElement('button');
      num.type = 'button';
      num.className = 'st-num';
      const value = hit ? (prefs.numAxis === 'pts' ? hit.rank : hit.ordinal) : undefined;
      const maxFrame = Math.max(value ?? 0, (hit?.total ?? 1) - 1);
      wrap.style.setProperty('--frame-number-width', `${Math.max(4, String(maxFrame).length + 2)}ch`);
      if (hit == null) num.textContent = '…';
      else if (value == null) num.textContent = '—';
      else num.textContent = `#${value}${hit.complete ? '' : '~'}`;
      num.disabled = value == null || !hit?.complete;
      num.title = num.disabled ? t(msg("analysis.indexNotReady", "帧索引尚未就绪")) : t(msg("analysis.enterFrameNumber", "输入轨道 {slot} 的{axis}帧号后按回车跳转"), { slot: entry.slot, axis: axisLabel });
      num.setAttribute('aria-label', t(msg("analysis.editTrackFrameNumber", "轨道 {slot} {axis}帧号，点击编辑"), { slot: entry.slot, axis: axisLabel }));
      num.onclick = () => {
        if (value == null || !hit?.complete) return;
        const axis = prefs.numAxis;
        editingNumber = true;
        const input = document.createElement('input');
        input.className = 'st-num-input'; input.type = 'text'; input.inputMode = 'numeric';
        input.autocomplete = 'off'; input.spellcheck = false; input.value = String(value);
        input.setAttribute('aria-label', t(msg("analysis.trackFrameNumber", "轨道 {slot} {axis}帧号"), { slot: entry.slot, axis: axisLabel }));
        num.replaceWith(input); input.focus(); input.select();
        let finished = false;
        const finish = (commit: boolean) => {
          if (finished) return; finished = true;
          const raw = input.value.trim().replace(/^#/, '');
          editingNumber = false; lastStatusSig = ''; renderStatus();
          if (!commit) return;
          if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
            live.textContent = t(msg("analysis.frameNumberMustBeNonNegativeInteger", "帧号必须是非负整数。")); return;
          }
          const number = Number(raw);
          void act(async () => {
            const result = await session.seekAnalysisFrameNumber(entry.slot, number, axis);
            if ('reason' in result) throw new Error(result.reason);
          }, 'analysis.seek-frame-number', { slot: entry.slot, number, axis });
        };
        input.onkeydown = event => {
          if (event.key === 'Enter') { event.preventDefault(); finish(true); }
          else if (event.key === 'Escape') { event.preventDefault(); finish(false); }
        };
        input.onblur = () => finish(true);
      };
      wrap.append(dot, label, num);
      if (sessionPts == null) {
        wrap.title = t(msg("analysis.trackHasNoFrame", "轨道 {slot}：暂无上屏帧"), { slot: entry.slot });
      } else if (hit?.rank != null) {
        wrap.title = t(msg("analysis.frameTitleBase", "轨道 {slot} 上屏帧：会话 PTS {pts}（{ptsUs} µs）"), { slot: entry.slot, pts: formatAxis(sessionPts), ptsUs: sessionPts })
          + (f != null ? t(msg("analysis.frameTitleSourcePts", " · 源 PTS {sourcePtsUs} µs"), { sourcePtsUs: f.sourcePtsUs }) : '')
          + t(msg("analysis.frameTitlePtsRank", " · PTS序 #{rank}"), { rank: hit.rank })
          + (hit.total != null ? t(msg("analysis.frameTitlePtsTotal", " / 共 {total} 帧"), { total: hit.total }) : '')
          + (hit.ordinal == null ? t(msg("analysis.frameTitleDtsMissing", " · DTS序 —（解码 PTS 不在包表内，不猜测）")) : t(msg("analysis.frameTitleDtsOrdinal", " · DTS序 #{ordinal}（解码顺序号）"), { ordinal: hit.ordinal }))
          + (hit.complete ? '' : t(msg("analysis.frameTitleProvisional", "（索引构建中，暂定）")));
      } else {
        wrap.title = t(msg("analysis.frameTitleBase", "轨道 {slot} 上屏帧：会话 PTS {pts}（{ptsUs} µs）"), { slot: entry.slot, pts: formatAxis(sessionPts), ptsUs: sessionPts })
          + (f != null ? t(msg("analysis.frameTitleSourcePts", " · 源 PTS {sourcePtsUs} µs"), { sourcePtsUs: f.sourcePtsUs }) : '')
          + (hit?.note ? t(msg("analysis.frameTitleRankPending", " · 帧号 —（{note}）"), { note: hit.note }) : t(msg("analysis.frameTitleQuerying", " · 帧号查询中")));
      }
      itemsEl.append(wrap);
      summary.push(sessionPts == null || value == null ? `${entry.slot} —` : `${entry.slot} #${value}`);
      if (sessionPts != null && !hit) fetchRank(entry.slot, sessionPts);
    }
    statusEl.setAttribute('aria-label', t(msg("analysis.statusLabel", "当前上屏帧号（{axis}）：{summary}"), { axis: axisLabel, summary: summary.join(getLocale() === 'en' ? '; ' : '；') }));
  }
  function updateStatus() {
    // 暂定排名在索引完成后自动转正：仍是当前帧但缓存未完成时重查一次。
    for (const t of tracks) {
      const { sessionPts, hit } = statusEntry(t.slot, t.offsetUs);
      if (sessionPts != null && hit?.rank != null && !hit.complete) fetchRank(t.slot, sessionPts);
    }
    renderStatus();
  }

  // ---- 帧号顺序切换（PTS序/解码序）：复用全局 .segmented 样式 ----
  const numAxisButtons = [...numAxisEl.querySelectorAll<HTMLButtonElement>('[data-num-axis]')];
  function refreshNumAxis() {
    for (const b of numAxisButtons) b.setAttribute('aria-pressed', String(b.dataset.numAxis === prefs.numAxis));
  }
  for (const b of numAxisButtons) b.onclick = () => {
    const v = b.dataset.numAxis as 'pts' | 'dts';
    if (prefs.numAxis === v) return;
    prefs.numAxis = v;
    save(); refreshNumAxis(); renderStatus();
  };

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
    toolsSig = ''; lastDtsOk = null; lastStatusSig = '';
    flOrder = [];
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
      lastInspection = null;
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
    if (!kbInspect && hoverUs != null && lastClient) {
      if (viewSig !== lastViewSig) {
        hoverUs = Math.round(tOf(drawn, geom, lastClient.x - canvas.getBoundingClientRect().left));
        const range = viewRange();
        if (hoverUs < range.start || hoverUs > range.end) {
          hoverUs = null;
          hoverEl.hidden = true;
        }
      }
      if (hoverUs != null) { positionHover(); updateInspection(lastClient.x, lastClient.y); }
    }
    lastViewSig = viewSig;
    publishTestHook();
    refreshOverlay();
    // 底图重绘后卡片按最后光标重新限位（仍在坞内横向滑动，不跟随翻边）。
    if (hoverUs != null && lastClient && !pinned) positionFloat(lastClient.x);
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
    if (hoverUs == null || hoverUs < viewRange().start || hoverUs > viewRange().end) {
      hoverEl.hidden = true;
      return;
    }
    hoverEl.hidden = false;
    hoverEl.style.left = `${fracToPx(hoverUs)}px`;
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
    const r = results.get(direct.slot);
    const s = r?.samples.find(v => v.sampleId === direct.sampleId);
    if (!s) return null;
    const axisT = prefs.axis === 'pts' ? s.effectivePtsUs : s.dtsUs;
    if (axisT == null || !Number.isFinite(axisT)) return null;
    return { axisUs: Math.round(axisT), sampleId: s.sampleId };
  }

  /**
   * 统一检查状态：曲线/空白用公共 T；真正命中单样本柱时整次检查吸附到该样本
   * 的真实轴时间，表头、检查线、码率圆点、参考样本一起更新，被命中轨道强制
   * 使用该柱的准确 sampleId（相同 PTS 下不另选）。吸附只改变检查锚点。
   */
  function inspectAt(tUs: number, direct: DirectTarget | null): InspectionState {
    const sel = selectedTracks();
    let t = Math.round(tUs);
    const hit = resolveDirectSample(direct);
    if (hit) t = hit.axisUs;
    const insp = buildInspection({
      axis: prefs.axis, inspectionTimeUs: t, windowUs: prefs.windowUs,
      stepUs: viewStepUs(), order: sel.map(t => t.slot),
      results, caps, domain: domainBounds(), directTarget: direct,
    });
    if (hit && direct?.kind === 'sample') {
      const r = results.get(direct.slot);
      const s = r?.samples.find(v => v.sampleId === hit.sampleId);
      const ti = insp.tracks.find(tr => tr.slot === direct.slot);
      if (s && ti && ti.coverageState === 'known') {
        ti.reference = { sample: s, axisUs: hit.axisUs, dtUs: 0, relation: 'exact' };
      }
    }
    return insp;
  }

  function stateText(s: string): string {
    switch (s) {
      case 'pending': return t(msg("analysis.statePending", "统计中"));
      case 'unsupported': return t(msg("analysis.stateUnsupported", "不可用"));
      case 'outside': return '—';
      case 'error': return t(msg("analysis.stateError", "索引错"));
      default: return '—';
    }
  }

  /** 码率固定两位小数；极小非零不写成误导的 0.00；无近似后缀。 */
  function fmtBitrate(v: number | null): string {
    if (v == null || !Number.isFinite(v)) return '—';
    if (v > 0 && v < 0.005) return '<0.01';
    return v.toFixed(2);
  }

  /** 帧率固定两位小数（保留 29.97 可读性）；无近似后缀。 */
  function fmtFps(v: number | null): string {
    if (v == null || !Number.isFinite(v)) return '—';
    return v.toFixed(2);
  }

  /** 帧大小固定一位小数 KiB；极小非零不写成误导的 0.0；字节数本身是真实值。 */
  function fmtSize(bytes: number | null | undefined): string {
    if (bytes == null || !Number.isFinite(bytes)) return '—';
    if (bytes <= 0) return '0.0';
    const kib = bytes / 1024;
    if (kib < 0.05) return '<0.1';
    return kib.toFixed(1);
  }

  /** 三行读数文本（固定表与悬浮窗共用同一口径与格式，无近似后缀）。 */
  function formatCells(t: TrackInspection): [bitrate: string, rate: string, size: string] {
    const b = t.coverageState !== 'known' && t.bitrate.value == null
      ? stateText(t.coverageState) : fmtBitrate(t.bitrate.value);
    const f = t.coverageState !== 'known' && t.localRate.value == null
      ? stateText(t.coverageState) : fmtFps(t.localRate.value);
    const s = t.coverageState !== 'known' ? stateText(t.coverageState)
      : !t.reference ? '—' : fmtSize(t.reference.sample.sizeBytes);
    return [b, f, s];
  }

  function sameOrder(a: readonly Slot[], b: readonly Slot[]): boolean {
    return a.length === b.length && a.every((s, i) => s === b[i]);
  }

  // ---- 横轴下方卡片坞：竖排三行（单位常驻），玻璃背板 ----
  // 与标注工具条同一毛玻璃材质；坞高恒定预留（画布扣除等量高度），
  // 卡片在坞内横向以鼠标为中心滑动，不翻边、不盖数据区、不挡轴数字。
  let flOrder: Slot[] = [];
  let flTime: HTMLElement | null = null;
  let flRateLabel: HTMLElement | null = null;
  let flDots = new Map<Slot, HTMLElement>();
  let flCells = new Map<string, HTMLElement>();

  function ensureFloatStructure(order: readonly Slot[]) {
    if (flTime && sameOrder(order, flOrder)) return;
    flOrder = [...order];
    flDots = new Map();
    flCells = new Map();
    cardEl.replaceChildren();
    const table = document.createElement('table');
    table.className = 'fl-grid';
    const thead = document.createElement('thead');
    // 表头与时间同一行：时间 + 各轨标记，不再独占一行。
    const head = document.createElement('tr');
    const time = document.createElement('th');
    time.className = 'fl-time';
    time.textContent = '—';
    head.append(time);
    flTime = time;
    for (const slot of order) {
      const th = document.createElement('th');
      th.scope = 'col';
      const dot = document.createElement('span');
      dot.className = 'dot';
      dot.style.background = slotColors.get(slot) ?? '#888';
      th.append(dot, document.createTextNode(slot));
      head.append(th);
      flDots.set(slot, dot);
    }
    thead.append(head);
    table.append(thead);
    const tbody = document.createElement('tbody');
    const rows = [
      { key: 'bitrate', label: t(msg("analysis.bitrateMbps", "码率 · Mbps")) },
      { key: 'rate', label: t(msg("analysis.frameRateFps", "帧率 · fps")) },
      { key: 'size', label: t(msg("analysis.frameSizeKib", "帧大小 · KiB")) },
    ] as const;
    for (const { key, label } of rows) {
      const tr = document.createElement('tr');
      const th = document.createElement('th');
      th.scope = 'row';
      th.textContent = label;
      if (key === 'rate') flRateLabel = th;
      tr.append(th);
      for (const slot of order) {
        const td = document.createElement('td');
        td.className = 'metric-value';
        td.textContent = '—';
        tr.append(td);
        flCells.set(`${key}:${slot}`, td);
      }
      tbody.append(tr);
    }
    table.append(tbody);
    cardEl.append(table);
  }

  /**
   * 卡片定位（视口坐标，顶层绘制）：横向以鼠标为中心并限位在图表内，
   * 纵向落在横轴下方（画布底边之下），不盖数据区、不挡轴数字。
   */
  function positionFloat(clientX: number) {
    if (cardEl.hidden) return;
    const canvasRect = canvas.getBoundingClientRect();
    const w = cardEl.offsetWidth || 0;
    if (!w) return;
    const maxX = Math.max(canvasRect.left, canvasRect.right - w - 4);
    const x = Math.min(Math.max(canvasRect.left + 4, clientX - w / 2), maxX);
    cardEl.style.left = `${Math.round(x)}px`;
    cardEl.style.top = `${Math.round(canvasRect.bottom + 6)}px`;
  }

  /** 卡片内容：同一检查快照；顶层绘制，闲时隐藏，不占面板布局。 */
  function renderFloat(insp: InspectionState | null, clientX: number | null) {
    if (!insp) { cardEl.hidden = true; return; }
    ensureFloatStructure(insp.tracks.map(t => t.slot));
    cardEl.hidden = false;
    if (flTime) {
      flTime.textContent = `${formatAxis(insp.inspectionTimeUs)}${pinned ? t(msg("analysis.pinnedSuffix", " · 已固定")) : ''}`;
    }
    if (flRateLabel) flRateLabel.textContent = t(insp.axis === 'dts' ? msg("analysis.sampleRate", "样本率 /s") : msg("analysis.frameRateFps", "帧率 · fps"));
    for (const [slot, dot] of flDots) dot.style.background = slotColors.get(slot) ?? '#888';
    for (const tr of insp.tracks) {
      const [b, f, s] = formatCells(tr);
      const vals: Record<string, string> = { bitrate: b, rate: f, size: s };
      for (const [m, text] of Object.entries(vals)) {
        const el = flCells.get(`${m}:${tr.slot}`);
        if (el) el.textContent = text;
      }
    }
    if (clientX != null) positionFloat(clientX);
  }

  /** 检查更新：冻结期间不跟随；命中单样本时吸附锚点并同步检查线与悬浮条。 */
  function updateInspection(clientX: number, clientY: number) {
    if (hoverUs == null) { lastInspection = null; renderFloat(null, null); refreshOverlay(); publishTestHook(); return; }
    const sel = selectedTracks();
    if (!sel.length) { lastInspection = null; renderFloat(null, null); refreshOverlay(); publishTestHook(); return; }
    if (pinned) return;
    const direct = directTargetFromGlyph(pickAt(clientX, clientY));
    const insp = inspectAt(hoverUs, direct);
    // 吸附后的真实检查时间同步到检查线与悬浮条，不保留另一时刻的过期读数。
    hoverUs = insp.inspectionTimeUs;
    lastInspection = insp;
    positionHover();
    renderFloat(insp, clientX);
    // 辅助技术播报只在键盘步进/固定时更新，不每个鼠标帧推送整段文本。
    if (kbInspect) live.textContent = cardEl.textContent ?? '';
    refreshOverlay();
    publishTestHook();
  }

  /**
   * 独立覆盖层：检查圆点与样本高亮只画在 overlay canvas 上，
   * 不重绘基础图层（hover 扫描不增加底图绘制次数）。
   */
  function refreshOverlay() {
    if (!lastModel || !overlayCtx || !lastGeom) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    overlayCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    overlayCtx.clearRect(0, 0, lastModel.width, lastModel.height);
    const active = pinned ?? lastInspection;
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

  /** 只读测试快照：布局 glyph 身份与当前检查状态，供浏览器回归精确断言。
   * 只在 QA 钩子启用时构建：生产 hover 不为 2000 条 glyph 摘要与 DOM 几何读取付费。 */
  function publishTestHook() {
    try {
      const w = window as unknown as { __vpAnalysis?: unknown; __vpAnalysisQA?: boolean };
      if (!w.__vpAnalysisQA) return;
      const active = pinned ?? lastInspection;
      const plotRect = plot.getBoundingClientRect();
      const flRect = cardEl.hidden ? null : cardEl.getBoundingClientRect();
      w.__vpAnalysis = {
        view: viewRange(),
        axis: prefs.axis,
        pinned: pinned != null,
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
    if (pinned) { unpinInspection(); return; }
    if (hoverUs == null) return;
    const insp = inspectAt(hoverUs, direct);
    pinned = insp;
    lastInspection = insp;
    renderFloat(insp, lastClient?.x ?? null);
    refreshOverlay();
    publishTestHook();
    // 固定状态做节制播报；普通 hover 不推送整段文本。
    live.textContent = cardEl.textContent ?? '';
  }

  function unpinInspection(focusCanvas = false) {
    if (!pinned) return;
    pinned = null;
    renderFloat(lastInspection, lastClient?.x ?? null);
    refreshOverlay();
    publishTestHook();
    if (focusCanvas) canvas.focus();
  }

  // ---- 指针交互 ----
  let pressX: number | null = null;
  let pressT = 0;
  let selecting = false;

  const canvasT = (clientX: number) => {
    const rect = canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    if (lastGeom && lastModel) {
      return tOf({ ...lastModel, width: lastGeom.width } as CanvasModel, {
        gutter: lastGeom.gutter, plotW: lastGeom.plotW,
      } as never, x);
    }
    // 首帧数据到达前用纯视图几何定位，手势不依赖数据。
    const g = plotGeometry(plotWidthCss());
    const range = viewRange();
    const span = Math.max(1, range.end - range.start);
    return range.start + ((x - g.gutter) / g.plotW) * span;
  };

  canvas.addEventListener('pointerdown', event => {
    if (event.button !== 0 || !open || !selectedTracks().length) return;
    canvas.focus();
    pressX = event.clientX;
    pressT = canvasT(event.clientX);
    selecting = false;
    canvas.setPointerCapture(event.pointerId);
  }, { signal });

  canvas.addEventListener('pointermove', event => {
    if (!open || !selectedTracks().length) return;
    if (pressX != null) {
      if (!selecting && Math.abs(event.clientX - pressX) > 4) selecting = true;
      if (selecting) {
        rubber = { a: pressT, b: canvasT(event.clientX) };
        renderRubber();
        return;
      }
    }
    // rAF 合并取本帧最新坐标，不保留首个事件丢弃后续；冻结期间不跟随。
    if (pinned) return;
    pendingHover = { x: event.clientX, y: event.clientY, t: canvasT(event.clientX) };
    if (hoverRaf) return;
    hoverRaf = requestAnimationFrame(() => {
      hoverRaf = 0;
      if (signal.aborted) return;
      const p = pendingHover;
      pendingHover = null;
      if (!p) return;
      hoverUs = Math.round(p.t);
      kbInspect = false;
      lastClient = { x: p.x, y: p.y };
      positionHover();
      updateInspection(p.x, p.y);
    });
  }, { signal });

  function renderRubber() {
    if (!lastModel || !ctx) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawAnalysis(ctx, { ...lastModel, height: lastModel.height, rubber });
  }

  canvas.addEventListener('pointerup', event => {
    if (pressX == null) return;
    const wasSelecting = selecting;
    selecting = false;
    pressX = null;
    if (wasSelecting && rubber) {
      const a = Math.min(rubber.a, rubber.b), b = Math.max(rubber.a, rubber.b);
      rubber = null;
      if (b - a > MIN_SPAN_US) setView(Math.floor(a), Math.ceil(b), false);
      else render();
      // 框选拖拽藏起了悬浮条；冻结中恢复快照显示。
      if (pinned) renderFloat(pinned, lastClient?.x ?? null);
      return;
    }
    rubber = null;
    const picked = pickAt(event.clientX, event.clientY);
    // Shift+单击冻结/解冻当前检查，不改变播放状态：已冻结时只解冻，
    // 不在点击位置重新冻结（再次 Shift+单击必须可逆）。
    if (event.shiftKey) {
      if (pinned) { unpinInspection(); return; }
      hoverUs = Math.round(canvasT(event.clientX));
      lastClient = { x: event.clientX, y: event.clientY };
      positionHover();
      updateInspection(event.clientX, event.clientY);
      pinInspection(directTargetFromGlyph(picked));
      return;
    }
    // 单击只定位到展示 PTS，不改变视图范围（缩放走框选/滚轮/双击）；
    // 样本与区间桶都按其主样本定位（桶峰值走 session 有界定位）；空白不定位。
    if (picked && picked.kind === 'sample') {
      const g = picked as SampleGlyph;
      const r = results.get(g.slot);
      const s = r?.samples.find(v => v.sampleId === g.sampleId);
      const resolved = session.resolveAnalysisSeek(g.slot, { effectivePtsUs: s?.effectivePtsUs ?? g.sessionPtsUs });
      if ('sessionPtsUs' in resolved) {
        kbTrack = g.slot;
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
        const inView = results.get(g.slot)?.samples.find(v => v.sampleId === peakId);
        if (inView) {
          const resolved = session.resolveAnalysisSeek(g.slot, { effectivePtsUs: inView.effectivePtsUs });
          if ('sessionPtsUs' in resolved) {
            kbTrack = g.slot;
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
            if (signal.aborted) return;
            if ('sessionPtsUs' in res) {
              kbTrack = g.slot;
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
    if (pinned) {
      // 冻结快照不随指针移出消失：卡片与检查线保持，只藏 hover 悬浮条。
      // 否则 pinned 保留而卡片隐藏后，pointermove 的 pinned 提前返回会形成死状态。
      pendingHover = null;
      hoverEl.hidden = true;
      return;
    }
    // 移出隐藏顶层卡片，只隐藏检查线并清空覆盖层，不重绘底图。
    hoverUs = null;
    kbInspect = false;
    pendingHover = null;
    hoverEl.hidden = true;
    renderFloat(null, null);
    refreshOverlay();
    publishTestHook();
  }, { signal });

  // 滚轮左右平移；Ctrl+滚轮（触摸板捏合）以 hover 点为中心缩放坐标轴。
  // 触摸板双指滑动直接产生带 deltaX/Y 的 wheel 事件，走同一条平移路径。
  canvas.addEventListener('wheel', event => {
    if (!open || !selectedTracks().length) return;
    event.preventDefault();
    const range = viewRange();
    const span = Math.max(1, range.end - range.start);
    const db = domainBounds();
    // Firefox 行/页模式换算为像素当量；页模式一页约 1/4 视图。
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? span / 4 : 1;
    if (event.ctrlKey) {
      const factor = Math.exp((event.deltaY * unit) / 280);
      const center = canvasT(event.clientX);
      const z = zoomTimeRange(range.start, range.end, center, factor, MIN_SPAN_US, db);
      setView(z.start, z.end, false);
    } else {
      const px = (lastGeom && lastGeom.plotW > 0 ? lastGeom.plotW : plotGeometry(plotWidthCss()).plotW) || 1;
      const shift = Math.round((event.deltaX * unit + event.deltaY * unit) * (span / px));
      if (!shift) return;
      const p = panTimeRange(range.start, range.end, shift, db);
      setView(p.start, p.end, false);
    }
  }, { signal, passive: false });

  canvas.addEventListener('dblclick', () => setView(null, undefined, true), { signal });

  canvas.addEventListener('keydown', event => {
    if (!lastModel) return;
    const range = viewRange();
    const sel = selectedTracks();
    if (!sel.length) return;
    if (!kbTrack || !sel.some(t => t.slot === kbTrack)) kbTrack = sel[0].slot;
    const step = Math.max(1, Math.floor((range.end - range.start) / 100));
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      if (pinned) return;
      const base = hoverUs ?? positionUs;
      hoverUs = Math.round(base + (event.key === 'ArrowRight' ? step : -step));
      kbInspect = true;
      positionHover();
      const rect = canvas.getBoundingClientRect();
      updateInspection(rect.left + (lastGeom ? xOf(lastModel, {
        gutter: lastGeom.gutter, plotW: lastGeom.plotW,
      } as never, hoverUs) : 0), rect.top + 20);
    } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      // 键盘轨道焦点：上下切换，不总是第一轨。
      event.preventDefault();
      const idx = sel.findIndex(t => t.slot === kbTrack);
      const next = event.key === 'ArrowDown'
        ? sel[(idx + 1) % sel.length].slot
        : sel[(idx - 1 + sel.length) % sel.length].slot;
      kbTrack = next;
      kbInspect = true;
      if (hoverUs != null) {
        const rect = canvas.getBoundingClientRect();
        updateInspection(rect.left + (lastGeom ? xOf(lastModel, {
          gutter: lastGeom.gutter, plotW: lastGeom.plotW,
        } as never, hoverUs) : 0), rect.top + 20);
        live.textContent = t(msg("analysis.trackFocusWithContext", "轨道焦点 {slot}。{rest}"), { slot: kbTrack, rest: live.textContent ?? '' });
      } else {
        live.textContent = t(msg("analysis.trackFocus", "轨道焦点 {slot}"), { slot: kbTrack });
      }
    } else if (event.key === 'Enter' && hoverUs != null) {
      event.preventDefault();
      // 键盘 Enter 定位当前焦点轨道在检查点的参考样本（与鼠标统一口径），不总是第一轨。
      const focus = kbTrack ?? sel[0].slot;
      const insp = inspectAt(hoverUs, lastInspection?.directTarget ?? null);
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
      kbInspect = true;
      if (pinned) unpinInspection();
      else if (hoverUs != null) {
        const rect = canvas.getBoundingClientRect();
        updateInspection(rect.left + (lastGeom ? xOf(lastModel, {
          gutter: lastGeom.gutter, plotW: lastGeom.plotW,
        } as never, hoverUs) : 0), rect.top + 20);
        pinInspection(lastInspection?.directTarget ?? null);
      }
    } else if (event.key === 'Escape') {
      if (pinned) { unpinInspection(true); return; }
      hoverUs = null; rubber = null; kbInspect = false;
      lastInspection = null;
      hoverEl.hidden = true;
      renderFloat(null, null);
      refreshOverlay();
      publishTestHook();
    }
  }, { signal });

  // ---- 会话联动（开关与高度由 workbench 统一管理） ----
  function setOpen(next: boolean) {
    if (open === next) return;
    open = next;
    render();
    if (open) { refreshTools(); scheduleQuery(true); }
    else {
      cardEl.hidden = true;
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
    for (const t of state.tracks) {
      const frame = (t as { frame?: { ptsUs: number; sourcePtsUs: number } | null }).frame;
      framesBySlot.set(t.slot as Slot, frame ? { ptsUs: frame.ptsUs, sourcePtsUs: frame.sourcePtsUs } : null);
    }
    for (const slot of [...framesBySlot.keys()]) {
      if (!state.tracks.some(t => (t.slot as Slot) === slot)) {
        framesBySlot.delete(slot);
        rankCache.delete(slot);
      }
    }
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
      for (const slot of queries.reconcile(tracks, entries)) {
        rankCache.delete(slot);
        rankSeq.set(slot, (rankSeq.get(slot) ?? 0) + 1);
      }
      tracks = entries;
      caps = new Map(session.getAnalysisCapabilities().map(c => [c.slot as Slot, c.capability]));
      if (prefs.axis === 'dts' && !allHaveDts()) prefs.axis = 'pts';
      // 换片/清轨后旧检查与冻结快照失效，不拿旧 sampleId 定位新片源。
      lastInspection = null;
      pinned = null;
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

  const themeChanges = new MutationObserver(() => { readColors(); lastStatusSig = ''; updateStatus(); render(); });
  themeChanges.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] });
  const stopLanguage = onLanguageChange(() => { if (!signal.aborted) localize(); }, signal);

  refreshTools();
  refreshNumAxis();
  onSession();
  render();

  signal.addEventListener('abort', () => {
    queries.dispose();
    window.clearTimeout(buildingTimer);
    if (hoverRaf) cancelAnimationFrame(hoverRaf);
    if (viewRaf) cancelAnimationFrame(viewRaf);
    if (resizeRaf) cancelAnimationFrame(resizeRaf);
    offSession();
    offProgress();
    stopLanguage();
    resizer_obs.disconnect();
    wrapObs.disconnect();
    themeChanges.disconnect();
    floatLayer.remove();
    axisMenu.dispose();
    windowMenu.dispose();
    layoutMenu.dispose();
  }, { once: true });

  return { setOpen, getAnalysisState, restoreAnalysisState };
}
