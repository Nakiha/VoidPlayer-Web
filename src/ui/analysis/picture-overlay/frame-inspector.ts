import type { AnalysisBlock, BlockDepth, ReadonlyAnalysisResult } from '../../../../shared/analysis/bitstream/contract.ts';
import { failureInfo, type AnalysisReasonCode } from '../../../../shared/analysis/bitstream/failure.ts';
import type { Slot } from '../../../../shared/review/model.ts';
import { msg, t } from '../../../i18n.ts';
import { bitstreamReasonText } from '../../bitstream-reasons.ts';
import { installChoiceMenu } from '../../choice-menu.ts';
import { bitBandLabel, blockColor, summarizeBlocks } from './block-display.ts';
import type { BlockFilter, Dimension } from './block-display.ts';
import type { InterFrame } from './inter-prediction.ts';

export const depthLabel = (kind?: BlockDepth) => kind === 'vvc-qt' ? t(msg('bitstream.qtDepth', 'QT 深度')) :
  kind === 'hevc-cu' ? t(msg('bitstream.cuDepth', 'CU 深度')) : t(msg('bitstream.treeDepth', '树深度'));
export const predictionLabel = (mode: AnalysisBlock['mode']) => mode === 'intra' ? t(msg('bitstream.intra', '帧内')) :
  mode === 'inter' ? t(msg('bitstream.inter', '帧间')) : t(msg('bitstream.skip', '跳过'));
