// 码流分析面板的专用 Canvas 2D 绘制（非通用图表框架）。
// DOM 负责工具条/tooltip/可访问文本；Canvas 只画高密度柱、线、网格。
// 播放游标与悬停线是独立 DOM 覆盖层，只做 transform，不触发重绘。

export interface CanvasSample {
  t: number;
  size: number;
  key: boolean | null;
  /** 成对并排时的组锚定时间（共同时间）；缺省用 t。 */
  gx?: number;
}
export interface CanvasBucket {
  startUs: number; endUs: number; count: number; sumBytes: number; maxBytes: number;
  keyCount: number; deltaCount: number; unknownCount: number; complete: boolean;
}
export interface CanvasBitrate { t: number; mbps: number | null }
export interface CanvasTrack {
  slot: string;
  color: string;
  samples: CanvasSample[] | null;
  truncated: boolean;
  buckets: CanvasBucket[];
  bitrate: CanvasBitrate[];
  provisional: boolean;
}
export interface CanvasColors {
  key: string; delta: string; unknown: string;
  grid: string; text: string; axisText: string;
}
export interface CanvasModel {
  width: number;
  height: number;
  viewStart: number;
  viewEnd: number;
  showBitrate: boolean;
  showSize: boolean;
  colorByType: boolean;
  tracks: CanvasTrack[];
  /** 双轨且严格配对成功时为 true，组内左右并排（仍锚定共同时间）。 */
  paired: boolean;
  yMaxBitrate: number;
  yMaxSize: number;
  colors: CanvasColors;
  /** 框选橡皮筋（会话时间），绘制时覆盖。 */
  rubber: { a: number; b: number } | null;
}

export interface RowGeom { kind: 'bitrate' | 'size'; slot?: string; slots?: string[]; y: number; h: number }
export interface CanvasGeom {
  gutter: number; plotW: number;
  bitrate: { y: number; h: number } | null;
  sizeRows: RowGeom[];
  axisY: number; axisH: number;
}

export const AXIS_H = 22;
const GUTTER = 46;
/** 纯视图几何（无数据也可定位）：hover/框选/滚轮在首帧数据到达前即可用。 */
export function plotGeometry(widthCss: number): { gutter: number; plotW: number; width: number } {
  const width = Math.max(1, Math.floor(widthCss));
  return { gutter: GUTTER, plotW: Math.max(1, width - GUTTER), width };
}

export function computeLayout(model: CanvasModel): CanvasGeom {
  const axisY = model.height - AXIS_H;
  const plotH = Math.max(0, axisY);
  const sizeRowCount = model.showSize ? (model.paired ? 1 : Math.max(1, model.tracks.length)) : 0;
  let bitrateH = 0;
  if (model.showBitrate) {
    bitrateH = sizeRowCount ? Math.round(plotH * 0.42) : plotH;
    bitrateH = Math.max(sizeRowCount ? 48 : 0, Math.min(bitrateH, 140));
  }
  const sizeH = sizeRowCount ? Math.max(0, plotH - bitrateH) : 0;
  const perRow = sizeRowCount ? sizeH / sizeRowCount : 0;
  const sizeRows: RowGeom[] = [];
  for (let i = 0; i < sizeRowCount; i++) {
    sizeRows.push(model.paired
      ? { kind: 'size', slots: model.tracks.map(t => t.slot), y: bitrateH + i * perRow, h: perRow }
      : { kind: 'size', slot: model.tracks[i]?.slot, y: bitrateH + i * perRow, h: perRow });
  }
  return {
    gutter: GUTTER, plotW: Math.max(1, model.width - GUTTER),
    bitrate: model.showBitrate ? { y: 0, h: bitrateH } : null,
    sizeRows, axisY, axisH: AXIS_H,
  };
}

/** 本面板需要的最小内容高度（多轨分行时允许面板内滚动，不挤扁行）。 */
export function desiredHeight(showBitrate: boolean, sizeRows: number): number {
  const bitrate = showBitrate ? 72 : 0;
  return bitrate + sizeRows * 52 + AXIS_H;
}

export function xOf(model: CanvasModel, geom: CanvasGeom, t: number): number {
  const span = model.viewEnd - model.viewStart || 1;
  return geom.gutter + ((t - model.viewStart) / span) * geom.plotW;
}

export function tOf(model: CanvasModel, geom: CanvasGeom, x: number): number {
  const span = model.viewEnd - model.viewStart || 1;
  return model.viewStart + ((x - geom.gutter) / geom.plotW) * span;
}

