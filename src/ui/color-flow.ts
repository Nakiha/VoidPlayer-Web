import { t, th, getLocaleRevision, msg } from '../i18n.ts';
import { icon } from './icons.ts';
import type { ColorMode } from '../color-mode.ts';

type Node = [Parameters<typeof icon>[0], string, string];
const connector = '<svg class="color-flow-connector color-flow-connector-horizontal" viewBox="0 0 60 12" aria-hidden="true" focusable="false"><path d="M1 6H13M47 6H59M55 2L59 6L55 10" /></svg><svg class="color-flow-connector color-flow-connector-vertical" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M8 1V15M4 11L8 15L12 11" /></svg>';
function lane(title: string, nodes: Node[], links: string[]) {
  return `<div class="color-flow-lane"><h5>${title}</h5><ol class="color-flow-nodes" style="--flow-edges:${nodes.length - 1}">${nodes.map(([glyph, title, detail], i) => `<li class="color-flow-step"><div class="color-flow-unit">${icon(glyph)}<strong>${title}</strong><span>${detail}</span></div>${i < nodes.length - 1 ? `<div class="color-flow-link"><span>${links[i]}</span>${connector}</div>` : ''}</li>`).join('')}</ol></div>`;
}

/** Decoder changes only alter the first unit; keep the rest of the lane mounted. */
export function updateColorFlow(root: HTMLElement, mode: ColorMode, decoder: 'hardware' | 'software') {
  if (root.dataset.mode !== mode) {
    root.innerHTML = colorFlow(mode, decoder);
    root.dataset.mode = mode;
  } else if (mode === 'reference' && root.dataset.decoder !== decoder) {
    const hardware = decoder === 'hardware';
    root.querySelector('h5')!.textContent = hardware ? t(msg("colorFlow.whenNativePlaneVerificationPasses", "原生平面核对通过时")) : t(msg("colorFlow.softwareDecoding", "软件解码"));
    const unit = root.querySelector<HTMLElement>('.color-flow-unit')!;
    unit.querySelector('svg')!.outerHTML = icon(hardware ? 'gpu' : 'cpu');
    unit.querySelector('strong')!.textContent = hardware ? t(msg("colorFlow.hardwareDecoder", "硬件解码单元")) : 'CPU';
    unit.querySelector('span')!.textContent = hardware ? t(msg("colorFlow.browserHardwarePreference", "浏览器优先请求")) : t(msg("colorFlow.softwareDecoding", "软件解码"));
    root.querySelector('.color-flow-link span')!.textContent = hardware ? t(msg("colorFlow.readBack", "读回")) : t(msg("colorFlow.decode", "解码"));
  }
  if(root.dataset.localeRevision !== String(getLocaleRevision())) {
    const template=document.createElement('template');template.innerHTML=colorFlow(mode,decoder);
    const labels='h5, strong, .color-flow-unit > span, .color-flow-link > span';
    const translated=template.content.querySelectorAll(labels);
    root.querySelectorAll(labels).forEach((node,i)=>node.textContent=translated[i].textContent);
    root.dataset.localeRevision=String(getLocaleRevision());
  }
  root.toggleAttribute('data-long-labels',[...root.querySelectorAll('.color-flow-link > span')].some(node=>(node.textContent?.length??0)>20));
  root.dataset.decoder = decoder;
}

