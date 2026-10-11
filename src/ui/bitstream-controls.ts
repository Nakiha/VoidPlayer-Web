import { SLOTS, formatTime } from '../model.ts';
import type { Slot } from '../model.ts';
import type { AnalysisBlock, ReadonlyAnalysisResult, PresentedFrameToken } from '../bitstream-analysis/contract.ts';
import type { ReviewSession } from '../session.ts';
import { t, msg } from '../i18n.ts';
import { failureInfo } from '../bitstream-analysis/failure.ts';
import { bitstreamReasonText } from './bitstream-reasons.ts';
import { installChoiceMenu } from './choice-menu.ts';
import { parseTimeInput } from '../time-input.ts';
import './bitstream-controls.css';

type State = ReturnType<ReviewSession['getState']>;
type Mode = 'blocks' | 'qp' | 'modes';
type Entry = {
  sourceId: string;
  overlay?: import('../analysis-overlay/controller.ts').ReturnOverlay;
  loading?: Promise<void>;
  tooltip?: HTMLOutputElement;
  request?: AbortController;
  enabled: boolean;
  mode: Mode;
  opacity: number;
  result?: ReadonlyAnalysisResult;
  resultKey?: string;
  selectedBlock?: AnalysisBlock;
  selectedKey?: string;
  message?: string;
  completed?: number;
  range?: { start: number; end: number };
};
const tokenKey = (token: PresentedFrameToken | null) => token?.picture ? JSON.stringify([token.generation, token.picture]) : null;
const modeLabel = (mode: Mode) => mode === 'qp' ? t(msg('bitstream.qp','QP 热图')) : mode === 'modes' ? t(msg('bitstream.prediction','预测模式')) : t(msg('bitstream.boundaries','块边界'));
const predictionLabel = (mode: AnalysisBlock['mode']) => mode === 'intra' ? t(msg('bitstream.intra','帧内')) : mode === 'inter' ? t(msg('bitstream.inter','帧间')) : t(msg('bitstream.skip','跳过'));

