import type { ReviewSession } from '../../session.ts';
import type { Slot } from '../../../shared/review/model.ts';
import { AXIS_H, drawTimeAxis, drawHitRect, drawHitPoint, plotGeometry, formatAxis as formatTime } from './canvas.ts';
import { chartBarWidth, referenceNodeRadius, representativeIntervalUs, chartFrameHoverStart } from './geometry.ts';
import { panTimeRange, zoomTimeRange } from '../../../shared/analysis/metadata/projection.ts';
import { diagramTime, naluName } from '../../../shared/analysis/bitstream/diagrams.ts';
import type { DiagramPicture, DiagramBucket } from '../../../shared/analysis/bitstream/diagrams.ts';
import { t, msg } from '../../i18n.ts';
import { MIN_ANALYSIS_SPAN_US, type AnalysisAction, type AnalysisViewport, type ChartHover } from './shared.ts';
import { analysisDetailTable, analysisMetricValue, analysisTrackBadge, installFloatingAnalysisCard } from './card.ts';
import { installChartNavigation } from './chart-navigation.ts';
import { installFilterGestures } from './filter-gestures.ts';
export type BitstreamDiagram = 'nalu-size' | 'nalu-types' | 'references';
const palette = ['#6aaeff', '#f0b429', '#5bc9b3', '#bca0f8', '#ef839f', '#d4bd82', '#67c8ec', '#a8cd75'];
const typeColor = (type: number) => palette[type % palette.length];
function drawContainerBar(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, color: string, ink: string) {
  ctx.fillStyle = color; ctx.fillRect(x, y, width, height);
  ctx.save(); ctx.beginPath(); ctx.rect(x, y, width, height); ctx.clip();
  ctx.strokeStyle = ink; ctx.lineWidth = 1; ctx.globalAlpha = .45; ctx.beginPath();
  for (let start = x - height; start < x + width; start += 5) { ctx.moveTo(start, y + height); ctx.lineTo(start + height, y); }
  ctx.stroke(); ctx.restore();
}
const seconds = (us: number) => `${(us / 1e6).toFixed(3)}s`;
type CardPresentation = { size: boolean; types: boolean; header?: boolean };
type Point = { x: number; y: number; picture?: DiagramPicture; bucket?: DiagramBucket };
export function installBitstreamDiagrams(host: HTMLElement, session: ReviewSession, act: AnalysisAction, signal: AbortSignal, viewport: AnalysisViewport, options: { hiddenTypes: Set<number>; filterChanged(): void; hover(value: ChartHover | null, clientX?: number, clientY?: number): void; pinned(): boolean; layoutChanged?(): void; rendered?(): void; slotColor?(): string; avoid?(): DOMRect | undefined; inspection(): { status: string; pending: boolean; percent: number; state: string; name: string } }) {
  host.innerHTML = `<div class="bitstream-diagram-head"><div class="bitstream-diagram-navigation"><strong></strong><output></output></div><div class="bitstream-diagram-legend"></div></div><div class="bitstream-diagram-plot"><canvas tabindex="0" role="img" ></canvas><div class="bitstream-diagram-empty"><div class="bitstream-empty-copy"><strong role="status"></strong><span></span></div><button type="button" class="bitstream-empty-action"></button></div></div><output class="bitstream-diagram-detail" aria-live="polite"></output>`;
  const canvas = host.querySelector('canvas')!, ctx = canvas.getContext('2d')!;
  const plot = host.querySelector<HTMLElement>('.bitstream-diagram-plot')!;
  const label = host.querySelector('output')!, detail = host.querySelector<HTMLOutputElement>('.bitstream-diagram-detail')!;
  const empty = host.querySelector<HTMLElement>('.bitstream-diagram-empty')!, legend = host.querySelector<HTMLElement>('.bitstream-diagram-legend')!;
  const emptyTitle = empty.querySelector('strong')!, emptyDescription = empty.querySelector('span')!, emptyAction = empty.querySelector('button')!;
  const headerCard = installFloatingAnalysisCard(canvas, signal, () => host.getBoundingClientRect(), true, options.avoid);
  headerCard.element.classList.add('analysis-view-card', 'analysis-container-card');
  headerCard.element.dataset.origin = 'container';
  let headerGeometry: { x: number; width: number; timeUs: number; widthUs: number } | null = null;
  let headerHovered = false;
  const hideHeader = () => { headerCard.hide(); if (headerHovered) { headerHovered = false; drawSoon(); } };
  const showHeader = (clientX: number, clientY?: number) => {
    if (options.pinned()) return;
    const headers = (data?.containerHeaders ?? []).map(header => ({ ...header, nalus: header.nalus.filter(n => !hiddenTypes.has(n.type)) })).filter(header => header.nalus.length);
    if (!headers.length) return;
    headerHovered = true;
    options.hover(null);
    const table = document.createElement('table'); table.className = 'fl-grid';
    const title = table.createTHead().insertRow().insertCell(); title.colSpan = 3;
    title.append(analysisTrackBadge(slot), document.createTextNode(` −1 · ${t(msg('analysis.containerConfig', '容器配置'))}`));
    const origin = document.createElement('span'); origin.className = 'analysis-card-origin'; origin.textContent = `${t(msg('analysis.containerOrigin', '来自容器头部'))} · ${headers[0].box}`; title.append(origin);
    const body = table.createTBody();
    for (const header of headers) {
    if (headers.length > 1) { const label = body.insertRow().insertCell(); label.colSpan = 3; label.textContent = t(msg('analysis.containerConfigNumber', '配置 {number}'), { number: header.configuration + 1 }); }
    const counts = new Map<number, { count: number; bytes: number }>();
    for (const n of header.nalus) { const value = counts.get(n.type) ?? { count: 0, bytes: 0 }; value.count++; value.bytes += n.size; counts.set(n.type, value); }
    for (const [nalType, value] of counts) {
      const row = body.insertRow(); row.dataset.naluType = String(nalType); row.classList.add('is-selected');
      const label = document.createElement('th'); const dot = document.createElement('span'); dot.className = 'dot'; dot.style.background = typeColor(nalType);
      label.append(dot, document.createTextNode(naluName(data!.codec!, nalType))); row.append(label);
      row.insertCell().textContent = t(msg('analysis.containerNaluCount', '{count} 个'), { count: value.count });
      row.insertCell().textContent = `${value.bytes.toLocaleString()} B`;
    }
    }
    const note = document.createElement('p'); note.className = 'analysis-card-note';
    note.textContent = t(msg('analysis.containerNaluHint', '不计入逐帧 NALU 和帧大小。'));
    headerCard.element.replaceChildren(table, note); headerCard.element.hidden = false;
    headerCard.element.dataset.column = '-1';
    const clip = host.closest('.analysis-charts')!.getBoundingClientRect(), rect = (host.closest('.bitstream-nalu-group:not([hidden])') ?? host).getBoundingClientRect();
    const top = Math.max(8, clip.top, rect.top) + 2, bottom = Math.min(innerHeight - 8, clip.bottom, rect.bottom) - 2;
    headerCard.element.style.setProperty('--card-max-height', `${innerHeight - 16}px`);
    headerCard.position(clientX, top);
    const centerY = host.closest('.analysis-charts.multiple') || clientY == null ? (top + bottom) / 2 : clientY;
    const height = headerCard.element.offsetHeight;
    headerCard.position(clientX, height <= bottom - top ? Math.max(top, Math.min(bottom - height, centerY - height / 2)) : centerY - height / 2);
  };
  canvas.addEventListener('pointerleave', hideHeader, { signal });
  const trackBadge = document.createElement('span'); trackBadge.className = 'bitstream-track-badge';
  host.querySelector('.bitstream-diagram-navigation')!.prepend(trackBadge);
  const layerBadge = document.createElement('span'); layerBadge.className = 'bitstream-layer-badge'; layerBadge.hidden = true;
  host.querySelector('.bitstream-diagram-navigation')!.append(layerBadge);
  const layerLabel = (p: DiagramPicture) => {
    const layer = p.referenceLayer;
    return !layer ? '—' : `${layer.source === 'temporal-id' ? 'T' : '≈'}${layer.level}${layer.provisional ? '*' : ''}`;
  };
  const layerTitle = (p: DiagramPicture) => t(p.referenceLayer?.source === 'temporal-id' ? msg('analysis.temporalLayer', '时间层级')
    : p.referenceLayer?.provisional ? msg('analysis.inferredLayerPartial', '推断层级（参考信息不完整）') : msg('analysis.inferredLayer', '推断层级'));
  let mode: BitstreamDiagram = 'nalu-size', slot: Slot | undefined, identity = '';
  let data: ReturnType<ReviewSession['queryBitstreamChart']> = null;
  let chosenAu: number | undefined, chosenBucket: number | undefined, points: Point[] = [];
  let raf = 0, lastSignature = '', geometry = { left: 65, right: 66 };
  const hiddenTypes = options?.hiddenTypes ?? new Set<number>();
  let sharedHover: ChartHover | null = null;
  let pointerRaf = 0, pendingPointer: PointerEvent | null = null;
  const clearHover = () => {
    hideHeader();
    if (pointerRaf) cancelAnimationFrame(pointerRaf);
    pointerRaf = 0; pendingPointer = null; options.hover(null);
  };
  const resetView = () => { clearHover(); viewport.set(null); chosenAu = chosenBucket = undefined; detail.textContent = ''; };
  const filteredNalus = (picture: DiagramPicture) => picture.nalus.filter(n => !hiddenTypes.has(n.type));
  const pictureTime = (picture: DiagramPicture) => diagramTime(picture, viewport.axis())!;
  const axisLabel = () => viewport.axis().toUpperCase();
  const sessionTime = (sourceUs: number) => sourceUs - (data?.firstPtsUs ?? 0) + (data?.offsetUs ?? 0);
  const inPlot = (x: number) => x >= geometry.left && x <= geometry.right;
  const drawSoon = () => { if (!raf && !host.hidden) raf = requestAnimationFrame(() => { raf = 0; draw(); }); };
  function pointDetail(point: Point): string {
    if (point.picture) {
      const picture = point.picture, r = picture.references;
      const nalText = filteredNalus(picture).map(n => `${naluName(picture.codec, n.type)} ${n.size.toLocaleString()} B`).join(' · ');
      const refText = r?.state === 'ready' ? r.edges.map(e => `L${e.list}→AU ${e.au}`).join(' · ') || '—' : t(msg('analysis.referenceMissing', '参考记录不可用'));
      return `AU ${picture.picture.au} · ${axisLabel()} ${seconds(pictureTime(picture))} · ${r?.frameType ?? '—'}${r ? ` · POC ${r.poc}` : ''} · ${mode === 'references' ? refText : nalText}`;
    }
    const b = point.bucket!;
    const totals = data!.types.filter(type => !hiddenTypes.has(type) && b.naluCounts[type]).map(type => `${naluName(data!.codec!, type)} ${b.naluCounts[type]} · ${b.naluBytes[type].toLocaleString()} B`).join(' · ');
    return t(msg('analysis.diagramBucketDetail', '{start}–{end} · {count} 帧 · {values}'), {
      start: formatTime(sessionTime(b.startUs)), end: formatTime(sessionTime(b.endUs)), count: b.pictures,
      values: mode === 'references' ? `I ${b.frames.I} · P ${b.frames.P} · B ${b.frames.B}` : totals,
    });
  }
  function showPoint(point: Point, clientX = canvas.getBoundingClientRect().left + point.x, cursorTimeUs?: number, clientY?: number) {
    if (options.pinned()) return;
    options.hover({ timeUs: point.picture ? sessionTime(pictureTime(point.picture)) : sessionTime((point.bucket!.startUs + point.bucket!.endUs) / 2),
      slot, au: point.picture?.picture.au, sourceVersion: data?.sourceVersion, cursorTimeUs }, clientX, clientY);
  }
  function pointTable(point: Point, presentation: CardPresentation) {
    const time = (point.picture ? formatTime(sessionTime(pictureTime(point.picture))) : `${formatTime(sessionTime(point.bucket!.startUs))}–${formatTime(sessionTime(point.bucket!.endUs))}`) + ` · ${axisLabel()}`;
    const { table, body, row } = analysisDetailTable({
      kind: mode === 'references' ? 'references' : 'nalu', aggregated: !!point.bucket,
      valueColumns: mode === 'references' ? 1 : Number(presentation.size) + Number(presentation.types),
      header: presentation.header === false ? undefined : { time, slot },
    });
    if (point.picture) {
      const p = point.picture, r = p.references;
      const frame = row(t(msg('analysis.codedFrame', '编码帧')), `#${p.picture.au + 1}${r ? ` · ${r.frameType} · POC ${r.poc}` : ''}`); frame.className = 'analysis-card-frame';
      if (mode === 'references') {
        const depth = document.createElement('span'); depth.className = 'analysis-card-depth';
        depth.textContent = layerLabel(p); depth.title = layerTitle(p); depth.dataset.layerSource = p.referenceLayer?.source ?? 'unknown';
        frame.cells[1].append(depth);
        for (const list of [0, 1] as const) row(`L${list}`, r?.state === 'ready' ? r.edges.filter(e => e.list === list).map(e => `#${e.au + 1}`).join(', ') || '—' : t(msg('analysis.referenceMissing', '参考记录不可用'))).dataset.list = String(list);
      }
    } else {
      row(t(msg('analysis.bucketFrames', '汇总帧数')), String(point.bucket!.pictures)).className = 'analysis-card-frame';
      if (mode === 'references') for (const type of ['I', 'P', 'B'] as const) row(type, String(point.bucket!.frames[type]));
    }
    if (mode !== 'references') {
      const counts = Array<number>(64).fill(0), bytes = Array<number>(64).fill(0);
      if (point.picture) for (const n of filteredNalus(point.picture)) { counts[n.type]++; bytes[n.type] += n.size; }
      else for (const type of data!.types) if (!hiddenTypes.has(type)) { counts[type] = point.bucket!.naluCounts[type]; bytes[type] = point.bucket!.naluBytes[type]; }
      const types = data!.types.filter(type => counts[type]);
      const totalBytes = bytes.reduce((sum, value) => sum + value, 0);
      const countUnit = t(msg('analysis.naluCountUnit', '个'));
      const columns = (tr: HTMLTableRowElement, count: number, size: number) => {
        tr.cells[1]?.remove();
        if (presentation.types) analysisMetricValue(tr.insertCell(), String(count), countUnit);
        if (presentation.size) { const cell = tr.insertCell(); analysisMetricValue(cell, (size / 1024).toFixed(1), 'KiB'); cell.title = `${size.toLocaleString()} B`; }
      };
      for (const type of types.slice(0, 10)) columns(row(naluName(data!.codec!, type), '', typeColor(type)), counts[type], bytes[type]);
      if (types.length > 10) row(t(msg('analysis.otherNaluTypes', '其他类型')), String(types.length - 10)).cells[1].colSpan = Number(presentation.types) + Number(presentation.size);
      const total = row(t(msg('analysis.naluSelected', '选中 NALU')), ''); total.className = 'analysis-card-total';
      columns(total, counts.reduce((sum, value) => sum + value, 0), totalBytes);
      if (point.bucket && presentation.size) row(t(msg('analysis.meanNaluSize', '平均每帧 · KiB')), (totalBytes / point.bucket.pictures / 1024).toFixed(1)).cells[1].colSpan = Number(presentation.types) + Number(presentation.size);
      // Metadata spans all selected value columns; type and size rows stay aligned.
      const meta = body.querySelector<HTMLTableRowElement>('.analysis-card-frame');
      if (meta) meta.cells[1].colSpan = Number(presentation.types) + Number(presentation.size);
    }
    return table;
  }
  function draw(prepareOnly = false) {
    if (host.hidden || !host.getClientRects().length) return;
    // Single and multiple diagrams use the same fixed panel time axis.
    const showTimeAxis = false;
    const axisHeight = showTimeAxis ? AXIS_H : 0;
    const bottomPadding = showTimeAxis ? 0 : 4;
    const w = Math.max(1, Math.floor(plot.clientWidth)), sharedGeometry = plotGeometry(w), left = sharedGeometry.gutter, right = left + sharedGeometry.plotW, top = 8, span = sharedGeometry.plotW;
    geometry = { left, right };
    const base = slot ? session.queryBitstreamChart(slot, undefined, undefined, Math.max(32, Math.min(4096, Math.round(span))), viewport.axis()) : null;
    if (base && identity && identity !== base.sourceVersion) { hiddenTypes.clear(); chosenAu = chosenBucket = undefined; }
    if (base) identity = base.sourceVersion;
    const domain = viewport.domain(), duration = Math.max(1, domain.end - domain.start);
    const { start: startUs, end: endUs } = viewport.range();
    const column = viewport.containerColumn();
    headerGeometry = null;
    const queryStart = Math.max(startUs, base?.domain.start ?? startUs), queryEnd = Math.min(endUs, base?.domain.end ?? endUs);
    data = base && queryEnd > queryStart ? queryStart === base.startUs && queryEnd === base.endUs ? base : session.queryBitstreamChart(slot!, queryStart, queryEnd, Math.max(32, Math.min(4096, Math.round(span))), viewport.axis())
      : base ? { ...base, pictures: [], buckets: [], aggregated: false, detailMissing: false } : null;
    const pictures = data?.pictures ?? [], buckets = data?.buckets ?? [];
    const headers = mode === 'references' ? [] : data?.containerHeaders ?? [];

    const inferred = pictures.some(p => p.referenceLayer?.source === 'inferred');
    layerBadge.hidden = mode !== 'references' || !pictures.some(p => p.referenceLayer);
    layerBadge.textContent = t(inferred ? msg('analysis.inferredLayer', '推断层级') : msg('analysis.temporalLayer', '时间层级'));
    layerBadge.title = inferred ? t(msg('analysis.inferredLayerHint', '按相邻 I/P 锚帧间的局部参考关系推断，不代表码流标记的时间层。* 表示参考信息不完整。')) : t(msg('analysis.temporalLayerHint', '层级来自图像 VCL NAL 的 Temporal ID。'));
    const style = getComputedStyle(host);
    const minimumPlot = Number.parseFloat(style.getPropertyValue('--analysis-chart-min-plot-height')) || 36;
    const minimumTypeRow = Number.parseFloat(style.getPropertyValue('--analysis-type-row-min-height')) || 10;
    const headerTypes = [...new Set(headers.flatMap(header => header.nalus.map(n => n.type)))];
    const shownHeaderTypes = headerTypes.filter(type => !hiddenTypes.has(type));
    const typeRows = mode === 'nalu-types' ? new Set([...(data?.types ?? []).filter(type => !hiddenTypes.has(type)), ...(column.timeUs >= startUs && column.timeUs <= endUs ? shownHeaderTypes : [])]).size : 0;
    const referencePictures = mode === 'references' ? pictures.filter(p => p.references?.state === 'ready') : [];
    const referenceDepth = Math.max(0, ...referencePictures.map(p => p.referenceLayer?.level ?? 0));
    const frameCellWidth = representativeIntervalUs(pictures.map(p => pictureTime(p))) / (endUs - startUs) * span;
    const desiredNodeRadius = referenceNodeRadius(frameCellWidth);
    const minimumReferencePlot = referencePictures.length && !buckets.length ? desiredNodeRadius * 2 + referenceDepth * (desiredNodeRadius * 2 + 4) + top + bottomPadding + 4 : 0;
    const minimum = `${Math.max(minimumPlot, typeRows * minimumTypeRow + top + bottomPadding, minimumReferencePlot) + axisHeight}px`;
    if (host.style.getPropertyValue('--chart-min-plot-height') !== minimum) { host.style.setProperty('--chart-min-plot-height', minimum); options.layoutChanged?.(); }
    canvas.dataset.plotLeft = String(left); canvas.dataset.plotRight = String(right);
    canvas.dataset.timeAxis = String(showTimeAxis);
    const hovered = sharedHover ? matchingPoint(sharedHover) : null;
    chosenAu = hovered?.picture?.picture.au; chosenBucket = hovered?.bucket?.startUs;
    canvas.dataset.diagram = mode; canvas.dataset.pictures = String(pictures.length);
    canvas.dataset.totalPictures = String(data?.count ?? 0); canvas.dataset.buckets = String(buckets.length);
    canvas.dataset.aggregated = String(data?.aggregated ?? false);
    canvas.dataset.nalus = String(pictures.reduce((sum, p) => sum + p.nalus.length, 0) + buckets.reduce((sum, b) => sum + b.naluCounts.reduce((s, n) => s + n, 0), 0));
    canvas.dataset.references = String(pictures.reduce((sum, p) => sum + (p.references?.state === 'ready' ? p.references.edges.length : 0), 0) + buckets.reduce((sum, b) => sum + b.references, 0));
    canvas.dataset.viewStart = String((startUs - domain.start) / duration); canvas.dataset.viewEnd = String((endUs - domain.start) / duration);
    canvas.dataset.axis = viewport.axis();
    canvas.dataset.axisStart = String(startUs); canvas.dataset.axisEnd = String(endUs);
    // The leading blank cell is display space, not an extra media time range.
    label.textContent = data ? `${slot} · ${formatTime(Math.max(startUs, Math.min(0, data.domain.start)))}–${formatTime(endUs)}` : slot ?? '—';
    const usable = mode === 'references' ? referencePictures : pictures;
    const hasRecords = usable.length > 0 || (mode !== 'references' ? buckets.length > 0 : buckets.some(b => b.frames.I + b.frames.P + b.frames.B > 0));
    empty.hidden = hasRecords; canvas.hidden = !data?.count; legend.hidden = !hasRecords;
    const inspection = options.inspection();
    const noResults = !base?.count;
    emptyTitle.textContent = !slot ? t(msg('analysis.diagramNoTrack', '先载入一条视频轨道。'))
      : noResults ? inspection.state !== 'idle' ? inspection.status : t(msg('analysis.streamNotStarted','{slot} 尚未检查'), { slot })
      : mode === 'references' && (pictures.length || buckets.length) ? t(msg('analysis.diagramReferencesUnsupported', '这些帧没有可用的参考记录。需要支持参考列表的分析内核。'))
      : t(msg('analysis.diagramUnanalyzed', '此范围尚未收到检查结果。'));
    emptyDescription.textContent = noResults ? inspection.pending ? t(msg('analysis.streamLiveHint','结果会随分析进度逐步显示。')) : t(msg('analysis.streamEmptyHint','正在准备分析，NALU 和帧参考结果会自动显示。')) : inspection.status;
    emptyDescription.title = inspection.name;
    emptyAction.hidden = noResults || inspection.pending || !slot || (mode === 'references' && !!(pictures.length || buckets.length));
    emptyAction.textContent = t(msg('analysis.fullRange','完整范围'));
    emptyAction.onclick = resetView;
    const emptyState = String(!hasRecords);
    if (host.dataset.empty !== emptyState) { host.dataset.empty = emptyState; options.layoutChanged?.(); }
    if (!hasRecords) { ctx.clearRect(0, 0, canvas.width, canvas.height); points = []; legend.replaceChildren(); lastSignature = ''; detail.textContent = ''; return; }
    const text = style.getPropertyValue('--text-secondary').trim() || '#aaa', grid = style.getPropertyValue('--analysis-grid').trim() || '#80808030';
    const hitOutline = style.getPropertyValue('--text').trim() || text;
    const referenceColors = [style.getPropertyValue('--analysis-reference-l0').trim() || '#d75d18', style.getPropertyValue('--analysis-reference-l1').trim() || '#14813b'];
    const legendItems: { label: string; color: string; type?: number; origin?: 'container' | 'mixed'; boxes?: string }[] = [];
    if (mode === 'references') {
      legendItems.push({ label: 'I', color: '#f0b429' }, { label: 'P', color: '#6aaeff' }, { label: 'B', color: '#bca0f8' });
      if (!buckets.length) legendItems.push({ label: 'L0', color: referenceColors[0] }, { label: 'L1', color: referenceColors[1] });
    } else {
      const types = [...new Set([...data!.types, ...headerTypes])].sort((a, b) => a - b), codec = data!.codec!;
      for (const type of types) legendItems.push({ label: naluName(codec, type), color: typeColor(type), type,
        origin: headerTypes.includes(type) ? data!.types.includes(type) ? 'mixed' : 'container' : undefined,
        boxes: headerTypes.includes(type) ? [...new Set(headers.filter(header => header.nalus.some(n => n.type === type)).map(header => header.box))].join(' / ') : undefined });
    }
    const signature = JSON.stringify([mode, legendItems]);
    if (signature !== lastSignature) {
      lastSignature = signature; legend.replaceChildren();
      if (mode !== 'references') { const all = document.createElement('button'); all.type = 'button'; all.dataset.filter = 'all'; all.textContent = t(msg('analysis.naluFilterAll', '全部')); legend.append(all); }
      for (const item of legendItems) {
        const entry = document.createElement(item.type === undefined ? 'span' : 'button'), dot = document.createElement('i');
        if (entry instanceof HTMLButtonElement) { entry.type = 'button'; entry.dataset.naluType = String(item.type); }
        if (mode === 'references' && /^L[01]$/.test(item.label)) entry.dataset.referenceList = item.label.slice(1);
        dot.style.backgroundColor = item.color;
        if (entry.dataset.referenceList === '1') { dot.style.backgroundColor = 'transparent'; dot.style.borderTop = `2px dashed ${item.color}`; }
        entry.append(dot, document.createTextNode(item.label));
        const filterHint = item.type === undefined ? '' : t(msg('analysis.naluSoloHint', '点击切换筛选；右键或长按单选，再次操作恢复全部。'));
        if (filterHint) entry.title = filterHint;
        if (item.origin) {
          entry.dataset.origin = item.origin; dot.className = 'container-nalu-swatch';
          entry.setAttribute('aria-label', item.label);
          entry.title = `${t(msg('analysis.containerOrigin', '来自容器头部'))} · ${item.boxes}${item.origin === 'mixed' ? ` · ${t(msg('analysis.containerMixedHint', '也出现在逐帧 NALU 中'))}` : ''} · ${filterHint}`;
          entry.setAttribute('aria-description', entry.title);
        }
        legend.append(entry);
      }
    }
    for (const button of legend.querySelectorAll<HTMLButtonElement>('button')) button.setAttribute('aria-pressed', String(button.dataset.filter === 'all' ? !hiddenTypes.size : !hiddenTypes.has(Number(button.dataset.naluType))));
    // All charts prepare their legends and minimum heights before any canvas
    // measures the shared flex layout. Never paint a provisional plot height.
    if (prepareOnly) return;
    const h = Math.max(showTimeAxis ? 48 : 36, plot.clientHeight);
    const bottom = h - axisHeight - bottomPadding;
    const axisLabelY = (y: number) => Math.min(h - 3, y + 4);
    const dpr = Math.min(2, devicePixelRatio || 1);
    canvas.style.width = `${w}px`; canvas.style.height = `${h}px`; canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, w, h); ctx.font = '10px system-ui'; ctx.fillStyle = text; ctx.strokeStyle = grid; ctx.lineWidth = 1;
    const xOf = (sourceUs: number) => left + (sessionTime(sourceUs) - startUs) / Math.max(1, endUs - startUs) * span;
    const clipPlot = () => { ctx.save(); ctx.beginPath(); ctx.rect(left, 0, span, bottom + 5); ctx.clip(); };
    points = []; canvas.dataset.renderedNalus = '0'; canvas.dataset.renderedBytes = '0';
    canvas.dataset.nodeRadius = '';
    if (mode === 'references') {
      if (buckets.length) {
        for (const [row, type] of (['I', 'P', 'B'] as const).entries()) {
          const yy = top + (row + .5) * (bottom - top) / 3;
          ctx.strokeStyle = grid; ctx.beginPath(); ctx.moveTo(left, yy); ctx.lineTo(right, yy); ctx.stroke(); ctx.fillStyle = text; ctx.fillText(type, 10, yy + 4);
          const max = Math.max(1, ...buckets.map(b => b.frames[type]));
          clipPlot();
          for (const b of buckets) if (b.frames[type]) {
            const x = xOf((b.startUs + b.endUs) / 2), width = chartBarWidth((b.endUs - b.startUs) / (endUs - startUs) * span, 2);
            ctx.fillStyle = legendItems[row].color; ctx.globalAlpha = .25 + .75 * Math.sqrt(b.frames[type] / max);
            ctx.fillRect(x - width / 2, yy - 4, width, 8); points.push({ x, y: yy, bucket: b });
            ctx.globalAlpha = 1;
            if (b.startUs === chosenBucket) drawHitRect(ctx, { x: x - width / 2, y: yy - 4, width, height: 8 }, hitOutline);
          }
          ctx.restore(); ctx.globalAlpha = 1;
        }
      } else {
        const maxDepth = referenceDepth;
        canvas.dataset.layerSource = inferred ? 'inferred' : 'temporal-id'; canvas.dataset.maxLayer = String(maxDepth);
        // Only guard the outer plot edges during layout; adjacent layers do not cap node size.
        const radius = Math.min(desiredNodeRadius, Math.max(2, (bottom - top - 4) / 2)), inset = radius + 2;
        canvas.dataset.nodeRadius = String(radius);
        const layerHeight = Math.max(1, bottom - top - inset * 2);
        const yOf = (level: number) => bottom - inset - level / Math.max(1, maxDepth) * layerHeight;
        const depthTickStep = Math.max(1, Math.ceil(maxDepth * 12 / layerHeight));
        for (let level = 0; level <= maxDepth; level++) {
          ctx.strokeStyle = grid; ctx.beginPath(); ctx.moveTo(left, yOf(level)); ctx.lineTo(right, yOf(level)); ctx.stroke();
          if (level % depthTickStep === 0) { ctx.fillStyle = text; ctx.fillText(`${inferred ? '≈' : 'T'}${level}`, 9, yOf(level) + 4); }
        }
        const map = new Map<number, Point>();
        for (const p of usable) { const point = { picture: p, x: xOf(pictureTime(p)), y: yOf(p.referenceLayer?.level ?? 0) }; points.push(point); map.set(p.picture.au, point); }
        clipPlot();
        const selected = chosenAu ?? data?.anchorAu;
        for (const point of points) for (const edge of point.picture!.references!.edges) {
          const target = map.get(edge.au), highlighted = point.picture!.picture.au === selected || edge.au === selected;
          const x = target?.x ?? left - 12, yy = target?.y ?? bottom - 8;
          ctx.strokeStyle = highlighted ? referenceColors[edge.list] : grid; ctx.lineWidth = highlighted ? 1.6 : 1; ctx.setLineDash(!target ? [2, 3] : edge.list === 1 ? [7, 4] : []);
          ctx.beginPath(); ctx.moveTo(point.x, point.y); ctx.lineTo(x, yy); ctx.stroke(); ctx.setLineDash([]);
          if (highlighted) { const angle = Math.atan2(yy - point.y, x - point.x), clearance = target ? radius + 3 : 8, ax = x - Math.cos(angle) * clearance, ay = yy - Math.sin(angle) * clearance; ctx.beginPath(); ctx.moveTo(ax - Math.cos(angle - .5) * 5, ay - Math.sin(angle - .5) * 5); ctx.lineTo(ax, ay); ctx.lineTo(ax - Math.cos(angle + .5) * 5, ay - Math.sin(angle + .5) * 5); ctx.stroke(); }
        }
        for (const point of points) {
          const frameType = point.picture!.references!.frameType, color = frameType === 'I' ? '#f0b429' : frameType === 'P' ? '#6aaeff' : '#bca0f8', picked = point.picture!.picture.au === selected;
          if (picked) drawHitPoint(ctx, point.x, point.y, radius, color, hitOutline);
          else { ctx.fillStyle = color; ctx.beginPath(); ctx.arc(point.x, point.y, radius, 0, Math.PI * 2); ctx.fill(); }
        }
        ctx.restore();
      }
      canvas.setAttribute('aria-label', t(msg('analysis.referenceCanvas', '帧参考关系图。横轴为整片时间；总览显示帧类型分布，放大后显示参考金字塔和连线。方向键选择，回车查看。')));
    } else {
      const types = [...new Set([...data!.types, ...headerTypes])].sort((a,b) => a-b), shownTypes = types.filter(type => !hiddenTypes.has(type)), codec = data!.codec!;
      let rowTypes: number[];
      const headerCounts = Array(64).fill(0), headerBytes = Array(64).fill(0);
      for (const header of headers) for (const n of header.nalus) if (!hiddenTypes.has(n.type)) { headerCounts[n.type]++; headerBytes[n.type] += n.size; }
      const frameUs = representativeIntervalUs(pictures.map(p => pictureTime(p)));
      const frameWidth = frameUs / (endUs - startUs) * span;
      const headerX = left + (column.timeUs - startUs) / (endUs - startUs) * span;
      const headerWidth = frameWidth;
      const headerVisible = shownHeaderTypes.length > 0 && inPlot(headerX);
      rowTypes = [...new Set([...data!.types.filter(type => !hiddenTypes.has(type)), ...(headerVisible ? shownHeaderTypes : [])])].sort((a,b) => a-b);
      if (headerVisible) headerGeometry = { x:headerX, width:headerWidth, ...column };
      canvas.dataset.containerX = headerVisible ? String(headerX) : '';
      canvas.dataset.containerWidth = headerVisible ? String(headerWidth) : '';
      canvas.dataset.containerColumn = headerVisible ? '-1' : '';
      canvas.dataset.containerTypes = headerVisible ? shownHeaderTypes.join(',') : '';
      empty.hidden = !!shownTypes.length;
      if (!shownTypes.length) { emptyTitle.textContent = t(msg('analysis.naluFilterEmpty', '没有选中 NALU 类型。点击图例或“全部”恢复显示。')); emptyDescription.textContent = ''; emptyAction.hidden = true; }
      const samples = buckets.length ? buckets.map(b => ({ bucket: b, x: xOf((b.startUs + b.endUs) / 2), width: (b.endUs - b.startUs) / (endUs - startUs) * span, counts: b.naluCounts, bytes: b.naluBytes, divisor: b.pictures }))
        : pictures.map(p => { const counts = Array(64).fill(0), bytes = Array(64).fill(0); for (const n of p.nalus) { counts[n.type]++; bytes[n.type] += n.size; } return { picture: p, x: xOf(pictureTime(p)), width: frameWidth, counts, bytes, divisor: 1 }; });
      canvas.dataset.renderedNalus = String(samples.reduce((sum, p) => sum + shownTypes.reduce((s, type) => s + p.counts[type], 0), 0));
      canvas.dataset.renderedBytes = String(samples.reduce((sum, p) => sum + shownTypes.reduce((s, type) => s + p.bytes[type], 0), 0));
      const maxBytes = Math.max(1, headerVisible ? headerBytes.reduce((sum,n)=>sum+n,0) : 0, ...samples.map(p => shownTypes.reduce((sum, type) => sum + p.bytes[type], 0) / p.divisor));
      if (mode === 'nalu-size') for (let i = 0; i < 3; i++) { const yy = top + (bottom - top) * i / 2; ctx.strokeStyle = grid; ctx.beginPath(); ctx.moveTo(left, yy); ctx.lineTo(right, yy); ctx.stroke(); if (i === 1 && bottom - top < 28) continue; ctx.fillStyle = text; ctx.fillText(`${(maxBytes * (1 - i / 2) / 1024).toFixed(maxBytes / 1024 >= 100 ? 0 : 1)} KiB`, 2, axisLabelY(yy)); }
      else for (let i = 0; i < rowTypes.length; i++) { const yy = top + (i + .5) * (bottom - top) / rowTypes.length; ctx.strokeStyle = grid; ctx.beginPath(); ctx.moveTo(left, yy); ctx.lineTo(right, yy); ctx.stroke(); ctx.fillStyle = text; ctx.fillText(String(rowTypes[i]), 10, yy + 4); }
      clipPlot();
      for (const sample of samples) {
        let yy = bottom;
        const picked = 'picture' in sample ? sample.picture?.picture.au === chosenAu : sample.bucket?.startUs === chosenBucket;
        if (!shownTypes.some(type => sample.counts[type])) continue;
        for (const type of shownTypes) if (sample.counts[type]) {
          ctx.fillStyle = typeColor(type);
          if (mode === 'nalu-size') { const hh = sample.bytes[type] / sample.divisor / maxBytes * (bottom - top); yy -= hh; const width = chartBarWidth(sample.width); ctx.fillRect(sample.x - width / 2, yy, width, Math.max(.75, hh)); }
          else { const row = top + (rowTypes.indexOf(type) + .5) * (bottom - top) / rowTypes.length; ctx.globalAlpha = buckets.length ? .25 + .75 * Math.min(1, sample.counts[type] / sample.divisor) : 1; const width = chartBarWidth(sample.width, 2); ctx.fillRect(sample.x - width / 2, row - 3, width, 6); ctx.globalAlpha = 1; if (picked) drawHitRect(ctx, { x: sample.x - width / 2, y: row - 3, width, height: 6 }, hitOutline); }
        }
        if (picked && mode === 'nalu-size') { const width = chartBarWidth(sample.width); drawHitRect(ctx, { x: sample.x - width / 2, y: yy, width, height: bottom - yy }, hitOutline); }
        points.push({ ...sample, y: yy });
        if (!sharedHover && 'picture' in sample && sample.picture?.picture.au === data?.anchorAu) { ctx.strokeStyle = text; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(sample.x, top - 3); ctx.lineTo(sample.x, bottom + 4); ctx.stroke(); }
      }
      if (headerVisible) {
        const width = chartBarWidth(headerWidth, mode === 'nalu-size' ? 1 : 2);
        ctx.fillStyle = text; ctx.globalAlpha = .06; ctx.fillRect(headerX - headerWidth / 2, top, headerWidth, bottom - top); ctx.globalAlpha = 1;
        let yy = bottom;
        for (const type of shownHeaderTypes) {
          ctx.fillStyle = typeColor(type);
          if (mode === 'nalu-size') { const hh = Math.max(2, headerBytes[type] / maxBytes * (bottom - top)); yy -= hh; drawContainerBar(ctx, headerX - width / 2, yy, width, hh, typeColor(type), hitOutline); }
          else { const row = top + (rowTypes.indexOf(type) + .5) * (bottom - top) / rowTypes.length; drawContainerBar(ctx, headerX - width / 2, row - 3, width, 6, typeColor(type), hitOutline); if (headerHovered) drawHitRect(ctx, { x:headerX-width/2, y:row-3, width, height:6 }, hitOutline); }
        }
        if (headerHovered && mode === 'nalu-size') drawHitRect(ctx, { x:headerX-width/2, y:yy, width, height:bottom-yy }, hitOutline);
        ctx.fillStyle = text; ctx.textAlign = 'center'; ctx.fillText('−1', headerX, top + 7); ctx.textAlign = 'left';
      }
      ctx.restore();
      canvas.setAttribute('aria-label', t(mode === 'nalu-size' ? msg('analysis.naluSizeCanvas', 'NALU 大小图。横轴为整片时间；放大查看逐帧大小。点击图例筛选类型，方向键选择，回车查看。') : msg('analysis.naluTypeCanvas', 'NALU 类型图。横轴为整片时间；放大查看逐帧类型。点击图例筛选类型，方向键选择，回车查看。')));
    }
    points = points.filter(p => inPlot(p.x));
    const cursorTimeUs = sharedHover?.cursorTimeUs ?? sharedHover?.timeUs;
    if (sharedHover && !sharedHover.unmapped && cursorTimeUs! >= startUs && cursorTimeUs! <= endUs) {
      const x = left + (cursorTimeUs! - startUs) / (endUs - startUs) * span;
      ctx.strokeStyle = style.getPropertyValue('--accent').trim() || '#287be8'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, top - 3); ctx.lineTo(x, bottom + 4); ctx.stroke();
    }
    drawTimeAxis(ctx, { width: w, height: h, viewStart: startUs, viewEnd: endUs, showTimeAxis, colors: { grid, axisText: text, text, key: '', delta: '', unknown: '' } });
    const picked = points.find(p => chosenAu !== undefined ? p.picture?.picture.au === chosenAu : chosenBucket !== undefined && p.bucket?.startUs === chosenBucket);
    detail.textContent = picked ? pointDetail(picked) : data?.detailMissing ? t(msg('analysis.diagramDetailEvicted', '当前范围保留了汇总；重新检查可恢复逐帧细节。'))
      : buckets.length ? mode === 'references' ? t(msg('analysis.referenceOverview', '整片帧类型分布 · 放大查看参考金字塔与 L0 / L1 连线。')) : t(msg('analysis.naluOverview', '汇总：每个时间段按选中类型显示平均帧大小与类型分布 · 放大查看逐帧细节。'))
      : mode === 'references' ? t(msg('analysis.referenceLegend', 'L0 实线 · L1 长虚线 · 点线指向视图外参考帧；活动参考列表不表示每个块都使用该参考帧。')) : t(msg('analysis.naluLegend', '横轴为时间 · 大小不含长度前缀 · 点击图例筛选，点击帧定位。'));
    detail.title = detail.textContent;
    options.rendered?.();
  }
  const applyFilter = (button: HTMLButtonElement, solo: boolean) => {
    if (button.dataset.filter === 'all') hiddenTypes.clear();
    else {
      const type = Number(button.dataset.naluType);
      if (solo) {
        const types = [...legend.querySelectorAll<HTMLElement>('[data-nalu-type]')].map(entry => Number(entry.dataset.naluType));
        const alreadySolo = !hiddenTypes.has(type) && types.every(other => other === type || hiddenTypes.has(other));
        hiddenTypes.clear();
        if (!alreadySolo) for (const other of types) if (other !== type) hiddenTypes.add(other);
      } else if (hiddenTypes.has(type)) hiddenTypes.delete(type);
      else hiddenTypes.add(type);
    }
    clearHover(); drawSoon(); options?.filterChanged();
  };
  installFilterGestures(legend, signal, (button, solo) => { if (mode !== 'references') applyFilter(button, solo); });
  const hit = (event: PointerEvent) => { const rect = canvas.getBoundingClientRect(), x = event.clientX - rect.left, y = event.clientY - rect.top; if (!inPlot(x)) return null; return points.reduce<Point | null>((best, p) => !best || (mode === 'references' ? Math.hypot(p.x - x, p.y - y) < Math.hypot(best.x - x, best.y - y) : Math.abs(p.x - x) < Math.abs(best.x - x)) ? p : best, null); };
  const activate = (point: Point) => {
    if (!data) return;
    if (point.picture) void act(() => session.seek(Math.max(0, sessionTime(point.picture!.sourcePtsUs))), 'analysis.diagramSeek', { slot, au: point.picture.picture.au });
    else if (point.bucket) {
      viewport.set(sessionTime(point.bucket.startUs), sessionTime(point.bucket.endUs));
      chosenAu = chosenBucket = undefined; drawSoon();
    }
  };
  canvas.addEventListener('pointermove', event => {
    if (options.pinned()) return;
    pendingPointer = event;
    if (pointerRaf) return;
    pointerRaf = requestAnimationFrame(() => {
      pointerRaf = 0;
      const latest = pendingPointer; pendingPointer = null;
      if (!latest || signal.aborted || options.pinned() || !canvas.matches(':hover')) return;
      const x = latest.clientX - canvas.getBoundingClientRect().left;
      if (!inPlot(x)) return;
      const range = viewport.range(), cursorTimeUs = range.start + (x - geometry.left) / (geometry.right - geometry.left) * (range.end - range.start);
      if (headerGeometry && Math.abs(x - headerGeometry.x) <= headerGeometry.width / 2) { showHeader(latest.clientX, latest.clientY); drawSoon(); return; }
      hideHeader();
      if (cursorTimeUs < chartFrameHoverStart(viewport.containerColumn())) { options.hover(null); return; }
      const point = hit(latest);
      if (point) showPoint(point, latest.clientX, cursorTimeUs, latest.clientY);
      else options.hover({ timeUs: cursorTimeUs, cursorTimeUs, slot }, latest.clientX, latest.clientY);
    });
  }, { signal });
  canvas.addEventListener('blur', () => { if (!host.closest('.analysis-charts')?.matches(':hover')) clearHover(); }, { signal });
  canvas.addEventListener('click', event => { const x = event.clientX - canvas.getBoundingClientRect().left; if (headerGeometry && Math.abs(x-headerGeometry.x) <= headerGeometry.width/2) { showHeader(event.clientX,event.clientY); drawSoon(); return; } const range = viewport.range(); if (range.start + (x-geometry.left)/(geometry.right-geometry.left)*(range.end-range.start) < chartFrameHoverStart(viewport.containerColumn())) return; const p = hit(event); if (p) { showPoint(p, event.clientX, undefined, event.clientY); activate(p); } }, { signal });
  canvas.addEventListener('keydown', event => {
    if (event.key === 'Home' && headerGeometry) { event.preventDefault(); event.stopPropagation(); showHeader(canvas.getBoundingClientRect().left + headerGeometry.x); drawSoon(); return; }
    if (event.key === 'Escape') hideHeader();
    if (!points.length) return;
    if (['ArrowLeft', 'ArrowRight', 'Enter', 'Escape'].includes(event.key)) event.stopPropagation();
    const index = Math.max(0, points.findIndex(p => chosenAu !== undefined ? p.picture?.picture.au === chosenAu : chosenBucket !== undefined ? p.bucket?.startUs === chosenBucket : p.picture?.picture.au === data?.anchorAu));
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      if (headerGeometry && (headerHovered || event.key === 'ArrowLeft' && index === 0)) {
        if (event.key === 'ArrowLeft') { showHeader(canvas.getBoundingClientRect().left + headerGeometry.x); drawSoon(); return; }
        hideHeader(); showPoint(points[0]); return;
      }
      hideHeader(); showPoint(points[Math.max(0, Math.min(points.length - 1, index + (event.key === 'ArrowLeft' ? -1 : 1)))]);
    }
    if (event.key === 'Enter') { event.preventDefault(); if (!headerHovered) activate(points[index]); }
    if (event.key === 'Escape') { clearHover(); chosenAu = chosenBucket = undefined; drawSoon(); }
  }, { signal });
  installChartNavigation({ canvas, signal, enabled: () => !host.hidden && !!data?.count, plotWidth: () => Math.max(1, geometry.right - geometry.left),
    zoom(factor, clientX) {
      clearHover();
      const fraction = Math.max(0, Math.min(1, (clientX - canvas.getBoundingClientRect().left - geometry.left) / Math.max(1, geometry.right - geometry.left)));
      const range = viewport.range(), anchor = range.start + fraction * (range.end - range.start);
      const next = zoomTimeRange(range.start, range.end, anchor, factor, MIN_ANALYSIS_SPAN_US, viewport.domain());
      viewport.set(next.start, next.end); drawSoon();
    },
    pan(pixels) {
      clearHover();
      const range = viewport.range(), shift = Math.round(pixels / Math.max(1, geometry.right - geometry.left) * (range.end - range.start));
      const next = panTimeRange(range.start, range.end, shift, viewport.domain());
      viewport.set(next.start, next.end); drawSoon();
    },
  });
  canvas.addEventListener('dblclick', event => { event.preventDefault(); resetView(); drawSoon(); }, { signal });
  const observer = new ResizeObserver(drawSoon); observer.observe(plot);
  signal.addEventListener('abort', () => { observer.disconnect(); if (raf) cancelAnimationFrame(raf); if (pointerRaf) cancelAnimationFrame(pointerRaf); pendingPointer = null; }, { once: true });
  function matchingPoint(value: ChartHover): Point | null {
    if (!data || !slot || value.unmapped) return null;
    // Never substitute a nearby frame when the selected AU is absent/evicted.
    if (value.slot === slot && value.au !== undefined) {
      if (value.sourceVersion && value.sourceVersion !== data.sourceVersion) return null;
      const picture = data.pictures.find(p => p.picture.au === value.au);
      if (picture) return { picture, x: 0, y: 0 };
    } else {
      const time = value.cursorTimeUs ?? value.timeUs;
      const picture = data.pictures.reduce<DiagramPicture | null>((best, p) => !best || Math.abs(sessionTime(pictureTime(p)) - time) < Math.abs(sessionTime(pictureTime(best)) - time) ? p : best, null);
      const halfCell = representativeIntervalUs(data.pictures.map(p => pictureTime(p))) / 2;
      if (picture && Math.abs(sessionTime(pictureTime(picture)) - time) <= halfCell + 1) return { picture, x: 0, y: 0 };
    }
    const bucket = data.buckets.find(b => value.timeUs >= sessionTime(b.startUs) && value.timeUs < sessionTime(b.endUs));
    return bucket ? { bucket, x: 0, y: 0 } : null;
  }
  return { hideCard: clearHover,
    prepareLayout() { draw(true); },
    render() { if (raf) cancelAnimationFrame(raf); raf = 0; draw(); },
    highlight(value: ChartHover | null) {
      sharedHover = value;
      const point = value ? matchingPoint(value) : null;
      chosenAu = point?.picture?.picture.au; chosenBucket = point?.bucket?.startUs;
      canvas.dataset.hoverTime = value ? String(value.timeUs) : '';
      canvas.dataset.hoverCursorTime = value ? String(value.cursorTimeUs ?? value.timeUs) : '';
      canvas.dataset.hoverAu = chosenAu === undefined ? '' : String(chosenAu);
      canvas.dataset.hoverBucket = chosenBucket === undefined ? '' : String(chosenBucket);
      drawSoon();
    },
    details(value: ChartHover, presentation: CardPresentation = { size: true, types: true }) {
      const point = matchingPoint(value);
      if (point) {
        const element = pointTable(point, presentation);
        if (point.picture && viewport.axis() === 'dts') {
          const row = element.tBodies[0].insertRow(1), label = document.createElement('th'); label.textContent = 'PTS';
          row.append(label); row.insertCell().textContent = formatTime(sessionTime(point.picture.sourcePtsUs));
        }
        return { element, exact: !!point.picture, timeUs: point.picture ? sessionTime(pictureTime(point.picture)) : undefined };
      }
      const message = document.createElement('p');
      message.textContent = t(mode === 'references' ? msg('analysis.referenceMissing', '参考记录不可用') : msg('analysis.hoverDetailMissing', '此时间没有逐帧检查记录。'));
      const element = document.createElement('div');
      const heading = document.createElement('div'); heading.className = 'analysis-card-track';
      heading.append(analysisTrackBadge(slot));
      if (presentation.header !== false) element.append(heading);
      element.append(message);
      return { element, exact: false, timeUs: undefined };
    }, refresh(nextMode: BitstreamDiagram, nextSlot?: Slot, primary = true) {
    if (slot !== nextSlot) { clearHover(); if (slot !== undefined) hiddenTypes.clear(); identity = ''; chosenAu = chosenBucket = undefined; detail.textContent = ''; }
    else if (mode !== nextMode) { clearHover(); chosenAu = chosenBucket = undefined; detail.textContent = ''; }
    mode = nextMode; slot = nextSlot; canvas.id = `bitstream-diagram-${mode}${primary ? '' : `-${slot}`}`; canvas.dataset.slot = slot ?? '';
    trackBadge.replaceChildren();
    if (slot) { const dot = document.createElement('i'); dot.className = 'dot'; dot.style.background = options.slotColor?.() ?? '#888'; trackBadge.append(dot, document.createTextNode(slot)); trackBadge.title = options.inspection().name; }
    label.dataset.label = mode; label.title = nextMode === 'references' ? t(msg('analysis.referencePyramid','帧参考金字塔')) : t(nextMode === 'nalu-size' ? msg('analysis.naluSize','NALU 大小') : msg('analysis.naluTypes','NALU 类型'));
    host.querySelector('strong')!.textContent = mode === 'nalu-size' && host.closest('.bitstream-nalu-group') ? 'NALU' : label.title;
    drawSoon();
  } };
}
