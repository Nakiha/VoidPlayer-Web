import type { Slot } from '../../../shared/review/model.ts';
import type { InspectionState, TrackInspection } from '../../../shared/analysis/metadata/inspection.ts';
import { t, msg } from '../../i18n.ts';
import { formatAxis } from './canvas.ts';
import { floatingAvoidanceShift } from './geometry.ts';

/** Reuse the player track badge and its theme-owned slot colors in every tooltip. */
export function analysisTrackBadge(slot: Slot | undefined, color?: string) {
  const badge = document.createElement('span');
  badge.className = `slot slot-${slot ?? 'A'} analysis-card-track-badge`;
  badge.textContent = slot ?? '—';
  if (color) badge.style.background = color;
  return badge;
}

/** Shared detail structure; embedding changes the header, never the content layout. */
export function analysisDetailTable(options: {
  kind: 'nalu' | 'references'; valueColumns: number; aggregated: boolean;
  header?: { time: string; slot?: Slot };
}) {
  const table = document.createElement('table'); table.className = 'fl-grid analysis-detail-grid';
  table.dataset.kind = options.kind; table.dataset.aggregated = String(options.aggregated);
  const columns = document.createElement('colgroup'), label = document.createElement('col'), values = document.createElement('col');
  label.className = 'analysis-card-label-col'; values.span = options.valueColumns;
  columns.append(label, values); table.append(columns);
  if (options.header) {
    const head = table.createTHead().insertRow(), time = document.createElement('th'), track = document.createElement('th');
    time.className = 'fl-time'; time.textContent = options.header.time;
    track.colSpan = options.valueColumns; track.append(analysisTrackBadge(options.header.slot)); head.append(time, track);
  }
  const body = table.createTBody();
  const row = (label: string, value: string, color?: string) => {
    const tr = body.insertRow(), th = document.createElement('th'); th.scope = 'row';
    if (color) { const mark = document.createElement('span'); mark.className = 'dot'; mark.style.background = color; th.append(mark); }
    th.append(document.createTextNode(label));
    const td = tr.insertCell(); td.className = 'metric-value'; td.textContent = value; td.title = value; tr.prepend(th);
    return tr;
  };
  return { table, body, row };
}

export function analysisMetricValue(cell: HTMLElement, value: string, unit?: string) {
  cell.className = 'metric-value'; cell.textContent = value;
  if (unit) {
    const suffix = document.createElement('span'); suffix.className = 'analysis-card-unit'; suffix.textContent = unit; cell.append(suffix);
  }
}

