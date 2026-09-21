import { installSourceActivity } from './source-activity.ts';
import { installTrackColumnResize } from './track-column-resize.ts';
import { installResizeGesture } from './resize-gesture.ts';
import { installPanelMotion, animatePanelLayout } from './panel-motion.ts';
import { installPanelResize } from './panel-resize.ts';
import type { ReviewSession } from '../session.ts';
import type { Slot } from '../model.ts';
import { installAnnotationPanel } from './annotation-panel.ts';
import { installAnalysisPanel } from './analysis-panel.ts';
import { WorkspaceState } from './workspace-state.ts';
import type { Panel } from './workspace-state.ts';
import { SourceCatalog } from './source-catalog.ts';
import { createTracksPane } from './workbench/tracks.ts';
import { createSourcesPane } from './workbench/sources.ts';
import type { WorkbenchShared, WorkbenchState } from './workbench/shared.ts';

type Action = (action: () => unknown | Promise<unknown>, name?: string, data?: unknown) => Promise<void>;
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const HISTORY_KEY = 'voidplayer.sources.v1';
function readHistory() { try { return JSON.parse(localStorage.getItem(HISTORY_KEY) ?? '[]'); } catch { return []; } }

export function installWorkbench(session: ReviewSession, act: Action, addMark: (slot: Slot, markId?: string) => void, notify: (message: string) => void = () => {}) {
  const view = new WorkspaceState();
  const catalog = new SourceCatalog(readHistory());
  const lifecyle = new AbortController();
  installSourceActivity(session, lifecyle.signal);
  const workspace = $('workspace');
  const trackColumns = installTrackColumnResize(document.querySelector<HTMLElement>('.subtrack-scroll')!, $('track-label-resize'), lifecyle.signal);
  const panelMotion = installPanelMotion(workspace, lifecyle.signal);
  const panelResize = installPanelResize(workspace, lifecyle.signal, panel => {
    setPanel(panel, false); $(`toggle-${panel}`).focus();
  });
  let dockHeight = Number.parseFloat(getComputedStyle(workspace).getPropertyValue('--dock-default-height')) || 180;
  const save = () => { try { localStorage.setItem(HISTORY_KEY, JSON.stringify(catalog.serializable())); } catch { /* Session access still works when storage is disabled/full. */ } };
  const annotationHeightDelta = () => {
    const style = getComputedStyle(workspace);
    return Number.parseFloat(style.getPropertyValue('--annotation-cards-height')) - Number.parseFloat(style.getPropertyValue('--annotation-symbols-height'));
  };
  const annotations = installAnnotationPanel(ptsUs => void act(() => session.seek(ptsUs), 'ui.mark-seek'), id => void act(() => session.deleteMark(id), 'ui.mark-delete'), (id, ptsUs, slot) => void act(async () => { select(slot); await session.seek(ptsUs); addMark(slot, id); }, 'ui.mark-edit'), open => resize(dockHeight + (open ? 1 : -1) * annotationHeightDelta()));

  // Panes must not call shared callbacks at factory top level: select/render
  // are hoisted function declarations, but resize/sources resolve later.
  const shared: WorkbenchShared = {
    session, act, addMark, view, catalog, workspace, lifecyle, save, notify,
    select, inspect, setPanel,
    render: state => render(state),
    renderSources: () => sources.renderSources(),
    resize: value => resize(value), dockHeight: () => dockHeight, annotationHeightDelta,
  };
  const tracks = createTracksPane(shared);
  const sources = createSourcesPane(shared);
  sources.wireSourceControls();
  const analysis = installAnalysisPanel(session, act, { signal: lifecyle.signal, isOpen: () => view.panels.analysis });

  function select(slot: Slot) {
    view.selected = slot;
    tracks.resetInspectorSignature();
    render(session.getState());
  }
  function syncPanels() {
    for (const panel of ['inspector', 'subtracks', 'sources', 'analysis'] as Panel[]) {
      const open = view.panels[panel];
      panelMotion.set(panel, open);
      $(`toggle-${panel}`).setAttribute('aria-expanded', String(open));
      $(`toggle-${panel}`).title = `${open ? '收起' : '展开'}${{ inspector: '轨道信息', subtracks: '子轨道', sources: '片源', analysis: '码流分析' }[panel]}`;

    }
    analysis.setOpen(view.panels.analysis);
  }
  function setPanel(panel: Panel, open: boolean) {
    view.setPanel(panel, open, window.innerWidth);
    syncPanels();
    panelResize.refresh();
    if (!open) { tracks.hideSeekPreview(); annotations.hidePreview(); }
    render(session.getState());
    if (panel === 'sources' && open) {
      sources.renderSources();
      sources.ensureLibrary();
    }
  }
  for (const panel of ['inspector', 'subtracks', 'sources', 'analysis'] as Panel[]) {
    $(`toggle-${panel}`).onclick = () => setPanel(panel, !view.panels[panel]);
  }
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-close-panel]')) {
    button.onclick = () => {
      const panel = button.dataset.closePanel as Panel;
      setPanel(panel, false); $(`toggle-${panel}`).focus();
    };
  }
  function inspect(slot: Slot) {
    const close = view.panels.inspector && view.selected === slot;
    select(slot); setPanel('inspector', !close);
  }
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-inspect]')) button.onclick = () => inspect(button.dataset.inspect as Slot);

  function renderProgress(positionUs: number, durationUs: number) {
    tracks.renderProgress(positionUs, durationUs);
  }
  function render(state: WorkbenchState) {
    view.reconcile(state.tracks);
    if (!state.tracks.length && view.panels.subtracks) { view.panels.subtracks = false; syncPanels(); }
    if (!state.tracks.length && view.panels.analysis) { view.panels.analysis = false; syncPanels(); }
    if (view.panels.inspector) tracks.renderInspector(state);
    if (view.panels.subtracks) tracks.renderDock(state, annotations);
    const addMarkButton = $<HTMLButtonElement>('subtrack-add-mark');
    addMarkButton.disabled = !state.tracks.length;
    addMarkButton.setAttribute('aria-disabled', String(!state.tracks.length || state.busy));
    sources.syncCatalog(state);
    sources.syncLoadVisuals(state);
  }

  const resizer = $('dock-resize');
  const dock = $('subtracks-panel');
  const dockBounds = () => {
    const max = Math.round(Math.min(420, window.innerHeight * .55));
    const min = annotations.expanded() ? Number.parseFloat(getComputedStyle(dock).getPropertyValue('--annotation-cards-height')) + 90 : 128;
    return { min: Math.min(min, max), max };
  };
  const resize = (value: number) => {
    const { min, max } = dockBounds();
    dockHeight = Math.round(Math.max(min, Math.min(max, value)));
    workspace.style.setProperty('--dock-height', `${dockHeight}px`);
    resizer.setAttribute('aria-valuemin', String(min)); resizer.setAttribute('aria-valuemax', String(max));
    resizer.setAttribute('aria-valuenow', String(dockHeight)); resizer.setAttribute('aria-valuetext', `${dockHeight} 像素`);
  };
  installResizeGesture(resizer, {
    axis: 'y', direction: -1, size: () => dockHeight, bounds: dockBounds, resize,
    threshold: () => Number.parseFloat(getComputedStyle(workspace).getPropertyValue('--panel-collapse-distance')),
    reset: () => Number.parseFloat(getComputedStyle(workspace).getPropertyValue('--dock-default-height')) + (annotations.expanded() ? annotationHeightDelta() : 0),
    dragging(active) { workspace.classList.toggle('panel-dragging', active); dock.classList.toggle('panel-pushing', active); if (!active) animatePanelLayout(workspace); },
    preview(push, veil) { workspace.style.setProperty('--dock-push-space', `${push}px`); dock.style.setProperty('--panel-push', `${push}px`); dock.style.setProperty('--panel-veil-opacity', String(veil)); },
    collapse() { setPanel('subtracks', false); $('toggle-subtracks').focus(); },
  }, lifecyle.signal);
  // 顶部码流分析面板：与底部子轨道同一套高度手势（下拉放大、上推过阈值收起）。
  const analysisPanel = $('analysis-panel');
  const analysisResizer = $('analysis-resize');
  const ANALYSIS_HEIGHT_KEY = 'voidplayer.analysis-height.v1';
  const analysisDefaultHeight = () => Number.parseFloat(getComputedStyle(workspace).getPropertyValue('--analysis-default-height')) || 220;
  let analysisHeight = analysisDefaultHeight();
  try {
    const savedRaw = localStorage.getItem(ANALYSIS_HEIGHT_KEY);
    const savedHeight = savedRaw == null ? NaN : Number(JSON.parse(savedRaw));
    if (Number.isFinite(savedHeight) && (savedHeight as number) > 0) analysisHeight = savedHeight as number;
  } catch { /* 高度偏好缺失时用主题默认值。 */ }
  const analysisBounds = () => {
    const max = Math.round(Math.min(420, window.innerHeight * .55));
    return { min: Math.min(140, max), max };
  };
  const applyAnalysisHeight = (value: number) => {
    const { min, max } = analysisBounds();
    analysisHeight = Math.round(Math.max(min, Math.min(max, value)));
    workspace.style.setProperty('--analysis-height', `${analysisHeight}px`);
    analysisResizer.setAttribute('aria-valuemin', String(min)); analysisResizer.setAttribute('aria-valuemax', String(max));
    analysisResizer.setAttribute('aria-valuenow', String(analysisHeight)); analysisResizer.setAttribute('aria-valuetext', `${analysisHeight} 像素`);
    try { localStorage.setItem(ANALYSIS_HEIGHT_KEY, JSON.stringify(analysisHeight)); } catch { /* 高度偏好可选。 */ }
  };
  installResizeGesture(analysisResizer, {
    axis: 'y', direction: 1, size: () => analysisHeight, bounds: analysisBounds, resize: applyAnalysisHeight,
    threshold: () => Number.parseFloat(getComputedStyle(workspace).getPropertyValue('--panel-collapse-distance')),
    reset: analysisDefaultHeight,
    dragging(active) { workspace.classList.toggle('panel-dragging', active); analysisPanel.classList.toggle('panel-pushing', active); if (!active) animatePanelLayout(workspace); },
    preview(push, veil) { workspace.style.setProperty('--analysis-push-space', `${-push}px`); analysisPanel.style.setProperty('--panel-push', `${push}px`); analysisPanel.style.setProperty('--panel-veil-opacity', String(veil)); },
    collapse() { setPanel('analysis', false); $('toggle-analysis').focus(); },
  }, lifecyle.signal);
  window.addEventListener('resize', () => {
    resize(dockHeight);
    applyAnalysisHeight(analysisHeight);
  }, { signal: lifecyle.signal });
  applyAnalysisHeight(analysisHeight);
  resize(dockHeight); syncPanels();
  void sources.refreshLibrary();
  return {
    render, renderProgress, refreshLibrary: () => sources.refreshLibrary(), selected: () => view.selected,
    rememberFile(file: File) { sources.rememberFile(file); },
    getState: () => ({ panels: { ...view.panels }, selected: view.selected, dockHeight, marksExpanded: annotations.expanded(), filenameWidth: trackColumns.width(), sources: sources.sourcesLayout(), analysisView: analysis.getAnalysisState() }),
    async restore(layout: import('../workspace-file.ts').WorkspaceLayout) {
      view.panels = { ...layout.panels, analysis: layout.panels.analysis ?? false }; view.selected = layout.selected;
      annotations.setExpanded(layout.marksExpanded); resize(layout.dockHeight);
      if (layout.filenameWidth !== undefined) trackColumns.resize(layout.filenameWidth);
      if (layout.analysisView) analysis.restoreAnalysisState(layout.analysisView);
      const sourcesState = layout.sources ?? { tab: 'available', query: '', root: '', directory: '', search: '', all: false };
      const browsing = sources.beginRestore(sourcesState);
      tracks.resetSignatures();
      syncPanels(); panelResize.refresh(); render(session.getState());
      await sources.finishRestore(browsing);
    },
    dispose() { sources.markDisposed(); annotations.dispose(); lifecyle.abort(); },
  };
}
