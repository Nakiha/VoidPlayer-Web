import type { InspectionState } from '../../../shared/analysis/metadata/inspection.ts';
import type { AnalysisDiagram } from '../../../shared/analysis/metadata/types.ts';
import { msg, t } from '../../i18n.ts';
import type { Slot } from '../../../shared/review/model.ts';
import { computeLayout, formatAxis, plotGeometry } from './canvas.ts';
import type { CanvasModel } from './canvas.ts';
import { layoutAnalysisCards } from './geometry.ts';
import { chartHoverStyle, CHART_HOVER_STYLE_EVENT } from '../chart-hover-style.ts';
import type { BitstreamDiagram, installBitstreamDiagrams } from './bitstream-diagrams.ts';
import { analysisTrackBadge, installAnalysisCard, installFloatingAnalysisCard } from './card.ts';
import type { ChartHover } from './shared.ts';

export interface DeepDiagramEntry {
  mode: BitstreamDiagram;
  slot: Slot;
  host: HTMLElement;
  panel: ReturnType<typeof installBitstreamDiagrams>;
}

export interface AnalysisHoverCardsDeps {
  signal: AbortSignal;
  section: HTMLElement;
  charts: HTMLElement;
  canvas: HTMLCanvasElement;
  slotColors: () => Map<Slot, string>;
  pinned: () => boolean;
  visibleRows: () => { bitrate: boolean; size: boolean; qp: boolean };
  qpAt: (slot: Slot, time: number) => number | null;
  avoid: () => DOMRect | undefined;
  overviewVisible: () => boolean;
  lastModel: () => CanvasModel | null;
  naluGroup: (slot: Slot) => HTMLElement | undefined;
  deepFor: (mode: BitstreamDiagram, slot: Slot) => DeepDiagramEntry | undefined;
  deepPanels: () => Iterable<DeepDiagramEntry>;
  deepPanelCount: () => number;
  diagrams: () => ReadonlySet<AnalysisDiagram>;
  tracks: () => readonly { slot: Slot; name: string }[];
  viewRange: () => { start: number; end: number };
  sharedHover: () => ChartHover | null;
  sharedPointerY: () => number | null;
  hoverUs: () => number | null;
  activeInspection: () => InspectionState | null;
  lastClientX: () => number | null;
  fracToPx: (t: number) => number;
  trackHover: (slot: Slot, value: ChartHover, snapshot?: InspectionState | null) => ChartHover;
  clearSharedHover: () => void;
}

