import { localOnly } from '../services/build-profile.ts';
import { t, th, msg } from '../i18n.ts';
import { colorSettingsShell } from './color-flow.ts';
import { browserCachesShell } from './browser-caches.ts';
import { annotationActivityShell } from './annotation-activity.ts';
import { icon } from './icons.ts';
import { aboutFrameGraph, aboutMark } from './about-banner.ts';
import { buildInfo } from '../build-info.ts';
import { ACCENTS, BASE_COLORS, customTheme } from './appearance.ts';
import { supportsFileHandles } from '../services/file-handles.ts';
import { shortcutLabel } from './shortcuts.ts';
import type { Shortcut } from './shortcuts.ts';
export const settingsPanes = () => ([
  ['appearance', t(msg('settingsShell.preferences', '首选项')), 'settings'], ['caches', t(msg('admin.cacheTitle', '缓存')), 'database'],
  ['identity', t(msg("settingsShell.user", "用户")), 'user'], ['shortcuts', t(msg("settingsShell.shortcuts", "快捷键")), 'keyboard'], ['logs', t(msg("settingsShell.logs", "日志")), 'fileText'], ['performance', t(msg("settingsShell.colorDecoding", "色彩与解码")), 'colorDecoding'],
  ['experimental', t(msg('settingsShell.experimental', '实验性功能')), 'diagnostics'], ['about', t(msg("settingsShell.about", "关于")), 'info'],
] as const).filter(([key]) => !localOnly || key !== 'identity');
const paneTitle = (title: string, description = '') => `<div class="settings-page-title"><h3>${title}</h3>${description ? `<p>${description}</p>` : ''}</div>`;
const annotationSettings = () => `<div class="settings-section"><h4 class="settings-section-title">${th(msg('uriState.annotations', '片源标注同步'))}</h4>
  <p id="annotation-status" class="settings-caption" role="status"></p><div id="annotation-conflicts"></div></div>${annotationActivityShell()}`;
const preferenceHelp = (id: string, text: string) =>
  `<button type="button" class="section-title-info" data-tooltip="${text}" aria-labelledby="${id}">${icon('info')}</button><span id="${id}" hidden>${text}</span>`;