function niceStep(span: number, target = 6): number {
  const raw = span / Math.max(1, target);
  const mag = 10 ** Math.floor(Math.log10(Math.max(1, raw)));
  for (const m of [1, 2, 2.5, 5, 10]) if (raw <= m * mag) return m * mag;
  return 10 * mag;
}

export function formatAxis(us: number): string {
  const sign = us < 0 ? '-' : '';
  const ms = Math.floor(Math.abs(us) / 1000);
  return `${sign}${String(Math.floor(ms / 60000)).padStart(2, '0')}:${String(Math.floor(ms / 1000 % 60)).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`;
}

function barColor(model: CanvasModel, key: boolean | null, slotColor: string): string {
  if (!model.colorByType) return slotColor;
  if (key === true) return model.colors.key;
  if (key === false) return model.colors.delta;
  return model.colors.unknown;
}

export function drawAnalysis(ctx: CanvasRenderingContext2D, model: CanvasModel): void {
  const geom = computeLayout(model);
  const { width, height } = model;
  ctx.clearRect(0, 0, width, height);
  ctx.font = '10px system-ui, sans-serif';
  ctx.textBaseline = 'middle';
  // 网格 + 时间刻度
  const step = niceStep(model.viewEnd - model.viewStart);
  const firstTick = Math.ceil(model.viewStart / step) * step;
  ctx.strokeStyle = model.colors.grid;
  ctx.fillStyle = model.colors.axisText;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let t = firstTick; t <= model.viewEnd; t += step) {
    const x = Math.round(xOf(model, geom, t)) + 0.5;
    ctx.moveTo(x, 0);
    ctx.lineTo(x, geom.axisY);
    ctx.fillText(formatAxis(t), x + 4, geom.axisY + AXIS_H / 2);
  }
  ctx.stroke();
  // 码率行：折线（非贝塞尔），缺失区间断线。
  if (geom.bitrate && model.showBitrate) {
    const { y, h } = geom.bitrate;
    ctx.fillStyle = model.colors.axisText;
    ctx.fillText('Mbps', 4, y + 10);
    if (model.yMaxBitrate > 0) ctx.fillText(trimNum(model.yMaxBitrate), 4, y + h - 8);
    ctx.strokeStyle = model.colors.grid;
    ctx.strokeRect(geom.gutter + 0.5, y + 0.5, geom.plotW - 1, Math.max(1, h - 1));
    for (const track of model.tracks) {
      ctx.strokeStyle = track.color;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      let pen = false;
      for (const p of track.bitrate) {
        if (p.mbps == null || !(p.t >= model.viewStart && p.t <= model.viewEnd)) { pen = false; continue; }
        const x = xOf(model, geom, p.t);
        const yy = y + h - 4 - (Math.min(p.mbps, model.yMaxBitrate) / (model.yMaxBitrate || 1)) * (h - 8);
        if (!pen) { ctx.moveTo(x, yy); pen = true; }
        else ctx.lineTo(x, yy);
      }
      ctx.stroke();
    }
    ctx.lineWidth = 1;
  }
  // 大小行：放大画真实帧柱，缩小画时间桶峰值。
  if (model.showSize) {
    for (let r = 0; r < geom.sizeRows.length; r++) {
      const row = geom.sizeRows[r];
      const rows = model.paired ? model.tracks : [model.tracks[r]];
      if (!rows[0]) continue;
      const label = model.paired ? rows.map(t => t.slot).join('+') : rows[0].slot;
      ctx.fillStyle = model.colors.axisText;
      ctx.fillText(label, 4, row.y + 10);
      if (model.yMaxSize > 0) ctx.fillText(`${trimNum(model.yMaxSize / 1024)}K`, 4, row.y + row.h - 8);
      ctx.strokeStyle = model.colors.grid;
      ctx.strokeRect(geom.gutter + 0.5, row.y + 0.5, geom.plotW - 1, Math.max(1, row.h - 1));
      const lanes = rows.length;
      rows.forEach((track, lane) => {
        if (track.samples && !track.truncated) drawSamples(ctx, model, geom, row, track, lane, lanes);
        else drawBuckets(ctx, model, geom, row, track, lane, lanes);
        if (track.provisional) {
          ctx.fillStyle = model.colors.axisText;
          ctx.fillText('暂定', geom.gutter + geom.plotW - 30, row.y + 10);
        }
      });
    }
  }
  // 框选橡皮筋
  if (model.rubber) {
    const x1 = xOf(model, geom, Math.min(model.rubber.a, model.rubber.b));
    const x2 = xOf(model, geom, Math.max(model.rubber.a, model.rubber.b));
    ctx.fillStyle = 'rgba(59, 130, 246, 0.12)';
    ctx.fillRect(x1, 0, x2 - x1, geom.axisY);
    ctx.strokeStyle = 'rgba(59, 130, 246, 0.8)';
    ctx.strokeRect(x1 + 0.5, 0.5, x2 - x1 - 1, geom.axisY - 1);
  }
}