export function installAnalysisHoverCards(deps: AnalysisHoverCardsDeps) {
  const {
    signal, section, charts, canvas, slotColors, pinned, visibleRows, qpAt, avoid,
    overviewVisible, lastModel, naluGroup, deepFor, deepPanels, deepPanelCount, diagrams,
    tracks, viewRange, sharedHover, sharedPointerY, hoverUs, activeInspection,
    lastClientX, fracToPx, trackHover, clearSharedHover,
  } = deps;

  // 悬浮卡片挂在 body 顶层（fixed），彻底脱离分析面板的 overflow 裁剪；
  // abort 时移除，平时 pointer-events:none 不拦截输入。
  const card = installAnalysisCard(canvas, {
    signal, colors: slotColors, pinned, visibleRows,
    qpValue: (slot, time) => qpAt(slot, time), avoid,
    panelBounds: () => section.getBoundingClientRect(),
  });
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
      const model = lastModel();
      const plotHeight = model ? computeLayout(model).axisY : rect.height;
      return new DOMRect(rect.left, rect.top, rect.width, plotHeight);
    }
    const [kind, slot] = group.split(':') as ['nalu' | 'references', Slot];
    if (kind === 'nalu') return (naluGroup(slot) ?? deepFor('nalu-size', slot)?.host ?? deepFor('nalu-types', slot)?.host)?.getBoundingClientRect();
    return deepFor('references', slot)?.host.getBoundingClientRect();
  }

  const overviewCard = installAnalysisCard(canvas, {
    signal, colors: slotColors, pinned, visibleRows,
    qpValue: (slot, time) => qpAt(slot, time), avoid,
    panelBounds: () => cardGroupBounds('overview') ?? canvas.getBoundingClientRect(), beside: true,
  });
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
  function hoverCardsContain(node: Node) { return cardEl.contains(node) || [...individualCards.values()].some(c => c.element.contains(node)); }
  function cardText() { return cardEl.hidden ? [...individualCards.values()].filter(c => !c.element.hidden).map(c => c.element.textContent).join(' · ') : cardEl.textContent ?? ''; }
  function visibleCard() { return cardEl.hidden ? [...individualCards.values()].find(c => !c.element.hidden)?.element : cardEl; }

  function detailPanels() {
    return [...deepPanels()].filter(entry => entry.mode !== 'nalu-types' || !deepFor('nalu-size', entry.slot));
  }

  function positionIndividualCards() {
    const hover = sharedHover();
    if (!hover || chartHoverStyle() !== 'separate') return;
    const clip = charts.getBoundingClientRect();
    const pending: { card: { element: HTMLElement; position(x: number, y?: number): void }; x: number; height: number; preferredTop: number; order: number; top: number; bottom: number; centerY: number }[] = [];
    const widths = new Map<string, number>();
    const pointerY = sharedPointerY();
    for (const [mode, c] of individualCards) {
      const rect = cardGroupBounds(mode);
      if (!rect) { c.element.hidden = true; continue; }
      const top = Math.max(8, clip.top, rect.top) + 2;
      const bottom = Math.min(innerHeight - 8, clip.bottom, rect.bottom) - 2;
      if (bottom - top < 24) { c.element.hidden = true; continue; }
      const time = mode === 'overview' ? hoverUs() ?? hover.timeUs : hover.cursorTimeUs ?? hover.timeUs;
      const geometry = plotGeometry(rect.width);
      const range = viewRange(), x = rect.left + geometry.gutter + (time - range.start) / Math.max(1, range.end - range.start) * geometry.plotW;
      c.element.hidden = false;
      c.element.style.width = '';
      c.position(x, 0);
      const kind = c.element.dataset.diagram!;
      widths.set(kind, Math.max(widths.get(kind) ?? 0, c.element.offsetWidth));
      const height = c.element.offsetHeight;
      // Prefer the owner's centre in a stack, or follow the pointer in a single chart.
      // Keep full height when the owner is too short, then move neighbouring cards.
      const centerY = Number(overviewVisible()) + deepPanelCount() > 1 || pointerY == null ? (top + bottom) / 2 : pointerY;
      const preferredTop = height <= bottom - top ? Math.max(top, Math.min(bottom - height, centerY - height / 2)) : centerY - height / 2;
      pending.push({ card: c, x, height, preferredTop, order: rect.top, top, bottom, centerY });
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

  const positionFloat = (x: number) => chartHoverStyle() === 'separate' ? positionIndividualCards() : card.position(x);

  /** 区间编辑器开合或移动后重算卡片避让：与视口两个拖拽面板同一契约。 */
  function refreshCardAvoidance() {
    const x = lastClientX() ?? canvas.getBoundingClientRect().left + fracToPx(hoverUs() ?? 0);
    positionFloat(x);
  }

  function renderIndividual(snapshot: InspectionState) {
    const hover = sharedHover()!;
    const activeDiagrams = diagrams();
    cardEl.hidden = true;
    if (overviewVisible()) { overviewCard.render(snapshot, null); overviewCard.element.dataset.hoverTime = String(hover.timeUs); }
    for (const { mode, slot, host, panel } of detailPanels()) {
      const kind = mode === 'references' ? 'references' : 'nalu';
      const group: CardGroup = `${kind}:${slot}`;
      let floating = individualCards.get(group);
      if (!floating) {
        floating = installFloatingAnalysisCard(host.querySelector('canvas')!, signal, () => cardGroupBounds(group) ?? host.getBoundingClientRect(), true, avoid);
        floating.element.classList.add('analysis-view-card'); floating.element.dataset.diagram = kind; floating.element.dataset.slot = slot;
        floating.managePosition(individualLayer);
        individualCards.set(group, floating); retainCardLeave(floating.element);
      }
      floating.element.replaceChildren(panel.details(trackHover(slot, hover, snapshot), { size: activeDiagrams.has('nalu-size'), types: activeDiagrams.has('nalu-types') }).element);
      floating.element.dataset.hoverTime = String(hover.timeUs);
    }
    positionIndividualCards();
  }

  function renderCombined(snapshot: InspectionState, x: number | null) {
    if (chartHoverStyle() === 'separate') { renderIndividual(snapshot); return; }
    hideIndividualCards();
    const hover = sharedHover()!;
    const activeDiagrams = diagrams();
    const currentTracks = tracks();
    // Reuse canonical metric formatting, but keep each track's readouts together.
    overviewCard.render(snapshot, null); overviewCard.element.hidden = true;
    const overview = overviewCard.element.querySelector<HTMLTableElement>('.analysis-overview-grid')!;
    cardEl.replaceChildren(); cardEl.hidden = false;
    const modes: BitstreamDiagram[] = [];
    if (activeDiagrams.has('nalu-size')) modes.push('nalu-size'); else if (activeDiagrams.has('nalu-types')) modes.push('nalu-types');
    if (activeDiagrams.has('references')) modes.push('references');
    const widths = [...(overviewVisible() ? [180] : []), ...modes.map(mode => mode === 'references' ? 240 : 250)];
    for (const [index, track] of snapshot.tracks.entries()) {
      const row = document.createElement('article'); row.className = 'analysis-track-details'; row.dataset.slot = track.slot;
      const heading = document.createElement('div'); heading.className = 'analysis-card-track';
      const badge = analysisTrackBadge(track.slot);
      const name = document.createElement('span'); name.textContent = currentTracks.find(entry => entry.slot === track.slot)?.name ?? ''; name.className = 'analysis-card-track-name';
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
        const title = document.createElement('strong'); title.textContent = mode === 'references' ? t(msg('analysis.referenceSection', '帧参考')) : 'NALU';
        part.style.setProperty('--section-width', mode === 'references' ? '240px' : '250px');
        const { element: contents, timeUs } = entry.panel.details(trackHover(track.slot, hover, snapshot), {
          size: activeDiagrams.has('nalu-size'), types: activeDiagrams.has('nalu-types'), header: false,
        });
        if (timeUs !== undefined) hitTimeUs = timeUs;
        part.append(title, contents); grid.append(part);
      }
      time.dataset.hitTime = hitTimeUs === undefined ? '' : String(hitTimeUs);
      time.textContent = hitTimeUs === undefined ? '—' : `${formatAxis(hitTimeUs)} · ${snapshot.axis.toUpperCase()}`;
      cardEl.append(row);
    }
    cardEl.style.setProperty('--combined-card-width', `${widths.reduce((sum, width) => sum + width, 0) + Math.max(0, widths.length - 1) * 8 + 18}px`);
    cardEl.dataset.hoverTime = String(hover.timeUs);
    card.position(x ?? canvas.getBoundingClientRect().left + fracToPx(hoverUs() ?? snapshot.inspectionTimeUs));
  }

  window.addEventListener(CHART_HOVER_STYLE_EVENT, () => {
    hideIndividualCards(); cardEl.hidden = true;
    const active = activeInspection();
    if (sharedHover() && active) renderCombined(active, lastClientX());
  }, { signal });
  charts.addEventListener('scroll', positionIndividualCards, { signal, capture: true });
  charts.addEventListener('pointerleave', event => {
    if (!(event.relatedTarget instanceof Node) || !hoverCardsContain(event.relatedTarget)) clearSharedHover();
  }, { signal });
  cardEl.addEventListener('pointerleave', event => {
    if (!(event.relatedTarget instanceof Node) || !charts.contains(event.relatedTarget)) clearSharedHover();
  }, { signal });
  charts.addEventListener('keydown', event => { if (event.key === 'Escape' && !pinned()) clearSharedHover(); }, { signal });

  return {
    cardEl,
    reset: () => card.reset(),
    hideAll: () => { cardEl.hidden = true; hideIndividualCards(); },
    contains: hoverCardsContain,
    text: cardText,
    visibleCard,
    positionIndividual: positionIndividualCards,
    positionFloat,
    refreshAvoidance: refreshCardAvoidance,
    renderCombined,
  };
}