/** Floating card owns only DOM and formatting, never analysis/seek state. */
export function installAnalysisCard(canvas: HTMLCanvasElement, options: {
  signal: AbortSignal; colors(): ReadonlyMap<Slot, string>; pinned(): boolean;
  visibleRows?(): { bitrate: boolean; size: boolean; qp?: boolean }; qpValue?(slot: Slot, time: number): number|null; panelBounds?(): DOMRect; beside?: boolean;
  avoid?(): DOMRect | undefined;
}) {
  const floating = installFloatingAnalysisCard(canvas, options.signal, options.panelBounds, options.beside, options.avoid);
  const cardEl = floating.element;
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

  // Shared table keeps a stable header/metric structure while selected details change.
  let flOrder: Slot[] = [];
  let flTime: HTMLElement | null = null;
  let flRateLabel: HTMLElement | null = null;
  let flBadges = new Map<Slot, HTMLElement>();
  let flCells = new Map<string, HTMLElement>();

  function ensureFloatStructure(order: readonly Slot[]) {
    if (flTime && sameOrder(order, flOrder)) return;
    flOrder = [...order];
    flBadges = new Map();
    flCells = new Map();
    cardEl.replaceChildren();
    const table = document.createElement('table');
    table.className = 'fl-grid analysis-overview-grid';
    const columns = document.createElement('colgroup'), labelColumn = document.createElement('col'), values = document.createElement('col');
    labelColumn.className = 'analysis-card-label-col'; values.span = order.length; columns.append(labelColumn, values); table.append(columns);
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
      const dot = analysisTrackBadge(slot, options.colors().get(slot));
      th.append(dot);
      head.append(th);
      flBadges.set(slot, dot);
    }
    thead.append(head);
    table.append(thead);
    const tbody = document.createElement('tbody');
    const rows = [
      { key: 'bitrate', label: t(msg("analysis.bitrate", "码率")) },
      { key: 'rate', label: t(msg("analysis.frameRate", "帧率")) },
      { key: 'size', label: t(msg("analysis.frameSize", "帧大小")) },
      { key: 'qp', label: 'QP' },
    ] as const;
    for (const { key, label } of rows) {
      const tr = document.createElement('tr'); tr.dataset.metric = key;
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

  /** Floating placement never changes inspection state. */
  const positionFloat = floating.position;

  /** 卡片内容：同一检查快照；顶层绘制，闲时隐藏，不占面板布局。 */
  function renderFloat(insp: InspectionState | null, clientX: number | null) {
    if (!insp) { cardEl.hidden = true; return; }
    ensureFloatStructure(insp.tracks.map(t => t.slot));
    cardEl.hidden = false;
    const rows = options.visibleRows?.();
    for (const row of cardEl.querySelectorAll<HTMLElement>('[data-metric]')) row.hidden = !!rows && (row.dataset.metric === 'qp' ? !rows.qp : row.dataset.metric === 'size' ? !rows.size : !rows.bitrate);
    if (flTime) {
      flTime.textContent = `${formatAxis(insp.inspectionTimeUs)} · ${insp.axis.toUpperCase()}${options.pinned() ? t(msg("analysis.pinnedSuffix", " · 已固定")) : ''}`;
    }
    const bitrateLabel = cardEl.querySelector('[data-metric="bitrate"] th');
    if (bitrateLabel) bitrateLabel.textContent = t(insp.axis === 'pts' ? msg('analysis.presentationLoad', '展示负载率') : msg('analysis.bitrate', '码率'));
    if (flRateLabel) flRateLabel.textContent = t(insp.axis === 'dts' ? msg("analysis.sampleRateLabel", "样本率") : msg("analysis.frameRate", "帧率"));
    for (const [slot, dot] of flBadges) dot.style.background = options.colors().get(slot) ?? '#888';
    for (const tr of insp.tracks) {
      const [b, f, s] = formatCells(tr);
      const qp=rows&&!rows.qp?null:options.qpValue?.(tr.slot,tr.reference?.axisUs ?? insp.inspectionTimeUs);
      const vals: Record<string, string> = { bitrate: b, rate: f, size: s, qp:qp==null?'—':qp.toFixed(1) };
      for (const [m, text] of Object.entries(vals)) {
        const el = flCells.get(`${m}:${tr.slot}`);
        if (el) {
          const known = text !== '—' && (tr.coverageState === 'known' || (m === 'bitrate' ? tr.bitrate.value : m === 'rate' ? tr.localRate.value : null) != null);
          analysisMetricValue(el, text, known ? m === 'bitrate' ? 'Mbps' : m === 'size' ? 'KiB' : m === 'qp' ? undefined : insp.axis === 'dts' ? '/s' : 'fps' : undefined);
        }
      }
    }
    if (clientX != null) positionFloat(clientX);
  }

  return { element: cardEl, render: renderFloat, position: positionFloat, managePosition: floating.managePosition, reset: () => { flOrder = []; flTime = null; } };
}

/** Shared glass surface, removed with its owner and clamped to the visible viewport. */
export function installFloatingAnalysisCard(canvas: HTMLCanvasElement, signal: AbortSignal, panelBounds?: () => DOMRect, beside = false, avoid?: () => DOMRect | undefined) {
  const layer = document.createElement('div'); layer.className = 'analysis-float-layer'; layer.setAttribute('aria-hidden', 'true');
  const element = document.createElement('div'); element.className = 'analysis-card'; element.hidden = true;
  layer.append(element); document.body.append(layer);
  signal.addEventListener('abort', () => layer.remove(), { once: true });
  const hide = () => { element.hidden = true; };
  let lastX = 0, lastY: number | undefined, managed = false;
  window.addEventListener('scroll', () => { if (managed) return; if (panelBounds && !element.hidden) position(lastX, lastY); else hide(); }, { signal, capture: true });
  window.addEventListener('resize', hide, { signal });
  function position(clientX: number, clientY?: number) {
    lastX = clientX; lastY = clientY;
    if (element.hidden) return;
    const rect = panelBounds?.() ?? canvas.getBoundingClientRect();
    const top = Math.max(8, Math.min(innerHeight - 8, rect.bottom + 6));
    element.style.maxHeight = managed ? 'none' : beside ? `min(var(--card-max-height, 180px), ${innerHeight - 16}px)` : `${Math.max(0, innerHeight - top - 8)}px`;
    const width = element.offsetWidth, height = element.offsetHeight;
    const left = Math.max(8, rect.left + 4), right = Math.min(innerWidth - 8, rect.right - 4);
    const gap = 24;
    const fitsRight = clientX + gap + width <= innerWidth - 8;
    const x = beside ? fitsRight ? clientX + gap : clientX - width - gap
      : Math.max(left, Math.min(right - width, clientX - width / 2));
    element.dataset.side = beside ? fitsRight ? 'right' : 'left' : 'below';
    const targetLeft = Math.round(Math.max(8, Math.min(innerWidth - width - 8, x)));
    const targetTop = Math.round(managed ? clientY ?? 0 : beside ? Math.max(8, Math.min(innerHeight - height - 8, clientY ?? rect.top + 4)) : top);
    element.style.left = `${targetLeft}px`;
    element.style.top = `${targetTop}px`;
    // 顶部面板内的其它浮层（区间编辑器）优先：相交时卡片带动画地上下让位。
    // 独立卡片挂在共享浮层里，坐标相对父层，需要换算到窗口坐标再避让。
    const peer = avoid?.();
    const parentTop = managed ? element.parentElement?.getBoundingClientRect().top ?? 0 : 0;
    const shift = peer ? Math.round(floatingAvoidanceShift({ top: targetTop + parentTop, left: targetLeft, width, height }, peer, innerHeight)) : 0;
    element.style.setProperty('--floating-offset-y', `${shift}px`);
    if (!managed && !beside && shift > 0) element.style.maxHeight = `${Math.max(0, innerHeight - (targetTop + shift) - 8)}px`;
    element.classList.toggle('is-scrollable', element.scrollHeight > element.clientHeight);
  }
  const managePosition = (parent: HTMLElement) => { managed = true; parent.append(element); };
  return { element, hide, position, managePosition };
}
