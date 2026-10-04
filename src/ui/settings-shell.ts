import { t, th, msg } from '../i18n.ts';
import { colorSettingsShell } from './color-flow.ts';
import { savedWorkspaceShell } from './saved-workspaces.ts';
import { icon } from './icons.ts';
import { buildInfo } from '../build-info.ts';
import { ACCENTS, BASE_COLORS, customTheme } from './appearance.ts';
import { shortcutLabel } from './shortcuts.ts';
import type { Shortcut } from './shortcuts.ts';
export const settingsPanes = () => [
  ['appearance', t(msg("settingsShell.appearance", "外观")), 'appearance'], ['workspace', t(msg("settingsShell.workspace", "工作区")), 'open'],
  ['identity', t(msg("settingsShell.user", "用户")), 'user'], ['shortcuts', t(msg("settingsShell.shortcuts", "快捷键")), 'keyboard'], ['logs', t(msg("settingsShell.feedback", "反馈")), 'note'], ['performance', t(msg("settingsShell.colorDecoding", "色彩与解码")), 'diagnostics'], ['about', t(msg("settingsShell.about", "关于")), 'info'],
] as const;
const paneTitle = (title: string, description = '') => `<div class="settings-page-title"><h3>${title}</h3>${description ? `<p>${description}</p>` : ''}</div>`;
const shortcutRows = (entries: [string, Shortcut[]][]) => entries.map(([action, keys]) => `<div class="shortcut-row"><span>${action}</span><span class="shortcut-keys">${keys.map(key => `<kbd>${shortcutLabel(key)}</kbd>`).join('<span> / </span>')}</span></div>`).join('');
export function settingsShell() {
  return `<dialog id="settings" class="settings-window" aria-label="${th(msg("shell.settings", "设置"))}">
    <div class="settings-body"><nav class="settings-navigation" aria-label="${th(msg("settingsShell.settingsCategories", "设置分类"))}"><div role="tablist" aria-orientation="vertical">${settingsPanes().map(([id, label, glyph]) => `<button id="settings-tab-${id}" role="tab" data-settings-pane="${id}" aria-controls="settings-pane-${id}" aria-selected="${id === 'appearance'}" tabindex="${id === 'appearance' ? 0 : -1}">${icon(glyph)}<span>${label}</span></button>`).join('')}</div></nav>
    <div class="settings-content">
      <header class="settings-floating-header"><h2 id="settings-current-title">${th(msg("settingsShell.appearance", "外观"))}</h2><button id="settings-close" class="icon-button" aria-label="${th(msg("settingsShell.closeSettings", "关闭设置"))}">${icon('close')}</button></header>
      <section id="settings-pane-appearance" role="tabpanel" aria-labelledby="settings-tab-appearance" tabindex="0">
        ${paneTitle(t(msg("settingsShell.appearance", "外观")))}
        <div class="settings-section"><h4 class="settings-section-title" id="theme-label">${th(msg("settingsShell.displayMode", "显示模式"))}</h4>
        <div class="theme-options settings-card" role="radiogroup" aria-labelledby="theme-label">${[['system',t(msg("settingsShell.system", "跟随系统"))],['light',t(msg("settingsShell.light", "亮色"))],['dark',t(msg("settingsShell.dark", "暗色"))],['custom',t(msg("settingsShell.custom", "自定义"))]].map(([id,label]) => `<button role="radio" data-theme-choice="${id}" aria-checked="false"><span class="appearance-sample sample-${id}" aria-hidden="true"><span class="sample-header"></span><span class="sample-sidebar"></span><span class="sample-content"></span></span><span>${label}</span></button>`).join('')}</div>
        <div id="theme-base-controls" class="theme-base-controls" hidden>
          <div class="theme-base-row"><label id="theme-base-label" for="theme-base-picker">${th(msg("theme.baseColor", "基调色"))}</label><div class="theme-base-inputs"><input id="theme-base-picker" type="color" aria-label="${th(msg("theme.chooseBaseColor", "选择自定义基调色"))}"><label class="theme-base-hex-label"><span>HEX</span><input id="theme-base-hex" type="text" aria-label="${th(msg("theme.baseHex", "基调色 HEX"))}" maxlength="7" spellcheck="false" autocomplete="off" aria-describedby="theme-base-hint"></label></div></div>
          <div class="accent-choices theme-base-choices" role="radiogroup" aria-labelledby="theme-base-label">${BASE_COLORS.map(c => `<button class="accent-choice" role="radio" data-base-choice="${c.color}" aria-checked="false" aria-label="${c.name}" data-tooltip="${c.name}" style="--base-swatch:${c.color};--base-check:${customTheme(c.color)!.dark ? '#f2f3f5' : '#16191e'}"><span class="accent-swatch">${icon('check')}</span></button>`).join('')}</div>
        </div>
        <p id="theme-base-hint" class="settings-caption" role="status"></p>
        </div><div class="settings-section"><div class="accent-heading"><h4 class="settings-section-title" id="accent-label">${th(msg("settingsShell.accentColor", "主题色"))}</h4><span id="accent-current"></span></div>
        <div role="radiogroup" aria-labelledby="accent-label" class="accent-palette settings-card">
          <div class="accent-choices">${ACCENTS.map(c => `<button class="accent-choice" role="radio" data-accent-choice="${c.id}" aria-label="${c.name}" data-tooltip="${c.name}" style="--swatch-light:${c.light};--swatch-dark:${c.dark}"><span class="accent-swatch">${icon('check')}</span></button>`).join('')}</div>
          <div class="accent-custom-row">
            <button class="accent-custom-choice" role="radio" data-accent-choice="custom" aria-label="${th(msg("settingsShell.customAccentColor", "自定义主题色"))}"><span class="accent-swatch">${icon('check')}</span><span>${th(msg("settingsShell.custom", "自定义"))}</span></button>
            <div class="accent-custom-inputs"><input id="accent-picker" type="color" aria-label="${th(msg("settingsShell.chooseCustomAccentColor", "选择自定义主题色"))}"><label class="accent-hex-label"><span>HEX</span><input id="accent-hex" type="text" aria-label="${th(msg("settingsShell.accentColorHex", "主题色 HEX"))}" maxlength="7" spellcheck="false" autocomplete="off" aria-describedby="accent-input-hint"></label></div>
          </div>
        </div>
        <p class="settings-caption" id="accent-input-hint" role="status"></p></div>
        <div class="settings-section"><h4 class="settings-section-title" id="language-label">${th(msg("language.label", "语言 / Language"))}</h4>
          <div class="settings-group"><div class="settings-action-row language-settings"><button id="language-choice" type="button" class="settings-choice" aria-label="${th(msg("language.label", "语言 / Language"))}"></button></div></div>
          <p id="language-status" class="settings-caption" role="status"></p>
        </div>

      </section>
      <section id="settings-pane-workspace" role="tabpanel" aria-labelledby="settings-tab-workspace" tabindex="0" hidden>
        ${paneTitle(t(msg("settingsShell.workspace", "工作区")))}
        ${savedWorkspaceShell()}
      </section>
      <section id="settings-pane-identity" role="tabpanel" aria-labelledby="settings-tab-identity" tabindex="0" hidden>
        ${paneTitle(t(msg("settingsShell.user", "用户")))}
        <div class="settings-card identity-compact">
          <div class="identity-summary"><div class="identity-current"><span>${th(msg("settingsShell.currentUser", "当前用户"))}</span><strong id="identity-current" hidden></strong></div><p id="identity-id" class="settings-caption"></p></div>
          <form id="identity-form"><div class="identity-combo"><input id="identity-name" maxlength="128" autocomplete="off" placeholder="${th(msg("settingsShell.enterANameOrChooseAnExisting", "输入名字或选择已有用户"))}" aria-label="${th(msg("settingsShell.name", "名字"))}" aria-describedby="identity-kind"><span id="identity-kind" role="status"></span><button id="identity-users" type="button" aria-label="${th(msg("settingsShell.chooseAUserOrRenameYourself", "选择用户或修改当前名字"))}"></button></div>
          <button id="identity-save" type="submit" >${th(msg("settingsShell.enterAName", "输入名字"))}</button></form>
          <p id="identity-message" class="settings-caption" role="status"></p>
        </div>
      </section>
      <section id="settings-pane-shortcuts" role="tabpanel" aria-labelledby="settings-tab-shortcuts" tabindex="0" hidden>
        ${paneTitle(t(msg("settingsShell.shortcuts", "快捷键")))}
        <div class="settings-section"><h4 class="settings-section-title">${th(msg("settingsShell.playbackView", "播放与视图"))}</h4><div class="settings-group">${shortcutRows([[t(msg("shell.playPause", "播放 / 暂停")),['play']],[t(msg("settingsShell.previousNextFrame", "上一帧 / 下一帧")),['previous','next']],[t(msg("shell.toggleSideBySideSplit", "切换并排 / 分屏")),['layout']],[t(msg("shell.focusMode", "专注模式")),['focusMode']],[t(msg("shell.trackInfo", "轨道信息")),['panelInspector']],[t(msg("shell.bitstreamAnalysis", "码流分析")),['panelAnalysis']],[t(msg("shell.tracks", "子轨道")),['panelSubtracks']],[t(msg("shell.sources", "片源")),['panelSources']],[t(msg("shell.openSettings", "打开设置")),['settings']]])}</div>
        </div><div class="settings-section"><h4 class="settings-section-title">${th(msg("shell.annotations", "标注"))}</h4><div class="settings-group">${shortcutRows([[t(msg("settingsShell.startAnnotating", "开始标注")),['annotate']],[t(msg("settingsShell.selectPen", "选择 / 画笔")),['select','pen']],[t(msg("settingsShell.rectangleEllipse", "矩形 / 椭圆")),['rect','ellipse']],[t(msg("settingsShell.lineTextEraser", "线条 / 文字 / 橡皮擦")),['line','text','eraser']],[t(msg("shell.undo", "撤销")),['undo']],[t(msg("shell.redo", "重做")),['redo']],[t(msg("shell.deleteSelection", "删除选中对象")),['delete']],[t(msg("settingsShell.finishAnnotatingCloseWindow", "结束标注 / 关闭窗口")),['close']]])}</div>
        <p class="settings-caption">${th(msg("settingsShell.spaceAndArrowKeysRemainAvailableWhen", "输入文字时保留空格与方向键。滚轮或捏合缩放，右键拖动或双指滚动平移。"))}</p></div>
      </section>
      <section id="settings-pane-logs" role="tabpanel" aria-labelledby="settings-tab-logs" tabindex="0" hidden>
        ${paneTitle(t(msg("settingsShell.feedback", "反馈")))}
        <div id="diagnostic-logs"></div>
        </section>
      <section id="settings-pane-performance" role="tabpanel" aria-labelledby="settings-tab-performance" tabindex="0" hidden>
        ${paneTitle(t(msg("settingsShell.colorDecoding", "色彩与解码")))}
        ${colorSettingsShell()}
      </section>
      <section id="settings-pane-about" role="tabpanel" aria-labelledby="settings-tab-about" tabindex="0" hidden>
        ${paneTitle(t(msg("settingsShell.about", "关于")))}
        <div class="settings-section"><h4 class="settings-section-title">VoidPlayer</h4><div class="about-project settings-group">
          <div class="about-project-row"><span>${th(msg("settingsShell.version", "版本"))}</span><span>${buildInfo?.revision ?? t(msg("settingsShell.developmentBuild", "开发版本"))}</span></div>
          <div class="about-project-row"><span>${th(msg("settingsShell.projectSource", "项目源码"))}</span><a href="https://github.com/Nakiha/VoidPlayer-Web" target="_blank" rel="noopener noreferrer">VoidPlayer-Web ↗</a></div>
          <div class="about-project-row"><span>${th(msg("settingsShell.decoderSource", "解码器源码"))}</span><a href="https://github.com/Nakiha/VoidPlayer-FFmpeg-Build/tree/wasm" target="_blank" rel="noopener noreferrer">VoidPlayer-FFmpeg-Build ↗</a></div>
          <div class="about-project-row"><span>${th(msg("settingsShell.license", "许可证"))}</span><a href="/licenses/voidplayer-web.txt" target="_blank" rel="noopener">LGPL-2.1-or-later</a></div>
        </div>
        </div><section class="settings-section"><h4 class="settings-section-title">${th(msg("settingsShell.openSourceCredits", "开源致谢"))}</h4><div class="settings-detail-body">
        <div class="settings-credits settings-group">
          <div><a class="credit-name" href="https://github.com/Vanilagy/mediabunny" target="_blank" rel="noopener noreferrer">Mediabunny ↗</a><span>${th(msg("settingsShell.mediaDemuxing", "媒体解封装"))}</span><a href="/licenses/mediabunny.txt" target="_blank" rel="noopener">MPL-2.0</a></div>
          <div><a class="credit-name" href="https://github.com/phosphor-icons/phosphor-core" target="_blank" rel="noopener noreferrer">Phosphor Icons ↗</a><span>${th(msg("settingsShell.interfaceIcons", "界面图标"))}</span><a href="/licenses/phosphor-icons.txt" target="_blank" rel="noopener">MIT</a></div>
          <div><a class="credit-name" href="https://ffmpeg.org/" target="_blank" rel="noopener noreferrer">FFmpeg ↗</a><span>${th(msg("settingsShell.videoDecoding", "视频解码"))}</span><a href="/vendor/voidplayer-core/LICENSES/COPYING.LGPLv2.1" target="_blank" rel="noopener">LGPL-2.1-or-later</a></div>
          <div><a class="credit-name" href="https://code.videolan.org/videolan/dav1d" target="_blank" rel="noopener noreferrer">dav1d ↗</a><span>${th(msg("settingsShell.av1Decoding", "AV1 解码"))}</span><a href="/vendor/voidplayer-core/LICENSES/dav1d-COPYING" target="_blank" rel="noopener">BSD-2-Clause</a></div>
        </div>
        </div></section>

      </section>
      <div id="settings-scrollbar" class="source-scrollbar settings-scrollbar" aria-hidden="true"><span id="settings-scrollbar-thumb"></span></div>
    </div></div>
  </dialog>`;
}
