import { installBitstreamDiagrams, type BitstreamDiagram } from "./analysis/bitstream-diagrams.ts";
// 顶部码流分析面板：工具条 + Canvas + 覆盖层 + 会话共用查询。
// 数据全部走 ReviewSession.queryAnalysis（与 Agent 同一入口）；悬停只读
// 索引，不解码、不 seek；单击可显示帧经 resolveAnalysisSeek 定位到展示 PTS。
// 面板开关与高度由 workbench 统一管理（右上功能区、拖拽手势与子轨道同契约）；
// 本模块只负责内容、查询与绘制。下拉全部使用项目 choice-menu 控件。

import { SLOTS } from '../model.ts';
import type { Slot } from '../model.ts';
import type { ReviewSession } from '../session.ts';
import type { AnalysisDiagram, AnalysisCapability } from '../analysis/types.ts';
import { BITRATE_WINDOW_OPTIONS_US, DEFAULT_BITRATE_WINDOW_US } from '../analysis/statistics.ts';
import type { TimeGroup } from '../analysis/grouping.ts';
import type { DirectTarget, InspectionState } from '../analysis/inspection.ts';
import { pickGlyph, paddedChartDomain, containerChartColumn, chartFrameHoverStart, layoutAnalysisCards } from './analysis-geometry.ts';
import type { AnalysisGlyph, BucketGlyph, SampleGlyph } from './analysis-geometry.ts';
import { installChoiceMenu } from './choice-menu.ts';
import { analysisDiagramIcon } from './analysis/diagram-icons.ts';
import { bitstreamReasonText } from './bitstream-reasons.ts';
import { onLanguageChange, t, th, msg } from '../i18n.ts';
import { reconcileTrackSelection } from './track-selection.ts';
import type { AnalysisViewState } from '../workspace-file.ts';
import {
  AXIS_H, computeLayout, drawAnalysis, drawTimeAxis, formatAxis, plotGeometry, tOf,
} from './analysis-canvas.ts';
import type { CanvasColors, CanvasModel } from './analysis-canvas.ts';
import { loadAnalysisPreferences as loadPrefs, selectedAnalysisDiagrams, PREF_KEY } from './analysis/preferences.ts';
import type { AnalysisPreferences as Prefs } from './analysis/preferences.ts';
import { buildAnalysisModel } from './analysis/model.ts';
import { createAnalysisQueries } from './analysis/queries.ts';
import type { AnalysisQueryTrack } from './analysis/queries.ts';
import { installAnalysisStatus } from './analysis/status.ts';
import { chartHoverStyle, CHART_HOVER_STYLE_EVENT } from './chart-hover-style.ts';
import { analysisTrackBadge, installAnalysisCard, installFloatingAnalysisCard } from './analysis/card.ts';
import { createInspectionController } from './analysis/inspection-state.ts';
import { drawAnalysisOverlay } from './analysis/overlay.ts';
import { installAnalysisGestures } from './analysis/gestures.ts';
import { installChartNavigation } from './analysis/chart-navigation.ts';
import { installFilterGestures } from './analysis/filter-gestures.ts';
import { panTimeRange, zoomTimeRange } from '../analysis/projection.ts';
import './analysis-panel.css';

import type { ChartHover, AnalysisAction as Action } from './analysis/shared.ts';

export interface AnalysisHooks {
  signal: AbortSignal;
  isOpen: () => boolean;
  selectedSlot?: () => Slot;
}

import { MIN_ANALYSIS_SPAN_US as MIN_SPAN_US } from './analysis/shared.ts';

const WINDOW_LABELS: Record<number, string> = Object.fromEntries(
  BITRATE_WINDOW_OPTIONS_US.map(w => [w, w >= 1_000_000 ? `${w / 1_000_000}s` : `${w / 1000}ms`]),
);
// 合并为默认：同一基线按时间交错，不以严格配对为前提；分轨只作主动选择。
const layoutLabel = (mode: 'merged' | 'rows') => t(mode === 'merged' ? msg("analysis.layoutMerged", "码流合并") : msg("analysis.layoutRows", "码流分轨"));


interface TrackEntry extends AnalysisQueryTrack { name: string; frameIntervalUs: number }