function trimNum(v: number): string {
  return v >= 100 ? String(Math.round(v)) : v >= 10 ? v.toFixed(1) : v.toFixed(2);
}

function drawSamples(
  ctx: CanvasRenderingContext2D, model: CanvasModel, geom: CanvasGeom,
  row: RowGeom, track: CanvasTrack, lane: number, lanes: number,
): void {
  // 样本按轴有序：柱宽取该样本到下一 stripe 的时间 extent，随缩放自然变宽；
  // 末样本沿用上一间隔。分行单轨为直方图（左对齐），成对组内左右并排。
  const samples = track.samples!;
  const span = model.viewEnd - model.viewStart || 1;
  const pxPerUs = geom.plotW / span;
  const barTop = (size: number) => {
    const h = Math.max(1, (Math.min(size, model.yMaxSize) / (model.yMaxSize || 1)) * (row.h - 6));
    return { y: row.y + row.h - 2 - h, h };
  };
  let prevGap = span / Math.max(1, samples.length);
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    let j = i + 1;
    while (j < samples.length && !(samples[j].t > s.t)) j++;
    const gap = j < samples.length ? samples[j].t - s.t : prevGap;
    if (gap > 0 && Number.isFinite(gap)) prevGap = gap;
    if (!(s.t >= model.viewStart && s.t <= model.viewEnd)) continue;
    const slotPx = Math.max(0, gap * pxPerUs);
    const { y, h } = barTop(s.size);
    ctx.globalAlpha = 1;
    ctx.fillStyle = barColor(model, s.key, track.color);
    if (lanes < 2) {
      const bw = Math.max(1, slotPx * 0.9);
      ctx.fillRect(xOf(model, geom, s.t), y, bw, h);
      continue;
    }
    // 成对：组锚定共同时间，组内按时间占比分栏；过密时收拢为单柱。
    const gc = xOf(model, geom, s.gx ?? s.t);
    const laneW = slotPx / lanes;
    if (laneW >= 3) {
      const bw = Math.max(1, laneW - 1);
      const x = gc - slotPx / 2 + lane * laneW;
      ctx.fillRect(x, y, bw, h);
      // 轨道身份：组内固定左右位置 + 轨道色细线。
      ctx.fillStyle = track.color;
      ctx.fillRect(x, row.y + row.h - 2, bw, 2);
    } else {
      const bw = Math.max(1, slotPx);
      ctx.fillRect(gc - bw / 2, y, bw, h);
    }
  }
}

function drawBuckets(
  ctx: CanvasRenderingContext2D, model: CanvasModel, geom: CanvasGeom,
  row: RowGeom, track: CanvasTrack, lane: number, lanes: number,
): void {
  for (const b of track.buckets) {
    if (b.endUs <= model.viewStart || b.startUs >= model.viewEnd) continue;
    if (!b.count) continue;
    const x1 = xOf(model, geom, Math.max(b.startUs, model.viewStart));
    const x2 = xOf(model, geom, Math.min(b.endUs, model.viewEnd));
    const full = Math.max(1, x2 - x1 - 1);
    const laneW = lanes > 1 ? full / lanes : full;
    const x = lanes > 1 ? x1 + lane * laneW : x1;
    const w = Math.max(1, laneW - (lanes > 1 ? 1 : 1));
    const h = Math.max(1, (Math.min(b.maxBytes, model.yMaxSize) / (model.yMaxSize || 1)) * (row.h - 6));
    // 混合桶用中性色，不冒充单帧类型；纯桶用类型色。
    const mixed = (b.keyCount > 0 ? 1 : 0) + (b.deltaCount > 0 ? 1 : 0) + (b.unknownCount > 0 ? 1 : 0) > 1;
    ctx.globalAlpha = b.complete ? 1 : 0.55;
    ctx.fillStyle = mixed ? model.colors.unknown
      : b.keyCount > 0 ? barColor(model, true, track.color)
      : b.deltaCount > 0 ? barColor(model, false, track.color)
      : model.colors.unknown;
    ctx.fillRect(x, row.y + row.h - 2 - h, w, h);
    if (lanes > 1) {
      ctx.globalAlpha = 1;
      ctx.fillStyle = track.color;
      ctx.fillRect(x, row.y + row.h - 2, w, 2);
    }
    ctx.globalAlpha = 1;
  }
}
