import type { AnalysisBlock, BlockDepth } from '../../../../shared/analysis/bitstream/contract.ts';
import { formatTime } from '../../../../shared/review/model.ts';
import type { Slot } from '../../../../shared/review/model.ts';
import { msg, t } from '../../../i18n.ts';
import { analysisMetricValue, analysisTrackBadge } from '../card.ts';
import { depthLabel, predictionLabel } from './frame-inspector.ts';

export interface BlockHoverTrack {
  slot: Slot;
  name: string;
  timeUs?: number;
  block: Readonly<AnalysisBlock>;
  depth?: BlockDepth;
  interTools?: readonly string[];
}

function createTrackDetails(slot: Slot) {
  const element = document.createElement('section');
  element.className = 'bitstream-hit-track';
  element.dataset.slot = slot;
  element.innerHTML = `
    <div class="bitstream-hit-heading">
      <span class="analysis-card-track-name"></span><time class="analysis-card-track-time"></time>
    </div>
    <dl class="bitstream-hit-line">
      <div><dt data-label="position"></dt><dd data-field="position"></dd></div>
      <div><dt data-label="size"></dt><dd data-field="size"></dd></div>
    </dl>
    <dl class="bitstream-hit-line bitstream-hit-prediction-line">
      <div><dt data-label="prediction"></dt><dd data-field="prediction"></dd><dd data-field="inter-tools" hidden></dd></div>
      <div><dt>QP</dt><dd data-field="qp"></dd></div>
      <div data-depth hidden><dt data-label="depth"></dt><dd data-field="depth"></dd></div>
    </dl>
    <div class="bitstream-hit-coding" hidden>
      <span data-label="coding"></span><span data-field="bits"></span><span data-field="kib"></span>
    </div>`;
  const select = (selector: string) => element.querySelector<HTMLElement>(selector)!;
  select('.bitstream-hit-heading').prepend(analysisTrackBadge(slot));
  const name = select('.analysis-card-track-name'), time = select('time');
  const position = select('[data-field=position]'), size = select('[data-field=size]'), prediction = select('[data-field=prediction]');
  const tools = select('[data-field=inter-tools]');
  const qp = select('[data-field=qp]'), depth = select('[data-field=depth]'), depthTitle = select('[data-label=depth]');
  const depthPair = select('[data-depth]'), coding = select('.bitstream-hit-coding');
  const bits = select('[data-field=bits]'), kib = select('[data-field=kib]');
  let previousBits: number | undefined;
  let previousTools: readonly string[] | undefined;
  const updateText = (node: HTMLElement, value: string) => { if (node.textContent !== value) node.textContent = value; };

  function localize() {
    select('[data-label=position]').textContent = t(msg('bitstream.blockPosition', '坐标'));
    select('[data-label=size]').textContent = t(msg('bitstream.blockSize', '块尺寸'));
    select('[data-label=prediction]').textContent = t(msg('bitstream.predictionTypes', '预测类型'));
    select('[data-label=coding]').textContent = t(msg('bitstream.estimatedCodedSize', '估算编码大小'));
  }

  function update(track: BlockHoverTrack) {
    const { block } = track;
    if (name.textContent !== track.name) { name.textContent = track.name; name.title = track.name; }
    updateText(time, `${track.timeUs === undefined ? '—' : formatTime(track.timeUs)} PTS`);
    updateText(position, `${block.x}, ${block.y}`);
    updateText(size, `${block.width}×${block.height}`);
    updateText(prediction, predictionLabel(block.mode));
    if (previousTools !== track.interTools) {
      previousTools = track.interTools;
      tools.replaceChildren(...(track.interTools ?? []).map(tool => {
        const tag = document.createElement('span');
        tag.textContent = tool;
        return tag;
      }));
      tools.hidden = !track.interTools?.length;
    }
    updateText(qp, String(block.qp ?? '—'));
    depthPair.hidden = block.depth === undefined;
    if (block.depth !== undefined) {
      updateText(depthTitle, depthLabel(track.depth));
      updateText(depth, String(block.depth));
    }
    coding.hidden = block.bits === undefined;
    if (block.bits !== undefined && block.bits !== previousBits) {
      previousBits = block.bits;
      bits.textContent = `${block.bits} bit · ${block.bits / 8} B`;
      analysisMetricValue(kib, (block.bits / 8192).toFixed(4), 'KiB');
    }
  }

  localize();
  return { element, localize, update };
}

export function installBlockHoverCard(viewport: HTMLElement, signal: AbortSignal) {
  const card = document.createElement('div');
  card.className = 'analysis-card bitstream-hit-tooltip';
  card.hidden = true;
  card.setAttribute('aria-hidden', 'true');
  viewport.append(card);
  signal.addEventListener('abort', () => card.remove(), { once: true });

  const details = new Map<Slot, ReturnType<typeof createTrackDetails>>();
  function show(tracks: readonly BlockHoverTrack[], clientX: number, clientY: number) {
    card.hidden = tracks.length === 0;
    if (card.hidden) return;
    const children = tracks.map(track => {
      let row = details.get(track.slot);
      if (!row) {
        row = createTrackDetails(track.slot);
        details.set(track.slot, row);
      }
      row.update(track);
      return row.element;
    });
    if (card.childElementCount !== children.length || children.some((row, i) => row !== card.children[i])) {
      card.replaceChildren(...children);
    }
    const bounds = viewport.getBoundingClientRect(), tip = card.getBoundingClientRect();
    const place = (pointer: number, length: number, limit: number) => {
      const candidate = pointer + 12 + length <= limit - 8 ? pointer + 12 : pointer - length - 12;
      return `${Math.max(8, Math.min(candidate, limit - length - 8))}px`;
    };
    card.style.left = place(clientX - bounds.left, tip.width, bounds.width);
    card.style.top = place(clientY - bounds.top, tip.height, bounds.height);
  }

  return { show, localize() { for (const row of details.values()) row.localize(); }, hide() { card.hidden = true; } };
}
