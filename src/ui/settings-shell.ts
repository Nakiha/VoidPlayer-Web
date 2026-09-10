import { savedWorkspaceShell } from './saved-workspaces.ts';
import { icon } from './icons.ts';
import { ACCENTS } from './appearance.ts';
export const SETTINGS_PANES = [
  ['appearance', '外观', 'appearance'], ['workspace', '工作区', 'open'],
  ['identity', '用户', 'info'], ['shortcuts', '快捷键', 'keyboard'], ['logs', '日志', 'note'], ['performance', '性能', 'diagnostics'], ['about', '关于', 'info'],
] as const;
const paneTitle = (title: string, description = '') => `<div class="settings-page-title"><h3>${title}</h3>${description ? `<p>${description}</p>` : ''}</div>`;
const shortcutRows = (entries: string[][]) => entries.map(([action, keys]) => `<div class="shortcut-row"><span>${action}</span><span class="shortcut-keys">${keys.split(' / ').map(key => `<kbd>${key}</kbd>`).join('<span> / </span>')}</span></div>`).join('');
export function settingsShell() {
  return `<dialog id="settings" class="settings-window" aria-label="设置">
    <button id="settings-close" class="icon-button" aria-label="关闭设置">${icon('close')}</button>
    <div class="settings-body"><nav class="settings-navigation" aria-label="设置分类"><div role="tablist" aria-orientation="vertical">${SETTINGS_PANES.map(([id, label, glyph]) => `<button id="settings-tab-${id}" role="tab" data-settings-pane="${id}" aria-controls="settings-pane-${id}" aria-selected="${id === 'appearance'}" tabindex="${id === 'appearance' ? 0 : -1}">${icon(glyph)}<span>${label}</span></button>`).join('')}</div></nav>
    <div class="settings-content">
      <section id="settings-pane-appearance" role="tabpanel" aria-labelledby="settings-tab-appearance" tabindex="0">
        ${paneTitle('外观')}
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
        <p class="settings-caption" id="accent-input-hint">自动适配亮暗模式，不影响视频颜色。</p>

      </section>
      <section id="settings-pane-workspace" role="tabpanel" aria-labelledby="settings-tab-workspace" tabindex="0" hidden>
        ${paneTitle('工作区')}
        <div class="settings-group">
          <div class="settings-action-row"><div><h4>导出工作区</h4><p>保存标注、视频引用与布局，不包含视频文件。</p></div><button id="export" disabled>${icon('export')}导出</button></div>
          <div class="settings-action-row"><div><h4>打开工作区</h4><p>.voidplayer / JSON，也可拖入播放器。</p></div><button id="workspace-import">${icon('open')}打开</button></div>
        </div>
        ${savedWorkspaceShell()}
        <details class="settings-disclosure"><summary>打开工作区时找不到视频？</summary><p class="settings-caption">本地视频需重新选择原文件，媒体库视频需连接原服务。载入失败会保留当前工作区。</p></details>
      </section>
      <section id="settings-pane-identity" role="tabpanel" aria-labelledby="settings-tab-identity" tabindex="0" hidden>
        ${paneTitle('用户')}
        <div class="identity-current"><span class="settings-caption">当前用户</span><div><strong id="identity-current"></strong><span id="identity-id" class="settings-caption"></span></div></div>
        <form id="identity-form" class="identity-form">
          <label for="identity-name">用户名</label>
          <div class="identity-input-row"><input id="identity-name" maxlength="128" autocomplete="off" spellcheck="false" aria-describedby="identity-hint"><button id="identity-save" type="submit">保存</button></div>
          <p id="identity-hint" class="settings-caption">新名字用于重命名；已有名字会切换用户。</p>
        </form>
        <div class="identity-form"><label for="identity-users">切换到已有用户</label><button type="button" id="identity-users" class="settings-choice" aria-label="切换到已有用户" aria-describedby="identity-switch-hint"></button></div>
        <p id="identity-switch-hint" class="settings-caption">切换后保留当前评审，显示所选用户的服务器工作区。</p>
        <button id="identity-guest" type="button">切换为访客</button>
        <p id="identity-message" class="settings-caption" role="status"></p>
      </section>
      <section id="settings-pane-shortcuts" role="tabpanel" aria-labelledby="settings-tab-shortcuts" tabindex="0" hidden>
        ${paneTitle('快捷键')}
        <h4 class="settings-section-title">播放与视图</h4><div class="settings-group">${shortcutRows([['播放 / 暂停','Space'],['上一帧 / 下一帧','← / →'],['切换并排 / 分屏','M'],['打开设置','⌘ , / Ctrl ,']])}</div>
        <h4 class="settings-section-title">标注</h4><div class="settings-group">${shortcutRows([['开始标注','N'],['选择 / 画笔','V / P'],['矩形 / 椭圆','R / O'],['线条 / 文字 / 橡皮擦','L / T / E'],['撤销','⌘ Z / Ctrl Z'],['重做','⌘ ⇧ Z / Ctrl ⇧ Z'],['删除选中对象','Delete'],['结束标注 / 关闭窗口','Esc']])}</div>
        <p class="settings-caption">输入文字时保留空格与方向键。滚轮或捏合缩放，右键拖动或双指滚动平移。</p>
      </section>
      <section id="settings-pane-logs" role="tabpanel" aria-labelledby="settings-tab-logs" tabindex="0" hidden>
        ${paneTitle('日志')}
        <div id="diagnostic-logs"></div>
        </section>
      <section id="settings-pane-performance" role="tabpanel" aria-labelledby="settings-tab-performance" tabindex="0" hidden>
        ${paneTitle('性能')}
        <h4 class="settings-section-title"><label for="color-mode">色彩路径</label></h4>
        <div class="settings-group"><div class="settings-action-row"><div><select id="color-mode"><option value="reference">正确颜色（SDR）</option><option value="browser">匹配浏览器（近似拟合）</option></select><p id="color-mode-description" role="status"></p></div></div></div>
        <div id="reference-decode-settings" class="settings-group"><div class="settings-action-row"><div><label for="reference-decoder">解码路径</label><select id="reference-decoder"><option value="hardware">优先硬件解码</option><option value="software">强制软件解码</option></select><p>硬件路径可降低 CPU 开销；不支持的资源自动使用软件解码，部分设备上读回速度可能较慢。</p></div></div><div id="hardware-depth-row" class="settings-action-row"><div><label for="hardware-buffer-depth">硬件缓冲深度</label><select id="hardware-buffer-depth"><option value="1">1 帧</option><option value="2">2 帧（推荐）</option><option value="4">4 帧</option><option value="8">8 帧</option></select><p>每条轨道独立缓冲。更多帧会增加内存和等待时间，不保证更快。切换设置会暂停并重新载入视频。</p></div></div></div>
        <div class="settings-group"><div class="settings-action-row"><div><h4>解码环境</h4><p id="decoder-environment"></p></div></div><div id="performance-current" class="settings-action-row" hidden><div><h4>当前视频</h4><p class="evidence"><span id="alignment"></span><span id="decode"></span></p></div></div></div>
        <h4 class="settings-section-title">播放检查</h4><div class="settings-group"><div class="settings-action-row"><div><h4>测量播放流畅度</h4><p>从头播放，检查结束后暂停。</p></div><button id="benchmark">开始检查</button></div></div><details class="settings-disclosure"><summary>如何判断是否使用硬件解码？</summary><p class="settings-caption">WebCodecs 可用不代表正在硬解，实际取决于浏览器、显卡和视频编码。</p></details>
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
