import { icon } from './icons.ts';
import { ACCENTS } from './appearance.ts';
export const SETTINGS_PANES = [
  ['appearance', '外观', 'appearance'], ['workspace', '工作区', 'open'],
  ['shortcuts', '快捷键', 'keyboard'], ['logs', '日志', 'note'], ['performance', '性能', 'diagnostics'], ['about', '关于', 'info'],
] as const;
const paneTitle = (title: string, description: string) => `<div class="settings-page-title"><h3>${title}</h3><p>${description}</p></div>`;
const shortcutRows = (entries: string[][]) => entries.map(([action, keys]) => `<div class="shortcut-row"><span>${action}</span><span class="shortcut-keys">${keys.split(' / ').map(key => `<kbd>${key}</kbd>`).join('<span> / </span>')}</span></div>`).join('');
export function settingsShell() {
  return `<dialog id="settings" class="settings-window" aria-label="设置">
    <button id="settings-close" class="icon-button" aria-label="关闭设置">${icon('close')}</button>
    <div class="settings-body"><nav class="settings-navigation" aria-label="设置分类"><div role="tablist" aria-orientation="vertical">${SETTINGS_PANES.map(([id, label, glyph]) => `<button id="settings-tab-${id}" role="tab" data-settings-pane="${id}" aria-controls="settings-pane-${id}" aria-selected="${id === 'appearance'}" tabindex="${id === 'appearance' ? 0 : -1}">${icon(glyph)}<span>${label}</span></button>`).join('')}</div></nav>
    <div class="settings-content">
      <section id="settings-pane-appearance" role="tabpanel" aria-labelledby="settings-tab-appearance" tabindex="0">
        ${paneTitle('外观', '选择适合当前环境的显示方式。更改即时生效。')}
        <h4 class="settings-section-title" id="theme-label">显示模式</h4>
        <div class="theme-options" role="radiogroup" aria-labelledby="theme-label">${[['system','跟随系统'],['light','亮色'],['dark','暗色']].map(([id,label]) => `<button role="radio" data-theme-choice="${id}" aria-checked="false"><span class="appearance-sample sample-${id}" aria-hidden="true"><span class="sample-header"></span><span class="sample-sidebar"></span><span class="sample-content"></span></span><span>${label}</span></button>`).join('')}</div>
        <div class="accent-heading"><h4 class="settings-section-title" id="accent-label">主题色</h4><span id="accent-current"></span></div>
        <div role="radiogroup" aria-labelledby="accent-label" class="accent-palette">
          <div class="accent-choices">${ACCENTS.map(c => `<button class="accent-choice" role="radio" data-accent-choice="${c.id}" aria-label="${c.name}" data-tooltip="${c.name}" style="--swatch-light:${c.light};--swatch-dark:${c.dark}"><span class="accent-swatch">${icon('check')}</span></button>`).join('')}</div>
          <div class="accent-custom-row">
            <button class="accent-custom-choice" role="radio" data-accent-choice="custom" aria-label="自定义主题色"><span class="accent-swatch">${icon('check')}</span><span>自定义</span></button>
            <div class="accent-custom-inputs"><input id="accent-picker" type="color" aria-label="选择自定义主题色"><label class="accent-hex-label"><span>HEX</span><input id="accent-hex" type="text" aria-label="主题色 HEX" maxlength="7" spellcheck="false" autocomplete="off" aria-describedby="accent-input-hint"></label></div>
          </div>
        </div>
        <p class="settings-caption" id="accent-input-hint">自定义颜色自动适配亮暗模式，仅用于界面控件。</p>

      </section>
      <section id="settings-pane-workspace" role="tabpanel" aria-labelledby="settings-tab-workspace" tabindex="0" hidden>
        ${paneTitle('工作区', '保存当前评审，或继续之前的工作。')}
        <div class="settings-group">
          <div class="settings-action-row"><div><h4>导出工作区</h4><p>视频引用、标注、播放位置和布局。</p></div><button id="export" disabled>${icon('export')}导出</button></div>
          <div class="settings-action-row"><div><h4>打开工作区</h4><p>支持 .voidplayer 与 JSON，也可直接拖入网页。</p></div><button id="workspace-import">${icon('open')}打开</button></div>
        </div>
        <h4 class="settings-section-title">片源连接</h4><p class="settings-copy">工作区保存媒体服务地址，不打包视频。本地视频需要重新选择原文件；媒体库视频需要能访问记录的服务。</p>
        <p class="settings-caption">导入准备完成后才替换当前会话。片源不可用时会保留当前工作区。</p>
      </section>
      <section id="settings-pane-shortcuts" role="tabpanel" aria-labelledby="settings-tab-shortcuts" tabindex="0" hidden>
        ${paneTitle('快捷键', '播放、观察和标注时常用的操作。')}
        <h4 class="settings-section-title">播放与视图</h4><div class="settings-group">${shortcutRows([['播放 / 暂停','Space'],['上一帧 / 下一帧','← / →'],['切换并排 / 分屏','M'],['打开设置','⌘ , / Ctrl ,']])}</div>
        <h4 class="settings-section-title">标注</h4><div class="settings-group">${shortcutRows([['开始标注','N'],['选择 / 画笔','V / P'],['矩形 / 椭圆','R / O'],['线条 / 文字 / 橡皮擦','L / T / E'],['撤销','⌘ Z / Ctrl Z'],['重做','⌘ ⇧ Z / Ctrl ⇧ Z'],['删除选中对象','Delete'],['结束标注 / 关闭窗口','Esc']])}</div>
        <p class="settings-caption">输入文字时保留空格与方向键。滚轮或捏合缩放，右键拖动或双指滚动平移。</p>
      </section>
      <section id="settings-pane-logs" role="tabpanel" aria-labelledby="settings-tab-logs" tabindex="0" hidden>
        ${paneTitle('日志', '查看与导出当前会话的诊断记录。')}
        <div id="diagnostic-logs"></div>
        </section>
      <section id="settings-pane-performance" role="tabpanel" aria-labelledby="settings-tab-performance" tabindex="0" hidden>
        ${paneTitle('性能', '检查视频的播放节奏与呈现状态。')}
        <div class="settings-group"><div class="settings-action-row"><div><h4>检查当前视频</h4><p>从头播放一段并测量呈现节奏，结束后暂停。</p></div><button id="benchmark">开始检查</button></div></div>
        <p class="evidence settings-caption"><span id="alignment"></span><span id="decode"></span></p>
        <div id="benchmark-result" hidden><p id="benchmark-summary" role="status"></p><details><summary>性能报告</summary><textarea id="benchmark-json" aria-label="播放性能报告 JSON" readonly rows="8"></textarea></details></div>
      </section>
      <section id="settings-pane-about" role="tabpanel" aria-labelledby="settings-tab-about" tabindex="0" hidden>
        ${paneTitle('VoidPlayer', '浏览器内的视频评审工具')}
        <div class="about-project settings-group">
          <div class="about-project-row"><span>项目源码</span><a href="https://github.com/Nakiha/VoidPlayer-Web" target="_blank" rel="noopener noreferrer">VoidPlayer-Web ↗</a></div>
          <div class="about-project-row"><span>许可证</span><a href="/licenses/voidplayer-web.txt" target="_blank" rel="noopener">LGPL-2.1-or-later</a></div>
        </div>
        <h4 class="settings-section-title">开源致谢</h4>
        <div class="settings-credits settings-group">
          <div><a class="credit-name" href="https://github.com/Vanilagy/mediabunny" target="_blank" rel="noopener noreferrer">Mediabunny ↗</a><span>媒体解封装</span><a href="/licenses/mediabunny.txt" target="_blank" rel="noopener">MPL-2.0</a></div>
          <div><a class="credit-name" href="https://github.com/phosphor-icons/phosphor-core" target="_blank" rel="noopener noreferrer">Phosphor Icons ↗</a><span>界面图标</span><a href="/licenses/phosphor-icons.txt" target="_blank" rel="noopener">MIT</a></div>
          <div><a class="credit-name" href="https://ffmpeg.org/" target="_blank" rel="noopener noreferrer">FFmpeg ↗</a><span>视频解码</span><a href="/vendor/voidplayer-core/LICENSES/COPYING.LGPLv2.1" target="_blank" rel="noopener">LGPL-2.1-or-later</a></div>
          <div><a class="credit-name" href="https://code.videolan.org/videolan/dav1d" target="_blank" rel="noopener noreferrer">dav1d ↗</a><span>AV1 解码</span><a href="/vendor/voidplayer-core/LICENSES/dav1d-COPYING" target="_blank" rel="noopener">BSD-2-Clause</a></div>
        </div>
        <p class="settings-caption about-build"><a href="https://github.com/Nakiha/VoidPlayer-FFmpeg-Build/tree/wasm" target="_blank" rel="noopener noreferrer">WASM 解码器源码与构建 ↗</a></p>

      </section>
    </div></div>
  </dialog>`;
}