/** Task execution and overlay visibility are independent. Opening this UI is read-only. */
export function installBitstreamControls(session: ReviewSession, canvases: Record<Slot, HTMLCanvasElement>, hooks: {
  selected(): Slot;
  visible(): boolean;
  open(slot: Slot): void;
}) {
  const host = document.getElementById('bitstream-inspector')!;
  const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
  host.innerHTML = `
    <section class="bitstream-section"><h3 data-copy="current"></h3>
      <p id="bitstream-target" class="bitstream-target"></p>
      <div class="bitstream-actions"><button id="bitstream-run" type="button" class="bitstream-primary" data-copy="run"></button><button id="bitstream-cancel" type="button" data-copy="cancel" hidden></button></div>
      <output id="bitstream-state" class="bitstream-feedback" role="status" aria-live="polite"></output>
      <p class="bitstream-hint" data-copy="explicit"></p>
    </section>
    <section class="bitstream-section"><h3 data-copy="display"></h3>
      <label class="bitstream-display-row"><span data-copy="visibility"></span><input id="bitstream-visibility" type="checkbox"></label>
      <div class="bitstream-display-row"><label for="bitstream-mode" data-copy="mode"></label><button id="bitstream-mode" class="choice-trigger" type="button"></button></div>
      <label class="bitstream-display-row" for="bitstream-opacity"><span data-copy="opacity"></span><output id="bitstream-opacity-value"></output></label>
      <input id="bitstream-opacity" class="bitstream-opacity" type="range" min="10" max="100" step="5" value="75">
      <div id="bitstream-legend" class="bitstream-legend"></div>
    </section>
    <details class="bitstream-section bitstream-summary" id="bitstream-summary-section" hidden><summary data-copy="summary"></summary><dl id="bitstream-summary"></dl></details>
    <section class="bitstream-section"><div class="bitstream-section-heading"><h3 data-copy="block"></h3><button id="bitstream-unpin" type="button" data-copy="unpin" hidden></button></div><p id="bitstream-block-hint" class="bitstream-hint" data-copy="pick"></p><dl id="bitstream-block" hidden></dl></section>
    <details class="bitstream-section bitstream-range"><summary data-copy="range"></summary>
      <p class="bitstream-hint" data-copy="rangeHint"></p>
      <label for="bitstream-range-start" data-copy="start"></label><input id="bitstream-range-start" type="text" inputmode="decimal" autocomplete="off">
      <label for="bitstream-range-end" data-copy="end"></label><input id="bitstream-range-end" type="text" inputmode="decimal" autocomplete="off">
      <button id="bitstream-range-run" type="button" data-copy="rangeRun"></button>
    </details>`;
  const copy = () => ({
    current: t(msg('bitstream.current','当前帧')), run: t(msg('bitstream.run','分析此帧')), cancel: t(msg('bitstream.cancel','取消分析')),
    explicit: t(msg('bitstream.explicit','仅点击分析按钮才执行分析；切换画面只读取已有结果。')),
    display: t(msg('bitstream.display','画面遮罩')), visibility: t(msg('bitstream.visibility','显示遮罩')), mode: t(msg('bitstream.mode','分析遮罩')),
    opacity: t(msg('bitstream.opacity','不透明度')), summary: t(msg('bitstream.summary','帧摘要')), block: t(msg('bitstream.block','选中块')),
    unpin: t(msg('bitstream.unpin','清除选择')), pick: t(msg('bitstream.pick','在画面上点击一个块，将详情固定在这里。')),
    range: t(msg('bitstream.range','区间分析')), rangeHint: t(msg('bitstream.rangeHint','会话时间范围；每次最多 1 秒、32 帧。分析完成后逐帧查看缓存结果。')),
    start: t(msg('bitstream.start','开始')), end: t(msg('bitstream.end','结束')), rangeRun: t(msg('bitstream.rangeRun','分析此区间')),
  });
  const entries = new Map<Slot, Entry>();
  let lastState = session.getState();
  let uiIdentity: string | undefined;
  const life = new AbortController();
  function entryFor(slot: Slot): Entry | undefined {
    const track = lastState.tracks.find(track => track.slot === slot);
    if (!track) return undefined;
    let entry = entries.get(slot);
    if (!entry || entry.sourceId !== track.id) {
      destroy(slot);
      entry = { sourceId: track.id, enabled: false, mode: 'blocks', opacity: 75 };
      entries.set(slot, entry);
    }
    return entry;
  }
  function destroy(slot: Slot) {
    const entry = entries.get(slot);
    entry?.request?.abort(); entry?.overlay?.dispose(); entry?.tooltip?.remove(); entries.delete(slot);
  }
  function cached(slot: Slot, entry: Entry) {
    const token = session.getPresentedFrame(slot);
    return session.cachedBitstreamAnalysis(slot, token ?? undefined)
      ?? (tokenKey(token) === entry.resultKey ? entry.result : undefined);
  }
  async function ensureOverlay(slot: Slot, entry: Entry) {
    if (entry.overlay) return;
    if (!entry.loading) entry.loading = import('../analysis-overlay/controller.ts').then(({ createAnalysisOverlay }) => {
      if (entries.get(slot) !== entry || !entry.enabled || life.signal.aborted) return;
      entry.overlay = createAnalysisOverlay(session, slot, canvases[slot]);
      entry.overlay.setMode(entry.mode);
      const canvas = $(`bitstream-overlay-${slot}`); canvas.style.opacity = String(entry.opacity / 100);
      const result = cached(slot, entry); if (result) entry.overlay.setResult(result);
      const tooltip = document.createElement('output'); tooltip.className = 'bitstream-hit-tooltip'; tooltip.hidden = true;
      canvases[slot].closest('.frame-stage')!.append(tooltip); entry.tooltip = tooltip;
    }).finally(() => { entry.loading = undefined; });
    await entry.loading;
  }
  function setVisibility(slot: Slot, enabled: boolean) {
    const entry = entryFor(slot); if (!entry) return;
    entry.enabled = enabled;
    if (enabled) void ensureOverlay(slot, entry).catch(error => { entry.message = bitstreamReasonText(failureInfo(error).code); render(); });
    else { entry.overlay?.dispose(); entry.overlay = undefined; entry.tooltip?.remove(); entry.tooltip = undefined; }
    render();
  }
  function rows(element: HTMLElement, values: [string, string][]) {
    element.replaceChildren(...values.flatMap(([label, value]) => {
      const dt = document.createElement('dt'), dd = document.createElement('dd'); dt.textContent = label; dd.textContent = value; return [dt, dd];
    }));
  }
  const choices = () => {
    const slot = hooks.selected(), entry = entries.get(slot), result = entry && cached(slot, entry);
    return (['blocks', 'qp', 'modes'] as Mode[]).filter(mode => mode === 'blocks' || (mode === 'qp' ? result?.capabilities.qp === 'ready' : result?.capabilities.modes === 'ready')).map(value => ({ value, label: modeLabel(value) }));
  };
  const menu = installChoiceMenu('bitstream-mode', choices, value => {
    const entry = entryFor(hooks.selected()); if (!entry) return;
    entry.mode = value as Mode; entry.overlay?.setMode(entry.mode); render();
  });
  function localize() {
    const labels = copy();
    for (const node of host.querySelectorAll<HTMLElement>('[data-copy]')) node.textContent = labels[node.dataset.copy as keyof typeof labels];
    $('inspector-info-tab').textContent = t(msg('bitstream.infoTab','信息'));
    $('inspector-analysis-tab').textContent = t(msg('bitstream.analysisTab','分析'));
    $('bitstream-mode').setAttribute('aria-label', labels.mode);
    $('bitstream-opacity').setAttribute('aria-label', labels.opacity);
    for (const slot of SLOTS) {
      $(`bitstream-${slot}`).textContent = t(msg('bitstream.analysisTab','分析'));
      $(`bitstream-${slot}`).setAttribute('aria-label', t(msg('bitstream.open','打开轨道 {slot} 的分析检查'), { slot }));
    }
    render();
  }
  function render(state: State = lastState) {
    lastState = state;
    for (const slot of SLOTS) {
      const track = state.tracks.find(track => track.slot === slot);
      ($(`bitstream-${slot}`) as HTMLButtonElement).disabled = !track || !!track.failure;
      if (!track || entries.get(slot)?.sourceId !== track.id) destroy(slot);
    }
    if (!hooks.visible()) return;
    const slot = hooks.selected(), track = state.tracks.find(track => track.slot === slot), entry = entryFor(slot);
    const token = track && session.getPresentedFrame(slot), result = entry && cached(slot, entry), key = tokenKey(token || null);
    if (entry?.selectedKey !== key) { if (entry) { entry.selectedBlock = undefined; entry.selectedKey = undefined; } }
    $('bitstream-target').textContent = track ? `${slot} · ${formatTime(token?.normalizedMediaUs ?? 0)}${token?.picture ? ` · AU ${token.picture.au}` : ''}` : t(msg('tracks.noTracksLoaded','尚未载入轨道'));
    const streamState = session.getBitstreamAnalysisState(hooks.selected());
    const stream = streamState.stream?.slot === slot ? streamState.stream : undefined;
    const busy = !!entry?.request || !!stream && streamState.state === 'pending';
    ($('bitstream-run') as HTMLButtonElement).disabled = !track || !!track.failure || state.playing || busy;
    $('bitstream-cancel').hidden = !busy;
    const feedback = $('bitstream-state');
    feedback.textContent = busy ? entry?.range ? t(msg('bitstream.rangePending','正在分析区间…')) : t(msg('bitstream.pending','正在分析当前帧…')) : entry?.message ?? (state.playing ? t(msg('bitstream.pauseFirst','暂停后可分析当前帧。')) : result ? result.confidence === 'exact' ? t(msg('bitstream.available','当前帧结果可用')) : bitstreamReasonText(result.reasonCodes?.[0] ?? 'incomplete-reference-state') : t(msg('bitstream.notAnalyzed','此帧尚未分析')));
    if (stream) {
      const percent = stream.totalUs > 0 ? Math.min(100, Math.floor(stream.checkedUs / stream.totalUs * 100)) : 0;
      feedback.textContent = streamState.state === 'ready' ? t(msg('analysis.streamDone','{slot} 已完成 · {count} 帧'), { slot, count: stream.pictures })
        : stream.waitingForIndex ? t(msg('analysis.streamWaiting','{slot} 等待索引 · 已检查 {count} 帧'), { slot, count: stream.pictures })
        : t(msg('analysis.streamProgress','{slot} {percent}% · {count} 帧'), { slot, percent, count: stream.pictures });
      if (streamState.reason) feedback.textContent += ` · ${bitstreamReasonText(streamState.reason.code)}`;
    }
    if (result && entry?.enabled) entry.overlay?.setResult(result);
    if (result?.confidence === 'exact' && result.capabilities.qp !== 'ready') feedback.textContent += ` · ${bitstreamReasonText('unsupported-qp-depth')}`;
    if (entry?.completed !== undefined && !busy) feedback.textContent += ` · ${t(msg('bitstream.rangeCompleted','区间已完成 {count} 帧'), { count: entry.completed })}`;
    if (entry && result && ((entry.mode === 'qp' && result.capabilities.qp !== 'ready') || (entry.mode === 'modes' && result.capabilities.modes !== 'ready'))) {
      entry.mode = 'blocks'; entry.overlay?.setMode('blocks');
    }
    const visibility = $('bitstream-visibility') as HTMLInputElement;
    visibility.checked = entry?.enabled ?? false; visibility.disabled = !track;
    menu.setOptions(choices); menu.sync(entry?.mode ?? 'blocks', modeLabel(entry?.mode ?? 'blocks'), !!result && result.confidence === 'exact');
    const opacity = $('bitstream-opacity') as HTMLInputElement; opacity.disabled = !entry?.enabled;
    if (document.activeElement !== opacity) opacity.value = String(entry?.opacity ?? 75);
    $('bitstream-opacity-value').textContent = `${entry?.opacity ?? 75}%`;
    const legend = $('bitstream-legend');
    legend.replaceChildren();
    if (result?.confidence === 'exact' && entry?.mode === 'qp') {
      const gradient = document.createElement('div'); gradient.className = 'bitstream-qp-gradient';
      const labels = document.createElement('div'); labels.className = 'bitstream-display-row';
      const max = result.codec === 'vvc' ? 63 : 51; labels.textContent = `QP 0 — ${max}`; legend.append(gradient, labels);
    } else if (result?.confidence === 'exact' && entry?.mode === 'modes') {
      for (const mode of ['intra', 'inter', 'skip'] as const) {
        const item = document.createElement('span'); item.className = `bitstream-mode-key ${mode}`; item.textContent = predictionLabel(mode); legend.append(item);
      }
    } else legend.textContent = t(msg('bitstream.cacheOnly','换帧时仅显示精确匹配的缓存；没有结果则隐藏遮罩。'));
    $('bitstream-summary-section').hidden = !result;
    if (result) rows($('bitstream-summary'), [
      [t(msg('bitstream.blocks','块')), String(result.blocks.length)],
      [t(msg('bitstream.meanQp','平均亮度 QP')), result.qp.mean?.toFixed(1) ?? '—'],
      [t(msg('bitstream.precision','匹配')), result.confidence === 'exact' ? t(msg('bitstream.exact','精确')) : t(msg('bitstream.partial','部分结果'))],
    ]);
    const block = entry?.selectedBlock;
    $('bitstream-block').hidden = !block; $('bitstream-block-hint').hidden = !!block; $('bitstream-unpin').hidden = !block;
    if (block) rows($('bitstream-block'), [
      [t(msg('bitstream.coordinates','坐标')), `${block.x}, ${block.y}`], [t(msg('tracks.dimensions','尺寸')), `${block.width} × ${block.height}`],
      [t(msg('bitstream.prediction','预测模式')), predictionLabel(block.mode)], ['QP', block.qp === null ? '—' : String(block.qp)],
    ]);
    const rangeButton = $('bitstream-range-run') as HTMLButtonElement; rangeButton.disabled = !track || !!track.failure || busy;
    if (uiIdentity !== `${slot}:${entry?.sourceId}`) {
      uiIdentity = `${slot}:${entry?.sourceId}`;
      const start = entry?.range?.start ?? Math.max(0, (token?.normalizedMediaUs ?? 0) + (track?.offsetUs ?? 0));
      const end = entry?.range?.end ?? Math.min(start + 500000, (track?.durationUs ?? start + 500000) + (track?.offsetUs ?? 0));
      ($('bitstream-range-start') as HTMLInputElement).value = formatTime(start);
      ($('bitstream-range-end') as HTMLInputElement).value = formatTime(end);
    }
  }
  async function run(range?: { start: number; end: number }) {
    const slot = hooks.selected(), entry = entryFor(slot); if (!entry || entry.request) return;
    const requested = session.getPresentedFrame(slot), controller = new AbortController();
    entry.request = controller; entry.message = undefined; entry.completed = undefined; entry.range = range;
    render();
    try {
      if (range) {
        const completed = await session.requestBitstreamRange(slot, range.start, range.end, controller.signal);
        entry.completed = completed.pictures;
      } else {
        entry.enabled = true;
        await ensureOverlay(slot, entry);
        controller.signal.throwIfAborted();
        const current = session.getPresentedFrame(slot);
        if (!requested || current?.commit !== requested.commit || current.generation !== requested.generation) {
          entry.message = t(msg('bitstream.changedFrame','画面已切换，请分析新的当前帧。')); return;
        }
        const result = await session.requestBitstreamAnalysis(slot, controller.signal);
        controller.signal.throwIfAborted();
        entry.result = result; entry.resultKey = tokenKey(requested) ?? undefined;
        if (tokenKey(session.getPresentedFrame(slot)) === entry.resultKey) entry.overlay?.setResult(result);
      }
    } catch (error) {
      if (entries.get(slot) === entry) entry.message = bitstreamReasonText(controller.signal.aborted ? 'cancelled' : failureInfo(error).code);
    } finally {
      if (entry.request === controller) entry.request = undefined;
      render();
    }
  }
  for (const slot of SLOTS) {
    $(`bitstream-${slot}`).onclick = () => hooks.open(slot);
    const stage = canvases[slot].closest<HTMLElement>('.frame-stage')!;
    const hit = (event: PointerEvent | MouseEvent) => {
      const entry = entries.get(slot);
      if (!entry?.enabled || !entry.overlay || !stage.querySelector('.drawing-layer')?.hasAttribute('hidden') || (event.target as Element).closest('button,input,select')) return null;
      const rect = stage.getBoundingClientRect(); return entry.overlay.hit(event.clientX - rect.left, event.clientY - rect.top);
    };
    stage.addEventListener('pointermove', event => {
      const entry = entries.get(slot), block = hit(event); if (!entry?.tooltip) return;
      entry.tooltip.hidden = !block;
      if (!block) return;
      const rect = stage.getBoundingClientRect();
      entry.tooltip.textContent = `${block.x},${block.y} · ${block.width}×${block.height} · ${predictionLabel(block.mode)} · QP ${block.qp ?? '—'}`;
      entry.tooltip.style.left = `${Math.max(8, Math.min(event.clientX - rect.left + 12, rect.width - 260))}px`;
      entry.tooltip.style.top = `${Math.max(8, Math.min(event.clientY - rect.top + 12, rect.height - 40))}px`;
    }, { signal: life.signal });
    stage.addEventListener('pointerleave', () => { const entry = entries.get(slot); if (entry?.tooltip) entry.tooltip.hidden = true; }, { signal: life.signal });
    stage.addEventListener('click', event => {
      const block = hit(event), entry = entries.get(slot); if (!block || !entry) return;
      entry.selectedBlock = { ...block }; entry.selectedKey = tokenKey(session.getPresentedFrame(slot)) ?? undefined; hooks.open(slot);
    }, { signal: life.signal });
  }
  $('bitstream-run').onclick = () => void run();
  $('bitstream-cancel').onclick = () => { const state = session.getBitstreamAnalysisState(hooks.selected()); if (state.stream?.slot === hooks.selected() && state.state === 'pending') session.cancelBitstreamAnalysis(hooks.selected()); else entries.get(hooks.selected())?.request?.abort(); };
  $('bitstream-visibility').onchange = () => setVisibility(hooks.selected(), ($('bitstream-visibility') as HTMLInputElement).checked);
  $('bitstream-opacity').oninput = () => {
    const slot = hooks.selected(), entry = entryFor(slot); if (!entry) return;
    entry.opacity = Number(($('bitstream-opacity') as HTMLInputElement).value);
    const canvas = document.getElementById(`bitstream-overlay-${slot}`); if (canvas) canvas.style.opacity = String(entry.opacity / 100); render();
  };
  $('bitstream-unpin').onclick = () => { const entry = entries.get(hooks.selected()); if (entry) entry.selectedBlock = undefined; render(); };
  $('bitstream-range-run').onclick = () => {
    const entry = entryFor(hooks.selected()); if (!entry) return;
    try {
      const start = parseTimeInput(($('bitstream-range-start') as HTMLInputElement).value), end = parseTimeInput(($('bitstream-range-end') as HTMLInputElement).value);
      const track = lastState.tracks.find(track => track.slot === hooks.selected())!;
      if (end <= start || end - start > 1000000 || start < Math.max(0, track.offsetUs ?? 0) || end > track.durationUs + (track.offsetUs ?? 0)) {
        entry.message = t(msg('bitstream.invalidRange','请选择片源范围内不超过 1 秒的区间。')); render(); return;
      }
      void run({ start, end });
    } catch { entry.message = t(msg('bitstream.invalidTime','请输入有效时间，例如 00:03.300。')); render(); }
  };
  const offFrames = session.subscribePresentedFrames((slot, token) => {
    const entry = entries.get(slot); if (!entry) return;
    entry.message = undefined;
    if (entry.selectedKey !== tokenKey(token)) { entry.selectedBlock = undefined; entry.selectedKey = undefined; }
    if (entry.tooltip) entry.tooltip.hidden = true;
    if (hooks.visible() && hooks.selected() === slot) render();
  });
  localize();
  return {
    render, localize,
    dispose() { offFrames(); life.abort(); menu.dispose(); for (const slot of SLOTS) destroy(slot); },
  };
}
