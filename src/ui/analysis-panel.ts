// 顶部码流分析面板：工具条 + Canvas + 覆盖层 + 会话共用查询。
// 数据全部走 ReviewSession.queryAnalysis（与 Agent 同一入口）；悬停只读
// 索引，不解码、不 seek；单击可显示帧经 resolveAnalysisSeek 定位到展示 PTS。
// 面板开关与高度由 workbench 统一管理（右上功能区、拖拽手势与子轨道同契约）；
// 本模块只负责内容、查询与绘制。下拉全部使用项目 choice-menu 控件。

import { SLOTS } from '../model.ts';
import type { Slot } from '../model.ts';
import type { ReviewSession } from '../session.ts';
import type { AnalysisCapability, AnalysisResult } from '../analysis/types.ts';
import { BITRATE_WINDOW_OPTIONS_US, DEFAULT_BITRATE_WINDOW_US, niceCeiling, shouldBucketize } from '../analysis/statistics.ts';
import { matchPairsStrict, panTimeRange, zoomTimeRange } from '../analysis/projection.ts';
import { correspondenceCoverage, groupSamples } from '../analysis/grouping.ts';
import type { GroupSampleRef, TimeGroup } from '../analysis/grouping.ts';
import { bucketWidthFor, canSatisfy, clampPixelWidth } from '../analysis/view-cache.ts';
import type { ViewCacheEntry } from '../analysis/view-cache.ts';
import { layoutMergedBuckets, layoutMergedSamples, pickGlyph } from './analysis-geometry.ts';
import type { AnalysisGlyph, BucketGlyph, SampleGlyph } from './analysis-geometry.ts';
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
const GROUP_TOLERANCE_US = 2000;
const MAX_SAMPLES = 5000;
const MIN_SPAN_US = 10_000;

const WINDOW_LABELS: Record<number, string> = Object.fromEntries(
  BITRATE_WINDOW_OPTIONS_US.map(w => [w, w >= 1_000_000 ? `${w / 1_000_000}s` : `${w / 1000}ms`]),
);
// 合并为默认：同一基线按时间交错，不以严格配对为前提；分轨只作主动选择。
const LAYOUT_LABELS: Record<'merged' | 'rows', string> = { merged: '合并', rows: '分轨' };

interface Prefs {
  showBitrate: boolean; showSize: boolean; colorByType: boolean;
  axis: 'pts' | 'dts'; windowUs: number; layoutMode: 'merged' | 'rows';
  follow: boolean; selected: Slot[];
}

function migrateLayoutMode(raw: unknown): Prefs['layoutMode'] {
  // 旧偏好 auto/paired 一律迁到 merged，rows 保留。
  if (raw === 'rows') return 'rows';
  return 'merged';
}

