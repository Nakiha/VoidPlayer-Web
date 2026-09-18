// 顶部码流分析面板：工具条 + Canvas + 覆盖层 + 会话共用查询。
// 数据全部走 ReviewSession.queryAnalysis（与 Agent 同一入口）；悬停只读
// 索引，不解码、不 seek；单击可显示帧经 resolveAnalysisSeek 定位到展示 PTS。
// 面板开关与高度由 workbench 统一管理（右上功能区、拖拽手势与子轨道同契约）；
// 本模块只负责内容、查询与绘制。下拉全部使用项目 choice-menu 控件。

import { SLOTS, formatTime } from '../model.ts';
import type { Slot } from '../model.ts';
import type { ReviewSession } from '../session.ts';
import type { AnalysisCapability, AnalysisResult } from '../analysis/types.ts';
import { BITRATE_WINDOW_OPTIONS_US, DEFAULT_BITRATE_WINDOW_US, niceCeiling } from '../analysis/statistics.ts';
import { decideLayout, matchPairsStrict, panTimeRange, zoomTimeRange } from '../analysis/projection.ts';
import { installChoiceMenu } from './choice-menu.ts';
import {
  computeLayout, desiredHeight, drawAnalysis, formatAxis, plotGeometry, tOf, xOf,
} from './analysis-canvas.ts';
import type { CanvasColors, CanvasModel, CanvasTrack } from './analysis-canvas.ts';
import './analysis-panel.css';

type Action = (action: () => unknown | Promise<unknown>, name?: string, data?: unknown) => Promise<void>;

export interface AnalysisHooks {
  signal: AbortSignal;
  isOpen: () => boolean;
}

const PREF_KEY = 'voidplayer.analysis.v1';
const PAIR_TOLERANCE_US = 2000;
const MAX_SAMPLES = 5000;
const MIN_SPAN_US = 10_000;

const WINDOW_LABELS: Record<number, string> = Object.fromEntries(
  BITRATE_WINDOW_OPTIONS_US.map(w => [w, w >= 1_000_000 ? `${w / 1_000_000}s` : `${w / 1000}ms`]),
);
const LAYOUT_LABELS: Record<'auto' | 'paired' | 'rows', string> = { auto: '自动布局', paired: '并排', rows: '分行' };

interface Prefs {
  showBitrate: boolean; showSize: boolean; colorByType: boolean;
  axis: 'pts' | 'dts'; windowUs: number; layoutMode: 'auto' | 'paired' | 'rows';
  follow: boolean; selected: Slot[];
}

function loadPrefs(): Prefs {
  const fallback: Prefs = {
    showBitrate: true, showSize: true, colorByType: true,
    axis: 'pts', windowUs: DEFAULT_BITRATE_WINDOW_US, layoutMode: 'auto',
    follow: true, selected: [],
  };
  try {
    const raw = localStorage.getItem(PREF_KEY);
    if (!raw) return fallback;
    const p = JSON.parse(raw) as Partial<Prefs>;
    return {
      ...fallback, ...p,
      axis: p.axis === 'dts' ? 'dts' : 'pts',
      windowUs: BITRATE_WINDOW_OPTIONS_US.includes(p.windowUs!) ? p.windowUs! : DEFAULT_BITRATE_WINDOW_US,
      layoutMode: p.layoutMode === 'paired' || p.layoutMode === 'rows' ? p.layoutMode : 'auto',
      selected: Array.isArray(p.selected) ? p.selected.filter((s): s is Slot => SLOTS.includes(s as Slot)) : [],
    };
  } catch { return fallback; }
}

interface TrackEntry { slot: Slot; mediaId: string; offsetUs: number; durationUs: number; name: string }