export function installAnalysisPanel(session: ReviewSession, act: Action, hooks: AnalysisHooks): {
  setOpen(open: boolean): void;
  refreshTarget(): void;
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
      <div class="analysis-primary"><div id="analysis-diagrams" class="analysis-diagram-toggles" role="group" aria-label="${th(msg('analysis.diagrams','分析图示'))}"></div></div>
      <div class="analysis-tools" role="group" aria-label="${th(msg("analysis.tools", "分析选项"))}">
        <span id="analysis-tracks" class="analysis-tracks" role="group" aria-label="${th(msg("analysis.compareTracks", "对比轨道"))}"></span>
        <div class="segmented" id="analysis-axis" role="group" aria-label="${th(msg("analysis.timeBase", "时间基准"))}" title="${th(msg("analysis.timeBaseTitle", "PTS 为展示时间，DTS 为解码时间；无可靠 DTS 的轨道不支持 DTS 视图"))}">
          <button type="button" data-axis="pts">PTS</button>
          <button type="button" data-axis="dts">DTS</button>
        </div>
        <button type="button" id="analysis-window" class="choice-trigger" aria-label="${th(msg("analysis.bitrateWindow", "码率窗口"))}" title="${th(msg("analysis.bitrateWindowTitle", "码率窗口：视频样本负载码率的滑动时间窗（真实时间窗，非 N 帧窗）"))}"></button>
        <button type="button" id="analysis-layout" class="choice-trigger" aria-label="${th(msg("analysis.multiTrackLayout", "多轨布局"))}" title="${th(msg("analysis.multiTrackLayoutTitle", "只影响码率和帧大小；NALU 与帧参考始终按轨道分开显示。"))}"></button>
        <button type="button" id="analysis-current" class="seg" hidden></button>
        <button type="button" class="seg" data-seg="full" title="${th(msg("analysis.fullRangeTitle", "双击图也可恢复完整范围"))}">${th(msg("analysis.fullRange", "完整范围"))}</button>
      </div>
      <div class="analysis-status" id="analysis-status" role="group" aria-label="${th(msg("analysis.currentFrameNumbers", "当前上屏帧号"))}">
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
  let diagrams = new Set<AnalysisDiagram>(selectedAnalysisDiagrams(prefs));
  let diagramSolo: { target: AnalysisDiagram; previous: Set<AnalysisDiagram> } | undefined;
  const overviewVisible = () => diagrams.has('bitrate') || diagrams.has('size');
  const charts = document.createElement('div'); charts.className = 'analysis-charts';
  const overviewHost = document.createElement('div'); overviewHost.className = 'analysis-overview';
  overviewHost.append($<HTMLElement>('.analysis-notice'), $<HTMLElement>('.analysis-body'));
  const none = document.createElement('div'); none.className = 'analysis-no-charts';
  const noneCopy = document.createElement('p'); none.append(noneCopy);
  const diagramHost = $<HTMLElement>('#analysis-diagrams');
  const emptyDiagramHost = document.createElement('div'); emptyDiagramHost.id = 'analysis-empty-diagrams';
  emptyDiagramHost.className = 'analysis-diagram-toggles'; emptyDiagramHost.setAttribute('role', 'group'); none.append(emptyDiagramHost);
  charts.append(overviewHost, none); section.querySelector('.analysis-head')!.after(charts);
  const sharedAxisHost = document.createElement('div'); sharedAxisHost.className = 'analysis-shared-axis'; sharedAxisHost.hidden = true;
  const sharedAxis = document.createElement('canvas'); sharedAxis.id = 'analysis-shared-axis'; sharedAxis.setAttribute('aria-hidden', 'true');
  sharedAxisHost.append(sharedAxis); charts.after(sharedAxisHost);
  const sharedAxisCtx = sharedAxis.getContext('2d');
  let sharedAxisSignature = '';
  type DeepEntry = { mode: BitstreamDiagram; slot: Slot; host: HTMLElement; abort: AbortController; panel: ReturnType<typeof installBitstreamDiagrams> };
  const deepPanels = new Map<string, DeepEntry>();
  const naluGroups = new Map<Slot, HTMLElement>();
  const filters = new Map<Slot, { identity: string; hiddenTypes: Set<number> }>();
  const deepKey = (mode: BitstreamDiagram, slot: Slot) => `${mode}:${slot}`;
  const deepFor = (mode: BitstreamDiagram, slot: Slot) => deepPanels.get(deepKey(mode, slot));
  function syncNaluMinimum() {
    for (const [slot, group] of naluGroups) {
      const height = ['nalu-size', 'nalu-types'].reduce((sum, mode) => {
        const host = deepFor(mode as BitstreamDiagram, slot)?.host;
        return sum + (host ? parseFloat(host.style.getPropertyValue('--chart-min-plot-height')) || 36 : 0);
      }, 25);
      group.style.setProperty('--nalu-min-height', `${height}px`);
      group.dataset.empty = String(['nalu-size', 'nalu-types'].every(mode => deepFor(mode as BitstreamDiagram, slot)?.host.dataset.empty === 'true'));
    }
  }
  let sharedHover: ChartHover | null = null;
  let sharedPointerY: number | null = null;
  let sharedOrigin: 'overview' | 'deep' = 'overview';
  function syncChartMinimum() {
    // A chart's minimum fills the panel's usable area at the resize lower bound.
    // Keep this independent of the current height so enlarging the panel can fit more charts.
    const panelStyle = getComputedStyle(section);
    const panelMinimum = parseFloat(panelStyle.getPropertyValue('--analysis-min-height')) || 140;
    const chromeHeight = $<HTMLElement>('.analysis-head').getBoundingClientRect().height
      + sharedAxisHost.getBoundingClientRect().height
      + (parseFloat(panelStyle.borderTopWidth) || 0) + (parseFloat(panelStyle.borderBottomWidth) || 0);
    const viewMinimum = Math.max(1, panelMinimum - chromeHeight);
    const plotMinimum = Math.max(36, viewMinimum - 25); // Compact legend and separator.
    for (const [name, height] of [['--analysis-view-min-height', viewMinimum], ['--analysis-chart-min-plot-height', plotMinimum]] as const) {
      const value = `${height}px`;
      if (charts.style.getPropertyValue(name) !== value) charts.style.setProperty(name, value);
    }
  }
  let deepRaf = 0;
  function refreshDeep(immediate = false) {
    if (open && !immediate) {
      // Coalesce stream batches and playback updates, while preparing every
      // sibling chart together in the animation frame before it is painted.
      if (!deepRaf) deepRaf = requestAnimationFrame(() => { deepRaf = 0; refreshDeep(true); });
      return;
    }
    if (deepRaf) cancelAnimationFrame(deepRaf);
    deepRaf = 0;
    if (open) {
      syncChartMinimum();
      const primary = selectedTracks()[0]?.slot;
      for (const { mode, slot, panel } of deepPanels.values()) panel.refresh(mode, slot, primary === slot);
      for (const { panel } of deepPanels.values()) panel.prepareLayout();
      syncNaluMinimum();
      for (const { panel } of deepPanels.values()) panel.render();
    }
    renderSharedAxis();
  }
  const diagramLabels = () => [
    { value: 'bitrate', label: t(prefs.axis === 'pts' ? msg('analysis.presentationLoad', '展示负载率') : msg('analysis.bitrate', '码率')) },
    { value: 'size', label: t(msg('analysis.frameSize', '帧大小')) },
    { value: 'nalu-size', label: t(msg('analysis.naluSize','NALU 大小')) },
    { value: 'nalu-types', label: t(msg('analysis.naluTypes','NALU 类型')) },
    { value: 'references', label: t(msg('analysis.referencePyramid','帧参考金字塔')) },
  ];
  const diagramButtons = [diagramHost, emptyDiagramHost].flatMap(host => diagramLabels().map(({ value }) => {
    const next = value as AnalysisDiagram;
    const button = document.createElement('button'); button.type = 'button'; button.dataset.value = value;
    button.innerHTML = analysisDiagramIcon(next);
    host.append(button); return button;
  }));
  for (const host of [diagramHost, emptyDiagramHost]) installFilterGestures(host, signal, (button, solo) => {
    const next = button.dataset.value as AnalysisDiagram;
    if (solo) {
      if (diagramSolo?.target === next) {
        diagrams = diagramSolo.previous; diagramSolo = undefined;
      } else {
        diagramSolo = { target: next, previous: diagramSolo?.previous ?? new Set(diagrams) };
        diagrams = new Set([next]);
      }
    } else {
      diagramSolo = undefined;
      if (diagrams.has(next)) diagrams.delete(next); else diagrams.add(next);
    }
    clearSharedHover(); refreshTools(); save(); requestRender();
    const focus = none.hidden && emptyDiagramHost.contains(button) ? diagramHost.querySelector<HTMLButtonElement>(`[data-value="${next}"]`)! : button;
    focus.focus({ preventScroll: true });
  });
  function refreshDiagram() {
    prefs.diagrams = diagramLabels().filter(item => diagrams.has(item.value as AnalysisDiagram)).map(item => item.value as AnalysisDiagram);
    prefs.showBitrate = diagrams.has('bitrate'); prefs.showSize = diagrams.has('size');
    const groupLabel = t(msg('analysis.diagrams','分析图示'));
    for (const host of [diagramHost, emptyDiagramHost]) host.setAttribute('aria-label', groupLabel);
    diagramLabels().forEach(({ value, label }) => {
      for (const button of diagramButtons.filter(button => button.dataset.value === value)) {
        button.setAttribute('aria-label', label);
        button.dataset.tooltip = `${label}\n${t(msg('analysis.diagramSoloHint', '点击切换；右键或长按单选，再次操作同一图表恢复之前的选择。'))}`;
        button.setAttribute('aria-pressed', String(diagrams.has(value as AnalysisDiagram)));
      }
    });
    const overview = overviewVisible();
    overviewHost.hidden = !overview;
    for (const control of $<HTMLElement>('.analysis-tools').children) (control as HTMLElement).hidden = !overview && control.id !== 'analysis-tracks' && control.id !== 'analysis-axis' && (control as HTMLElement).dataset.seg !== 'full';
    $<HTMLElement>('#analysis-window').hidden = !prefs.showBitrate;
    const current = $<HTMLButtonElement>('#analysis-current'); current.hidden = ![...diagrams].some(mode => mode !== 'bitrate' && mode !== 'size');
    current.textContent = t(msg('analysis.diagramCurrent', '当前帧')); current.disabled = !tracks.length;
    const selected = selectedTracks();
    const wanted = new Set<string>();
    for (const track of selected) {
      const identity = `${track.mediaId}|${track.sourceGen}`;
      const previousFilter = filters.get(track.slot);
      if (previousFilter) { if (previousFilter.identity !== identity) previousFilter.hiddenTypes.clear(); previousFilter.identity = identity; }
      else filters.set(track.slot, { identity, hiddenTypes: new Set() });
      for (const mode of ['nalu-size', 'nalu-types', 'references'] as const) {
        if (!diagrams.has(mode)) continue;
        const key = deepKey(mode, track.slot); wanted.add(key);
        if (deepPanels.has(key)) continue;
        const host = document.createElement('div'); host.className = 'bitstream-diagrams'; host.dataset.diagram = mode; host.dataset.slot = track.slot;
        const abort = new AbortController(), slot = track.slot;
        const panel = installBitstreamDiagrams(host, session, act, abort.signal, {
          axis: () => prefs.axis, range: () => viewRange(), domain: () => domainBounds(), containerColumn: () => containerColumn(), set: (start, end) => setView(start, end),
        }, { hiddenTypes: filters.get(slot)!.hiddenTypes, filterChanged: () => { clearSharedHover(); refreshDeep(); }, hover: hoverDeep,
          pinned: () => inspection.state.pinned != null, layoutChanged: syncNaluMinimum, rendered: positionIndividualCards,
          inspection: () => inspectionUi(slot), slotColor: () => slotColors.get(slot) ?? '#888' });
        deepPanels.set(key, { mode, slot, host, abort, panel });
      }
    }
    for (const [key, entry] of deepPanels) if (!wanted.has(key)) { entry.abort.abort(); entry.host.remove(); deepPanels.delete(key); }
    for (const [slot, group] of naluGroups) if (!selected.some(track => track.slot === slot) || !diagrams.has('nalu-size') || !diagrams.has('nalu-types')) { group.remove(); naluGroups.delete(slot); }
    // Group by diagram, then by track; each track retains its own NAL filter.
    let preceding: Element = none;
    for (const track of selected) {
      const size = deepFor('nalu-size', track.slot), types = deepFor('nalu-types', track.slot);
      if (size && types) {
        let group = naluGroups.get(track.slot);
        if (!group) { group = document.createElement('div'); group.className = 'bitstream-nalu-group'; group.dataset.slot = track.slot; naluGroups.set(track.slot, group); }
        if (group.firstElementChild !== size.host || size.host.nextElementSibling !== types.host) group.append(size.host, types.host);
        if (preceding.nextElementSibling !== group) preceding.after(group); preceding = group;
      } else {
        const entry = size ?? types;
        if (entry) { if (preceding.nextElementSibling !== entry.host) preceding.after(entry.host); preceding = entry.host; }
      }
    }
    for (const track of selected) {
      const entry = deepFor('references', track.slot);
      if (entry) { if (preceding.nextElementSibling !== entry.host) preceding.after(entry.host); preceding = entry.host; }
    }
    syncNaluMinimum();
    const overviewRows = Number(prefs.showBitrate) + (prefs.showSize ? prefs.layoutMode === 'merged' ? 1 : Math.max(1, selectedTracks().length) : 0);
    const multiple = overviewRows + deepPanels.size > 1;
    charts.classList.toggle('multiple', multiple);
    // The time axis belongs to the panel, even when its only view is the overview.
    sharedAxisHost.hidden = diagrams.size === 0;
    overviewHost.style.setProperty('--overview-weight', String(Math.max(1, overviewRows)));
    overviewHost.style.setProperty('--overview-min-height', `calc(max(36px, var(--analysis-view-min-height)) * ${Math.max(1, overviewRows)})`);
    none.hidden = diagrams.size > 0; noneCopy.textContent = t(msg('analysis.chooseCharts', '选择要显示的图表。'));
    if (!overview) { cardEl.hidden = true; queries.suspend(); }
    else scheduleQuery();
    refreshStream();
  }
  const tools = $<HTMLElement>('.analysis-tools');
  const tracksEl = $<HTMLElement>('#analysis-tracks');
  const statusEl = $<HTMLElement>('#analysis-status');
  const axisEl = $<HTMLElement>('#analysis-axis');
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
  const card = installAnalysisCard(canvas, { signal, colors: () => slotColors, pinned: () => inspection.state.pinned != null,
    visibleRows: () => ({ bitrate: prefs.showBitrate, size: prefs.showSize }),
    panelBounds: () => section.getBoundingClientRect() });
  const cardEl = card.element;
  cardEl.classList.add('analysis-linked-card');
  type CardGroup = 'overview' | `nalu:${Slot}` | `references:${Slot}`;
  const individualLayer = document.createElement('div'); individualLayer.className = 'analysis-float-layer analysis-individual-layer';
  individualLayer.setAttribute('aria-hidden', 'true'); document.body.append(individualLayer);
  signal.addEventListener('abort', () => individualLayer.remove(), { once: true });
  const individualCards = new Map<CardGroup, { element: HTMLElement; position(x: number, y?: number): void; managePosition(parent: HTMLElement): void }>();
  function cardGroupBounds(group: CardGroup): DOMRect | undefined {
    if (group === 'overview') {
      if (!overviewVisible()) return;
      const rect = canvas.getBoundingClientRect();
      const plotHeight = lastModel ? computeLayout(lastModel).axisY : rect.height;
      return new DOMRect(rect.left, rect.top, rect.width, plotHeight);
    }
    const [kind, slot] = group.split(':') as ['nalu' | 'references', Slot];
    if (kind === 'nalu') return (naluGroups.get(slot) ?? deepFor('nalu-size', slot)?.host ?? deepFor('nalu-types', slot)?.host)?.getBoundingClientRect();
    return deepFor('references', slot)?.host.getBoundingClientRect();
  }

  const overviewCard = installAnalysisCard(canvas, { signal, colors: () => slotColors, pinned: () => inspection.state.pinned != null,
    visibleRows: () => ({ bitrate: prefs.showBitrate, size: prefs.showSize }),
    panelBounds: () => cardGroupBounds('overview') ?? canvas.getBoundingClientRect(), beside: true });
  overviewCard.element.classList.add('analysis-view-card'); overviewCard.element.dataset.diagram = 'overview';
  overviewCard.managePosition(individualLayer);
  individualCards.set('overview', overviewCard);
  function retainCardLeave(element: HTMLElement) {
    element.addEventListener('pointerleave', event => {
      if (!(event.relatedTarget instanceof Node) || (!charts.contains(event.relatedTarget) && !hoverCardsContain(event.relatedTarget))) clearSharedHover();
    }, { signal });
  }
  for (const { element } of individualCards.values()) retainCardLeave(element);
  function hideIndividualCards() { for (const { element } of individualCards.values()) element.hidden = true; }
  function hoverCardsContain(node: Node) { return cardEl.contains(node) || [...individualCards.values()].some(card => card.element.contains(node)); }
  function cardText() { return cardEl.hidden ? [...individualCards.values()].filter(card => !card.element.hidden).map(card => card.element.textContent).join(' · ') : cardEl.textContent ?? ''; }
  function positionIndividualCards() {
    if (!sharedHover || chartHoverStyle() !== 'separate') return;
    const clip = charts.getBoundingClientRect();
    const pending: { card: { element: HTMLElement; position(x: number, y?: number): void }; x: number; height: number; preferredTop: number; order: number; top: number; bottom: number; centerY: number }[] = [];
    const widths = new Map<string, number>();
    for (const [mode, card] of individualCards) {
      const rect = cardGroupBounds(mode);
      if (!rect) { card.element.hidden = true; continue; }
      const top = Math.max(8, clip.top, rect.top) + 2;
      const bottom = Math.min(innerHeight - 8, clip.bottom, rect.bottom) - 2;
      if (bottom - top < 24) { card.element.hidden = true; continue; }
      const time = mode === 'overview' ? inspection.state.hoverUs ?? sharedHover.timeUs : sharedHover.cursorTimeUs ?? sharedHover.timeUs;
      const range = viewRange(), x = rect.left + 46 + (time - range.start) / Math.max(1, range.end - range.start) * (rect.width - 46);
      card.element.hidden = false;
      card.element.style.width = '';
      card.position(x, 0);
      const kind = card.element.dataset.diagram!;
      widths.set(kind, Math.max(widths.get(kind) ?? 0, card.element.offsetWidth));
      const height = card.element.offsetHeight;
      // Prefer the owner's centre in a stack, or follow the pointer in a single chart.
      // Keep full height when the owner is too short, then move neighbouring cards.
      const centerY = Number(overviewVisible()) + deepPanels.size > 1 || sharedPointerY == null ? (top + bottom) / 2 : sharedPointerY;
      const preferredTop = height <= bottom - top ? Math.max(top, Math.min(bottom - height, centerY - height / 2)) : centerY - height / 2;
      pending.push({ card, x, height, preferredTop, order: rect.top, top, bottom, centerY });
    }
    for (const item of pending) {
      item.card.element.style.width = `${widths.get(item.card.element.dataset.diagram!)!}px`;
      item.height = item.card.element.offsetHeight;
      item.preferredTop = item.height <= item.bottom - item.top ? Math.max(item.top, Math.min(item.bottom - item.height, item.centerY - item.height / 2)) : item.centerY - item.height / 2;
    }
    pending.sort((a, b) => a.order - b.order);
    const layout = layoutAnalysisCards(pending, 8, innerHeight - 8);
    const wasScrollable = individualLayer.classList.contains('is-scrollable');
    individualLayer.classList.toggle('is-scrollable', layout.scroll);
    if (!layout.scroll || !wasScrollable) individualLayer.scrollTop = 0;
    for (const [i, item] of pending.entries()) item.card.position(item.x, layout.tops[i] - 8);
  }

  function renderIndividual(snapshot: InspectionState) {
    cardEl.hidden = true;
    if (overviewVisible()) { overviewCard.render(snapshot, null); overviewCard.element.dataset.hoverTime = String(sharedHover!.timeUs); }
    for (const { mode, slot, host, panel } of detailPanels()) {
      const kind = mode === 'references' ? 'references' : 'nalu';
      const group: CardGroup = `${kind}:${slot}`;
      let floating = individualCards.get(group);
      if (!floating) {
        floating = installFloatingAnalysisCard(host.querySelector('canvas')!, signal, () => cardGroupBounds(group) ?? host.getBoundingClientRect(), true);
        floating.element.classList.add('analysis-view-card'); floating.element.dataset.diagram = kind; floating.element.dataset.slot = slot;
        floating.managePosition(individualLayer);
        individualCards.set(group, floating); retainCardLeave(floating.element);
      }
      floating.element.replaceChildren(panel.details(trackHover(slot, sharedHover!, snapshot), { size: diagrams.has('nalu-size'), types: diagrams.has('nalu-types') }).element);
      floating.element.dataset.hoverTime = String(sharedHover!.timeUs);
    }
    positionIndividualCards();
  }
  window.addEventListener(CHART_HOVER_STYLE_EVENT, () => { hideIndividualCards(); cardEl.hidden = true; if (sharedHover && inspection.state.lastInspection) renderCombined(inspection.state.pinned ?? inspection.state.lastInspection, inspection.state.lastClient?.x ?? null); }, { signal });
  charts.addEventListener('scroll', positionIndividualCards, { signal, capture: true });
  function clearSharedHover() {
    if (inspection.state.pinned) return;
    sharedHover = null;
    sharedPointerY = null;
    inspection.state.hoverUs = null; inspection.state.lastInspection = null; inspection.state.kbInspect = false;
    hoverEl.hidden = true; cardEl.hidden = true; hideIndividualCards();
    canvas.dataset.hoverTime = ''; canvas.dataset.hoverCursorTime = '';
    for (const { panel } of deepPanels.values()) panel.highlight(null);
    refreshOverlay(); publishTestHook();
  }
  function detailPanels() {
    return [...deepPanels.values()].filter(entry => entry.mode !== 'nalu-types' || !deepFor('nalu-size', entry.slot));
  }
  function trackHover(slot: Slot, value: ChartHover, snapshot = inspection.state.pinned ?? inspection.state.lastInspection): ChartHover {
    if (value.slot === slot && value.au !== undefined) return value;
    const reference = snapshot?.tracks.find(track => track.slot === slot)?.reference;
    return reference ? { ...value, slot, au: reference.sample.decodeOrdinal, sourceVersion: undefined, timeUs: reference.axisUs }
      : { ...value, sourceVersion: undefined };
  }
  function syncHighlights() {
    canvas.dataset.hoverTime = inspection.state.hoverUs == null ? '' : String(inspection.state.hoverUs);
    canvas.dataset.hoverCursorTime = canvas.dataset.hoverTime;
    for (const { slot, panel } of deepPanels.values()) panel.highlight(sharedHover ? trackHover(slot, sharedHover) : null);
    positionHover(); refreshOverlay();
  }
  function renderCombined(snapshot: InspectionState, x: number | null) {
    if (chartHoverStyle() === 'separate') { renderIndividual(snapshot); return; }
    hideIndividualCards();
    // Reuse canonical metric formatting, but keep each track's readouts together.
    overviewCard.render(snapshot, null); overviewCard.element.hidden = true;
    const overview = overviewCard.element.querySelector<HTMLTableElement>('.analysis-overview-grid')!;
    cardEl.replaceChildren(); cardEl.hidden = false;
    const modes: BitstreamDiagram[] = [];
    if (diagrams.has('nalu-size')) modes.push('nalu-size'); else if (diagrams.has('nalu-types')) modes.push('nalu-types');
    if (diagrams.has('references')) modes.push('references');
    const widths = [...(overviewVisible() ? [180] : []), ...modes.map(mode => mode === 'references' ? 240 : 250)];
    for (const [index, track] of snapshot.tracks.entries()) {
      const row = document.createElement('article'); row.className = 'analysis-track-details'; row.dataset.slot = track.slot;
      const heading = document.createElement('div'); heading.className = 'analysis-card-track';
      const badge = analysisTrackBadge(track.slot);
      const name = document.createElement('span'); name.textContent = tracks.find(entry => entry.slot === track.slot)?.name ?? ''; name.className = 'analysis-card-track-name';
      const time = document.createElement('span'); time.className = 'analysis-card-track-time';
      let hitTimeUs = track.reference?.axisUs;
      heading.append(badge, name, time); row.append(heading);
      const grid = document.createElement('div'); grid.className = 'analysis-combined-grid'; row.append(grid);
      if (overviewVisible()) {
        const part = document.createElement('section'); part.className = 'analysis-card-section'; part.dataset.diagram = 'overview';
        part.style.setProperty('--section-width', '180px');
        const title = document.createElement('strong'); title.textContent = t(msg('analysis.streamSection', '码流'));
        const table = document.createElement('table'); table.className = 'fl-grid analysis-stream-grid';
        const cols = document.createElement('colgroup'); cols.append(document.createElement('col'), document.createElement('col')); cols.firstElementChild!.className = 'analysis-card-label-col'; table.append(cols);
        const body = table.createTBody();
        for (const metric of overview.tBodies[0].rows) {
          const clone = metric.cloneNode(true) as HTMLTableRowElement;
          for (let i = clone.cells.length - 1; i > 0; i--) if (i !== index + 1) clone.deleteCell(i);
          body.append(clone);
        }
        part.append(title, table); grid.append(part);
      }
      for (const mode of modes) {
        const entry = deepFor(mode, track.slot); if (!entry) continue;
        const part = document.createElement('section'); part.className = 'analysis-card-section'; part.dataset.diagram = mode; part.dataset.slot = track.slot;
        const title = document.createElement('strong'); title.textContent = mode === 'references' ? t(msg('analysis.referenceSection','帧参考')) : 'NALU';
        part.style.setProperty('--section-width', mode === 'references' ? '240px' : '250px');
        const { element: contents, timeUs } = entry.panel.details(trackHover(track.slot, sharedHover!, snapshot), {
          size: diagrams.has('nalu-size'), types: diagrams.has('nalu-types'), header: false,
        });
        if (timeUs !== undefined) hitTimeUs = timeUs;
        part.append(title, contents); grid.append(part);
      }
      time.dataset.hitTime = hitTimeUs === undefined ? '' : String(hitTimeUs);
      time.textContent = hitTimeUs === undefined ? '—' : `${formatAxis(hitTimeUs)} · ${snapshot.axis.toUpperCase()}`;
      cardEl.append(row);
    }
    cardEl.style.setProperty('--combined-card-width', `${widths.reduce((sum, width) => sum + width, 0) + Math.max(0, widths.length - 1) * 8 + 18}px`);
    cardEl.dataset.hoverTime = String(sharedHover!.timeUs);
    card.position(x ?? canvas.getBoundingClientRect().left + fracToPx(inspection.state.hoverUs ?? snapshot.inspectionTimeUs));
  }
  function renderFloat(snapshot: InspectionState | null, x: number | null) {
    if (!snapshot) { clearSharedHover(); return; }
    sharedOrigin = 'overview';
    const targetSlot = snapshot.directTarget?.slot ?? streamSlot();
    const track = snapshot.tracks.find(entry => entry.slot === targetSlot);
    const reference = track?.reference;
    const frame = snapshot.directTarget?.kind !== 'bucket' ? reference : null;
    sharedHover = { timeUs: snapshot.inspectionTimeUs, slot: targetSlot, au: frame?.sample.decodeOrdinal,
      cursorTimeUs: inspection.state.hoverUs ?? snapshot.inspectionTimeUs };
    syncHighlights(); renderCombined(snapshot, x);
  }
  function hoverDeep(value: ChartHover | null, x?: number, y?: number) {
    if (!value) { if (inspection.state.pinned) inspection.unpin(); clearSharedHover(); return; }
    if (inspection.state.pinned) return;
    sharedOrigin = 'deep'; sharedHover = value; sharedPointerY = y ?? null;
    const sample = results.get(value.slot!)?.samples.find(entry => entry.decodeOrdinal === value.au);
    const direct: DirectTarget | null = sample ? { kind: 'sample', slot: value.slot!, sampleId: sample.sampleId } : null;
    const snapshot = inspectAt(value.timeUs, direct);
    if (!sample) { const track = snapshot.tracks.find(track => track.slot === value.slot); if (track) track.reference = null; }
    inspection.state.hoverUs = snapshot.inspectionTimeUs + (value.cursorTimeUs == null ? 0 : value.cursorTimeUs - value.timeUs); inspection.state.lastInspection = snapshot;
    inspection.state.lastClient = null;
    syncHighlights(); renderCombined(snapshot, x ?? null); publishTestHook();
  }
  charts.addEventListener('pointerleave', event => {
    if (!(event.relatedTarget instanceof Node) || !hoverCardsContain(event.relatedTarget)) clearSharedHover();
  }, { signal });
  cardEl.addEventListener('pointerleave', event => {
    if (!(event.relatedTarget instanceof Node) || !charts.contains(event.relatedTarget)) clearSharedHover();
  }, { signal });
  charts.addEventListener('keydown', event => { if (event.key === 'Escape' && !inspection.state.pinned) clearSharedHover(); }, { signal });
  const positionFloat = (x: number) => chartHoverStyle() === 'separate' ? positionIndividualCards() : card.position(x);
  const live = $<HTMLElement>('output');
  // 查询与检查状态分别由独立模块持有。

  let tracks: TrackEntry[] = [];
  let caps = new Map<Slot, AnalysisCapability>();
  const queries = createAnalysisQueries({
    signal,
    snapshot: () => ({ open: open && overviewVisible(), tracks, selected: selectedTracks(), capabilities: caps,
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
  function dataDomainBounds(): { start: number; end: number } {
    const lo = tracks.length ? Math.min(0, ...tracks.map(t => t.offsetUs)) : 0;
    const hi = Math.max(1, durationUs);
    if (prefs.axis !== 'dts') return { start: Math.floor(lo), end: Math.ceil(hi) };
    let dtsMin: number | null = null, dtsEnd = hi;
    for (const track of selectedTracks()) {
      const domain = session.bitstreamChartDomain(track.slot, 'dts');
      if (domain) { dtsMin = Math.min(dtsMin ?? domain.start, domain.start); dtsEnd = Math.max(dtsEnd, domain.end); }
    }
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
    return { start: Math.floor(start), end: Math.ceil(dtsEnd) };
  }

  function domainBounds(visibleSpan?: number) {
    const raw = dataDomainBounds(), column = containerColumn();
    return paddedChartDomain({ start: column.timeUs, end: raw.end }, Math.max(1, ...tracks.map(track => track.frameIntervalUs)), plotGeometry(charts.clientWidth || 1024).plotW, visibleSpan ?? raw.end - raw.start);
  }
  function containerColumn() {
    return containerChartColumn(dataDomainBounds(), Math.max(1, ...tracks.map(track => track.frameIntervalUs)));
  }
  const fullRange = () => domainBounds();
  const viewRange = () => view ?? fullRange();

  /** Shared session-time viewport; null follows the complete time domain. */
  function setView(start: number | null, end?: number) {
    if (start == null) view = null;
    else {
      const span = Math.max(MIN_SPAN_US, (end ?? start) - start);
      // At the start of the film, zoom keeps a half-cell instead of magnifying
      // the full-film blank margin into a wide empty band.
      const db = domainBounds(span);
      if (span >= db.end - db.start) view = { start: db.start, end: db.end };
      else {
        const s = Math.min(Math.max(start, db.start), db.end - span);
        view = { start: Math.floor(s), end: Math.ceil(s + span) };
      }
    }
    save(); refreshTools(); requestRender(); scheduleQuery();
  }

  let viewRaf = 0;
  /** 高频手势（滚轮/捏合）合并为一帧一次重绘；数据查询走 100ms 节流。 */
  function requestRender() {
    if (viewRaf || signal.aborted) return;
    viewRaf = requestAnimationFrame(() => { viewRaf = 0; if (!signal.aborted) render(); });
  }

  const sharedAxisGeometry = () => plotGeometry(sharedAxis.clientWidth);
  installChartNavigation({ canvas: sharedAxis, signal, enabled: () => open && !sharedAxisHost.hidden && tracks.length > 0,
    plotWidth: () => sharedAxisGeometry().plotW,
    zoom(factor, clientX) {
      clearSharedHover();
      const geometry = sharedAxisGeometry(), range = viewRange();
      const fraction = Math.max(0, Math.min(1, (clientX - sharedAxis.getBoundingClientRect().left - geometry.gutter) / geometry.plotW));
      const next = zoomTimeRange(range.start, range.end, range.start + fraction * (range.end - range.start), factor, MIN_SPAN_US, domainBounds());
      setView(next.start, next.end);
    },
    pan(pixels) {
      clearSharedHover();
      const range = viewRange(), shift = Math.round(pixels / sharedAxisGeometry().plotW * (range.end - range.start));
      const next = panTimeRange(range.start, range.end, shift, domainBounds());
      setView(next.start, next.end);
    },
  });
  sharedAxis.addEventListener('dblclick', () => { clearSharedHover(); setView(null); }, { signal });

  const selectedTracks = () => tracks.filter(t => prefs.selected.includes(t.slot));

  const allHaveDts = () => {
    const sel = selectedTracks();
    return sel.length > 0 && sel.every(t => caps.get(t.slot)?.hasDts);
  };

  const status = installAnalysisStatus({ session, act, signal, prefs, statusEl, itemsEl, live,
    tracks: () => tracks, colors: () => slotColors });
  const updateStatus = () => status.update();

  let diagramSlot: Slot | undefined;
  function streamSlot() {
    const selected = selectedTracks();
    const preferred = hooks.selectedSlot?.();
    if (diagramSlot && selected.some(track => track.slot === diagramSlot)) return diagramSlot;
    return selected.length === 1 ? selected[0].slot : tracks.some(track => track.slot === preferred) ? preferred : selected[0]?.slot ?? tracks[0]?.slot;
  }
  function inspectionUi(slot?: Slot) {
    const track = tracks.find(entry => entry.slot === slot);
    const state = slot ? session.getBitstreamAnalysisState(slot) : undefined;
    const stream = state?.stream;
    const pending = state?.state === 'pending';
    const percent = stream && stream.totalUs > 0 ? Math.min(100, Math.floor(stream.checkedUs / stream.totalUs * 100)) : 0;
    let status = stream ? state?.state === 'ready' ? t(msg('analysis.streamDone','{slot} 已完成 · {count} 帧'), { slot: slot ?? '—', count: stream.pictures })
      : stream.waitingForIndex && pending ? t(msg('analysis.streamWaiting','{slot} 等待索引 · 已检查 {count} 帧'), { slot: slot ?? '—', count: stream.pictures })
      : t(msg('analysis.streamProgress','{slot} {percent}% · {count} 帧'), { slot: slot ?? '—', percent, count: stream.pictures })
      : t(msg('analysis.streamNotStarted','{slot} 尚未检查'), { slot: slot ?? '—' });
    if (state?.queued) status = t(msg('analysis.streamQueued', '{slot} 排队中'), { slot: slot ?? '—' });
    if (state?.reason) status += ` · ${bitstreamReasonText(state.reason.code)}`;
    if (state?.state === 'cancelled') status += ` · ${t(msg('analysis.streamCancelled','已取消'))}`;
    return { status, pending, percent, state: state?.state ?? 'idle', name: track?.name ?? '' };
  }
  // One automatic attempt per loaded source identity; session admission owns
  // the shared local/library concurrency limit and independent track tasks.
  const automaticStreams = new Map<Slot, string>();
  let automaticScheduled = false;
  function queueAutomaticStreams() {
    if (automaticScheduled || signal.aborted) return;
    automaticScheduled = true;
    queueMicrotask(() => {
      automaticScheduled = false;
      if (signal.aborted || !open || ![...diagrams].some(mode => mode !== 'bitrate' && mode !== 'size')) return;
      for (const track of selectedTracks()) {
        const identity = `${track.mediaId}:${track.sourceGen}`, state = session.getBitstreamAnalysisState(track.slot);
        if (automaticStreams.get(track.slot) === identity || state.state === 'pending' ||
          (state.state === 'ready' && state.stream) || caps.get(track.slot)?.indexState === 'error') continue;
        automaticStreams.set(track.slot, identity);
        void session.requestBitstreamStream(track.slot).catch(() => { /* The facade publishes errors; never retry automatically. */ })
          .finally(() => { if (!signal.aborted) refreshStream(); });
      }
    });
  }

  function refreshStream() {
    for (const chip of tracksEl.querySelectorAll<HTMLElement>('.analysis-track-control')) {
      const slot = chip.dataset.slot as Slot, ui = inspectionUi(slot);
      chip.dataset.state = ui.state;
      const button = chip.querySelector<HTMLButtonElement>('.analysis-chip')!;
      button.setAttribute('aria-description', ui.status);
      const progress = chip.querySelector<HTMLElement>('.analysis-track-progress')!;
      progress.setAttribute('aria-label', ui.status);
      progress.setAttribute('aria-valuenow', String(ui.percent));
      progress.setAttribute('aria-hidden', String(!ui.pending));
      progress.style.setProperty('--inspection-progress', String(100 - ui.percent));
      progress.classList.toggle('is-waiting', ui.percent === 0);
    }
    refreshDeep(); queueAutomaticStreams();
  }

  // ---- 工具条：静态控件一次装配，动态部分（轨道、菜单标签）按需刷新 ----
  const segButtons = new Map<string, HTMLButtonElement>();
  for (const b of tools.querySelectorAll<HTMLButtonElement>('[data-seg]')) segButtons.set(b.dataset.seg!, b);
  segButtons.get('full')!.onclick = () => setView(null);
  $<HTMLButtonElement>('#analysis-current').onclick = () => {
    let time = positionUs;
    if (prefs.axis === 'dts') {
      const data = session.queryBitstreamDiagrams(streamSlot()!);
      const anchor = data?.anchor;
      if (anchor?.sourceDtsUs != null) time = anchor.sourceDtsUs - data!.firstPtsUs + data!.offsetUs;
      else {
        const token = session.getPresentedFrame(streamSlot()!);
        const sample = results.get(streamSlot()!)?.samples.find(s => s.decodeOrdinal === token?.picture?.au);
        if (sample?.dtsUs == null) return;
        time = sample.dtsUs;
      }
    }
    setView(time - 500_000, time + 500_000);
  };
  const axisButtons = [...axisEl.querySelectorAll<HTMLButtonElement>('[data-axis]')];
  for (const button of axisButtons) button.onclick = () => {
    const next = button.dataset.axis as Prefs['axis'];
    if (prefs.axis === next || (next === 'dts' && !allHaveDts())) return;
    clearSharedHover(); prefs.axis = next;
    save(); refreshTools(); refreshDeep(); requestRender(); scheduleQuery(true);
  };
  const windowMenu = installChoiceMenu('analysis-window',
    BITRATE_WINDOW_OPTIONS_US.map(w => ({ value: String(w), label: WINDOW_LABELS[w] })), value => {
      prefs.windowUs = Number(value); save(); refreshTools(); scheduleQuery(true);
    });
  const layoutMenu = installChoiceMenu('analysis-layout',
    () => (['merged', 'rows'] as const).map(v => ({ value: v, label: layoutLabel(v) })), value => {
      prefs.layoutMode = value as Prefs['layoutMode']; save(); refreshTools(); render();
    });

  let toolsSig = '';
  installFilterGestures(tracksEl, signal, (button, solo) => {
    const slot = button.dataset.slot as Slot;
    if (!tracks.some(track => track.slot === slot)) return;
    inspection.invalidate(); clearSharedHover();
    prefs.selected = solo
      ? prefs.selected.length === 1 && prefs.selected[0] === slot ? tracks.map(track => track.slot) : [slot]
      : prefs.selected.includes(slot) ? prefs.selected.filter(s => s !== slot) : [...prefs.selected, slot];
    if (prefs.selected.includes(slot)) diagramSlot = slot;
    else if (diagramSlot === slot) diagramSlot = undefined;
    if (prefs.axis === 'dts' && !allHaveDts()) prefs.axis = 'pts';
    save(); refreshTools(); scheduleQuery(true);
  });
  function refreshTools() {
    const dtsOk = allHaveDts();
    const hasTracks = selectedTracks().length > 0;
    if (hasTracks && prefs.axis === 'dts' && !dtsOk) { prefs.axis = 'pts'; save(); }
    refreshDiagram();
    // 高频手势每 tick 都经过这里：DOM 重建只在签名变化时做，label 同步很便宜。
    const sig = JSON.stringify(tracks.map(t => [t.slot, t.mediaId, t.sourceGen, slotColors.get(t.slot)]));
    if (sig !== toolsSig) {
      toolsSig = sig;
      tracksEl.replaceChildren();
      for (const entry of tracks) {
        const chip = document.createElement('span'); chip.className = 'analysis-track-control';
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'analysis-chip';
        const on = prefs.selected.includes(entry.slot);
        b.dataset.slot = entry.slot;
        b.setAttribute('aria-pressed', String(on));
        chip.dataset.selected = String(on);
        b.title = on ? t(msg("analysis.hideTrack", "隐藏轨道 {slot}"), { slot: entry.slot }) : t(msg("analysis.showTrack", "显示轨道 {slot}（{name}）"), { slot: entry.slot, name: entry.name });
        const dot = document.createElement('span');
        dot.className = 'dot';
        dot.style.background = slotColors.get(entry.slot) ?? '#888';
        b.append(dot, document.createTextNode(entry.slot));
        chip.dataset.slot = entry.slot;
        const progress = document.createElement('span'); progress.className = 'analysis-track-progress';
        progress.setAttribute('role', 'progressbar'); progress.setAttribute('aria-valuemin', '0'); progress.setAttribute('aria-valuemax', '100');
        progress.innerHTML = '<svg class="analysis-progress-ring" viewBox="0 0 20 20" aria-hidden="true"><circle class="ring-track" cx="10" cy="10" r="7"/><circle class="ring-value" cx="10" cy="10" r="7" pathLength="100"/></svg>';
        b.append(progress); chip.append(b); tracksEl.append(chip);
      }
    }
    for (const chip of tracksEl.querySelectorAll<HTMLElement>('.analysis-track-control')) {
      const slot = chip.dataset.slot as Slot, on = prefs.selected.includes(slot), button = chip.querySelector<HTMLButtonElement>('.analysis-chip')!;
      chip.dataset.selected = String(on); button.setAttribute('aria-pressed', String(on));
      button.title = on ? t(msg("analysis.hideTrack", "隐藏轨道 {slot}"), { slot }) : t(msg("analysis.showTrack", "显示轨道 {slot}（{name}）"), { slot, name: tracks.find(track => track.slot === slot)?.name ?? '' });
      button.title += `\n${t(msg('analysis.trackSoloHint', '右键或长按单选此轨道，再次操作恢复全部。'))}`;
    }
    refreshStream();
    // 单一时间基准同时控制图表、当前帧号和按帧号跳转。
    for (const button of axisButtons) {
      button.setAttribute('aria-pressed', String(button.dataset.axis === prefs.axis));
      button.textContent = button.dataset.axis!.toUpperCase();
      const explanation = t(button.dataset.axis === 'pts' ? msg('analysis.presentationTime', '展示时间 PTS') : msg('analysis.decodingTime', '解码时间 DTS'));
      button.disabled = !hasTracks || (button.dataset.axis === 'dts' && !dtsOk);
      button.title = button.dataset.axis === 'dts' && !dtsOk ? `${explanation}\n${t(msg('analysis.missingDts', '所选轨道缺少可靠 DTS，无法按解码时间显示。'))}` : explanation;
    }
    const windowButton = $<HTMLButtonElement>('#analysis-window');
    windowButton.title = t(prefs.axis === 'pts' ? msg('analysis.presentationLoadWindowHint', '展示负载率：按展示时间窗口统计帧的压缩字节量，不表示网络吞吐。') : msg('analysis.decodeBitrateWindowHint', '码率：按解码时间窗口统计压缩样本负载，不表示网络吞吐。'));
    updateStatus();
    windowMenu.sync(String(prefs.windowUs), WINDOW_LABELS[prefs.windowUs] ?? '', selectedTracks().length > 0);
    layoutMenu.sync(prefs.layoutMode, layoutLabel(prefs.layoutMode), true);
    $<HTMLElement>('#analysis-layout').hidden = !overviewVisible() || selectedTracks().length < 2;
  }

  /** Static chrome follows the UI language; dynamic parts re-render below. */
  function localizeChrome() {
    tools.setAttribute('aria-label', t(msg("analysis.tools", "分析选项")));
    tracksEl.setAttribute('aria-label', t(msg("analysis.compareTracks", "对比轨道")));
    // Choice menus mirror the trigger label into the popup; refresh both ends
    // (the menu's own language listener runs before this one).
    const triggers = [
      ['analysis-axis', msg("analysis.timeBase", "时间基准"), msg("analysis.timeBaseTitle", "PTS 为展示时间，DTS 为解码时间；无可靠 DTS 的轨道不支持 DTS 视图")],
      ['analysis-window', msg("analysis.bitrateWindow", "码率窗口"), msg("analysis.bitrateWindowTitle", "码率窗口：视频样本负载码率的滑动时间窗（真实时间窗，非 N 帧窗）")],
      ['analysis-layout', msg("analysis.multiTrackLayout", "多轨布局"), msg("analysis.multiTrackLayoutTitle", "只影响码率和帧大小；NALU 与帧参考始终按轨道分开显示。")],
    ] as const;
    for (const [id, key, title] of triggers) {
      const trigger = section.querySelector(`#${id}`);
      trigger?.setAttribute('aria-label', t(key));
      trigger?.setAttribute('title', t(title));
      // Popups live on document.body, outside the panel section.
      document.getElementById(`${id}-menu`)?.setAttribute('aria-label', t(key));
    }
    const full = segButtons.get('full');
    if (full) { full.textContent = t(msg("analysis.fullRange", "完整范围")); full.title = t(msg("analysis.fullRangeTitle", "双击图也可恢复完整范围")); }
    statusEl.setAttribute('aria-label', t(msg("analysis.currentFrameNumbers", "当前上屏帧号")));
    canvas.setAttribute('aria-label', t(msg("analysis.canvasLabel", "码流分析图：码率曲线与帧大小柱。方向键移动检查位置，回车定位，Escape 退出检查。")));
  }

  function localize() {
    toolsSig = ''; status.invalidate();
    card.reset();
    localizeChrome();
    refreshTools();
    updateStatus();
    render();
  }

  /** 绘图区真实宽度：查询/x 换算/命中统一用它。 */
  const plotWidthCss = () => Math.max(1, Math.floor(plot.clientWidth || body.clientWidth));
  const scheduleQuery = (immediate = false) => queries.schedule(immediate);

  // ---- 绘制：时间分组 → 统一几何 → 绘图与命中共用 ----

  function renderSharedAxis() {
    if (!open || sharedAxisHost.hidden || !sharedAxisCtx) { sharedAxisSignature = ''; return; }
    const width = Math.max(1, Math.floor(charts.clientWidth));
    const range = viewRange(), dpr = Math.min(2, window.devicePixelRatio || 1);
    const signature = JSON.stringify([width, range, dpr, colors]);
    if (signature === sharedAxisSignature) return;
    sharedAxisSignature = signature;
    sharedAxis.style.width = `${width}px`; sharedAxis.style.height = `${AXIS_H}px`;
    sharedAxis.width = Math.round(width * dpr); sharedAxis.height = Math.round(AXIS_H * dpr);
    sharedAxisCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    sharedAxisCtx.clearRect(0, 0, width, AXIS_H);
    drawTimeAxis(sharedAxisCtx, { width, height: AXIS_H, viewStart: range.start, viewEnd: range.end, colors });
    const geometry = plotGeometry(width);
    sharedAxisCtx.strokeStyle = colors.grid; sharedAxisCtx.beginPath();
    sharedAxisCtx.moveTo(geometry.gutter, .5); sharedAxisCtx.lineTo(geometry.gutter + geometry.plotW, .5); sharedAxisCtx.stroke();
    sharedAxis.dataset.axisStart = String(range.start); sharedAxis.dataset.axisEnd = String(range.end);
    sharedAxis.dataset.plotLeft = String(geometry.gutter); sharedAxis.dataset.plotRight = String(geometry.gutter + geometry.plotW);
    sharedAxis.dataset.timeAxis = 'true';
  }

  function buildModel() {
    return buildAnalysisModel({ sel: selectedTracks(), results, prefs, range: viewRange(), width: plotWidthCss(),
      availableHeight: body.clientHeight, compact: true, showTimeAxis: !!sharedAxisHost.hidden, slotColors, colors, rubber });
  }

  function render() {
    window.clearTimeout(buildingTimer);
    if (!open || !ctx) return;
    refreshDeep(true);
    if (!overviewVisible()) return;
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
    const cssH = model.height;
    canvas.style.height = `${cssH}px`;
    overlay.style.height = `${cssH}px`;
    const w = Math.round(model.width * dpr), h = Math.round(cssH * dpr);
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    if (overlay.width !== w) overlay.width = w;
    if (overlay.height !== h) overlay.height = h;
    ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
    const drawn: CanvasModel = { ...model, height: cssH };
    canvas.dataset.axisStart = String(drawn.viewStart);
    canvas.dataset.axisEnd = String(drawn.viewEnd);
    canvas.dataset.timeAxis = String(drawn.showTimeAxis !== false);
    // 基础图层只在这里绘制；检查线/圆点/高亮走独立覆盖层，不触发底图重绘。
    drawAnalysis(ctx!, drawn);
    // 只读 QA 证据（对齐 pixel-grid 的 dataset 计数），不作可见计数器。
    canvas.dataset.analysisDrawMs = (performance.now() - renderStart).toFixed(2);
    canvas.dataset.analysisBuiltMs = builtMs.toFixed(2);
    lastModel = drawn;
    const geom = computeLayout(drawn);
    canvas.dataset.rowHeights = JSON.stringify([...(geom.bitrate ? [geom.bitrate.h] : []), ...geom.sizeRows.map(row => row.h)]);
    lastGeom = { gutter: geom.gutter, plotW: geom.plotW, width: drawn.width };
    canvas.dataset.plotLeft = String(geom.gutter); canvas.dataset.plotRight = String(geom.gutter + geom.plotW);
    lastGlyphs = (model as { glyphs?: AnalysisGlyph[] }).glyphs ?? [];
    lastGroups = (model as { groups?: TimeGroup[] }).groups ?? [];
    positionPlayhead();
    // 视图变化后把检查点重锚到光标（滚轮/捏合只动视图，不产生 pointermove），
    // 不展示过期内容；键盘检查中不抢夺焦点位置。
    const viewSig = `${drawn.viewStart}:${drawn.viewEnd}`;
    if (sharedOrigin === 'overview' && !inspection.state.kbInspect && inspection.state.hoverUs != null && inspection.state.lastClient) {
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
    // 底图重绘后卡片按当前检查位置重新限位。
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

  /** 命中样本只更新检查内容与标记；鼠标悬浮线和卡片保留连续位置。 */
  function updateInspection(clientX: number, clientY: number) {
    if (inspection.state.hoverUs == null) { inspection.state.lastInspection = null; renderFloat(null, null); refreshOverlay(); publishTestHook(); return; }
    const sel = selectedTracks();
    if (!sel.length) { inspection.state.lastInspection = null; renderFloat(null, null); refreshOverlay(); publishTestHook(); return; }
    if (inspection.state.pinned) return;
    if (inspection.state.hoverUs < chartFrameHoverStart(containerColumn())) { clearSharedHover(); return; }
    sharedPointerY = inspection.state.kbInspect ? null : clientY;
    const direct = directTargetFromGlyph(pickAt(clientX, clientY));
    // The first frame extends left of its timestamp, but its readout stays at media start.
    const insp = inspectAt(Math.max(dataDomainBounds().start, inspection.state.hoverUs), direct);
    // 键盘检查沿用样本锚点；指针位置独立于命中样本的真实时间。
    if (inspection.state.kbInspect) inspection.state.hoverUs = insp.inspectionTimeUs;
    inspection.state.lastInspection = insp;
    positionHover();
    renderFloat(insp, clientX);
    // 辅助技术播报只在键盘步进/固定时更新，不每个鼠标帧推送整段文本。
    if (inspection.state.kbInspect) live.textContent = cardText();
    refreshOverlay();
    publishTestHook();
  }

  /**
   * 独立覆盖层：检查圆点与样本高亮只画在 overlay canvas 上，
   * 不重绘基础图层（hover 扫描不增加底图绘制次数）。
   */
  function refreshOverlay() {
    drawAnalysisOverlay(overlayCtx, lastModel, lastGlyphs, inspection.state.pinned ?? inspection.state.lastInspection,
      inspection.state.hoverUs, window.devicePixelRatio || 1);
  }

  /** 只读测试快照：布局 glyph 身份与当前检查状态，供浏览器回归精确断言。
   * 只在 QA 钩子启用时构建：生产 hover 不为 2000 条 glyph 摘要与 DOM 几何读取付费。 */
  function publishTestHook() {
    try {
      const w = window as unknown as { __vpAnalysis?: unknown; __vpAnalysisQA?: boolean };
      if (!w.__vpAnalysisQA) return;
      const active = inspection.state.pinned ?? inspection.state.lastInspection;
      const plotRect = plot.getBoundingClientRect();
      const visibleCard = cardEl.hidden ? [...individualCards.values()].find(card => !card.element.hidden)?.element : cardEl;
      const flRect = visibleCard?.getBoundingClientRect() ?? null;
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
    live.textContent = cardText();
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
    retainHoverOnLeave: event => charts.matches(':hover') || (event.relatedTarget instanceof Node && hoverCardsContain(event.relatedTarget)),
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
      inspection.invalidate(); clearSharedHover();
      cardEl.hidden = true;
      for (const { panel } of deepPanels.values()) panel.hideCard();
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
      follow: false, selected: [...prefs.selected],
      numAxis: prefs.axis, diagrams: [...(prefs.diagrams ?? [])],
    };
  }

  /** 工作区还原：偏好立即生效；视图等轨道落定后按当时域钳制应用。 */
  let pendingAnalysisView: { start: number; end: number } | null | undefined;
  function applyPendingAnalysisView() {
    if (pendingAnalysisView === undefined) return;
    const v = pendingAnalysisView;
    pendingAnalysisView = undefined;
    if (v) setView(v.start, v.end);
    else setView(null);
  }
  function restoreAnalysisState(s: AnalysisViewState) {
    diagramSolo = undefined;
    diagrams = new Set(selectedAnalysisDiagrams(s));
    prefs.axis = s.axis === 'dts' ? 'dts' : 'pts';
    prefs.windowUs = BITRATE_WINDOW_OPTIONS_US.includes(s.windowUs) ? s.windowUs : DEFAULT_BITRATE_WINDOW_US;
    prefs.layoutMode = s.layoutMode === 'rows' ? 'rows' : 'merged';
    prefs.selected = s.selected.filter(x => SLOTS.includes(x as Slot)) as Slot[];
    // 以当前轨道身份为选择基准，避免后续元数据事件把快照里隐藏的轨道加回来。
    for (const e of tracks) knownTrackIds.add(`${e.slot}|${e.mediaId}`);
    save();
    refreshTools(); refreshDiagram();
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
      frameIntervalUs: t.frame?.durationUs && t.frame.durationUs > 0 ? t.frame.durationUs : 33_333,
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
      if (!entries.length || tracks.some(previous => {
        const current = entries.find(track => track.slot === previous.slot);
        return current && current.mediaId !== previous.mediaId;
      })) view = null;
      tracks = entries;
      caps = new Map(session.getAnalysisCapabilities().map(c => [c.slot as Slot, c.capability]));
      if (prefs.axis === 'dts' && !allHaveDts()) prefs.axis = 'pts';
      // 换片/清轨后旧检查与冻结快照失效，不拿旧 sampleId 定位新片源。
      inspection.invalidate();
      clearSharedHover();
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
      refreshStream();
    }
  };

  const onProgress = (pos: number) => {
    positionUs = pos;
    refreshDeep();
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
  resizer_obs.observe(charts);
  resizer_obs.observe(section);
  resizer_obs.observe($<HTMLElement>('.analysis-head'));
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
  const stopLanguage = onLanguageChange(() => {
    $<HTMLElement>('#analysis-diagrams').setAttribute('aria-label', t(msg('analysis.diagrams','分析图示')));
    refreshDiagram(); if (!signal.aborted) localize(); }, signal);

  refreshTools();
  onSession(); refreshDiagram();
  render();

  signal.addEventListener('abort', () => {
    if (deepRaf) cancelAnimationFrame(deepRaf);
    for (const { abort } of deepPanels.values()) abort.abort();
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
    windowMenu.dispose();
    layoutMenu.dispose();
  }, { once: true });

  return { setOpen, getAnalysisState, restoreAnalysisState, refreshTarget: refreshStream };
}