function loadPrefs(): Prefs {
  const fallback: Prefs = {
    showBitrate: true, showSize: true, colorByType: true,
    axis: 'pts', windowUs: DEFAULT_BITRATE_WINDOW_US, layoutMode: 'merged',
    follow: true, selected: [],
  };
  try {
    const raw = localStorage.getItem(PREF_KEY);
    if (!raw) return fallback;
    const p = JSON.parse(raw) as Partial<Prefs> & { layoutMode?: unknown };
    return {
      ...fallback, ...p,
      axis: p.axis === 'dts' ? 'dts' : 'pts',
      windowUs: BITRATE_WINDOW_OPTIONS_US.includes(p.windowUs!) ? p.windowUs! : DEFAULT_BITRATE_WINDOW_US,
      layoutMode: migrateLayoutMode(p.layoutMode),
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
        <button type="button" id="analysis-layout" class="choice-trigger" aria-label="多轨布局" title="合并：多轨同一基线按时间交错；分轨：各轨独立行"></button>
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
  let kbTrack: Slot | null = null;
  let lastViewSig = '';
  let lastGlyphs: AnalysisGlyph[] = [];
  let lastGroups: TimeGroup[] = [];
  // 有序轴时间的派生缓存：数据/几何 revision 改变时计算一次，不在 pointermove 重建。
  const medianCache = new Map<string, number>();
  const axisCache = new Map<string, Float64Array>();

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
    (['merged', 'rows'] as const).map(v => ({ value: v, label: LAYOUT_LABELS[v] })), value => {
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

  /**
   * 每轨已查询覆盖（会话时间）+ 分辨率/细节级别：区间覆盖只是必要条件，
   * 粗桶不可满足更细请求；预取半屏不改变可见区的目标 LOD。
   */
  const queriedBySlot = new Map<Slot, ViewCacheEntry>();

  /** 估计新区间内的样本数（用已缓存的 raw 精确计数或桶 count 求和）。 */
  function estimateSamplesIn(slot: Slot, startUs: number, endUs: number): number | null {
    const r = results.get(slot);
    if (!r) return null;
    if (!r.truncated && r.samples.length) {
      let n = 0;
      for (const s of r.samples) {
        const t = prefs.axis === 'pts' ? s.effectivePtsUs : s.dtsUs;
        if (t != null && t >= startUs && t < endUs) n++;
      }
      return n;
    }
    if (r.buckets) {
      let n = 0;
      for (const b of r.buckets) {
        if (b.endUs <= startUs || b.startUs >= endUs || !b.count) continue;
        n += b.count;
      }
      return n;
    }
    return null;
  }

  async function refresh() {
    if (!open || signal.aborted) return;
    const range = viewRange();
    const pixelWidth = clampPixelWidth(Math.floor(body.clientWidth - 46));
    const span = Math.max(1, range.end - range.start);
    const db = domainBounds();
    // 预取半屏 margin：连续滚动落入缓存只重绘，不发查询；可见区密度与预取数量不混淆。
    const full = span >= db.end - db.start;
    const qStart = full ? range.start : Math.max(db.start, Math.floor(range.start - span * 0.5));
    const qEnd = full ? range.end : Math.min(db.end, Math.ceil(range.end + span * 0.5));
    // 大 CSS 宽度 + 预取 margin 不得产生 pixelWidth>4096 的查询异常。
    const qPix = clampPixelWidth(full ? pixelWidth : Math.round(pixelWidth * (qEnd - qStart) / span));
    const visibleBucketW = bucketWidthFor(range.start, range.end, pixelWidth);
    for (const t of selectedTracks()) {
      const cap = caps.get(t.slot);
      const cover = queriedBySlot.get(t.slot);
      const cached = results.get(t.slot);
      if (cap?.indexState === 'complete' && cover && cached
        && cached.indexRevision === cover.indexRevision
        && cached.sourceVersion === cover.sourceVersion) {
        // 可见区是否需要逐样本：用缓存估计密度，不只看点数。
        const estimated = estimateSamplesIn(t.slot, range.start, range.end);
        const needRaw = estimated == null ? false : !shouldBucketize(estimated, pixelWidth);
        const ok = canSatisfy(cover, {
          startUs: Math.floor(qStart), endUs: Math.ceil(qEnd),
          axis: prefs.axis, windowUs: prefs.windowUs, offsetUs: t.offsetUs,
          pixelWidth: qPix, needRaw, bucketWidthUs: bucketWidthFor(Math.floor(qStart), Math.ceil(qEnd), qPix),
        });
        // 可见区 LOD 也要满足：粗桶覆盖预取区不代表可见区够细。
        const visibleOk = !needRaw || cover.detailMode === 'raw';
        const densityOk = cover.detailMode === 'raw' || cover.bucketWidthUs <= visibleBucketW + 1;
        if (ok && visibleOk && densityOk) continue; // 已覆盖：只重绘，不发查询
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
        bucketOriginUs: 0,
        signal: controller.signal,
      }).then(result => {
        if (abortBySlot.get(t.slot) === controller) abortBySlot.delete(t.slot);
        if (signal.aborted || seqBySlot.get(t.slot) !== mySeq) return; // 旧结果不覆盖新图
        const current = tracks.find(e => e.slot === t.slot);
        if (!current || current.mediaId !== mediaId) return; // 换片后旧结果丢弃
        // 版本隔离：换片/同 slot 换媒体/重开解码路径后旧结果不得覆盖新图。
        const expectedPrefix = `${current.mediaId}:`;
        if (!result.sourceVersion.startsWith(expectedPrefix) && result.sourceVersion.split('@')[0] !== current.mediaId) return;
        results.set(t.slot, result);
        // 只有完整索引的结果才建立覆盖：构建中的空/稀疏结果不得缓存覆盖，
        // 否则索引完成后 revision 对比的是快照自身，永远跳过重查。
        if (result.capability?.indexState === 'complete') {
          const detailMode = !result.truncated && result.samples.length > 0 ? 'raw' : 'buckets';
          queriedBySlot.set(t.slot, {
            slot: t.slot, sourceVersion: result.sourceVersion, indexRevision: result.indexRevision,
            axis: result.axis, windowUs: prefs.windowUs,
            startUs: Math.floor(qStart), endUs: Math.ceil(qEnd),
            pixelWidth: qPix, offsetUs: t.offsetUs,
            detailMode, bucketWidthUs: bucketWidthFor(Math.floor(qStart), Math.ceil(qEnd), qPix),
            truncated: result.truncated, sampleCount: result.samples.length,
          });
          medianCache.delete(t.slot);
          axisCache.delete(t.slot);
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

  // ---- 绘制：时间分组 → 统一几何 → 绘图与命中共用 ----
  let layoutNote = '';

  const axisTimes = (r: AnalysisResult) => {
    const arr = new Float64Array(r.samples.length);
    r.samples.forEach((s, i) => { arr[i] = (prefs.axis === 'pts' ? s.effectivePtsUs : s.dtsUs) ?? Number.NaN; });
    return arr;
  };

  /** 严格对应统计：只用于状态/tooltip，不控制是否合并。 */
  function correspondenceNote(): string {
    const sel = selectedTracks();
    if (sel.length !== 2) return '';
    const [ra, rb] = [results.get(sel[0].slot), results.get(sel[1].slot)];
    if (!ra || !rb || ra.truncated || rb.truncated || !ra.samples.length || !rb.samples.length) return '';
    const ta = axisTimes(ra), tb = axisTimes(rb);
    const { pairs, unmatchedA, unmatchedB } = matchPairsStrict(ta, tb, GROUP_TOLERANCE_US);
    const { coverageA, coverageB } = correspondenceCoverage(pairs.length, ta.length, tb.length);
    const maxDt = pairs.reduce((m, p) => Math.max(m, Math.abs(p.dtUs)), 0);
    return `对应 ±${GROUP_TOLERANCE_US / 1000}ms · A${Math.round(coverageA * 100)}%/B${Math.round(coverageB * 100)}%` +
      (unmatchedA.length || unmatchedB.length ? ` · 未对应 A${unmatchedA.length}/B${unmatchedB.length}` : '') +
      (pairs.length ? ` · 最大差 ${Math.round(maxDt)}us` : '');
  }

  function buildModel(): (CanvasModel & { glyphs: AnalysisGlyph[]; groups: TimeGroup[] }) | null {
    const sel = selectedTracks();
    if (!sel.length) return null;
    const range = viewRange();
    const inView = (t: number) => t >= range.start && t <= range.end;
    const width = Math.max(1, Math.floor(body.clientWidth));
    const merged = prefs.layoutMode === 'merged';
    const plotW = Math.max(1, width - 46);
    // LOD：最终柱宽决定 raw 是否可用（目标 ≥2.5px/样本），初版全图统一 LOD。
    // 逐样本可用当且仅当全部选中轨都有完整 raw；否则用共享桶，仍保持合并。
    // 计数只看视口内（查询含预取 margin，视口外不参与），放大后可从桶切回 raw。
    let totalRawInView = 0;
    let allRaw = true;
    for (const t of sel) {
      const r = results.get(t.slot);
      if (!r || r.truncated || !r.samples.length) { allRaw = false; break; }
      let n = 0;
      for (const s of r.samples) {
        const axisT = prefs.axis === 'pts' ? s.effectivePtsUs : s.dtsUs;
        if (axisT != null && axisT >= range.start && axisT <= range.end) n++;
      }
      totalRawInView += n;
    }
    // 视口内无样本时不断言 raw 可用，走桶/空态，避免 0 样本误判为稀疏。
    const useRaw = allRaw && totalRawInView > 0 && !shouldBucketize(totalRawInView, plotW, 2.5);
    const canvasTracks: CanvasTrack[] = [];
    // 纵轴按视口内数据取最大（查询含预取 margin，视口外峰值不参与），
    // 同一指标跨轨共用零起点和纵轴范围。
    let yMaxBitrate = 0, yMaxSize = 0;
    // 分组输入：投影到公共会话时间域的真实样本，保留身份与可信展示 PTS。
    const groupInputs: { slot: Slot; samples: GroupSampleRef[] }[] = [];
    for (const t of sel) {
      const r = results.get(t.slot);
      if (!r) continue;
      const canvasSamples = (useRaw && !r.truncated && r.samples.length)
        ? r.samples.map(s => {
          const axisT = prefs.axis === 'pts' ? s.effectivePtsUs : s.dtsUs;
          return {
            t: axisT ?? Number.NaN,
            size: s.sizeBytes ?? 0,
            key: s.randomAccess === 'yes' ? true : s.randomAccess === 'no' ? false : null,
          };
        }).filter(s => Number.isFinite(s.t)) : null;
      if (canvasSamples) for (const s of canvasSamples) if (inView(s.t)) yMaxSize = Math.max(yMaxSize, s.size);
      for (const b of r.buckets ?? []) {
        if (b.endUs <= range.start || b.startUs >= range.end || !b.count) continue;
        // raw 可用时纵轴仍以视口内 raw 为主，桶仅作兜底；桶模式下用峰值。
        if (!useRaw) yMaxSize = Math.max(yMaxSize, b.maxBytes);
        else if (!canvasSamples) yMaxSize = Math.max(yMaxSize, b.maxBytes);
      }
      if (useRaw && canvasSamples) {
        // raw 模式下桶不参与纵轴，避免预取桶的视口外峰值抬高轴。
      } else if (!useRaw) {
        // 桶模式已在上面统计。
      }
      for (const p of r.bitrate ?? []) {
        if (p.mbps != null && p.tUs >= range.start && p.tUs <= range.end) yMaxBitrate = Math.max(yMaxBitrate, p.mbps);
      }
      canvasTracks.push({
        slot: t.slot,
        color: slotColors.get(t.slot) ?? '#888',
        samples: canvasSamples, truncated: useRaw ? false : true,
        buckets: (r.buckets ?? []).map(b => ({ ...b })),
        bitrate: (r.bitrate ?? []).map(p => ({ t: p.tUs, mbps: p.mbps })),
        provisional: r.capability.indexState !== 'complete',
      });
      if (useRaw && !r.truncated) {
        const refs: GroupSampleRef[] = [];
        // 分组只取视口 + 容差 halo，避免视口裁切改变边缘组组成，也避免长片全量分组。
        const halo = GROUP_TOLERANCE_US + 1000;
        for (const s of r.samples) {
          const axisT = prefs.axis === 'pts' ? s.effectivePtsUs : s.dtsUs;
          if (axisT == null || !Number.isFinite(axisT)) continue;
          if (axisT < range.start - halo || axisT > range.end + halo) continue;
          refs.push({
            sampleId: s.sampleId, axisUs: axisT, sessionPtsUs: s.effectivePtsUs,
            sizeBytes: s.sizeBytes,
            key: s.randomAccess === 'yes' ? true : s.randomAccess === 'no' ? false : null,
            decodeOrdinal: s.decodeOrdinal, mediaId: t.mediaId,
            sourceVersion: r.sourceVersion, indexRevision: r.indexRevision,
          });
        }
        groupInputs.push({ slot: t.slot, samples: refs });
      }
    }
    if (!canvasTracks.length) return null;
    const groups: TimeGroup[] = useRaw ? groupSamples(groupInputs, GROUP_TOLERANCE_US) : [];
    layoutNote = merged
      ? (useRaw ? `合并 ${groups.length} 组` : '合并 · 区间峰值（共享桶）')
      : '分轨';
    const corr = correspondenceNote();
    if (corr) layoutNote += ` ｜ ${corr}`;
    const rows = prefs.showSize ? (merged ? 1 : canvasTracks.length) : 0;
    const need = desiredHeight(prefs.showBitrate, rows);
    const height = Math.max(body.clientHeight || 220, need);
    const viewEnd = Math.max(range.start + 1, range.end);
    // 统一几何：组宽来自公共时间组，缺席留空；绘图与命中共用。
    // 先算布局占位（行高），再生成 glyph。
    const axisY = height - 22;
    const plotH = Math.max(0, axisY);
    let bitrateH = 0;
    if (prefs.showBitrate) {
      bitrateH = rows ? Math.round(plotH * 0.42) : plotH;
      bitrateH = Math.max(rows ? 48 : 0, Math.min(bitrateH, 140));
    }
    const sizeH = rows ? Math.max(0, plotH - bitrateH) : 0;
    const perRow = rows ? sizeH / rows : 0;
    const yMaxSizeNice = niceCeiling(yMaxSize);
    let sampleGlyphs: SampleGlyph[] = [];
    let bucketGlyphs: BucketGlyph[] = [];
    const mediaBySlot = new Map<Slot, { mediaId: string; sourceVersion: string; indexRevision: number }>(
      sel.map(t => {
        const r = results.get(t.slot);
        return [t.slot, {
          mediaId: t.mediaId,
          sourceVersion: r?.sourceVersion ?? `${t.mediaId}@0`,
          indexRevision: r?.indexRevision ?? 0,
        }] as const;
      }),
    );
    if (prefs.showSize && rows) {
      if (merged) {
        const rowY = bitrateH, rowH = perRow;
        if (useRaw) {
          sampleGlyphs = layoutMergedSamples(groups, {
            trackOrder: sel.map(t => t.slot),
            viewStart: range.start, viewEnd,
            gutter: 46, plotW, rowY, rowH, yMaxSize: yMaxSizeNice, mediaBySlot,
          });
        } else {
          // 多轨密集时选更粗的桶，保证每组仍有位置画不同轨道，不压成同一像素。
          const lanes = Math.max(1, sel.length);
          const span = Math.max(1, viewEnd - range.start);
          const coarsen = (() => {
            const first = sel.map(t => results.get(t.slot)?.buckets?.find(b => b.count > 0)).find(Boolean);
            if (!first) return 1;
            const w = Math.max(1, first.endUs - first.startUs);
            const bucketPx = (w / span) * plotW;
            const laneW = bucketPx / lanes;
            return laneW >= 2 ? 1 : Math.max(1, Math.ceil((2 * lanes) / Math.max(0.5, bucketPx)));
          })();
          const bucketsBySlot = new Map<Slot, { slot: Slot; bucketIndex: number; startUs: number; endUs: number; count: number; maxBytes: number; sumBytes: number; keyCount: number; deltaCount: number; unknownCount: number; complete: boolean; maxSampleId: string | null }[]>();
          sel.forEach(t => {
            const r = results.get(t.slot);
            const raw = (r?.buckets ?? []).filter(b => b.count > 0 && b.endUs > range.start && b.startUs < viewEnd);
            if (coarsen <= 1) {
              bucketsBySlot.set(t.slot, raw.map((b, i) => ({
                slot: t.slot, bucketIndex: i, startUs: b.startUs, endUs: b.endUs,
                count: b.count, maxBytes: b.maxBytes, sumBytes: b.sumBytes,
                keyCount: b.keyCount, deltaCount: b.deltaCount, unknownCount: b.unknownCount,
                complete: b.complete, maxSampleId: b.maxSampleId,
              })));
            } else {
              // 同一起源的相邻桶正确合并：count/sum 累加，max 取最大，类型计数累加。
              const merged: typeof raw = [];
              for (let i = 0; i < raw.length; i += coarsen) {
                const chunk = raw.slice(i, i + coarsen);
                if (!chunk.length) continue;
                merged.push({
                  startUs: chunk[0].startUs, endUs: chunk[chunk.length - 1].endUs,
                  count: chunk.reduce((n, b) => n + b.count, 0),
                  sumBytes: chunk.reduce((n, b) => n + b.sumBytes, 0),
                  maxBytes: Math.max(...chunk.map(b => b.maxBytes)),
                  maxSampleId: chunk.reduce((best: string | null, b) => (b.maxBytes > (chunk.find(c => c.maxSampleId === best)?.maxBytes ?? -1) ? b.maxSampleId : best), chunk[0].maxSampleId),
                  keyCount: chunk.reduce((n, b) => n + b.keyCount, 0),
                  deltaCount: chunk.reduce((n, b) => n + b.deltaCount, 0),
                  unknownCount: chunk.reduce((n, b) => n + b.unknownCount, 0),
                  complete: chunk.every(b => b.complete),
                });
              }
              bucketsBySlot.set(t.slot, merged.map((b, i) => ({
                slot: t.slot, bucketIndex: i, startUs: b.startUs, endUs: b.endUs,
                count: b.count, maxBytes: b.maxBytes, sumBytes: b.sumBytes,
                keyCount: b.keyCount, deltaCount: b.deltaCount, unknownCount: b.unknownCount,
                complete: b.complete, maxSampleId: b.maxSampleId,
              })));
            }
          });
          bucketGlyphs = layoutMergedBuckets(bucketsBySlot, {
            trackOrder: sel.map(t => t.slot),
            viewStart: range.start, viewEnd, gutter: 46, plotW, rowY, rowH, yMaxSize: yMaxSizeNice,
          });
        }
      } else {
        // 分轨：同一套时间分组，各轨在各自行里，x 仍共享时间轴。
        sel.forEach((t, i) => {
          const rowY = bitrateH + i * perRow, rowH = perRow;
          if (useRaw) {
            // 分轨仍用公共时间组锚点计算单元，保证跨轨 x 对齐，各轨只取自己的成员。
            sampleGlyphs.push(...layoutMergedSamples(groups.filter(gr => gr.membersByTrack.has(t.slot)), {
              trackOrder: [t.slot],
              viewStart: range.start, viewEnd, gutter: 46, plotW, rowY, rowH, yMaxSize: yMaxSizeNice,
              mediaBySlot: new Map([[t.slot, mediaBySlot.get(t.slot)!]]),
            }));
          } else {
            const r = results.get(t.slot);
            const bucketsBySlot = new Map<Slot, { slot: Slot; bucketIndex: number; startUs: number; endUs: number; count: number; maxBytes: number; sumBytes: number; keyCount: number; deltaCount: number; unknownCount: number; complete: boolean; maxSampleId: string | null }[]>();
            bucketsBySlot.set(t.slot, (r?.buckets ?? []).map((b, i) => ({
              slot: t.slot, bucketIndex: i, startUs: b.startUs, endUs: b.endUs,
              count: b.count, maxBytes: b.maxBytes, sumBytes: b.sumBytes,
              keyCount: b.keyCount, deltaCount: b.deltaCount, unknownCount: b.unknownCount,
              complete: b.complete, maxSampleId: b.maxSampleId,
            })));
            bucketGlyphs.push(...layoutMergedBuckets(bucketsBySlot, {
              trackOrder: [t.slot],
              viewStart: range.start, viewEnd, gutter: 46, plotW, rowY, rowH, yMaxSize: yMaxSizeNice,
            }));
          }
        });
      }
    }
    return {
      width, height,
      viewStart: range.start, viewEnd,
      showBitrate: prefs.showBitrate, showSize: prefs.showSize, colorByType: prefs.colorByType,
      tracks: canvasTracks, merged,
      yMaxBitrate: niceCeiling(yMaxBitrate), yMaxSize: yMaxSizeNice,
      colors, rubber,
      sampleGlyphs, bucketGlyphs,
      glyphs: [...sampleGlyphs, ...bucketGlyphs] as AnalysisGlyph[],
      groups,
    };
  }

  function render() {
    layoutNote = '';
    window.clearTimeout(buildingTimer);
    if (!open || !ctx) return;
    const renderStart = performance.now();
    const model = buildModel();
    const builtMs = performance.now() - renderStart;
    const note = layoutNote;
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
      note,
      states.join(' · '),
      unsupported.length ? `（${unsupported.map(t => t.slot).join('、')}：${caps.get(unsupported[0].slot)?.note ?? '暂不支持'}）` : '',
    ].filter(Boolean).join(' ｜ ');
    layoutNote = '';
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
      lastGlyphs = [];
      lastGroups = [];
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
    lastGlyphs = (model as { glyphs?: AnalysisGlyph[] }).glyphs ?? [];
    lastGroups = (model as { groups?: TimeGroup[] }).groups ?? [];
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

  // ---- 悬停/tooltip：绘图与命中共用统一几何 ----
  /** 有序轴时间缓存（后端保证按轴有序），二分命中，不在 pointermove 重建。 */
  function axisArray(slot: Slot): Float64Array | null {
    const key = `${slot}:${prefs.axis}`;
    const cached = axisCache.get(key);
    const r = results.get(slot);
    if (!r || r.truncated || !r.samples.length) return null;
    // 结果对象不变时复用；换结果（引用变化）时重建。
    const sig = `${r.sourceVersion}:${r.indexRevision}:${r.samples.length}`;
    const sigKey = `${key}:${sig}`;
    const hit = axisCache.get(sigKey) as Float64Array | undefined;
    if (hit) return hit;
    const arr = new Float64Array(r.samples.length);
    for (let i = 0; i < r.samples.length; i++) {
      arr[i] = (prefs.axis === 'pts' ? r.samples[i].effectivePtsUs : r.samples[i].dtsUs) ?? Number.NaN;
    }
    axisCache.set(sigKey, arr);
    void cached;
    // 控制缓存规模：只保留最近 16 条轨道的轴数组。
    if (axisCache.size > 32) {
      const first = axisCache.keys().next().value;
      if (first) axisCache.delete(first);
    }
    return arr;
  }

  /** 有序样本的中位间隔，用于吸附阈值（CFR 下约等于帧间隔，VFR 空洞不误吸）。 */
  function medianGapCached(slot: Slot): number {
    const r = results.get(slot);
    if (!r) return 0;
    const key = `${slot}:${prefs.axis}:${r.sourceVersion}:${r.indexRevision}`;
    const hit = medianCache.get(key);
    if (hit != null) return hit;
    const arr = axisArray(slot);
    let median = 0;
    if (arr && arr.length >= 3) {
      const gaps: number[] = [];
      for (let i = 1; i < arr.length; i++) {
        const d = arr[i] - arr[i - 1];
        if (d > 0 && Number.isFinite(d)) gaps.push(d);
      }
      if (gaps.length) {
        gaps.sort((a, b) => a - b);
        median = gaps[Math.floor(gaps.length / 2)];
      }
    }
    medianCache.set(key, median);
    if (medianCache.size > 32) {
      const first = medianCache.keys().next().value;
      if (first) medianCache.delete(first);
    }
    return median;
  }

  function lowerBoundArr(arr: Float64Array, value: number): number {
    let lo = 0, hi = arr.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid] < value) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** 二分找最近样本（只读当前已知索引，不扫描全片、不重排）。 */
  function nearestSample(slot: Slot, t: number): { index: number; dt: number } | null {
    const arr = axisArray(slot);
    if (!arr || !arr.length) return null;
    const pos = lowerBoundArr(arr, t);
    let best = -1, bestDt = Infinity;
    for (const k of [pos - 1, pos]) {
      if (k < 0 || k >= arr.length || !Number.isFinite(arr[k])) continue;
      const dt = Math.abs(arr[k] - t);
      if (dt < bestDt) { bestDt = dt; best = k; }
    }
    return best >= 0 ? { index: best, dt: bestDt } : null;
  }

  /** 画布 CSS 坐标下的直接命中：返回唯一 glyph 身份。 */
  function pickAt(clientX: number, clientY: number): AnalysisGlyph | null {
    if (!lastGlyphs.length) return null;
    const rect = canvas.getBoundingClientRect();
    return pickGlyph(lastGlyphs, clientX - rect.left, clientY - rect.top);
  }

  function sizeText(bytes: number): string {
    return `${(bytes / 1024).toFixed(1)} KiB (${bytes} B)`;
  }

  function updateTooltip(clientX: number, clientY: number) {
    if (hoverUs == null) { tooltip.hidden = true; return; }
    const sel = selectedTracks();
    if (!sel.length) { tooltip.hidden = true; return; }
    const main = pickAt(clientX, clientY);
    const rows: string[] = [];
    rows.push(`<div class="tt-head">${formatAxis(hoverUs)} ｜ ${prefs.axis.toUpperCase()} ｜ ${prefs.windowUs / 1000}ms滑窗</div>`);
    if (main && main.kind === 'sample') {
      const g = main as SampleGlyph;
      const r = results.get(g.slot);
      const s = r?.samples.find(v => v.sampleId === g.sampleId);
      const color = slotColors.get(g.slot) ?? '#888';
      const keyText = s
        ? (s.randomAccess === 'yes' ? '关键' : s.randomAccess === 'no' ? '非关键' : '未知')
        : (g.key === true ? '关键' : g.key === false ? '非关键' : '未知');
      const rate = r ? rateAt(r, g.axisUs) : null;
      const sizeLabel = s ? (s.sizeBytes != null ? sizeText(s.sizeBytes) : '大小未知') : sizeText(g.sizeBytes);
      rows.push(`<div class="tt-row"><span class="dot" style="background:${color}"></span><span><b>${g.slot}</b> ${sizeLabel} · ${keyText}（容器标记）${rate != null ? ` · ${rate.toFixed(2)} Mbps` : ''}${g.stackedCount > 1 ? ` · 同时刻${g.stackedCount}样本` : ''}</span></div>`);
      if (s) {
        const parts = [
          `样本 ${s.decodeOrdinal}`,
          // 原始值保持原值，不钳零；展示/DTS 为会话时间。
          s.containerPtsUs != null ? `原始PTS ${formatAxis(s.containerPtsUs)}` : '',
          s.effectivePtsUs != null ? `展示PTS ${formatAxis(s.effectivePtsUs)}` : '',
          s.dtsUs != null ? `DTS ${formatAxis(s.dtsUs)}` : '',
        ].filter(Boolean).join(' ｜ ');
        rows.push(`<div class="tt-row tt-note"><span>${parts}</span></div>`);
      } else {
        rows.push(`<div class="tt-row tt-note"><span>展示PTS ${g.sessionPtsUs != null ? formatAxis(g.sessionPtsUs) : '无'} ｜ 轴 ${formatAxis(g.axisUs)}</span></div>`);
      }
      // 邻轨参考：同一时刻附近的数据，明确标时间差或无新样本，不覆盖主命中。
      for (const t of sel) {
        if (t.slot === g.slot) continue;
        const near = nearestSample(t.slot, g.axisUs);
        const c = slotColors.get(t.slot) ?? '#888';
        if (!near) {
          rows.push(`<div class="tt-row tt-note"><span class="dot" style="background:${c}"></span><span><b>${t.slot}</b> 该时间无新样本</span></div>`);
          continue;
        }
        const rr = results.get(t.slot)!;
        const rs = rr.samples[near.index];
        const axisT = (prefs.axis === 'pts' ? rs.effectivePtsUs : rs.dtsUs) ?? g.axisUs;
        const dt = Math.round(axisT - g.axisUs);
        const snap = Math.max(500, medianGapCached(t.slot) * 0.6);
        if (Math.abs(dt) <= Math.max(snap, GROUP_TOLERANCE_US)) {
          rows.push(`<div class="tt-row tt-note"><span class="dot" style="background:${c}"></span><span><b>${t.slot}</b> ${rs.sizeBytes != null ? sizeText(rs.sizeBytes) : '大小未知'} · ${dt === 0 ? '同时' : `差 ${dt > 0 ? '+' : ''}${dt}us`}</span></div>`);
        } else {
          rows.push(`<div class="tt-row tt-note"><span class="dot" style="background:${c}"></span><span><b>${t.slot}</b> 该时间无新样本（最近差 ${dt}us）</span></div>`);
        }
      }
    } else if (main && main.kind === 'bucket') {
      const g = main as BucketGlyph;
      const r = results.get(g.slot);
      const color = slotColors.get(g.slot) ?? '#888';
      // 用 glyph 自带聚合数据（支持合并后的粗桶），不依赖原始桶下标。
      const rate = r ? rateAt(r, (g.startUs + g.endUs) / 2) : null;
      rows.push(`<div class="tt-row"><span class="dot" style="background:${color}"></span><span><b>${g.slot}</b> 区间峰值 ${sizeText(g.maxBytes)} · ${g.count} 样本 · 共 ${(g.sumBytes / 1024).toFixed(1)} KiB</span></div>`);
      rows.push(`<div class="tt-row tt-note"><span>${formatAxis(g.startUs)}–${formatAxis(g.endUs)} ｜ 关键${g.keyCount}/非关键${g.deltaCount}/未知${g.unknownCount}${g.complete ? '' : ' ｜ 暂定'}${rate != null ? ` ｜ ${rate.toFixed(2)} Mbps` : ''} ｜ 点击放大，不定位到帧</span></div>`);
    } else {
      // 空白/曲线：只检查，不偷用第一轨最近帧冒充定位。
      for (const t of sel) {
        const r = results.get(t.slot);
        const color = slotColors.get(t.slot) ?? '#888';
        if (!r) {
          rows.push(`<div class="tt-row"><span class="dot" style="background:${color}"></span><span><b>${t.slot}</b> 正在查询统计…</span></div>`);
          continue;
        }
        const bi = (r.buckets ?? []).findIndex(b => b.count > 0 && hoverUs! >= b.startUs && hoverUs! < b.endUs);
        if (bi >= 0) {
          const b = r.buckets![bi];
          rows.push(`<div class="tt-row tt-note"><span class="dot" style="background:${color}"></span><span><b>${t.slot}</b> 区间 ${b.count} 样本 · 峰值 ${sizeText(b.maxBytes)}</span></div>`);
        } else {
          rows.push(`<div class="tt-row tt-note"><span class="dot" style="background:${color}"></span><span><b>${t.slot}</b> 该区间无覆盖</span></div>`);
        }
      }
      rows.push('<div class="tt-row tt-note"><span>空白处点击不定位；拖拽框选放大，双击恢复。</span></div>');
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
    // 单击：精确柱定位到展示 PTS（DTS 图亦然，横坐标本身不是 seek 目标）；
    // 聚合桶/重复聚合只放大，不伪造某帧精确定位；空白不定位。
    const picked = pickAt(event.clientX, event.clientY);
    if (picked && picked.kind === 'sample') {
      const g = picked as SampleGlyph;
      // 聚合多样本（重复时间戳放不下）点击展开：放大到该组附近，不冒充 seek。
      if (g.stackedCount > 1) {
        const span = Math.max(MIN_SPAN_US, Math.floor((viewRange().end - viewRange().start) / 8));
        setView(Math.floor(g.axisUs - span / 2), Math.ceil(g.axisUs + span / 2), false);
        return;
      }
      const r = results.get(g.slot);
      const s = r?.samples.find(v => v.sampleId === g.sampleId);
      const resolved = session.resolveAnalysisSeek(g.slot, { effectivePtsUs: s?.effectivePtsUs ?? g.sessionPtsUs });
      if ('sessionPtsUs' in resolved) {
        kbTrack = g.slot;
        void act(() => session.seek(resolved.sessionPtsUs), 'analysis.seek', { slot: g.slot, ptsUs: resolved.sessionPtsUs });
      } else {
        status.textContent = `轨道 ${g.slot}：${resolved.reason}`;
        live.textContent = status.textContent;
      }
    } else if (picked && picked.kind === 'bucket') {
      const g = picked as BucketGlyph;
      if (g.count > 0) setView(Math.floor(g.startUs), Math.ceil(g.endUs), false);
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
    const sel = selectedTracks();
    if (!sel.length) return;
    if (!kbTrack || !sel.some(t => t.slot === kbTrack)) kbTrack = sel[0].slot;
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
        updateTooltip(rect.left + (lastGeom ? xOf(lastModel, {
          gutter: lastGeom.gutter, plotW: lastGeom.plotW,
        } as never, hoverUs) : 0), rect.top + 20);
        live.textContent = `轨道焦点 ${kbTrack}。${live.textContent ?? ''}`;
      } else {
        status.textContent = `轨道焦点 ${kbTrack}`;
        live.textContent = status.textContent;
      }
    } else if (event.key === 'Enter' && hoverUs != null) {
      event.preventDefault();
      // 键盘 Enter 定位当前焦点轨道在检查点的样本，不总是第一轨。
      const focus = kbTrack ?? sel[0].slot;
      const near = nearestSample(focus, hoverUs);
      if (near) {
        const r = results.get(focus)!;
        const s = r.samples[near.index];
        const snap = Math.max(500, medianGapCached(focus) * 0.6);
        if (near.dt <= Math.max(snap, GROUP_TOLERANCE_US)) {
          const resolved = session.resolveAnalysisSeek(focus, { effectivePtsUs: s.effectivePtsUs });
          if ('sessionPtsUs' in resolved) void act(() => session.seek(resolved.sessionPtsUs), 'analysis.seek', {});
          else { status.textContent = resolved.reason; live.textContent = resolved.reason; }
          return;
        }
      }
      status.textContent = `轨道 ${focus} 在该时间无可定位样本。`;
      live.textContent = status.textContent;
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
