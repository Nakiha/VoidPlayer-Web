import { msg, t } from '../../i18n.ts';
import { formatTime } from '../../model.ts';
import type { Slot } from '../../model.ts';
import { panTimeRange, zoomOverviewRange } from '../../analysis/projection.ts';
import type { ReviewSession } from '../../session.ts';
import { installTimeInput, parseTimeInput } from '../../time-input.ts';
import { AXIS_H, drawTimeAxis, formatAxis, plotGeometry } from '../analysis-canvas.ts';
import type { CanvasColors } from '../analysis-canvas.ts';
import { bindMenuTrigger } from '../menu.ts';
import { installChartNavigation } from './chart-navigation.ts';
import { MIN_ANALYSIS_SPAN_US as MIN_SPAN_US } from './shared.ts';
import type { AnalysisAction as Action } from './shared.ts';

export interface AnalysisRangeEditorDeps {
  signal: AbortSignal;
  charts: HTMLElement;
  rangeTrigger: HTMLButtonElement;
  session: ReviewSession;
  act: Action;
  isOpen: () => boolean;
  axis: () => 'pts' | 'dts';
  positionUs: () => number;
  durationUs: () => number;
  hasTracks: () => boolean;
  selectedTracks: () => { slot: Slot; offsetUs: number; durationUs: number }[];
  dataDomainBounds: () => { start: number; end: number };
  domainBounds: (visibleSpan?: number) => { start: number; end: number };
  fullRange: () => { start: number; end: number };
  viewRange: () => { start: number; end: number };
  setView: (start: number | null, end?: number) => void;
  colors: () => CanvasColors;
  slotColors: () => Map<Slot, string>;
  clearSharedHover: () => void;
  refreshCardAvoidance: () => void;
  syncHeadStack: () => void;
}

