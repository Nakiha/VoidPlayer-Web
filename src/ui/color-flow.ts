import { icon } from './icons.ts';
import type { ColorMode } from '../color-mode.ts';

type Node = [Parameters<typeof icon>[0], string, string];
const connector = '<svg class="color-flow-connector" viewBox="0 0 48 20" aria-hidden="true" focusable="false"><path d="M2 10H44M37 3L44 10L37 17" /></svg>';
function lane(title: string, nodes: Node[], links: string[]) {
  return `<div class="color-flow-lane"><h5>${title}</h5><ol class="color-flow-nodes">${nodes.map(([glyph, title, detail], i) => `<li class="color-flow-step"><div class="color-flow-unit">${icon(glyph)}<strong>${title}</strong><span>${detail}</span></div>${i < nodes.length - 1 ? `<div class="color-flow-link"><span>${links[i]}</span>${connector}</div>` : ''}</li>`).join('')}</ol></div>`;
}

/** Decoder changes only alter the first unit; keep the rest of the lane mounted. */
export function updateColorFlow(root: HTMLElement, mode: ColorMode, decoder: 'hardware' | 'software') {
  if (root.dataset.mode !== mode) {
    root.innerHTML = colorFlow(mode, decoder);
    root.dataset.mode = mode;
  } else if (mode === 'reference' && root.dataset.decoder !== decoder) {
    const hardware = decoder === 'hardware';
    root.querySelector('h5')!.textContent = hardware ? '原生平面核对通过时' : '软件解码';
    const unit = root.querySelector<HTMLElement>('.color-flow-unit')!;
    unit.querySelector('svg')!.outerHTML = icon(hardware ? 'gpu' : 'cpu');
    unit.querySelector('strong')!.textContent = hardware ? '硬件解码单元' : 'CPU';
    unit.querySelector('span')!.textContent = hardware ? '浏览器优先请求' : '软件解码';
    root.querySelector('.color-flow-link span')!.textContent = hardware ? '读回' : '解码';
    if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
      unit.querySelector('svg')!.animate([{ transform: 'translateY(2px)' }, { transform: 'none' }], { duration: 140, easing: 'ease-out' });
    }
  }
  root.dataset.decoder = decoder;
}

/** A conceptual flow, never evidence that a physical hardware decoder is active. */
export function colorFlow(mode: ColorMode, decoder: 'hardware' | 'software') {
  const screen: Node = ['monitor', '屏幕', '显示画面'];
  const ram: Node = ['memory', '内存', '原始 YUV 帧'];
  const software: Node = ['cpu', 'CPU', '软件解码'];
  if (mode === 'browser') return lane('原生解码', [
    ['cpu', '浏览器解码器', '优先请求硬件'], ['gpu', 'GPU', '浏览器转换颜色'], screen,
  ], ['原生帧', '上屏']) + lane('无法原生解码时', [software, ram, ['gpu', 'GPU', '近似浏览器颜色'], screen], ['解码', '上传', '上屏']);
  return lane(decoder === 'hardware' ? '原生平面核对通过时' : '软件解码', [
    decoder === 'hardware' ? ['gpu', '硬件解码单元', '浏览器优先请求'] : software,
    ram, ['gpu', 'GPU', 'VoidPlayer 转换颜色'], screen,
  ], [decoder === 'hardware' ? '读回' : '解码', '上传', '上屏']);
}

export function colorSettingsShell() {
  return `<div class="settings-section">
    <h4 class="settings-section-title">色彩转换</h4>
    <div class="settings-group color-settings-card">
      <div id="color-mode" class="color-mode-options" role="group" aria-label="色彩转换">
        <button data-color-mode="reference" aria-pressed="false"><strong>自有色彩</strong><span>统一 SDR 转换</span></button>
        <button data-color-mode="browser" aria-pressed="false"><strong>浏览器色彩</strong><span>沿用原生帧转换</span></button>
      </div>
      <div id="reference-decode-settings" class="color-decode-controls">
        <span>解码方式</span><div id="reference-decoder" class="color-segmented" role="group" aria-label="解码方式"><button data-reference-decoder="software" aria-pressed="false">软件</button><button data-reference-decoder="hardware" aria-pressed="false">硬件优先</button></div>
        <div id="hardware-depth-row"><label for="hardware-buffer-depth">缓冲</label><button id="hardware-buffer-depth" class="settings-choice" aria-label="硬件缓冲深度"></button></div>
      </div>
      <figure class="color-flow"><figcaption>帧数据流 <span>路径示意</span></figcaption><div id="color-flow-diagram"></div></figure>
      <p id="color-mode-description" class="color-flow-note" role="status"></p>
      <p class="color-flow-footnote">自有转换支持 CPU 兜底。切换会暂停，保留进度与标注。</p>
    </div>
  </div>
  <div class="settings-section"><h4 class="settings-section-title">当前运行</h4><div class="settings-group">
    <div class="settings-action-row"><span id="decoder-environment"></span></div>
    <div id="performance-current" class="color-runtime-row" hidden><div id="color-runtime-tracks"></div><p class="evidence"><span id="alignment"></span><span id="decode"></span></p></div>
    <div class="settings-action-row"><div><h4>播放流畅度</h4><p>从头播放，检查后暂停。</p></div><button id="benchmark">开始检查</button></div>
  </div></div>
  <div id="benchmark-result" class="color-benchmark-result" hidden><p id="benchmark-summary" role="status"></p><section><h4 class="settings-section-title">检查结果</h4><textarea id="benchmark-json" aria-label="播放性能报告 JSON" readonly rows="8"></textarea></section></div>`;
}