/** The drawer belongs to the transport popover. Build distributions only for its current, paused picture. */
export function installFrameInspector(drawer: HTMLElement, refresh: () => void, highlight: (filter: BlockFilter | null) => void,
  requestInter: (slot: Slot, frame: ReadonlyAnalysisResult) => Promise<InterFrame> | undefined, signal: AbortSignal) {
  drawer.innerHTML = `
    <div class="bitstream-frame-head"><div class="bitstream-frame-track"><span data-track-label></span>
      <button id="bitstream-inspect-track" class="choice-trigger" type="button"></button></div><strong data-frame></strong></div>
    <dl class="bitstream-metrics" data-readings>${['count', 'min', 'mean', 'max'].map(key => `<div><dt></dt><dd data-stat="${key}"></dd></div>`).join('')}</dl>
    <div class="bitstream-distribution"><span data-total></span><button id="bitstream-weight" class="choice-trigger" type="button"></button></div>
    <span data-unavailable hidden></span>
    <div class="bitstream-bins" data-bins></div>
    <div class="bitstream-export">
      <button type="button" data-export></button><span data-export-status role="status" hidden></span>
    </div>`;
  const track = drawer.querySelector<HTMLButtonElement>('#bitstream-inspect-track')!;
  let dimension: Dimension = 'sizes';
  const unavailable = drawer.querySelector<HTMLElement>('[data-unavailable]')!;
  const weight = drawer.querySelector<HTMLButtonElement>('#bitstream-weight')!;
  const title = drawer.querySelector<HTMLElement>('[data-frame]')!, readings = drawer.querySelector<HTMLElement>('[data-readings]')!;
  const bins = drawer.querySelector<HTMLElement>('[data-bins]')!, download = drawer.querySelector<HTMLButtonElement>('[data-export]')!;
  const exportStatus = drawer.querySelector<HTMLElement>('[data-export-status]')!;
  let frame: ReadonlyAnalysisResult | null = null, summary: ReturnType<typeof summarizeBlocks> | null = null;
  let filter: BlockFilter | null = null, drawn = '', trackSignature = '', slot: Slot | undefined;
  let selectedSlot: Slot | undefined, unit: 'pixels' | 'count' = 'pixels';
  let shown = false;
  let exportJob: object | undefined, exportFailure: AnalysisReasonCode | 'busy' | undefined;
  const clearFilter = () => { if (filter) { filter = null; highlight(null); } };
  const trackMenu = installChoiceMenu(track.id, [], value => { selectedSlot = value as Slot; clearFilter(); refresh(); });
  const weightChoices = () => [
    { value: 'pixels', label: t(msg('bitstream.byArea', '按编码面积')) },
    { value: 'count', label: t(msg('bitstream.byCount', '按块数')) },
  ];
  const weightMenu = installChoiceMenu(weight.id, weightChoices, value => { unit = value === 'count' ? 'count' : 'pixels'; refresh(); });
  signal.addEventListener('abort', () => {
    exportJob = undefined;
    trackMenu.dispose(); weightMenu.dispose();
  }, { once: true });
  function setVisible(open: boolean) {
    if (shown === open) return;
    shown = open;
    if (!open) {
      trackMenu.close(); weightMenu.close();
      frame = null; summary = null; drawn = ''; exportJob = exportFailure = undefined;
    }
  }
  bins.onclick = event => {
    const button = (event.target as Element).closest<HTMLButtonElement>('button[data-key]');
    if (!frame || !slot || !button) return;
    filter = filter?.key === button.dataset.key ? null : { slot, picture: frame, dimension, key: button.dataset.key! };
    highlight(filter);
    for (const item of bins.querySelectorAll<HTMLButtonElement>('button')) item.setAttribute('aria-pressed', String(item.dataset.key === filter?.key));
  };
  function renderExportStatus() {
    download.disabled = !frame || !!exportJob;
    download.setAttribute('aria-busy', String(!!exportJob));
    exportStatus.hidden = !exportJob && !exportFailure;
    const reason = exportFailure === 'busy' ? t(msg('bitstream.exportInterBusy', '此轨已有分析任务，暂时无法读取帧间预测明细')) :
      exportFailure ? bitstreamReasonText(exportFailure) : '';
    exportStatus.textContent = exportJob ? t(msg('bitstream.exportInterPending', '正在读取帧间预测明细…')) : reason ?
      t(msg('bitstream.exportInterIncomplete', '已导出块明细。帧间预测明细未能读取。{reason}'), { reason }) : '';
  }
  download.onclick = async () => {
    refresh();
    if (!frame || !summary || !slot || exportJob) return;
    const { blocks, ...metadata } = frame;
    const report = {
      schema: 'voidplayer-frame-inspection', version: 1, slot, frame: metadata, statistics: summary, blocks,
    };
    let inter: InterFrame | undefined;
    exportFailure = undefined;
    if (frame.codec !== 'h264') {
      const job = exportJob = {};
      renderExportStatus();
      try {
        const work = requestInter(slot, frame);
        if (work) inter = await work;
        else exportFailure = 'busy';
        if (exportJob !== job) return;
      } catch (error) {
        if (exportJob !== job) return;
        exportFailure = failureInfo(error).code;
      } finally {
        if (exportJob === job) { exportJob = undefined; renderExportStatus(); }
      }
    } else renderExportStatus();
    const output = inter ? { ...report, predictionInter: [...inter.records()] } : report;
    const url = URL.createObjectURL(new Blob([JSON.stringify(output)], {type: 'application/json'}));
    const link = document.createElement('a'); link.href = url; link.download = `VoidPlayer-${report.slot}-AU${metadata.picture.au}.json`;
    link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  function localize() {
    const trackLabel = t(msg('bitstream.inspectTrack', '检查轨道'));
    drawer.querySelector('[data-track-label]')!.textContent = trackLabel;
    track.setAttribute('aria-label', trackLabel);
    const metricNames = [t(msg('bitstream.blockCount', '块数')), t(msg('bitstream.minQp', '最低 QP')),
      t(msg('bitstream.meanQp', '平均 QP')), t(msg('bitstream.maxQp', '最高 QP'))];
    readings.querySelectorAll('dt').forEach((node, index) => { node.textContent = metricNames[index]; });
    unavailable.textContent = t(msg('bitstream.fieldUnavailable', '此轨当前帧没有该模式的数据'));
    weight.setAttribute('aria-label', t(msg('bitstream.weightBy', '统计口径')));
    download.textContent = t(msg('bitstream.exportFrame', '导出当前帧'));
    renderExportStatus();
    drawn = '';
  }
  function render(slots: Slot[], preferred: Slot, playing: boolean, cached: (slot: Slot) => ReadonlyAnalysisResult | null, status: (slot: Slot) => string) {
    if (!shown) {
      if (filter && (playing || !slots.includes(filter.slot) || cached(filter.slot) !== filter.picture)) clearFilter();
      return;
    }
    const signature = slots.join(',');
    if (signature !== trackSignature) {
      trackSignature = signature;
      trackMenu.setOptions(slots.map(value => ({ value, label: value })));
    }
    const active = selectedSlot && slots.includes(selectedSlot) ? selectedSlot : slots.includes(preferred) ? preferred : slots[0];
    selectedSlot = active;
    const hit = active && !playing ? cached(active) : null;
    const next = hit?.confidence === 'exact' ? hit : null;
    if (filter && (filter.slot !== active || filter.picture !== next)) clearFilter();
    if (slot !== active || next !== frame) {
      frame = next; slot = active; summary = frame ? summarizeBlocks(frame) : null; drawn = '';
      exportJob = exportFailure = undefined;
    }
    const ready = !!frame && !!summary;
    track.parentElement!.hidden = !slots.length;
    trackMenu.sync(active ?? '', active ?? '', !!active);
    const hasBins = !!summary?.distributions[dimension].length;
    weightMenu.sync(unit, weightChoices().find(choice => choice.value === unit)!.label, hasBins);
    readings.hidden = !ready || dimension !== 'qp' || !hasBins;
    unavailable.hidden = !ready || hasBins;
    renderExportStatus();
    drawer.querySelector<HTMLElement>('.bitstream-export')!.hidden = !ready;
    drawer.querySelector<HTMLElement>('.bitstream-distribution')!.hidden = !hasBins;
    if (!frame || !summary) {
      title.textContent = !active ? t(msg('bitstream.enableTrack', '请开启一个轨道遮罩')) : playing ?
        t(msg('bitstream.pauseInspect', '暂停后检查当前帧')) : status(active) || t(msg('bitstream.noFrameBlocks', '当前帧暂无可用的块数据'));
      bins.replaceChildren(); return;
    }
    const refs = frame.references;
    title.textContent = [`AU ${frame.picture.au}`, refs?.frameType, refs && `POC ${refs.poc}`].filter(Boolean).join(' · ');
    const field = dimension;
    const signatureBins = [field, unit, document.documentElement.lang].join('/');
    if (drawn === signatureBins) return;
    drawn = signatureBins;
    const number = new Intl.NumberFormat(document.documentElement.lang, {maximumFractionDigits: 2});
    const values = [summary.blockCount, summary.qp.min, summary.qp.mean, summary.qp.max];
    readings.querySelectorAll('dd').forEach((node, index) => {
      const value = values[index]; node.textContent = value === null ? '—' : number.format(value);
    });
    drawer.querySelector('[data-total]')!.textContent = t(msg('bitstream.totalBlocks', '{count} 块'), {count: number.format(summary.blockCount)});
    const total = unit === 'count' ? summary.blockCount : summary.codedPixels;
    bins.replaceChildren(...summary.distributions[field].map(bin => {
      const button = document.createElement('button'); button.type = 'button'; button.dataset.key = bin.key;
      const name = field === 'modes' ? predictionLabel(bin.key as AnalysisBlock['mode']) : field === 'bits' ? bitBandLabel(bin.key) : bin.key;
      const label = document.createElement('span'); label.textContent = name;
      const meter = document.createElement('span'); meter.className = 'bitstream-meter'; meter.setAttribute('aria-hidden', 'true');
      const bar = document.createElement('i'), percent = 100 * bin[unit] / total;
      bar.style.width = `${percent}%`; bar.style.backgroundColor = blockColor(field, bin.key); meter.append(bar);
      const value = document.createElement('span'); value.textContent = `${number.format(percent)}%`;
      button.append(label, meter, value);
      button.title = `${name} · ${number.format(bin[unit])} / ${number.format(total)}`;
      button.setAttribute('aria-pressed', String(filter?.key === bin.key)); return button;
    }));
  }
  localize();
  function setDimension(next: Dimension) {
    if (dimension !== next) { clearFilter(); dimension = next; drawn = ''; }
  }
  return { render, localize, setDimension, setVisible, clearFilter };
}