export function installAnalysisRangeEditor(deps: AnalysisRangeEditorDeps) {
  const {
    signal, charts, rangeTrigger, session, act, isOpen, axis, positionUs, durationUs,
    hasTracks, selectedTracks, dataDomainBounds, domainBounds, fullRange, viewRange,
    setView, colors, slotColors, clearSharedHover, refreshCardAvoidance, syncHeadStack,
  } = deps;

  const sharedAxisHost = document.createElement('div'); sharedAxisHost.className = 'analysis-shared-axis'; sharedAxisHost.hidden = true;
  const sharedAxis = document.createElement('canvas'); sharedAxis.id = 'analysis-shared-axis'; sharedAxis.setAttribute('aria-hidden', 'true');
  sharedAxisHost.append(sharedAxis); charts.after(sharedAxisHost);
  const rangeNavigation = document.createElement('div'); rangeNavigation.className = 'analysis-range-navigation';
  // 区间轨道没有刻度标签：只留一点边距，把手和胶囊贴近面板两侧。
  const RAIL_INSET = 10;
  const rangeAxis = document.createElement('canvas'); rangeAxis.id = 'analysis-range-axis';
  rangeAxis.tabIndex = 0; rangeAxis.setAttribute('role', 'slider');
  const rangeLabel = document.createElement('span'); rangeLabel.className = 'analysis-range-label';
  const rangePlayhead = document.createElement('span'); rangePlayhead.className = 'analysis-range-playhead'; rangePlayhead.setAttribute('aria-hidden', 'true');
  const rangeEditor = document.createElement('div'); rangeEditor.id = 'analysis-range-editor'; rangeEditor.className = 'popup-menu analysis-range-editor';
  rangeEditor.setAttribute('popover', 'auto'); rangeEditor.setAttribute('role', 'dialog');
  const rangeError = document.createElement('p'); rangeError.className = 'analysis-range-error'; rangeError.setAttribute('role', 'status'); rangeError.hidden = true;
  rangeNavigation.append(rangeAxis, rangeLabel, rangePlayhead); rangeLabel.hidden = true;
  rangeEditor.append(rangeNavigation, rangeError); document.body.append(rangeEditor);

  let sharedAxisSignature = '';
  const sharedAxisCtx = sharedAxis.getContext('2d');
  const rangeAxisCtx = rangeAxis.getContext('2d');

  const closeRangeEditor = () => {
    cancelRangeEdits();
    if (rangeEditor.matches(':popover-open')) rangeEditor.hidePopover();
    rangeTrigger.setAttribute('aria-expanded', 'false');
  };
  // 打开/关闭由显式点击处理（与项目下拉菜单同一契约）：原生 popovertarget 在
  // “按下轻触关闭 + 点击再打开”的竞态里会让触发器无法重新打开面板。
  const openRangeEditor = () => { if (!rangeTrigger.disabled && !rangeEditor.matches(':popover-open')) rangeEditor.showPopover(); };
  bindMenuTrigger(rangeTrigger, rangeEditor, openRangeEditor, closeRangeEditor, signal);

  // 与触发按钮居中对齐；放不下时翻到上方，并始终留在视口内。
  function positionRangeEditor() {
    if (!rangeEditor.matches(':popover-open')) return;
    const rect = rangeTrigger.getBoundingClientRect(), width = rangeEditor.offsetWidth, height = rangeEditor.offsetHeight;
    const gap = 6, margin = 8;
    rangeEditor.style.left = `${Math.max(margin, Math.min(innerWidth - width - margin, rect.left + (rect.width - width) / 2))}px`;
    rangeEditor.style.top = `${Math.max(margin, rect.bottom + gap + height <= innerHeight - margin ? rect.bottom + gap : rect.top - height - gap)}px`;
    refreshCardAvoidance();
  }

  rangeEditor.addEventListener('toggle', () => {
    const expanded = rangeEditor.matches(':popover-open'); rangeTrigger.setAttribute('aria-expanded', String(expanded));
    if (!expanded) { refreshCardAvoidance(); return; }
    ensureRangeEditors(); rangeError.hidden = true; rangeBand.focus({ preventScroll: true });
    sharedAxisSignature = ''; renderSharedAxis(); positionRangeEditor();
  }, { signal });
  rangeEditor.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeRangeEditor(); rangeTrigger.focus(); } }, { signal });
  window.addEventListener('resize', () => { if (rangeEditor.matches(':popover-open')) { sharedAxisSignature = ''; renderSharedAxis(); positionRangeEditor(); } }, { signal });
  // 工具条可横向滚动：触发按钮移动时编辑器跟随，锚定关系不脱钩。
  rangeTrigger.closest('.analysis-tools')?.addEventListener('scroll', positionRangeEditor, { signal, passive: true });
  // 触发按钮的标签随区间变化；居中锚定必须跟随按钮自身的宽度。
  const rangeTriggerObs = new ResizeObserver(() => { positionRangeEditor(); syncHeadStack(); });
  rangeTriggerObs.observe(rangeTrigger);
  // 编辑器自身的高度也会随胶囊换行变化，卡片避让要跟着新的矩形重算。
  const rangeEditorObs = new ResizeObserver(() => { positionRangeEditor(); refreshCardAvoidance(); });
  rangeEditorObs.observe(rangeEditor);
  signal.addEventListener('abort', () => { closeRangeEditor(); rangeTriggerObs.disconnect(); rangeEditorObs.disconnect(); rangeEditor.remove(); }, { once: true });

  function rangeGeometry() { return plotGeometry(Math.max(1, rangeNavigation.clientWidth || Math.min(460, innerWidth - 48)), RAIL_INSET, RAIL_INSET); }
  /** 编辑器打开时作为顶部面板内的浮层对等方：悬浮卡片据此避让。 */
  const rangeEditorBounds = () => rangeEditor.matches(':popover-open') ? rangeEditor.getBoundingClientRect() : undefined;

  const rangeBand = document.createElement('span'); rangeBand.className = 'analysis-window-band'; rangeBand.tabIndex = 0; rangeBand.setAttribute('role', 'slider');
  const rangeHandles = (['start', 'end'] as const).map(edge => {
    const button = document.createElement('button'); button.type = 'button'; button.className = `analysis-window-handle ${edge}`;
    button.dataset.edge = edge; button.setAttribute('role', 'slider');
    return button;
  });
  rangeNavigation.append(rangeBand, ...rangeHandles);
  const rangeHover = document.createElement('span'); rangeHover.className = 'analysis-range-hover'; rangeHover.hidden = true; rangeHover.setAttribute('aria-hidden', 'true'); rangeNavigation.append(rangeHover);
  let rangeHoverClientX: number | undefined;
  const rangeTimes = (['start', 'current', 'end', 'hover'] as const).map(kind => {
    const time = document.createElement('time'); time.className = `analysis-range-time ${kind}`;
    time.hidden = kind === 'hover';
    time.id = `analysis-range-time-${kind}`; rangeNavigation.append(time); return time;
  });

  // 起止胶囊：点击后原位切换为时间输入，回车/失焦提交、Escape 还原。
  // 草稿归输入框自己（installTimeInput），外部刷新只写显示文本，不覆盖未提交的编辑。
  type RangeEdge = 'start' | 'end';
  const rangeEdges = new Map<RangeEdge, { pill: HTMLElement; text: HTMLElement; input: HTMLInputElement; label: string }>();
  let rangeEditorsReady = false;
  for (const [edge, index] of [['start', 0], ['end', 2]] as const) {
    const pill = rangeTimes[index];
    const text = document.createElement('span'); text.className = 'analysis-range-time-text';
    const input = document.createElement('input'); input.className = 'analysis-range-time-input';
    input.id = `analysis-range-input-${edge}`; input.type = 'text'; input.autocomplete = 'off'; input.spellcheck = false; input.hidden = true;
    pill.classList.add('editable'); pill.tabIndex = 0; pill.setAttribute('role', 'button');
    pill.append(text, input);
    rangeEdges.set(edge, { pill, text, input, label: '' });
  }
  const edgeIndex: Record<RangeEdge, number> = { start: 0, end: 1 };
  const edgeValue = (edge: RangeEdge) => {
    const domain = dataDomainBounds(), range = viewRange();
    return edge === 'start' ? Math.max(domain.start, range.start) : Math.min(domain.end, range.end);
  };

  /** 胶囊显示文本与可访问名称跟随把手；编辑中的输入框不受影响。 */
  function syncRangeEdges() {
    for (const [edge, state] of rangeEdges) {
      const value = rangeHandles[edgeIndex[edge]].getAttribute('aria-valuetext') ?? formatAxis(edgeValue(edge));
      if (state.text.textContent !== value) state.text.textContent = value;
      state.pill.setAttribute('aria-label', state.label ? `${state.label} ${value}` : value);
    }
  }

  /** 结束编辑态：恢复显示文本并清掉线框标记（可重复调用）。 */
  function endRangeEdit(edge: RangeEdge) {
    const { pill, text, input } = rangeEdges.get(edge)!;
    input.hidden = true; text.style.visibility = ''; pill.removeAttribute('data-editing');
    layoutRangeTimes();
  }

  /** 放弃未提交的草稿：还原为当前区间值再失焦（提交随后因值未变而空转）。 */
  function cancelRangeEdits() {
    for (const [edge, { input }] of rangeEdges) {
      if (input.hidden) continue;
      input.value = formatAxis(edgeValue(edge));
      input.blur();
      // 失焦事件在窗口未聚焦时可能不到达，外观必须自行复位。
      rangeError.hidden = true;
      endRangeEdit(edge);
    }
  }

  /** 首次打开才接线：installTimeInput 立即读取会话范围，须等视图函数就绪。 */
  function ensureRangeEditors() {
    if (rangeEditorsReady) return;
    rangeEditorsReady = true;
    for (const edge of ['start', 'end'] as const) {
      const { pill, text, input } = rangeEdges.get(edge)!;
      const show = () => {
        if (!input.hidden) return;
        rangeError.hidden = true;
        // 编辑框精确覆盖文字盒：胶囊高度、位置与字号在编辑期间完全不变。
        // 绝对定位的 left/top 相对内边距盒，描边宽度按实际计算值扣除。
        const box = text.getBoundingClientRect(), pillBox = pill.getBoundingClientRect();
        const pillStyle = getComputedStyle(pill);
        input.style.left = `${box.left - pillBox.left - (parseFloat(pillStyle.borderLeftWidth) || 0)}px`;
        input.style.top = `${box.top - pillBox.top - (parseFloat(pillStyle.borderTopWidth) || 0)}px`;
        input.style.width = `${box.width}px`; input.style.height = `${box.height}px`;
        text.style.visibility = 'hidden'; input.hidden = false; pill.dataset.editing = 'true';
        layoutRangeTimes(); input.focus(); input.select();
      };
      let keyboardExit = false;
      pill.addEventListener('click', show, { signal });
      pill.addEventListener('keydown', event => {
        if (event.target === input) return;
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); show(); }
      }, { signal });
      input.addEventListener('keydown', event => { if (event.key === 'Escape' || event.key === 'Enter') keyboardExit = true; }, { signal, capture: true });
      input.addEventListener('focus', () => { keyboardExit = false; }, { signal });
      input.addEventListener('blur', () => {
        rangeError.hidden = true; endRangeEdit(edge);
        // 键盘提交/取消后焦点回到胶囊，下一次 Escape 才能关闭编辑器。
        if (keyboardExit) { keyboardExit = false; pill.focus({ preventScroll: true }); }
      }, { signal });
      installTimeInput(input, {
        read: () => edgeValue(edge), format: formatAxis,
        parse: raw => {
          try {
            const value = parseTimeInput(raw, 's', true), domain = dataDomainBounds(), range = viewRange();
            const min = edge === 'start' ? domain.start : Math.max(domain.start, range.start) + MIN_SPAN_US;
            const max = edge === 'start' ? range.end - MIN_SPAN_US : domain.end;
            if (value < min || value > max) throw new Error(t(msg('analysis.invalidRange', '请输入片源范围内的起止时间，结束时间须晚于起始时间。')));
            rangeError.hidden = true;
            return value;
          } catch (error) {
            rangeError.textContent = error instanceof Error ? error.message : String(error);
            rangeError.hidden = false;
            throw error;
          }
        },
        commit: async value => { const range = viewRange(); rangeError.hidden = true; setView(edge === 'start' ? value : range.start, edge === 'start' ? range.end : value); },
      });
    }
  }

  function layoutRangeTimes() {
    const geometry = rangeGeometry(), left = geometry.gutter, right = left + geometry.plotW;
    const anchors = [parseFloat(rangeHandles[0].style.left), parseFloat(rangePlayhead.style.left), parseFloat(rangeHandles[1].style.left), parseFloat(rangeHover.style.left)];
    const labels = rangeTimes.flatMap((element, index) => element.hidden ? [] : [{ element, index, anchor: anchors[index], width: element.offsetWidth, left: 0 }])
      .sort((a, b) => a.anchor - b.anchor || a.index - b.index);
    const gap = 8;
    const stacked = labels.reduce((sum, label) => sum + label.width, 0) + Math.max(0, labels.length - 1) * gap > geometry.plotW;
    rangeNavigation.style.setProperty('--range-navigation-height', `${stacked ? 28 + (labels.length - 1) * 20 : 28}px`);
    for (const [position, label] of labels.entries()) {
      label.left = Math.max(left, Math.min(right - label.width, label.anchor - label.width / 2));
      if (stacked) continue;
      // 同一行：自左向右排布，同时给右侧未放置的标签留出最小间距，
      // 总宽已确认可容纳，因此每个标签都不会越过轨道边界或彼此重叠。
      const remaining = labels.slice(position + 1).reduce((sum, next) => sum + next.width + gap, 0);
      const cursor = position ? labels[position - 1].left + labels[position - 1].width + gap : left;
      label.left = Math.max(cursor, Math.min(label.left, right - remaining - label.width));
    }
    for (const [row, label] of labels.entries()) {
      label.element.style.left = `${label.left}px`; label.element.style.top = `${12 + (stacked ? row * 20 : 0)}px`;
    }
  }

  const sharedAxisGeometry = () => plotGeometry(sharedAxis.clientWidth);
  installChartNavigation({
    canvas: sharedAxis, signal, enabled: () => isOpen() && !sharedAxisHost.hidden && hasTracks(),
    plotWidth: () => sharedAxisGeometry().plotW,
    zoom(factor, clientX) {
      clearSharedHover();
      const geometry = sharedAxisGeometry(), range = viewRange();
      const fraction = Math.max(0, Math.min(1, (clientX - sharedAxis.getBoundingClientRect().left - geometry.gutter) / geometry.plotW));
      const next = zoomOverviewRange(range, fullRange(), fraction, factor, MIN_SPAN_US);
      setView(next.start, next.end);
    },
    pan(pixels) {
      clearSharedHover();
      const range = viewRange(), shift = Math.round(pixels / sharedAxisGeometry().plotW * (fullRange().end - fullRange().start));
      const next = panTimeRange(range.start, range.end, shift, domainBounds());
      setView(next.start, next.end);
    },
  });
  sharedAxis.addEventListener('dblclick', () => { clearSharedHover(); setView(null); }, { signal });

  const rangeTimeAt = (clientX: number) => {
    const domain = dataDomainBounds(), geometry = rangeGeometry();
    const fraction = Math.max(0, Math.min(1, (clientX - rangeAxis.getBoundingClientRect().left - geometry.gutter) / geometry.plotW));
    return Math.max(0, Math.min(durationUs(), Math.round(domain.start + fraction * (domain.end - domain.start))));
  };
  const seekFromRange = (clientX: number) => {
    if (axis() === 'pts') void act(() => session.seek(rangeTimeAt(clientX)), 'ui.analysis-range-seek');
  };
  function positionRangeHover() {
    const geometry = rangeGeometry();
    const x = rangeHoverClientX == null ? -1 : rangeHoverClientX - rangeAxis.getBoundingClientRect().left;
    const hidden = !isOpen() || sharedAxisHost.hidden || x < geometry.gutter || x > geometry.gutter + geometry.plotW;
    rangeHover.hidden = rangeTimes[3].hidden = hidden;
    if (!hidden) {
      const domain = dataDomainBounds();
      const time = Math.round(domain.start + (x - geometry.gutter) / geometry.plotW * (domain.end - domain.start));
      rangeHover.style.left = `${x}px`;
      rangeHover.dataset.positionUs = String(time);
      rangeTimes[3].textContent = time < 0 ? formatAxis(time) : formatTime(time);
    }
    layoutRangeTimes();
  }
  rangeNavigation.addEventListener('pointermove', event => {
    rangeHoverClientX = event.pointerType === 'touch' ? undefined : event.clientX;
    positionRangeHover();
  }, { signal });
  rangeNavigation.addEventListener('pointerleave', () => { rangeHoverClientX = undefined; positionRangeHover(); }, { signal });
  rangeAxis.addEventListener('click', event => seekFromRange(event.clientX), { signal });
  rangeAxis.addEventListener('keydown', event => {
    if (axis() !== 'pts' || !['Home', 'End', 'ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    event.preventDefault();
    const dur = durationUs(), pos = positionUs();
    const value = event.key === 'Home' ? 0 : event.key === 'End' ? dur : pos + (event.key === 'ArrowLeft' ? -1 : 1) * 1_000_000;
    void act(() => session.seek(Math.max(0, Math.min(dur, value))), 'ui.analysis-range-seek');
  }, { signal });

  let rangeDrag: { x: number; start: number; end: number; moved: boolean } | undefined;
  rangeBand.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    cancelRangeEdits(); event.preventDefault(); rangeDrag = { x: event.clientX, ...viewRange(), moved: false };
    rangeBand.setPointerCapture(event.pointerId);
  }, { signal });
  rangeBand.addEventListener('pointermove', event => {
    if (!rangeDrag || !rangeBand.hasPointerCapture(event.pointerId)) return;
    if (!rangeDrag.moved && Math.abs(event.clientX - rangeDrag.x) < 3) return;
    rangeDrag.moved = true; rangeBand.dataset.dragging = 'true';
    const domain = dataDomainBounds(), delta = Math.round((event.clientX - rangeDrag.x) / rangeGeometry().plotW * (domain.end - domain.start));
    const next = panTimeRange(rangeDrag.start, rangeDrag.end, delta, domainBounds()); setView(next.start, next.end);
  }, { signal });
  rangeBand.addEventListener('pointerup', event => {
    if (!rangeDrag) return;
    if (!rangeDrag.moved) seekFromRange(event.clientX);
    if (rangeBand.hasPointerCapture(event.pointerId)) rangeBand.releasePointerCapture(event.pointerId);
  }, { signal });
  rangeBand.addEventListener('lostpointercapture', () => { rangeDrag = undefined; delete rangeBand.dataset.dragging; }, { signal });
  rangeBand.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const range = viewRange(), domain = fullRange();
    const delta = event.key === 'Home' ? domain.start - range.start : event.key === 'End' ? domain.end - range.end : (event.key === 'ArrowLeft' ? -1 : 1) * (event.shiftKey ? 1_000_000 : 100_000);
    const next = panTimeRange(range.start, range.end, delta, domainBounds()); setView(next.start, next.end);
  }, { signal });

  for (const handle of rangeHandles) {
    let dragOrigin: { x: number; value: number } | undefined;
    const apply = (value: number) => {
      const range = viewRange(), domain = dataDomainBounds();
      if (handle.dataset.edge === 'start') setView(Math.max(domain.start, Math.min(range.end - MIN_SPAN_US, value)), range.end);
      else setView(Math.max(domain.start, range.start), Math.min(domain.end, Math.max(Math.max(domain.start, range.start) + MIN_SPAN_US, value)));
    };
    handle.addEventListener('pointerdown', event => { if (event.button !== 0) return; cancelRangeEdits(); event.preventDefault(); dragOrigin = { x: event.clientX, value: Number(handle.getAttribute('aria-valuenow')) }; handle.dataset.dragging = 'true'; handle.setPointerCapture(event.pointerId); }, { signal });
    handle.addEventListener('pointermove', event => {
      if (!handle.hasPointerCapture(event.pointerId) || !dragOrigin) return;
      const domain = dataDomainBounds(), geometry = rangeGeometry();
      apply(Math.round(dragOrigin.value + (event.clientX - dragOrigin.x) / geometry.plotW * (domain.end - domain.start)));
    }, { signal });
    handle.addEventListener('pointerup', event => { if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId); }, { signal });
    handle.addEventListener('lostpointercapture', () => { dragOrigin = undefined; delete handle.dataset.dragging; }, { signal });
    handle.addEventListener('keydown', event => {
      const domain = dataDomainBounds(), value = Number(handle.getAttribute('aria-valuenow'));
      if (event.key === 'Home' || event.key === 'End') { event.preventDefault(); apply(event.key === 'Home' ? domain.start : domain.end); }
      else if (['ArrowLeft', 'ArrowRight'].includes(event.key)) { event.preventDefault(); apply(value + (event.key === 'ArrowLeft' ? -1 : 1) * (event.shiftKey ? 1_000_000 : 100_000)); }
    }, { signal });
  }

  function positionRangePlayhead() {
    const currentAxis = axis(), pos = positionUs(), dur = durationUs();
    rangePlayhead.hidden = currentAxis === 'dts' || !isOpen() || sharedAxisHost.hidden;
    rangeAxis.setAttribute('aria-disabled', String(currentAxis === 'dts'));
    rangeAxis.setAttribute('aria-valuemin', '0'); rangeAxis.setAttribute('aria-valuemax', String(dur));
    rangeAxis.setAttribute('aria-valuenow', String(pos)); rangeAxis.setAttribute('aria-valuetext', formatTime(pos));
    rangeTimes[1].hidden = rangePlayhead.hidden;
    if (rangePlayhead.hidden) { positionRangeHover(); return; }
    const domain = dataDomainBounds(), geometry = rangeGeometry();
    const fraction = Math.max(0, Math.min(1, (pos - domain.start) / Math.max(1, domain.end - domain.start)));
    rangePlayhead.style.left = `${geometry.gutter + fraction * geometry.plotW}px`;
    rangePlayhead.dataset.positionUs = String(pos);
    const text = formatTime(pos);
    if (rangeTimes[1].textContent !== text) rangeTimes[1].textContent = text;
    positionRangeHover();
  }

  function renderSharedAxis() {
    if (!isOpen() || sharedAxisHost.hidden || !sharedAxisCtx || !rangeAxisCtx) { sharedAxisSignature = ''; return; }
    const width = Math.max(1, Math.floor(charts.clientWidth));
    const range = viewRange(), domain = dataDomainBounds(), dpr = Math.min(2, window.devicePixelRatio || 1);
    const palette = colors(), slots = slotColors();
    const coverage = selectedTracks().map(track => ({ track, state: session.getBitstreamAnalysisState(track.slot) }));
    const signature = JSON.stringify([width, range, domain, dpr, palette, coverage.map(({ track, state }) => [track.slot, state.stream, state.completedStream])]);
    if (signature === sharedAxisSignature) return;
    sharedAxisSignature = signature;
    sharedAxis.style.width = `${width}px`; sharedAxis.style.height = `${AXIS_H}px`;
    sharedAxis.width = Math.round(width * dpr); sharedAxis.height = Math.round(AXIS_H * dpr);
    sharedAxisCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    sharedAxisCtx.clearRect(0, 0, width, AXIS_H);
    drawTimeAxis(sharedAxisCtx, { width, height: AXIS_H, viewStart: range.start, viewEnd: range.end, colors: palette });
    const navWidth = Math.max(1, rangeNavigation.clientWidth || Math.min(460, innerWidth - 48));
    rangeAxis.style.width = `${navWidth}px`; rangeAxis.style.height = `${AXIS_H}px`;
    rangeAxis.width = Math.round(navWidth * dpr); rangeAxis.height = Math.round(AXIS_H * dpr);
    rangeAxisCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    rangeAxis.dataset.timeAxis = 'false';
    rangeLabel.textContent = t(msg('analysis.rangeNavigator', '区间'));
    const triggerLabel = rangeTrigger.querySelector('span')!;
    const rangeText = `${formatAxis(Math.max(domain.start, range.start))} – ${formatAxis(Math.min(domain.end, range.end))}`;
    // Coverage/progress can redraw this axis during a pointer press. WebKit
    // drops the click if that redraw replaces the text node under the pointer.
    if (triggerLabel.textContent !== rangeText) triggerLabel.textContent = rangeText;
    rangeAxis.setAttribute('aria-label', t(msg('analysis.fullTimelinePosition', '全片播放位置')));
    rangeBand.setAttribute('aria-label', t(msg('analysis.panVisibleRange', '平移图表可见区间')));
    rangeBand.setAttribute('aria-valuemin', String(domain.start)); rangeBand.setAttribute('aria-valuemax', String(Math.max(domain.start, domain.end - (range.end - range.start))));
    rangeBand.setAttribute('aria-valuenow', String(range.start)); rangeBand.setAttribute('aria-valuetext', `${formatAxis(range.start)} – ${formatAxis(range.end)}`);
    const geometry = rangeGeometry();
    const dataDomain = dataDomainBounds();
    const selectionStart = Math.max(dataDomain.start, range.start), selectionEnd = Math.min(dataDomain.end, range.end);
    const xFor = (time: number) => geometry.gutter + Math.max(0, Math.min(1, (time - domain.start) / (domain.end - domain.start))) * geometry.plotW;
    rangeAxisCtx.strokeStyle = palette.grid; rangeAxisCtx.beginPath();
    rangeAxisCtx.lineWidth = 2;
    rangeAxisCtx.moveTo(xFor(dataDomain.start), 3); rangeAxisCtx.lineTo(xFor(dataDomain.end), 3); rangeAxisCtx.stroke();
    rangeAxisCtx.globalAlpha = .35;
    for (const { track, state } of coverage) {
      const stream = state.stream ?? state.completedStream;
      if (!stream || !stream.totalUs) continue;
      const window = 'window' in stream && stream.window ? stream.window : { startUs: 0, endUs: track.durationUs };
      rangeAxisCtx.strokeStyle = slots.get(track.slot) ?? palette.delta; rangeAxisCtx.beginPath();
      rangeAxisCtx.moveTo(xFor(window.startUs + track.offsetUs), 3);
      rangeAxisCtx.lineTo(xFor(window.startUs + track.offsetUs + (window.endUs - window.startUs) * stream.checkedUs / stream.totalUs), 3); rangeAxisCtx.stroke();
    }
    rangeAxisCtx.globalAlpha = 1;
    // Leave 3px on each side of the band midpoint free of the 32px handles,
    // so a narrow selection can still be dragged without resizing an edge.
    rangeNavigation.style.setProperty('--range-handle-inset', `${Math.min(8, Math.max(0, (xFor(selectionEnd) - xFor(selectionStart)) / 2 - 3))}px`);
    rangeBand.style.left = `${xFor(selectionStart)}px`; rangeBand.style.width = `${Math.max(0, xFor(selectionEnd) - xFor(selectionStart))}px`;
    for (const handle of rangeHandles) {
      const value = handle.dataset.edge === 'start' ? selectionStart : selectionEnd;
      handle.style.left = `${xFor(value)}px`;
      handle.setAttribute('aria-label', t(handle.dataset.edge === 'start' ? msg('analysis.visibleStart', '图表可见区间起点') : msg('analysis.visibleEnd', '图表可见区间终点')));
      handle.setAttribute('aria-valuemin', String(dataDomain.start)); handle.setAttribute('aria-valuemax', String(dataDomain.end)); handle.setAttribute('aria-valuenow', String(value)); handle.setAttribute('aria-valuetext', value < 0 ? formatAxis(value) : formatTime(value));
    }
    syncRangeEdges();
    positionRangePlayhead();
    const chartDomain = fullRange();
    sharedAxis.dataset.domainStart = String(chartDomain.start); sharedAxis.dataset.domainEnd = String(chartDomain.end);
    sharedAxis.dataset.axisStart = String(range.start); sharedAxis.dataset.axisEnd = String(range.end);
    rangeAxis.dataset.domainStart = String(domain.start); rangeAxis.dataset.domainEnd = String(domain.end);
    sharedAxis.dataset.viewStart = String(range.start); sharedAxis.dataset.viewEnd = String(range.end);
    sharedAxis.dataset.plotLeft = String(plotGeometry(width).gutter); sharedAxis.dataset.plotRight = String(plotGeometry(width).gutter + plotGeometry(width).plotW);
    sharedAxis.dataset.timeAxis = 'true';
  }

  function localize() {
    const rangeName = t(msg('analysis.editRange', '编辑图表区间'));
    rangeTrigger.setAttribute('aria-label', rangeName); rangeTrigger.dataset.tooltip = rangeName; rangeEditor.setAttribute('aria-label', rangeName);
    // 起止胶囊即时间输入：名称随语言更新，显示值由 syncRangeEdges 跟随区间。
    rangeEdges.get('start')!.label = t(msg('analysis.rangeStart', '起始时间'));
    rangeEdges.get('end')!.label = t(msg('analysis.rangeEnd', '结束时间'));
    for (const state of rangeEdges.values()) state.input.setAttribute('aria-label', state.label);
    syncRangeEdges();
  }

  return {
    sharedAxisHost,
    rangeNavigation,
    bounds: rangeEditorBounds,
    close: closeRangeEditor,
    render: renderSharedAxis,
    positionPlayhead: positionRangePlayhead,
    localize,
  };
}