const shortcutRows = (entries: [string, Shortcut[]][]) => entries.map(([action, keys]) => `<div class="shortcut-row"><span>${action}</span><span class="shortcut-keys">${keys.map(key => `<kbd>${shortcutLabel(key)}</kbd>`).join('<span> / </span>')}</span></div>`).join('');
export function settingsShell() {
  return `<dialog id="settings" class="settings-window" aria-label="${th(msg("shell.settings", "设置"))}">
    <div class="settings-body"><nav class="settings-navigation category-navigation" aria-label="${th(msg("settingsShell.settingsCategories", "设置分类"))}"><div class="category-tabs" role="tablist" aria-orientation="vertical">${settingsPanes().map(([id, label, glyph]) => `<button id="settings-tab-${id}" role="tab" data-settings-pane="${id}" ${id === 'experimental' ? 'hidden' : ''} aria-controls="settings-pane-${id}" aria-selected="${id === 'appearance'}" tabindex="${id === 'appearance' ? 0 : -1}">${icon(glyph)}<span>${label}</span></button>`).join('')}</div></nav>
    <div class="settings-content">
      <header class="settings-floating-header"><h2 id="settings-current-title">${th(msg('settingsShell.preferences', '首选项'))}</h2><button id="settings-close" class="icon-button" aria-label="${th(msg("settingsShell.closeSettings", "关闭设置"))}">${icon('close')}</button></header>
      <section id="settings-pane-appearance" role="tabpanel" aria-labelledby="settings-tab-appearance" tabindex="0">
        ${paneTitle(t(msg('settingsShell.preferences', '首选项')))}
        <div class="settings-section"><h4 class="settings-section-title" id="theme-label">${th(msg("settingsShell.displayMode", "显示模式"))}</h4>
        <div class="theme-options settings-card" role="radiogroup" aria-labelledby="theme-label">${[['system',t(msg("settingsShell.system", "跟随系统"))],['light',t(msg("settingsShell.light", "亮色"))],['dark',t(msg("settingsShell.dark", "暗色"))],['custom',t(msg("settingsShell.custom", "自定义"))]].map(([id,label]) => `<button role="radio" data-theme-choice="${id}" aria-checked="false"><span class="appearance-sample sample-${id}" aria-hidden="true"><span class="sample-header"></span><span class="sample-sidebar"></span><span class="sample-content"></span></span><span>${label}</span></button>`).join('')}</div>
        </div>
        <div id="theme-base-controls" class="settings-section theme-base-controls" hidden>
          <div class="accent-heading"><h4 class="settings-section-title" id="theme-base-label">${th(msg("theme.baseColor", "基调色"))}</h4><span id="theme-base-current"></span></div>
          <div class="accent-palette settings-card theme-base-palette">
            <div class="accent-choices theme-base-choices" role="radiogroup" aria-labelledby="theme-base-label">${BASE_COLORS.map(c => `<button class="accent-choice" role="radio" data-base-choice="${c.color}" aria-checked="false" aria-label="${c.name}" data-tooltip="${c.name}" style="--base-swatch:${c.color};--base-check:${customTheme(c.color)!.dark ? '#f2f3f5' : '#16191e'}"><span class="accent-swatch">${icon('check')}</span></button>`).join('')}</div>
            <div class="accent-custom-row">
              <label class="accent-custom-choice theme-base-custom" for="theme-base-picker"><span class="accent-swatch" aria-hidden="true"></span><span>${th(msg("settingsShell.custom", "自定义"))}</span></label>
              <div class="accent-custom-inputs"><input id="theme-base-picker" type="color" aria-label="${th(msg("theme.chooseBaseColor", "选择自定义基调色"))}"><label class="theme-base-hex-label"><span>HEX</span><input id="theme-base-hex" type="text" aria-label="${th(msg("theme.baseHex", "基调色 HEX"))}" maxlength="7" spellcheck="false" autocomplete="off"></label></div>
            </div>
          </div>
        </div><div class="settings-section"><div class="accent-heading"><h4 class="settings-section-title" id="accent-label">${th(msg("settingsShell.accentColor", "主题色"))}</h4><span id="accent-current"></span></div>
        <div role="radiogroup" aria-labelledby="accent-label" class="accent-palette settings-card">
          <div class="accent-choices">${ACCENTS.map(c => `<button class="accent-choice" role="radio" data-accent-choice="${c.id}" aria-label="${c.name}" data-tooltip="${c.name}" style="--swatch-light:${c.light};--swatch-dark:${c.dark}"><span class="accent-swatch">${icon('check')}</span></button>`).join('')}</div>
          <div class="accent-custom-row">
            <button class="accent-custom-choice" role="radio" data-accent-choice="custom" aria-label="${th(msg("settingsShell.customAccentColor", "自定义主题色"))}"><span class="accent-swatch">${icon('check')}</span><span>${th(msg("settingsShell.custom", "自定义"))}</span></button>
            <div class="accent-custom-inputs"><input id="accent-picker" type="color" aria-label="${th(msg("settingsShell.chooseCustomAccentColor", "选择自定义主题色"))}"><label class="accent-hex-label"><span>HEX</span><input id="accent-hex" type="text" aria-label="${th(msg("settingsShell.accentColorHex", "主题色 HEX"))}" maxlength="7" spellcheck="false" autocomplete="off"></label></div>
          </div>
        </div>
        </div>
        <div class="settings-section"><h4 class="settings-section-title" id="appearance-other-label">${th(msg('settingsShell.languageInteraction', '语言与交互'))}</h4>
          <div class="settings-group" role="group" aria-labelledby="appearance-other-label">
            <div class="settings-action-row appearance-other-row">
              <div><h4 id="language-label">${th(msg('language.label', '语言 / Language'))}</h4></div>
              <button id="language-choice" type="button" class="settings-choice" aria-labelledby="language-label"></button>
            </div>
            <div class="settings-action-row appearance-other-row">
              <div><h4><span id="viewport-wheel-label">${th(msg('settingsShell.wheelBehavior', '视口滚动行为'))}</span>${preferenceHelp('viewport-wheel-hint', th(msg('settingsShell.wheelHint', '捏合或 Ctrl 加滚轮始终缩放。')))}</h4></div>
              <button id="viewport-wheel-behavior" type="button" class="settings-choice" aria-labelledby="viewport-wheel-label" aria-describedby="viewport-wheel-hint"></button>
            </div>
            <div class="settings-action-row appearance-other-row">
              <div><h4>${icon('chart', 'settings-label-glyph')}<span id="chart-hover-label">${th(msg('settingsShell.chartHover', '码流分析悬浮面板显示方式'))}</span>${preferenceHelp('chart-hover-hint', th(msg('settingsShell.chartHoverHint', '各图独立显示在悬浮线旁；合并显示在上面板下方')))}</h4></div>
              <button id="chart-hover-style" type="button" class="settings-choice" aria-labelledby="chart-hover-label" aria-describedby="chart-hover-hint"></button>
            </div>
          </div>
        </div>
        <div class="settings-section"><h4 class="settings-section-title"><span id="local-file-access-label">${th(msg('fileAccess.title', '持久访问本地文件'))}</span>${preferenceHelp('local-file-access-hint',
          (supportsFileHandles() ? th(msg('fileAccess.available', '检测到文件访问接口，可以选择视频验证权限和保存能力')) : th(msg('fileAccess.unsupported', '当前浏览器未提供持久文件访问能力，本地视频按一次性文件打开'))) + '\n' + th(msg('fileAccess.help', '选择一个视频以验证访问权限和本机句柄保存，不会上传或播放，曾拒绝授权时可再次尝试；浏览器未提供此能力时，本地视频仅在本次页面可用，不进入最近打开')))}</h4>
          <div class="settings-group"><div class="settings-action-row">
            <span>${th(msg('fileAccess.apiName', 'File System Access API'))}</span>
            <button id="local-file-access-try" type="button" aria-describedby="local-file-access-hint">${th(msg('fileAccess.try', '尝试启用'))}</button>
          </div></div>
        </div>

        ${localOnly ? annotationSettings() : ''}
      </section>
      <section id="settings-pane-caches" role="tabpanel" aria-labelledby="settings-tab-caches" tabindex="0" hidden>
        ${paneTitle(t(msg('admin.cacheTitle', '缓存')))}
        ${browserCachesShell()}
      </section>
      <section id="settings-pane-identity" role="tabpanel" aria-labelledby="settings-tab-identity" tabindex="0" hidden>
        ${paneTitle(t(msg("settingsShell.user", "用户")))}
        <div class="settings-card identity-compact">
          <div class="identity-summary"><div class="identity-current"><span>${th(msg("settingsShell.currentUser", "当前用户"))}</span><strong id="identity-current" hidden></strong></div><p id="identity-id" class="settings-caption"></p></div>
          <form id="identity-form"><div class="identity-combo"><input id="identity-name" maxlength="128" autocomplete="off" placeholder="${th(msg("settingsShell.enterANameOrChooseAnExisting", "输入名字或选择已有用户"))}" aria-label="${th(msg("settingsShell.name", "名字"))}" aria-describedby="identity-kind"><span id="identity-kind" role="status"></span><button id="identity-users" type="button" aria-label="${th(msg("settingsShell.chooseAUserOrRenameYourself", "选择用户或修改当前名字"))}"></button></div>
          <button id="identity-save" type="submit" >${th(msg("settingsShell.enterAName", "输入名字"))}</button></form>
          <p id="identity-message" class="settings-caption" role="status"></p>
        </div>
        ${localOnly ? '' : annotationSettings()}
      </section>
      <section id="settings-pane-shortcuts" role="tabpanel" aria-labelledby="settings-tab-shortcuts" tabindex="0" hidden>
        ${paneTitle(t(msg("settingsShell.shortcuts", "快捷键")))}
        <div class="settings-section"><h4 class="settings-section-title">${th(msg("settingsShell.playbackView", "播放与视图"))}</h4><div class="settings-group">${shortcutRows([[t(msg("shell.playPause", "播放 / 暂停")),['play']],[t(msg("settingsShell.previousNextFrame", "上一帧 / 下一帧")),['previous','next']],[t(msg("shell.toggleSideBySideSplit", "切换并排 / 分屏")),['layout']],[t(msg("shell.focusMode", "专注模式")),['focusMode']],[t(msg("shell.trackInfo", "轨道信息")),['panelInspector']],[t(msg("shell.bitstreamAnalysis", "码流分析")),['panelAnalysis']],[t(msg("shell.tracks", "子轨道")),['panelSubtracks']],[t(msg("shell.sources", "片源")),['panelSources']],[t(msg("shell.openSettings", "打开设置")),['settings']]])}</div>
        </div><div class="settings-section"><h4 class="settings-section-title">${th(msg("shell.annotations", "标注"))}</h4><div class="settings-group">${shortcutRows([[t(msg("settingsShell.startAnnotating", "开始标注")),['annotate']],[t(msg("settingsShell.selectPen", "选择 / 画笔")),['select','pen']],[t(msg("settingsShell.rectangleEllipse", "矩形 / 椭圆")),['rect','ellipse']],[t(msg("settingsShell.lineTextEraser", "线条 / 文字 / 橡皮擦")),['line','text','eraser']],[t(msg("shell.undo", "撤销")),['undo']],[t(msg("shell.redo", "重做")),['redo']],[t(msg("shell.deleteSelection", "删除选中对象")),['delete']],[t(msg("settingsShell.finishAnnotatingCloseWindow", "结束标注 / 关闭窗口")),['close']]])}</div>
        </div>
      </section>
      <section id="settings-pane-logs" role="tabpanel" aria-labelledby="settings-tab-logs" tabindex="0" hidden>
        ${paneTitle(t(msg("settingsShell.logs", "日志")))}
        <div id="diagnostic-logs"></div>
        </section>
      <section id="settings-pane-performance" role="tabpanel" aria-labelledby="settings-tab-performance" tabindex="0" hidden>
        ${paneTitle(t(msg("settingsShell.colorDecoding", "色彩与解码")))}
        ${colorSettingsShell()}
        <div class="settings-section">
          <div class="settings-group">
          <div class="settings-action-row settings-key-value-row"><h4 id="analysis-concurrency-label">${th(msg('settingsShell.analysisConcurrency', '分析并发数'))}</h4><button id="analysis-concurrency" type="button" class="settings-choice" aria-labelledby="analysis-concurrency-label"></button></div></div>
        </div>
      </section>
      <section id="settings-pane-experimental" role="tabpanel" aria-labelledby="settings-tab-experimental" tabindex="0" hidden>
        <div id="page-bridge-settings" class="settings-mcp" hidden>
          <div class="settings-section">
            <h4 class="settings-section-title">${th(msg('pageBridge.localClient', 'AI 辅助评审'))}</h4>
            <div class="settings-card mcp-intro">
              <div class="mcp-intro-row"><p>${th(msg('pageBridge.purpose', '让电脑上的 AI 助手读取视频标注，跳到你想复查的那一帧。'))}</p>
                <button id="page-bridge-start" type="button" aria-controls="page-bridge-pairing" aria-expanded="false" hidden>${th(msg('pageBridge.startPairing', '配对 AI 助手'))}</button>
              </div>
              <div id="page-bridge-pairing" hidden>
                <label for="page-bridge-code">${th(msg('pageBridge.pairCode', '一次性配对码'))}</label>
                <div class="mcp-pair-row">
                  <input id="page-bridge-code" type="password" autocomplete="off" spellcheck="false" maxlength="32" placeholder="${th(msg('pageBridge.pasteCode','粘贴客户端提供的配对码'))}">
                  <button id="page-bridge-pair" type="button" disabled>${th(msg('pageBridge.pairReview', '核对配对'))}</button>
                  <button id="page-bridge-cancel" type="button">${th(msg('pageBridge.cancelPairing','取消'))}</button>
                </div>
                <button id="page-bridge-help" type="button" aria-controls="page-bridge-guide" aria-expanded="false">${th(msg('pageBridge.findCode', '在哪里获取配对码？'))}</button>
                <div id="page-bridge-guide" class="mcp-pair-guide" hidden>
                  <p>${th(msg('pageBridge.launchHelp', '让 MCP 客户端从 VoidPlayer 源码目录运行这条命令。'))}</p>
                  <code id="page-bridge-command"></code>
                  <p>${th(msg('pageBridge.codeHelp', '从客户端的进程日志（stderr）复制配对码，在 90 秒内粘贴到上方。'))}</p>
                </div>
              </div>
            </div>
          </div>
          <div id="page-bridge-target" class="settings-section" hidden>
            <h4 class="settings-section-title">${th(msg('pageBridge.target', '连接对象'))}</h4>
            <div class="settings-group"><div class="settings-action-row mcp-target">
              <div><h4>${th(msg('pageBridge.clientLabel', 'MCP 客户端'))}</h4><p id="page-bridge-client"></p></div>
              <div><h4>${th(msg('settingsShell.workspace', '工作区'))}</h4><p id="page-bridge-workspace"></p></div>
            </div></div>
            <p class="settings-caption">${th(msg('pageBridge.claim', '客户端名称为自行声明，并非认证身份，仅授权此页面及当前工作区，不跟随其他标签'))}</p>
          </div>
          <div id="page-bridge-permissions" class="settings-section" hidden>
            <h4 class="settings-section-title" id="page-bridge-scopes">${th(msg('pageBridge.scopes', '授权范围'))}</h4>
            <div class="settings-group" role="group" aria-labelledby="page-bridge-scopes">
              <label class="settings-action-row mcp-scope"><span>${th(msg('pageBridge.read', '读取此页面会话、已有标注与 ROI（不含媒体或日志字节）'))}</span><input id="page-bridge-read" type="checkbox"></label>
              <label class="settings-action-row mcp-scope"><span>${th(msg('pageBridge.view', '允许暂停和精确定位此页面'))}</span><input id="page-bridge-view" type="checkbox"></label>
              <label class="settings-action-row mcp-scope"><span>${th(msg('pageBridge.annotate', '允许在已暂停的当前帧创建可见标注'))}</span><input id="page-bridge-annotate" type="checkbox"></label>
            </div>
          </div>
          <div id="page-bridge-actions" class="settings-section" hidden>
            <h4 class="settings-section-title">${th(msg('pageBridge.title', '临时本机 MCP 连接'))}</h4>
            <div class="settings-group"><div class="settings-action-row mcp-controls">
              <button id="page-bridge-connect" type="button" disabled>${th(msg('pageBridge.connect', '明确连接此页面'))}</button>
              <button id="page-bridge-revoke" type="button" disabled>${th(msg('pageBridge.revoke', '撤销连接'))}</button>
              <button id="page-bridge-reset" type="button" hidden>${th(msg('pageBridge.pairReset', '配对其他客户端'))}</button>
            </div></div>
            <p class="settings-caption">${th(msg('pageBridge.lifetime', '授权仅存于当前进程和页面内存，撤销、重载、关页或断线即失效；已经开始的操作可能完成，取消不表示回滚，未知写入不得自动重试'))}</p>
          </div>
          <p id="page-bridge-status" class="settings-caption" role="status"></p>
        </div>
      </section>
      <section id="settings-pane-about" role="tabpanel" aria-labelledby="settings-tab-about" tabindex="0" hidden>
        ${paneTitle(t(msg("settingsShell.about", "关于")))}
        <header class="about-banner">
          ${aboutFrameGraph}<div class="about-ruler" aria-hidden="true"></div>
          <div class="about-banner-copy"><h3>VoidPlayer</h3>
            <p>${th(msg("settingsShell.version", "版本"))} <span id="about-version">${buildInfo?.version ?? t(msg("settingsShell.developmentBuild", "开发版本"))}</span></p>
          </div>
          ${aboutMark}
        </header>
        <div class="settings-section"><div class="about-project settings-group">
          <div id="web-app" class="about-project-row" hidden>
            <span>${th(msg('pwa.webApp', 'Web 应用'))}</span>
            <button id="web-app-install" type="button"></button>
          </div>
          <div class="about-project-row"><span>${th(msg("settingsShell.projectSource", "项目源码"))}</span><a href="https://github.com/Nakiha/VoidPlayer-Web" target="_blank" rel="noopener noreferrer">VoidPlayer-Web ↗</a></div>
          <div class="about-project-row"><span>${th(msg("settingsShell.decoderSource", "解码器源码"))}</span><a href="https://github.com/Nakiha/VoidPlayer-FFmpeg-Build/tree/wasm" target="_blank" rel="noopener noreferrer">VoidPlayer-FFmpeg-Build ↗</a></div>
          <div class="about-project-row"><span>${th(msg("settingsShell.license", "许可证"))}</span><a href="/licenses/voidplayer-web.txt" target="_blank" rel="noopener">LGPL-2.1-or-later</a></div>
        </div>
        </div>
        <section class="settings-section"><h4 class="settings-section-title">${th(msg("settingsShell.openSourceCredits", "开源致谢"))}</h4><div class="settings-detail-body">
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