/** A conceptual flow, never evidence that a physical hardware decoder is active. */
export function colorFlow(mode: ColorMode, decoder: 'hardware' | 'software') {
  const screen: Node = ['monitor', t(msg("colorFlow.screen", "屏幕")), t(msg("colorFlow.displayImage", "显示画面"))];
  const ram: Node = ['memory', t(msg("colorFlow.memory", "内存")), t(msg("colorFlow.rawYuvFrames", "原始 YUV 帧"))];
  const software: Node = ['cpu', 'CPU', t(msg("colorFlow.softwareDecoding", "软件解码"))];
  if (mode === 'browser') return lane(t(msg("colorFlow.nativeDecoding", "原生解码")), [
    ['cpu', t(msg("colorFlow.browserDecoder", "浏览器解码器")), t(msg("colorFlow.preferHardware", "优先请求硬件"))], ['gpu', 'GPU', t(msg("colorFlow.browserColorConversion", "浏览器转换颜色"))], screen,
  ], [t(msg("colorFlow.nativeFrames", "原生帧")), t(msg("colorFlow.present", "上屏"))]) + lane(t(msg("colorFlow.whenNativeDecodingIsUnavailable", "无法原生解码时")), [software, ram, ['gpu', 'GPU', t(msg("colorFlow.approximateBrowserColors", "近似浏览器颜色"))], screen], [t(msg("colorFlow.decode", "解码")), t(msg("colorFlow.upload", "上传")), t(msg("colorFlow.present", "上屏"))]);
  return lane(decoder === 'hardware' ? t(msg("colorFlow.whenNativePlaneVerificationPasses", "原生平面核对通过时")) : t(msg("colorFlow.softwareDecoding", "软件解码")), [
    decoder === 'hardware' ? ['gpu', t(msg("colorFlow.hardwareDecoder", "硬件解码单元")), t(msg("colorFlow.browserHardwarePreference", "浏览器优先请求"))] : software,
    ram, ['gpu', 'GPU', t(msg("colorFlow.voidplayerColorConversion", "VoidPlayer 转换颜色"))], screen,
  ], [decoder === 'hardware' ? t(msg("colorFlow.readBack", "读回")) : t(msg("colorFlow.decode", "解码")), t(msg("colorFlow.upload", "上传")), t(msg("colorFlow.present", "上屏"))]);
}

export function colorSettingsShell() {
  return `<div class="settings-section">
    <h4 class="settings-section-title">${th(msg("colorFlow.colorConversion", "色彩转换"))}</h4>
    <div class="settings-group color-settings-card">
      <div id="color-mode" class="color-mode-options segmented" role="group" aria-label="${th(msg("colorFlow.colorConversion", "色彩转换"))}">
        <button data-color-mode="reference" aria-pressed="false"><strong>${th(msg("colorFlow.managedColor", "自有色彩"))}</strong><span>${th(msg("colorFlow.unifiedSdrConversion", "统一 SDR 转换"))}</span></button>
        <button data-color-mode="browser" aria-pressed="false"><strong>${th(msg("colorFlow.browserColor", "浏览器色彩"))}</strong><span>${th(msg("colorFlow.nativeFrameConversion", "沿用原生帧转换"))}</span></button>
      </div>
      <div id="reference-decode-settings" class="color-decode-controls">
        <span>${th(msg("colorFlow.decoder", "解码方式"))}</span><div id="reference-decoder" class="color-segmented segmented" role="group" aria-label="${th(msg("colorFlow.decoder", "解码方式"))}"><button data-reference-decoder="software" aria-pressed="false">${th(msg("colorFlow.software", "软件"))}</button><button data-reference-decoder="hardware" aria-pressed="false">${th(msg("colorFlow.preferHardware2", "硬件优先"))}</button></div>
        <div id="hardware-depth-row"><label for="hardware-buffer-depth">${th(msg("colorFlow.buffer", "缓冲"))}</label><button id="hardware-buffer-depth" class="settings-choice" aria-label="${th(msg("colorFlow.hardwareBufferDepth", "硬件缓冲深度"))}"></button></div>
      </div>
      <figure class="color-flow"><figcaption>${th(msg("colorFlow.frameDataFlow", "帧数据流"))} <span>${th(msg("colorFlow.pathOverview", "路径示意"))}</span></figcaption><div id="color-flow-diagram"></div></figure>
      <p id="color-mode-description" class="color-flow-note" role="status"></p>
    </div>
  </div>
  <div class="settings-section"><h4 class="settings-section-title">${th(msg("colorFlow.currentRuntime", "当前运行"))}</h4><div class="settings-group">
    <div id="performance-current" class="color-runtime-row" hidden><div id="color-runtime-tracks"></div><p class="evidence"><span id="alignment"></span><span id="decode"></span></p></div>
    <div class="settings-action-row"><div><h4>${th(msg("colorFlow.playbackSmoothness", "播放流畅度"))}</h4><p>${th(msg("colorFlow.playFromTheStartThenPauseAfter", "从头播放，检查后暂停。"))}</p></div><button id="benchmark">${th(msg("colorFlow.runCheck", "开始检查"))}</button></div>
  </div></div>
  <div id="benchmark-result" class="color-benchmark-result" hidden><p id="benchmark-summary" role="status"></p><section><h4 class="settings-section-title">${th(msg("colorFlow.checkResults", "检查结果"))}</h4><textarea id="benchmark-json" aria-label="${th(msg("colorFlow.playbackPerformanceReportJson", "播放性能报告 JSON"))}" readonly rows="8"></textarea></section></div>`;
}