export function installAnalysisPanel(session: ReviewSession, act: Action, hooks: AnalysisHooks): { setOpen(open: boolean): void } {
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
      <span class="analysis-title">码流分析</span>
      <div class="analysis-tools" role="group" aria-label="分析选项">
        <button type="button" class="seg" data-seg="bitrate" title="视频样本负载码率，按 PTS/DTS 归集的滑动时间窗">码率</button>
        <button type="button" class="seg" data-seg="size" title="压缩样本字节（demux 负载），非解码内存">帧大小</button>
        <button type="button" class="seg" data-seg="type" title="帧大小柱按帧类型着色；关闭后统一使用轨道色">类型着色</button>
        <button type="button" class="seg" disabled title="暂无可靠的 QP 来源（不填零、不伪造），后续版本支持亮度面积加权平均 QP">QP：未解析</button>
        <span id="analysis-tracks" class="analysis-tracks" role="group" aria-label="对比轨道"></span>
        <button type="button" id="analysis-axis" class="choice-trigger" aria-label="时间基准" title="PTS 为展示时间，DTS 为解码时间；无可靠 DTS 的轨道不支持 DTS 视图"></button>
        <button type="button" id="analysis-window" class="choice-trigger" aria-label="码率滑窗" title="视频样本负载码率的滑动时间窗（真实时间窗，非 N 帧窗）"></button>
        <button type="button" id="analysis-layout" class="choice-trigger" aria-label="多轨布局" title="自动：双轨且严格配对成功时并排，否则分行"></button>
        <button type="button" class="seg" data-seg="follow" title="跟随播放范围；框选放大后自动关闭，不强制跳回播放位置">跟随：开</button>
        <button type="button" class="seg" data-seg="full" title="双击图也可恢复完整范围">完整范围</button>
      </div>
      <span class="analysis-status" role="status"></span>
    </header>
    <div class="analysis-body" id="analysis-body">
      <canvas id="analysis-canvas" tabindex="0" role="img" aria-label="码流分析图：码率曲线与帧大小柱。方向键移动检查位置，回车定位，Escape 退出检查。"></canvas>
      <div class="analysis-line analysis-playhead" hidden></div>
      <div class="analysis-line analysis-hover" hidden></div>
      <div class="analysis-tooltip" hidden></div>
      <div class="analysis-empty" hidden></div>
    </div>
    <output class="sr-only" aria-live="polite"></output>`);

  const $ = <T extends Element = HTMLElement>(sel: string) => section.querySelector(sel) as unknown as T;
  const tools = $<HTMLElement>('.analysis-tools');
  const tracksEl = $<HTMLElement>('#analysis-tracks');
  const status = $<HTMLElement>('.analysis-status');
  const body = $<HTMLElement>('.analysis-body');
  const canvas = $<HTMLCanvasElement>('#analysis-canvas');
  const ctx = canvas.getContext('2d');
  const playheadEl = $<HTMLElement>('.analysis-playhead');
  const hoverEl = $<HTMLElement>('.analysis-hover');
  const tooltip = $<HTMLElement>('.analysis-tooltip');
  const emptyEl = $<HTMLElement>('.analysis-empty');
  const live = $<HTMLElement>('output');

  let tracks: TrackEntry[] = [];
  let caps = new Map<Slot, AnalysisCapability>();
  let results = new Map<Slot, AnalysisResult>();
  let seqBySlot = new Map<Slot, number>();
  let abortBySlot = new Map<Slot, AbortController>();
  let panelSeq = 0;
  let view: { start: number; end: number } | null = null;
  let hoverUs: number | null = null;
  let rubber: { a: number; b: number } | null = null;
  let positionUs = 0;
  let durationUs = 0;
  let queryTimer = 0;
  let buildingTimer = 0;
  let lastGeom: { gutter: number; plotW: number; width: number } | null = null;
  let lastModel: CanvasModel | null = null;
  let colors: CanvasColors = { key: '', delta: '', unknown: '', grid: '', text: '', axisText: '' };
  let slotColors = new Map<Slot, string>();
  let trackSig = '';
  let hoverRaf = 0;
  let lastClient: { x: number; y: number } | null = null;
  let kbInspect = false;
  let lastViewSig = '';

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

  const fullRange = () => ({ start: 0, end: Math.max(1, durationUs - 1) });
  const viewRange = () => view ?? fullRange();

  /** 会话时间域：各轨偏移起点到会话终点；DTS 轴下界多留 1s 给合法负时间。 */
  function domainBounds(): { start: number; end: number } {
    const lo = tracks.length ? Math.min(0, ...tracks.map(t => t.offsetUs)) : 0;
    const hi = Math.max(1, durationUs - 1);
    return { start: Math.floor(lo - (prefs.axis === 'dts' ? 1_000_000 : 0)), end: Math.ceil(hi) };
  }

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
  /** 高频手势（滚轮/捏合）合并为一帧一次重绘；数据查询仍走 120ms 防抖。 */
  function requestRender() {
    if (viewRaf || signal.aborted) return;
    viewRaf = requestAnimationFrame(() => { viewRaf = 0; if (!signal.aborted) render(); });
  }

  const selectedTracks = () => tracks.filter(t => prefs.selected.includes(t.slot));

  const allHaveDts = () => {
    const sel = selectedTracks();
    return sel.length > 0 && sel.every(t => caps.get(t.slot)?.hasDts);
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
  segButtons.get('type')!.onclick = () => { prefs.colorByType = !prefs.colorByType; save(); refreshTools(); render(); };
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
    (['auto', 'paired', 'rows'] as const).map(v => ({ value: v, label: LAYOUT_LABELS[v] })), value => {
      prefs.layoutMode = value as Prefs['layoutMode']; save(); refreshTools(); render();
    });

  let toolsSig = '';
  let lastDtsOk: boolean | null = null;
  function refreshTools() {
    setSeg('bitrate', prefs.showBitrate);
    setSeg('size', prefs.showSize);
    setSeg('type', prefs.colorByType);
    setSeg('follow', prefs.follow, prefs.follow ? '跟随：开' : '跟随：关');
    // 高频手势每 tick 都经过这里：DOM 重建只在签名变化时做，label 同步很便宜。
    const sig = JSON.stringify([prefs.axis, prefs.windowUs, prefs.layoutMode, prefs.selected,
      tracks.map(t => t.slot)]);
    if (sig !== toolsSig) {
      toolsSig = sig;
      tracksEl.replaceChildren();
      for (const t of tracks) {
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'analysis-chip';
        const on = prefs.selected.includes(t.slot);
        b.setAttribute('aria-pressed', String(on));
        b.title = on ? `隐藏轨道 ${t.slot}` : `显示轨道 ${t.slot}（${t.name}）`;
        const dot = document.createElement('span');
        dot.className = 'dot';
        dot.style.background = slotColors.get(t.slot) ?? '#888';
        b.append(dot, document.createTextNode(t.slot));
        b.onclick = () => {
          prefs.selected = on ? prefs.selected.filter(s => s !== t.slot) : [...prefs.selected, t.slot];
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
    layoutMenu.sync(prefs.layoutMode, LAYOUT_LABELS[prefs.layoutMode], true);
  }

  // ---- 查询 ----
  // 离散动作（点击/菜单/框选）用 immediate=true：数据 2~30ms 就到；
  // 高频手势（滚轮/尺寸）走 120ms trailing 防抖，只重绘缓存数据。
  function scheduleQuery(immediate = false) {
    if (!open) return;
    window.clearTimeout(queryTimer);
    if (immediate) { void refresh(); return; }
    queryTimer = window.setTimeout(() => void refresh(), 120);
  }

  /** 每轨已查询覆盖（会话时间）+ 数据修订；视图落入其中且索引完整时跳过查询只重绘。 */
  const queriedBySlot = new Map<Slot, { start: number; end: number; axis: string; windowUs: number; pixelWidth: number; offsetUs: number; revision: number }>();

  async function refresh() {
    if (!open || signal.aborted) return;
    const range = viewRange();
    const pixelWidth = Math.max(32, Math.floor(body.clientWidth - 46));
    const span = Math.max(1, range.end - range.start);
    const db = domainBounds();
    // 预取半屏 margin：连续滚动落入缓存只重绘，不发查询；像素密度按比例放大保持不变。
    const full = span >= db.end - db.start;
    const qStart = full ? range.start : Math.max(db.start, Math.floor(range.start - span * 0.5));
    const qEnd = full ? range.end : Math.min(db.end, Math.ceil(range.end + span * 0.5));
    const qPix = full ? pixelWidth : Math.max(1, Math.round(pixelWidth * (qEnd - qStart) / span));
    for (const t of selectedTracks()) {
      const cap = caps.get(t.slot);
      const cover = queriedBySlot.get(t.slot);
      const cached = results.get(t.slot);
      if (cap?.indexState === 'complete' && cover && cached
        && cover.axis === prefs.axis && cover.windowUs === prefs.windowUs && cover.offsetUs === t.offsetUs
        && cover.start <= qStart && cover.end >= qEnd && Math.abs(cover.pixelWidth - qPix) / qPix < 0.25
        && cached.indexRevision === cover.revision) {
        continue; // 已覆盖：只重绘，不发查询
      }
      abortBySlot.get(t.slot)?.abort();
      const controller = new AbortController();
      abortBySlot.set(t.slot, controller);
      const mySeq = ++panelSeq;
      seqBySlot.set(t.slot, mySeq);
      const mediaId = t.mediaId;
      const queryStart = performance.now();
      canvas.dataset.analysisQueries = String((Number(canvas.dataset.analysisQueries ?? 0) || 0) + 1);
      session.queryAnalysis(t.slot, {
        startUs: Math.floor(qStart), endUs: Math.ceil(qEnd),
        axis: prefs.axis, pixelWidth: qPix, bitrateWindowUs: prefs.windowUs, maxSamples: MAX_SAMPLES,
        signal: controller.signal,
      }).then(result => {
        if (abortBySlot.get(t.slot) === controller) abortBySlot.delete(t.slot);
        if (signal.aborted || seqBySlot.get(t.slot) !== mySeq) return; // 旧结果不覆盖新图
        const current = tracks.find(e => e.slot === t.slot);
        if (!current || current.mediaId !== mediaId) return; // 换片后旧结果丢弃
        results.set(t.slot, result);
        // 只有完整索引的结果才建立覆盖：构建中的空/稀疏结果不得缓存覆盖，
        // 否则索引完成后 revision 对比的是快照自身，永远跳过重查。
        if (result.capability?.indexState === 'complete') {
          queriedBySlot.set(t.slot, {
            start: qStart, end: qEnd, axis: prefs.axis, windowUs: prefs.windowUs,
            pixelWidth: qPix, offsetUs: t.offsetUs, revision: result.indexRevision,
          });
        } else {
          queriedBySlot.delete(t.slot);
        }
        canvas.dataset.analysisQueryMs = (performance.now() - queryStart).toFixed(1);
        render();
      }).catch(error => {
        if (abortBySlot.get(t.slot) === controller) abortBySlot.delete(t.slot);
        if (signal.aborted || seqBySlot.get(t.slot) !== mySeq) return;
        if (error instanceof Error && error.name === 'AbortError') return;
        status.textContent = `轨道 ${t.slot} 查询失败：${error instanceof Error ? error.message : String(error)}`;
      });
    }
    render();
  }

  // ---- 绘制 ----
  function buildModel(): CanvasModel | null {
    const sel = selectedTracks();
    if (!sel.length) return null;
    const range = viewRange();
    const inView = (t: number) => t >= range.start && t <= range.end;
    const width = Math.max(1, Math.floor(body.clientWidth));
    const pairs = computePairs();
    const paired = pairs != null;
    const canvasTracks: CanvasTrack[] = [];
    // 纵轴按视口内数据取最大（查询含预取 margin，视口外峰值不参与），
    // 跨轨共享同一范围；平移时轴只在跨过取整档位时变化。
    let yMaxBitrate = 0, yMaxSize = 0;
    for (const t of sel) {
      const r = results.get(t.slot);
      if (!r) continue;
      const detailed = !r.truncated && r.samples.length > 0;
      const samples = detailed ? r.samples.map(s => {
        const axisT = prefs.axis === 'pts' ? s.effectivePtsUs : s.dtsUs;
        return {
          t: axisT ?? 0,
          size: s.sizeBytes ?? 0,
          key: s.randomAccess === 'yes' ? true : s.randomAccess === 'no' ? false : null,
          ...(paired && pairs!.gx.get(s.sampleId) !== undefined ? { gx: pairs!.gx.get(s.sampleId)! } : {}),
        };
      }) : null;
      if (samples) for (const s of samples) if (inView(s.t)) yMaxSize = Math.max(yMaxSize, s.size);
      for (const b of r.buckets ?? []) {
        if (b.endUs <= range.start || b.startUs >= range.end || !b.count) continue;
        yMaxSize = Math.max(yMaxSize, b.maxBytes);
      }
      for (const p of r.bitrate ?? []) {
        if (p.mbps != null && p.tUs >= range.start && p.tUs <= range.end) yMaxBitrate = Math.max(yMaxBitrate, p.mbps);
      }
      canvasTracks.push({
        slot: t.slot,
        color: slotColors.get(t.slot) ?? '#888',
        samples, truncated: r.truncated,
        buckets: (r.buckets ?? []).map(b => ({ ...b })),
        bitrate: (r.bitrate ?? []).map(p => ({ t: p.tUs, mbps: p.mbps })),
        provisional: r.capability.indexState !== 'complete',
      });
    }
    if (!canvasTracks.length) return null;
    const rows = prefs.showSize ? (paired ? 1 : canvasTracks.length) : 0;
    const need = desiredHeight(prefs.showBitrate, rows);
    const height = Math.max(body.clientHeight || 220, need);
    return {
      width, height,
      viewStart: range.start, viewEnd: Math.max(range.start + 1, range.end),
      showBitrate: prefs.showBitrate, showSize: prefs.showSize, colorByType: prefs.colorByType,
      tracks: canvasTracks, paired,
      yMaxBitrate: niceCeiling(yMaxBitrate), yMaxSize: niceCeiling(yMaxSize),
      colors, rubber,
    };
  }

  function computePairs(): { gx: Map<string, number> } | null {
    if (prefs.layoutMode === 'rows') return null;
    const sel = selectedTracks();
    if (sel.length !== 2) return prefs.layoutMode === 'paired' ? { gx: new Map() } : null;
    const [ra, rb] = [results.get(sel[0].slot), results.get(sel[1].slot)];
    if (!ra || !rb || ra.truncated || rb.truncated || !ra.samples.length || !rb.samples.length) return null;
    const ta = axisTimes(ra), tb = axisTimes(rb);
    const { pairs } = matchPairsStrict(ta, tb, PAIR_TOLERANCE_US);
    const coverage = pairs.length / Math.max(1, Math.min(ta.length, tb.length));
    const maxDt = pairs.reduce((m, p) => Math.max(m, Math.abs(p.dtUs)), 0);
    const layout = decideLayout({ trackCount: 2, pairCoverage: coverage, maxAbsDtUs: maxDt, toleranceUs: PAIR_TOLERANCE_US });
    if (prefs.layoutMode === 'auto' && layout !== 'paired') {
      pairNote = `无法一一配对（覆盖率 ${Math.round(coverage * 100)}%），已分行显示`;
      return null;
    }
    const gx = new Map<string, number>();
    const sa = ra.samples, sb = rb.samples;
    pairs.forEach((p, i) => {
      void i;
      const g = ((ta[p.a] + tb[p.b]) / 2);
      gx.set(sa[p.a].sampleId, g);
      gx.set(sb[p.b].sampleId, g);
    });
    pairNote = `并排配对 ±${PAIR_TOLERANCE_US / 1000}ms · 覆盖率 ${Math.round(coverage * 100)}%`;
    return { gx };
  }

  let pairNote = '';

  const axisTimes = (r: AnalysisResult) => {
    const arr = new Float64Array(r.samples.length);
    r.samples.forEach((s, i) => { arr[i] = (prefs.axis === 'pts' ? s.effectivePtsUs : s.dtsUs) ?? Number.NaN; });
    return arr;
  };

  function render() {
    pairNote = '';
    window.clearTimeout(buildingTimer);
    if (!open || !ctx) return;
    const renderStart = performance.now();
    const model = buildModel();
    const builtMs = performance.now() - renderStart;
    const sel = selectedTracks();
    const states = sel.map(t => {
      const cap = caps.get(t.slot);
      if (!cap) return `${t.slot}…`;
      if (!cap.hasSize) return `${t.slot}不支持`;
      return `${t.slot}${cap.indexState === 'complete' ? '' : cap.indexState === 'building' ? '索引中' : '索引错'}`;
    });
    const unsupported = sel.filter(t => caps.get(t.slot) && !caps.get(t.slot)!.hasSize);
    status.textContent = [
      prefs.axis.toUpperCase(),
      `${prefs.windowUs >= 1_000_000 ? `${prefs.windowUs / 1_000_000}s` : `${prefs.windowUs / 1000}ms`}滑窗`,
      pairNote,
      states.join(' · '),
      unsupported.length ? `（${unsupported.map(t => t.slot).join('、')}：${caps.get(unsupported[0].slot)?.note ?? '暂不支持'}）` : '',
    ].filter(Boolean).join(' ｜ ');
    pairNote = '';
    if (!model) {
      canvas.hidden = true;
      emptyEl.hidden = false;
      emptyEl.textContent = !tracks.length ? '尚未载入视频。载入后可在此检查码率与帧大小走向。'
        : !sel.length ? '已全部隐藏，请在工具条中选择要对比的轨道。'
        : '正在查询统计…';
      playheadEl.hidden = true;
      hoverEl.hidden = true;
      tooltip.hidden = true;
      lastModel = null;
      lastGeom = null;
      lastViewSig = '';
      return;
    }
    canvas.hidden = false;
    emptyEl.hidden = true;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const cssH = Math.max(80, model.height);
    canvas.style.height = `${cssH}px`;
    const w = Math.round(model.width * dpr), h = Math.round(cssH * dpr);
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
    const drawn: CanvasModel = { ...model, height: cssH };
    drawAnalysis(ctx!, drawn);
    // 只读 QA 证据（对齐 pixel-grid 的 dataset 计数），不作可见计数器。
    canvas.dataset.analysisDrawMs = (performance.now() - renderStart).toFixed(2);
    canvas.dataset.analysisBuiltMs = builtMs.toFixed(2);
    lastModel = drawn;
    const geom = computeLayout(drawn);
    lastGeom = { gutter: geom.gutter, plotW: geom.plotW, width: drawn.width };
    positionPlayhead();
    if (hoverUs != null) positionHover();
    // 视图变化后把检查点重锚到光标（滚轮/捏合只动视图，不产生 pointermove），
    // 不展示过期内容；键盘检查中不抢夺焦点位置。
    const viewSig = `${drawn.viewStart}:${drawn.viewEnd}`;
    if (!tooltip.hidden && !kbInspect && hoverUs != null && lastClient) {
      if (viewSig !== lastViewSig) {
        hoverUs = Math.round(tOf(drawn, geom, lastClient.x - canvas.getBoundingClientRect().left));
        const range = viewRange();
        if (hoverUs < range.start || hoverUs > range.end) {
          hoverUs = null;
          hoverEl.hidden = true;
          tooltip.hidden = true;
        }
      }
      if (hoverUs != null) { positionHover(); updateTooltip(lastClient.x, lastClient.y); }
    }
    lastViewSig = viewSig;
    // 索引构建中渐进重查（仅面板打开时）；完成后自动停止。
    if (selectedTracks().some(t => caps.get(t.slot)?.indexState === 'building')) {
      buildingTimer = window.setTimeout(() => {
        if (open && !signal.aborted) void refresh();
      }, 1000);
    }
  }

  const fracToPx = (t: number) => {
    const g = lastGeom ?? plotGeometry(body.clientWidth);
    const v = lastModel ? { start: lastModel.viewStart, end: lastModel.viewEnd } : viewRange();
    const span = Math.max(1, v.end - v.start);
    return g.gutter + ((t - v.start) / span) * g.plotW;
  };

  function positionPlayhead() {
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

  // ---- 悬停/tooltip ----
  interface Hit { slot: Slot; sampleIndex: number | null; bucketIndex: number | null; t: number; pending?: boolean }
  /** 有序样本的中位间隔，用于吸附阈值（CFR 下约等于帧间隔，VFR 空洞不误吸）。 */
  function medianGapUs(times: number[]): number {
    if (times.length < 3) return 0;
    const gaps: number[] = [];
    for (let i = 1; i < times.length; i++) {
      const d = times[i] - times[i - 1];
      if (d > 0 && Number.isFinite(d)) gaps.push(d);
    }
    if (!gaps.length) return 0;
    gaps.sort((a, b) => a - b);
    return gaps[Math.floor(gaps.length / 2)];
  }
  function hitAt(t: number): Hit[] {
    const hits: Hit[] = [];
    const range = viewRange();
    const pxPerUs = lastGeom ? lastGeom.plotW / Math.max(1, range.end - range.start) : 0;
    const px4 = 4 / Math.max(1e-9, pxPerUs);
    for (const track of selectedTracks()) {
      const r = results.get(track.slot);
      if (!r) {
        hits.push({ slot: track.slot, sampleIndex: null, bucketIndex: null, t, pending: true });
        continue;
      }
      if (!r.truncated && r.samples.length) {
        const axisOf = (i: number) => (prefs.axis === 'pts' ? r.samples[i].effectivePtsUs : r.samples[i].dtsUs) ?? Infinity;
        let best = -1, bestDt = Infinity;
        // 样本按轴有序（后端保证），线性/二分均可；窗口内数量有界，直接遍历。
        for (let i = 0; i < r.samples.length; i++) {
          const dt = Math.abs(axisOf(i) - t);
          if (dt < bestDt) { bestDt = dt; best = i; }
        }
        const snap = Math.max(500, px4, medianGapUs(r.samples.map((_, i) => axisOf(i)).filter(Number.isFinite)) * 0.6);
        if (best >= 0 && bestDt <= snap) {
          hits.push({ slot: track.slot, sampleIndex: best, bucketIndex: null, t });
          continue;
        }
      }
      const bi = (r.buckets ?? []).findIndex(b => b.count > 0 && t >= b.startUs && t < b.endUs);
      hits.push({ slot: track.slot, sampleIndex: null, bucketIndex: bi >= 0 ? bi : null, t });
    }
    return hits;
  }

  function sizeText(bytes: number): string {
    return `${(bytes / 1024).toFixed(1)} KiB (${bytes} B)`;
  }

  function updateTooltip(clientX: number, clientY: number) {
    if (hoverUs == null) { tooltip.hidden = true; return; }
    const hits = hitAt(hoverUs);
    if (!hits.length) { tooltip.hidden = true; return; }
    const rows: string[] = [];
    rows.push(`<div class="tt-head">${formatAxis(hoverUs)} ｜ ${prefs.axis.toUpperCase()} ｜ ${prefs.windowUs / 1000}ms滑窗</div>`);
    for (const hit of hits) {
      const r = results.get(hit.slot);
      const color = slotColors.get(hit.slot) ?? '#888';
      if (hit.pending || !r) {
        rows.push(`<div class="tt-row"><span class="dot" style="background:${color}"></span><span><b>${hit.slot}</b> 正在查询统计…</span></div>`);
        continue;
      }
      if (hit.sampleIndex != null) {
        const s = r.samples[hit.sampleIndex];
        const keyText = s.randomAccess === 'yes' ? '关键' : s.randomAccess === 'no' ? '非关键' : '未知';
        const rate = rateAt(r, hoverUs);
        rows.push(`<div class="tt-row"><span class="dot" style="background:${color}"></span><span><b>${hit.slot}</b> ${s.sizeBytes != null ? sizeText(s.sizeBytes) : '大小未知'} · ${keyText}（容器标记）${rate != null ? ` · ${rate.toFixed(2)} Mbps` : ''}</span></div>`);
        const parts = [
          `样本 ${s.decodeOrdinal}`,
          s.containerPtsUs != null ? `原始PTS ${formatTime(Math.max(0, s.containerPtsUs))}` : '',
          s.effectivePtsUs != null ? `展示PTS ${formatAxis(s.effectivePtsUs)}` : '',
          s.dtsUs != null ? `DTS ${formatAxis(s.dtsUs)}` : '',
        ].filter(Boolean).join(' ｜ ');
        rows.push(`<div class="tt-row tt-note"><span>${parts}</span></div>`);
      } else if (hit.bucketIndex != null) {
        const b = r.buckets![hit.bucketIndex];
        const rate = rateAt(r, hoverUs);
        rows.push(`<div class="tt-row"><span class="dot" style="background:${color}"></span><span><b>${hit.slot}</b> 区间统计：${b.count} 样本 · 共 ${(b.sumBytes / 1024).toFixed(1)} KiB · 峰值 ${sizeText(b.maxBytes)}</span></div>`);
        rows.push(`<div class="tt-row tt-note"><span>${formatAxis(b.startUs)}–${formatAxis(b.endUs)} ｜ 关键${b.keyCount}/非关键${b.deltaCount}/未知${b.unknownCount}${b.complete ? '' : ' ｜ 暂定'}${rate != null ? ` ｜ ${rate.toFixed(2)} Mbps` : ''}</span></div>`);
      } else {
        rows.push(`<div class="tt-row"><span class="dot" style="background:${color}"></span><span><b>${hit.slot}</b> 该区间无覆盖</span></div>`);
      }
    }
    if (rProvisional()) rows.push('<div class="tt-row tt-note"><span>索引构建中，数值为暂定。</span></div>');
    tooltip.innerHTML = rows.join('');
    tooltip.hidden = false;
    const rect = body.getBoundingClientRect();
    const x = Math.min(Math.max(0, clientX - rect.left + 14), Math.max(0, rect.width - 200));
    const y = Math.min(Math.max(0, clientY - rect.top + 14), Math.max(0, rect.height - 80));
    tooltip.style.left = `${x + body.scrollLeft}px`;
    tooltip.style.top = `${y + body.scrollTop}px`;
    live.textContent = tooltip.textContent ?? '';
  }

  const rProvisional = () => selectedTracks().some(t => {
    const r = results.get(t.slot);
    return r ? r.capability.indexState !== 'complete' : true;
  });

  function rateAt(r: AnalysisResult, t: number): number | null {
    const pts = r.bitrate ?? [];
    let best: number | null = null, bestDt = Infinity;
    for (const p of pts) {
      const dt = Math.abs(p.tUs - t);
      if (dt < bestDt) { bestDt = dt; best = p.mbps; }
    }
    return best;
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
    const g = plotGeometry(body.clientWidth);
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
    const t = canvasT(event.clientX);
    if (hoverRaf) return;
    hoverRaf = requestAnimationFrame(() => {
      hoverRaf = 0;
      if (signal.aborted) return;
      hoverUs = Math.round(t);
      kbInspect = false;
      lastClient = { x: event.clientX, y: event.clientY };
      positionHover();
      updateTooltip(event.clientX, event.clientY);
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
      return;
    }
    rubber = null;
    // 单击：精确柱定位到展示 PTS；聚合桶放大到该区间。
    const t = canvasT(event.clientX);
    const hits = hitAt(Math.round(t));
    const sampleHit = hits.find(h => h.sampleIndex != null);
    if (sampleHit) {
      const r = results.get(sampleHit.slot)!;
      const s = r.samples[sampleHit.sampleIndex!];
      const resolved = session.resolveAnalysisSeek(sampleHit.slot, { effectivePtsUs: s.effectivePtsUs });
      if ('sessionPtsUs' in resolved) {
        void act(() => session.seek(resolved.sessionPtsUs), 'analysis.seek', { slot: sampleHit.slot, ptsUs: resolved.sessionPtsUs });
      } else {
        status.textContent = `轨道 ${sampleHit.slot}：${resolved.reason}`;
        live.textContent = status.textContent;
      }
    } else {
      const bucketHit = hits.find(h => h.bucketIndex != null);
      if (bucketHit) {
        const r = results.get(bucketHit.slot)!;
        const b = r.buckets![bucketHit.bucketIndex!];
        if (b.count > 0) setView(Math.floor(b.startUs), Math.ceil(b.endUs), false);
      }
    }
    render();
  }, { signal });

  canvas.addEventListener('pointerleave', () => {
    if (pressX != null) return;
    hoverUs = null;
    kbInspect = false;
    hoverEl.hidden = true;
    tooltip.hidden = true;
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
      const px = (lastGeom && lastGeom.plotW > 0 ? lastGeom.plotW : plotGeometry(body.clientWidth).plotW) || 1;
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
    const step = Math.max(1, Math.floor((range.end - range.start) / 100));
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      const base = hoverUs ?? positionUs;
      hoverUs = Math.round(base + (event.key === 'ArrowRight' ? step : -step));
      kbInspect = true;
      positionHover();
      const rect = canvas.getBoundingClientRect();
      updateTooltip(rect.left + (lastGeom ? xOf(lastModel, {
        gutter: lastGeom.gutter, plotW: lastGeom.plotW,
      } as never, hoverUs) : 0), rect.top + 20);
    } else if (event.key === 'Enter' && hoverUs != null) {
      event.preventDefault();
      const hits = hitAt(hoverUs);
      const sampleHit = hits.find(h => h.sampleIndex != null);
      if (sampleHit) {
        const r = results.get(sampleHit.slot)!;
        const s = r.samples[sampleHit.sampleIndex!];
        const resolved = session.resolveAnalysisSeek(sampleHit.slot, { effectivePtsUs: s.effectivePtsUs });
        if ('sessionPtsUs' in resolved) void act(() => session.seek(resolved.sessionPtsUs), 'analysis.seek', {});
        else { status.textContent = resolved.reason; live.textContent = resolved.reason; }
      }
    } else if (event.key === 'Escape') {
      hoverUs = null; rubber = null; kbInspect = false;
      hoverEl.hidden = true; tooltip.hidden = true;
      render();
    }
  }, { signal });

  // ---- 会话联动（开关与高度由 workbench 统一管理） ----
  function setOpen(next: boolean) {
    if (open === next) return;
    open = next;
    render();
    if (open) { refreshTools(); scheduleQuery(true); }
    else {
      for (const c of abortBySlot.values()) c.abort();
      abortBySlot.clear();
      window.clearTimeout(buildingTimer);
    }
  }

  const onSession = () => {
    if (signal.aborted) return;
    const state = session.getState();
    positionUs = state.positionUs;
    durationUs = state.durationUs;
    const entries: TrackEntry[] = state.tracks.map(t => ({
      slot: t.slot as Slot, mediaId: t.id as string, offsetUs: t.offsetUs as number,
      durationUs: t.durationUs as number, name: (t.name as string) ?? '',
    }));
    const sig = JSON.stringify(entries.map(e => [e.slot, e.mediaId, e.offsetUs, e.durationUs]));
    if (sig !== trackSig) {
      trackSig = sig;
      tracks = entries;
      // 新轨道默认加入对比；已移除轨道清理选择与缓存。
      for (const e of entries) if (!prefs.selected.includes(e.slot)) prefs.selected.push(e.slot);
      prefs.selected = prefs.selected.filter(s => entries.some(e => e.slot === s));
      for (const slot of [...results.keys()]) {
        const entry = entries.find(e => e.slot === slot);
        if (!entry || results.get(slot)?.sourceVersion.split('@')[0] !== entry.mediaId) {
          results.delete(slot);
          queriedBySlot.delete(slot);
        }
      }
      caps = new Map(session.getAnalysisCapabilities().map(c => [c.slot as Slot, c.capability]));
      if (prefs.axis === 'dts' && !allHaveDts()) prefs.axis = 'pts';
      save();
      refreshTools();
      scheduleQuery(true);
    } else {
      // 索引构建会改变 duration 与能力，轻量跟进。
      const nextCaps = new Map(session.getAnalysisCapabilities().map(c => [c.slot as Slot, c.capability]));
      const capSig = JSON.stringify([...nextCaps].map(([s, c]) => [s, c.indexState]));
      const prevSig = JSON.stringify([...caps].map(([s, c]) => [s, c.indexState]));
      if (capSig !== prevSig) {
        caps = nextCaps;
        refreshTools();
        scheduleQuery(true);
      }
      positionPlayhead();
    }
  };

  const onProgress = (pos: number) => {
    positionUs = pos;
    if (open) positionPlayhead(); // 只移动标记，不重算整张图
  };

  const offSession = session.subscribe(onSession);
  const offProgress = session.subscribeProgress(onProgress);

  const resizer_obs = new ResizeObserver(() => {
    if (!open) return;
    render();
    scheduleQuery();
  });
  resizer_obs.observe(body);

  const themeChanges = new MutationObserver(() => { readColors(); render(); });
  themeChanges.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] });

  refreshTools();
  onSession();
  render();

  signal.addEventListener('abort', () => {
    window.clearTimeout(queryTimer);
    window.clearTimeout(buildingTimer);
    if (hoverRaf) cancelAnimationFrame(hoverRaf);
    if (viewRaf) cancelAnimationFrame(viewRaf);
    offSession();
    offProgress();
    resizer_obs.disconnect();
    themeChanges.disconnect();
    for (const c of abortBySlot.values()) c.abort();
    axisMenu.dispose();
    windowMenu.dispose();
    layoutMenu.dispose();
  }, { once: true });

  return { setOpen };
}
