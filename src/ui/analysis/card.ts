import type { Slot } from '../../model.ts';
import type { InspectionState, TrackInspection } from '../../analysis/inspection.ts';
import { t, msg } from '../../i18n.ts';
import { formatAxis } from '../analysis-canvas.ts';

/** Floating card owns only DOM and formatting, never analysis/seek state. */
export function installAnalysisCard(canvas: HTMLCanvasElement, options: {
  signal: AbortSignal; colors(): ReadonlyMap<Slot, string>; pinned(): boolean;
}) {
  const layer = document.createElement('div'); layer.className = 'analysis-float-layer'; layer.setAttribute('aria-hidden', 'true');
  const cardEl = document.createElement('div'); cardEl.className = 'analysis-card'; cardEl.hidden = true;
  layer.append(cardEl); document.body.append(layer);
  options.signal.addEventListener('abort', () => layer.remove(), { once: true });
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
      dot.style.background = options.colors().get(slot) ?? '#888';
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
      flTime.textContent = `${formatAxis(insp.inspectionTimeUs)}${options.pinned() ? t(msg("analysis.pinnedSuffix", " · 已固定")) : ''}`;
    }
    if (flRateLabel) flRateLabel.textContent = t(insp.axis === 'dts' ? msg("analysis.sampleRate", "样本率 /s") : msg("analysis.frameRateFps", "帧率 · fps"));
    for (const [slot, dot] of flDots) dot.style.background = options.colors().get(slot) ?? '#888';
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

  return { element: cardEl, render: renderFloat, position: positionFloat, reset: () => { flOrder = []; flTime = null; } };
}
