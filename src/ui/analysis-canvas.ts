// 码流分析面板的专用 Canvas 2D 绘制（非通用图表框架）。
// DOM 负责工具条/tooltip/可访问文本；Canvas 只画高密度柱、线、网格。
// 播放游标与悬停线是独立 DOM 覆盖层，只做 transform，不触发重绘。

export interface CanvasBitrate { t: number; mbps: number | null }
export interface CanvasTrack {
  slot: string;
  color: string;
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
  /**
   * 合并显示：多轨同一基线按时间交错，不以严格配对为前提；
   * 缺席留空，不复制。分轨由用户主动选择。
   */
  merged: boolean;
  yMaxBitrate: number;
  yMaxSize: number;
  colors: CanvasColors;
  /** 框选橡皮筋（会话时间），绘制时覆盖。 */
  rubber: { a: number; b: number } | null;
  /** 统一几何的逐样本/桶 glyph：绘图与命中只消费这一份 rect。 */
  sampleGlyphs?: import('./analysis-geometry.ts').SampleGlyph[];
  bucketGlyphs?: import('./analysis-geometry.ts').BucketGlyph[];
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
  const merged = model.merged;
  const sizeRowCount = model.showSize ? (merged ? 1 : Math.max(1, model.tracks.length)) : 0;
  let bitrateH = 0;
  if (model.showBitrate) {
    bitrateH = sizeRowCount ? Math.round(plotH * 0.42) : plotH;
    bitrateH = Math.max(sizeRowCount ? 48 : 0, Math.min(bitrateH, 140));
  }
  const sizeH = sizeRowCount ? Math.max(0, plotH - bitrateH) : 0;
  const perRow = sizeRowCount ? sizeH / sizeRowCount : 0;
  const sizeRows: RowGeom[] = [];
  for (let i = 0; i < sizeRowCount; i++) {
    sizeRows.push(merged
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

export function formatSize(bytes: number): string {
  if (!(bytes > 0)) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  return `${trimNum(bytes / 1024)} KiB`;
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
  // 纵轴与数据共用 valueToY：上限在上、零在下，边缘内收防裁切。
  if (geom.bitrate && model.showBitrate) {
    const { y, h } = geom.bitrate;
    ctx.fillStyle = model.colors.axisText;
    if (model.yMaxBitrate > 0) {
      ctx.fillText(`${trimNum(model.yMaxBitrate)} Mbps`, 4, y + 10);
      ctx.fillText('0', 4, y + h - 10);
    } else {
      ctx.fillText('Mbps', 4, y + 10);
    }
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
  // 大小行：只画统一几何 glyph，绘图与命中共用同一份 rect（无第二套绘制路径）。
  if (model.showSize) {
    const merged = model.merged;
    for (let r = 0; r < geom.sizeRows.length; r++) {
      const row = geom.sizeRows[r];
      const rows = merged ? model.tracks : [model.tracks[r]];
      if (!rows[0]) continue;
      const label = merged ? rows.map(t => t.slot).join('+') : rows[0].slot;
      ctx.fillStyle = model.colors.axisText;
      if (model.yMaxSize > 0) {
        ctx.fillText(formatSize(model.yMaxSize), 4, row.y + 10);
        ctx.fillText(label, 4, row.y + row.h / 2);
        ctx.fillText('0', 4, row.y + row.h - 10);
      } else {
        ctx.fillText(label, 4, row.y + 10);
      }
      ctx.strokeStyle = model.colors.grid;
      ctx.strokeRect(geom.gutter + 0.5, row.y + 0.5, geom.plotW - 1, Math.max(1, row.h - 1));
      drawGlyphs(ctx, model, row);
      for (const track of rows) {
        if (track.provisional) {
          ctx.fillStyle = model.colors.axisText;
          ctx.fillText('暂定', geom.gutter + geom.plotW - 30, row.y + 10);
        }
      }
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

function drawKeyMarker(ctx: CanvasRenderingContext2D, model: CanvasModel, cx: number, topY: number): void {
  // 关键样本顶端菱形标记（未知保持未知，不标 I/P/B）。
  const s = 3;
  ctx.beginPath();
  ctx.moveTo(cx, topY - s - 1);
  ctx.lineTo(cx + s, topY - 1);
  ctx.lineTo(cx, topY + s - 1);
  ctx.lineTo(cx - s, topY - 1);
  ctx.closePath();
  ctx.fillStyle = model.colors.key;
  ctx.fill();
  ctx.lineWidth = 1;
  ctx.strokeStyle = '#fff';
  ctx.stroke();
}

function drawGlyphs(
  ctx: CanvasRenderingContext2D, model: CanvasModel, row: RowGeom,
): void {
  const colorBySlot = new Map(model.tracks.map(t => [t.slot, t.color]));
  const clipY = (r: { y: number; h: number }) => r.y >= row.y - 0.5 && r.y <= row.y + row.h + 0.5;
  void clipY;
  for (const g of model.sampleGlyphs ?? []) {
    if (g.rect.y + g.rect.height < row.y || g.rect.y > row.y + row.h) continue;
    const slotColor = colorBySlot.get(g.slot) ?? '#888';
    ctx.globalAlpha = 1;
    // 多轨默认主体轨道色（与曲线对应），类型用顶端 K/菱形标记；不再用底线猜身份。
    ctx.fillStyle = barColor(model, g.key, slotColor);
    ctx.fillRect(g.rect.x, g.rect.y, g.rect.width, g.rect.height);
    if (g.key === true) {
      drawKeyMarker(ctx, model, g.rect.x + g.rect.width / 2, g.rect.y);
      if (g.rect.width >= 10) {
        ctx.fillStyle = model.colors.key;
        ctx.fillText('K', g.rect.x + 2, g.rect.y + 9);
      }
    }
    if (g.stackedCount > 1) {
      ctx.fillStyle = model.colors.axisText;
      ctx.fillText(`×${g.stackedCount}`, g.rect.x + g.rect.width + 2, g.rect.y + 8);
    }
  }
  for (const g of model.bucketGlyphs ?? []) {
    if (g.rect.y + g.rect.height < row.y || g.rect.y > row.y + row.h) continue;
    const slotColor = colorBySlot.get(g.slot) ?? '#888';
    // 混合桶在类型着色关闭时尊重选择，用轨道色，不统一变灰；用 glyph 自带聚合数据，支持合并后的粗桶。
    const mixed = (g.keyCount > 0 ? 1 : 0) + (g.deltaCount > 0 ? 1 : 0) + (g.unknownCount > 0 ? 1 : 0) > 1;
    ctx.globalAlpha = g.complete ? 1 : 0.55;
    if (!model.colorByType) ctx.fillStyle = slotColor;
    else if (mixed) ctx.fillStyle = model.colors.unknown;
    else if (g.keyCount > 0) ctx.fillStyle = barColor(model, true, slotColor);
    else if (g.deltaCount > 0) ctx.fillStyle = barColor(model, false, slotColor);
    else ctx.fillStyle = model.colors.unknown;
    ctx.fillRect(g.rect.x, g.rect.y, g.rect.width, g.rect.height);
    ctx.globalAlpha = 1;
  }
}
