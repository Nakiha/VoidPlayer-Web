import { t, th, msg } from '../i18n.ts';
import { settingsShell } from './settings-shell.ts';
import { DEFAULT_ANNOTATION_COLOR } from '../annotation.ts';
import { buildInfo } from '../build-info.ts';
import { SLOTS } from '../model.ts';
import { iconButton } from './controls.ts';
import { icon } from './icons.ts';
import { PANEL_SHORTCUTS, shortcutTooltip } from './shortcuts.ts';
import type { Shortcut } from './shortcuts.ts';
import type { Slot } from '../model.ts';

const panelButton = (id: 'inspector' | 'analysis' | 'subtracks' | 'sources', label: string, glyph: 'info' | 'chart' | 'rows' | 'film', extra = '') =>
  iconButton({ glyph, label, tooltip: shortcutTooltip(label, PANEL_SHORTCUTS[id]), iconClass: extra, attributes: { id: `toggle-${id}`, 'aria-controls': `${id}-panel`, 'aria-expanded': 'false' } });

const startResize = (edge: 'left' | 'right') => `<div id="start-resize-${edge}" class="start-resize" data-edge="${edge}" role="separator" tabindex="0" aria-label="${th(msg("shell.resizeRecent", "调整最近打开列表宽度（{side, select, left {左} other {右}}侧）"), {side:edge})}" aria-orientation="vertical" aria-controls="start-library-list" title="${th(msg("shell.resizeRecentHint", "拖动调整宽度，双击恢复默认"))}"></div>`;

export function shell() {
  const revision = buildInfo?.revision ?? t(msg("settingsShell.developmentBuild", "开发版本"));
  return `<header class="topbar glass">
    <button id="brand-about" class="brand" aria-label="${th(msg("shell.aboutVoidplayer", "关于 VoidPlayer"))}">VoidPlayer</button>
    <div class="view-controls" role="group" aria-label="${th(msg("shell.viewLayout", "视图布局"))}">
      <div class="segmented" id="layout-mode" role="group" aria-label="${th(msg("shell.comparisonLayout", "对比布局"))}"><button type="button" data-mode="side-by-side" data-tooltip="${shortcutTooltip(t(msg("shell.toggleSideBySideSplit", "切换并排 / 分屏")), 'layout')}" aria-pressed="true" disabled>${th(msg("shell.sideBySide", "并排"))}</button><button type="button" data-mode="split" data-tooltip="${shortcutTooltip(t(msg("shell.toggleSideBySideSplit", "切换并排 / 分屏")), 'layout')}" aria-pressed="false" disabled>${th(msg("shell.split", "分屏"))}</button></div>
      ${iconButton({ glyph: 'grid', label: t(msg("shell.switchToGridLayout", "切换为田字布局")), tooltip: t(msg("shell.arrangeTracksInAGrid", "田字排列轨道")), attributes: { id: 'arrangement' } })}
      <button id="reset-view" class="icon-button" aria-label="${th(msg("shell.resetView", "重置视图"))}" title="${th(msg("shell.resetViewCenterAt1", "重置视图：恢复 1× 并居中"))}">${icon('center')}</button>
      <button id="zoom-select" class="choice-trigger" aria-label="${th(msg("shell.zoom", "画面缩放"))}" data-tooltip="${th(msg("shell.zoom", "画面缩放"))}" disabled></button>
      <button id="pixel-size" class="choice-trigger" aria-label="${th(msg("shell.pixelSizeMode", "像素尺寸模式"))}" data-tooltip="${th(msg("shell.pixelSizeMode", "像素尺寸模式"))}" disabled></button>
      <button id="channel-select" class="choice-trigger" aria-label="${th(msg("shell.yuvChannels", "YUV 通道"))}" data-tooltip="${th(msg("shell.yuvChannelsRawYuvFramesOnly", "YUV 通道：仅原始平面帧生效"))}" disabled></button>
    </div>
    <span class="toolbar-spacer"></span>
    <div class="topbar-primary-actions">
      <button id="open" class="add-video" aria-label="${th(msg("shell.addLocalVideo", "添加本地视频"))}">${icon('filePlus')}<span>${th(msg("shell.addLocalVideo", "添加本地视频"))}</span></button>
      <button id="workspace-share" class="add-video" disabled>${icon('export')}<span>${th(msg("shell.share", "分享"))}</span></button>
    </div>
    <div class="topbar-utility-actions"><div class="panel-switches" role="group" aria-label="${th(msg("shell.workspacePanels", "工作区功能"))}">
      <span class="connection-control"><a href="/admin" target="_blank" rel="opener" id="server-status" class="icon-button connection-status" data-state="checking" aria-label="${th(msg("shell.checkingLibraryConnectionOpenServerSettingsNew", "正在检查媒体库连接，打开服务管理（新标签页）"))}" data-tooltip="${th(msg("shell.checkingConnection10OpenServerSettingsNew", "正在检查连接\n打开服务管理（新标签页）"))}"><span class="connection-dot" aria-hidden="true"></span></a></span>
      ${panelButton('inspector', t(msg("shell.trackInfo", "轨道信息")), 'info')}${panelButton('analysis', t(msg("shell.bitstreamAnalysis", "码流分析")), 'chart')}${panelButton('subtracks', t(msg("shell.tracks", "子轨道")), 'rows')}${panelButton('sources', t(msg("shell.sources", "片源")), 'film')}
    </div>
    <button id="settings-open" class="icon-button" aria-label="${th(msg("shell.settings", "设置"))}" data-tooltip="${shortcutTooltip(t(msg("shell.openSettings", "打开设置")), 'settings')}" aria-haspopup="dialog" aria-controls="settings" aria-expanded="false">${icon('settings')}</button></div>
  </header>
<output id="subtrack-preview" class="seek-preview" hidden></output><dialog id="replace-source-dialog" aria-labelledby="replace-source-title"><header class="dialog-heading"><h2 id="replace-source-title">${th(msg("shell.chooseAViewToReplace", "选择要替换的视图"))}</h2><button id="replace-source-close" class="icon-button" aria-label="${th(msg("shell.cancelAdding", "取消添加"))}">${icon('close')}</button></header><p id="replace-source-name"></p><div id="replace-source-targets"></div></dialog>
  <main>
    <div class="workspace" id="workspace"><div id="sources-resize" class="side-resize" hidden role="separator" tabindex="0" aria-label="${th(msg("shell.resizeSourcesPanel", "调整片源宽度"))}" aria-orientation="vertical" aria-controls="sources-panel"></div><div id="inspector-resize" class="side-resize" hidden role="separator" tabindex="0" aria-label="${th(msg("shell.resizeTrackInfoPanel", "调整轨道信息宽度"))}" aria-orientation="vertical" aria-controls="inspector-panel"></div>
      <aside id="inspector-panel" class="side-panel inspector-panel glass" aria-label="${th(msg("shell.trackInfo", "轨道信息"))}" hidden>
        <header class="panel-heading"><h2>${th(msg("shell.track", "轨道"))}</h2><button data-close-panel="inspector" class="icon-button" aria-label="${th(msg("shell.collapseTrackInfo", "收起轨道信息"))}">${icon('sidebar')}</button></header>
        <div id="track-selector" class="track-selector" role="group" aria-label="${th(msg("shell.selectTrackToInspect", "选择检查轨道"))}"></div>
        <div id="track-properties" class="track-properties"></div>
      </aside>
      <section id="analysis-panel" class="analysis-panel" aria-label="${th(msg("shell.bitstreamAnalysis", "码流分析"))}" hidden>
        <div id="analysis-resize" class="analysis-resize" role="separator" tabindex="0" aria-label="${th(msg("shell.resizeBitstreamAnalysis", "调整码流分析高度"))}" aria-orientation="horizontal" aria-valuemin="140" aria-valuemax="420" aria-valuenow="220"></div>
      </section>
      <section class="comparison" aria-label="${th(msg("shell.videoComparison", "视频对比"))}">
        <div class="viewport-surface"><div class="screens">${SLOTS.map(slot => `
          <article class="video-card" data-slot="${slot}"><div class="card-heading" data-track-drag="${slot}">
            <button class="track-identity" data-inspect="${slot}" data-drag-surface="${slot}" aria-label="${th(msg("shell.inspectTrack", "检查轨道 {p4}"), { p4: slot })}"><span class="slot slot-${slot}">${slot}</span><span id="name-${slot}" class="filename"></span></button>
            <output id="pts-${slot}" class="frame-time" aria-label="${th(msg("shell.videoCurrentFrameTime", "视频 {p9} 当前帧时间"), { p9: slot })}">—</output>${iconButton({ glyph: 'more', label: t(msg("shell.trackActions", "轨道 {p0} 操作"), { p0: slot }), tooltip: t(msg("shell.trackActions2", "轨道操作")), className: 'header-more', attributes: { id: `header-more-${slot}`, 'aria-expanded': 'false', 'aria-controls': `header-actions-${slot}`, hidden: '' } })}<div class="header-actions" id="header-actions-${slot}">
              ${iconButton({ glyph: 'copy', label: t(msg("shell.copyTrackAbsolutePath", "拷贝轨道 {p0} 绝对路径"), { p0: slot }), tooltip: t(msg("sourceActions.copyAbsolutePath", "拷贝绝对路径")), attributes: { id: `copy-path-${slot}` } })}
              ${iconButton({ glyph: 'open', label: t(msg("shell.locateTrackFile", "定位轨道 {p0} 文件"), { p0: slot }), tooltip: t(msg("shell.locateFile", "定位文件")), attributes: { id: `source-action-${slot}` } })}
              ${iconButton({ glyph: 'close', label: t(msg("shell.closeTrack", "关闭轨道 {p0}"), { p0: slot }), tooltip: t(msg("shell.closeTrack2", "关闭轨道")), className: 'remove-track', attributes: { id: `remove-track-${slot}` } })}
            </div><input id="file-${slot}" type="file" accept="video/*,.mkv,.mov,.mp4,.webm,.ts,.avi,.flv" aria-label="${th(msg("shell.openVideo", "打开视频 {p16}"), { p16: slot })}" hidden></div>
          <div class="frame-stage" id="stage-${slot}"><canvas id="grid-${slot}" class="pixel-grid" aria-hidden="true" hidden></canvas><span id="grid-label-${slot}" class="pixel-grid-label" hidden></span><div class="empty" id="empty-${slot}">${slot === 'A' ? `<section id="start-panel" class="start-panel" aria-label="${th(msg("shell.recentlyOpened", "最近打开"))}">${startResize('left')}${startResize('right')}<header class="start-header"><h3>${th(msg("shell.recentlyOpened", "最近打开"))}</h3><button id="start-identity" class="start-identity" type="button"></button><button id="start-library-more" class="add-video" aria-label="${th(msg("shell.browseLibrary", "浏览媒体库"))}">${icon('sidebar', 'mirror')}<span>${th(msg("shell.browseLibrary", "浏览媒体库"))}</span></button></header><div id="start-workspace-recovery" hidden></div><div id="start-library-list"></div><footer class="start-version"><button id="start-version-about" type="button" aria-label="${th(msg("shell.startVersionAbout", "当前构建 {revision}，打开关于页面"), { revision })}">VoidPlayer · ${revision}</button></footer></section>` : `<label class="empty-open" for="file-${slot}">${icon('filePlus')}<span>${th(msg("shell.addLocalVideo", "添加本地视频"))}</span></label><span class="empty-hint">${th(msg("shell.orDropFilesHere", "或将文件拖入这里"))}</span>`}</div><div id="image-${slot}" class="image-wrap" hidden><canvas id="canvas-${slot}" aria-label="${th(msg("shell.videoDecodedFrame", "视频 {p24} 当前解码画面"), { p24: slot })}"></canvas></div><div id="failure-${slot}" class="track-failure" role="status" hidden></div><svg id="annotations-${slot}" class="frame-annotations" aria-hidden="true"></svg><svg id="drawing-${slot}" class="drawing-layer" aria-label="${th(msg("shell.editAnnotationsForVideo", "编辑视频 {p28} 的标注"), { p28: slot })}" tabindex="0" hidden></svg><button id="recover-${slot}" class="recover-view" aria-label="${th(msg("shell.centerTrackKeepingZoom", "居中轨道 {p30} 画面，保留倍率"), { p30: slot })}" hidden>${icon('center')}${th(msg("shell.viewIsOffscreenCenter", "画面已移出 · 居中"))}</button></div>
          <div class="card-footer"><span id="meta-${slot}"></span></div></article>`).join('')}
          <div id="divider" role="slider" aria-label="${th(msg("shell.splitPosition", "分割线位置"))}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="50" tabindex="0" hidden><div class="divider-line"></div><div class="divider-grip" aria-hidden="true"></div></div>
          <section id="tracks-hidden" class="tracks-hidden" aria-labelledby="tracks-hidden-title" hidden>
            <div class="tracks-hidden-content">
              ${icon('eyeClosed', 'tracks-hidden-icon')}
              <h2 id="tracks-hidden-title">${th(msg("shell.tracksHiddenTitle", "所有轨道已隐藏"))}</h2>
              <p>${th(msg("shell.tracksHiddenHint", "点击轨道旁的眼睛图标，或显示所有轨道以继续查看。"))}</p>
              <button id="show-all-tracks">${icon('eye')}<span>${th(msg("shell.showAllTracks", "显示所有轨道"))}</span></button>
            </div>
          </section>
        </div>

        <section class="transport glass" aria-label="${th(msg("shell.sharedPlaybackControls", "共用播放控制"))}" hidden>
          <div class="transport-actions" role="group" aria-label="${th(msg("shell.playbackControls", "播放功能"))}">
            <div class="play-buttons"><button class="icon-button" id="previous" data-tooltip="${shortcutTooltip(t(msg("shell.previousFrame", "上一帧")), 'previous')}" aria-label="${th(msg("shell.previousFrame", "上一帧"))}" disabled>${icon('previous')}</button><button class="icon-button" id="play" data-playing="false" aria-label="${th(msg("shell.play", "播放"))}" data-tooltip="${shortcutTooltip(t(msg("shell.playPause", "播放 / 暂停")), 'play')}" disabled>${icon('play')}${icon('pause')}</button><button class="icon-button" id="next" data-tooltip="${shortcutTooltip(t(msg("shell.nextFrame", "下一帧")), 'next')}" aria-label="${th(msg("shell.nextFrame", "下一帧"))}" disabled>${icon('next')}</button></div>
            <div class="transport-time"><input id="position" class="time-input" type="text" aria-label="${th(msg("shell.seekToTime", "定位时间"))}" autocomplete="off" spellcheck="false" value="00:00.000" disabled><span class="duration"><span aria-hidden="true">/</span><span id="duration">00:00.000</span></span></div>
          <div class="timeline-control"><input id="timeline" type="range" min="0" max="1" step="1" value="0" aria-label="${th(msg("shell.sharedTimelineMicroseconds", "共用时间轴，微秒"))}" disabled><span class="timeline-playhead" aria-hidden="true"></span><span id="timeline-hover" class="timeline-hover" aria-hidden="true" hidden></span><output id="timeline-preview" class="seek-preview" hidden></output></div>
            <button id="fullscreen" class="icon-button" aria-label="${th(msg("shell.fullscreen", "全屏"))}" title="${th(msg("shell.fullscreen", "全屏"))}">${icon('fit')}</button>
          </div><span id="status" class="sr-only" role="status"></span>
        </section>
        ${iconButton({ glyph: 'focus', label: t(msg("shell.focusMode", "专注模式")), tooltip: shortcutTooltip(t(msg("shell.focusMode", "专注模式")), 'focusMode'), className: 'viewport-eye', attributes: { id: 'toggle-chrome', 'aria-pressed': 'false', hidden: '' } })}

<section id="annotation-toolbar" class="annotation-toolbar" aria-label="${th(msg("shell.annotationToolbar", "标注工具条"))}" hidden>
  <div class="drawing-tools" role="toolbar" aria-label="${th(msg("shell.annotationTools", "标注工具"))}">
    <button id="drawing-grip" class="icon-button" aria-label="${th(msg("shell.dragToolbar", "拖动工具条"))}" data-tooltip="${th(msg("shell.dragToolbar", "拖动工具条"))}">${icon('grip')}</button>
    ${([['select',t(msg("shell.selectMove", "选择 / 移动"))],['pen',t(msg("shell.pen", "画笔"))],['ellipse',t(msg("shell.ellipse", "椭圆"))],['rect',t(msg("shell.rectangle", "矩形"))],['line',t(msg("shell.line", "线条"))],['text',t(msg("shell.text", "文字"))],['eraser',t(msg("shell.eraser", "橡皮擦"))]] as const).map(([tool,label]) => `<button type="button" data-drawing-tool="${tool}" class="icon-button" aria-label="${label}" data-tooltip="${shortcutTooltip(label, tool as Shortcut)}" aria-pressed="false">${icon(tool)}</button>`).join('')}
    <span class="drawing-divider"></span>
    <input id="drawing-color" type="hidden" value="${DEFAULT_ANNOTATION_COLOR}"><button id="drawing-color-choice" class="icon-button" aria-label="${th(msg("shell.annotationColor", "标注颜色"))}" data-tooltip="${th(msg("shell.annotationColor", "标注颜色"))}"></button>
    <input id="drawing-width" type="hidden" value="4"><button id="drawing-width-choice" class="choice-trigger" aria-label="${th(msg("shell.strokeWidth", "笔画粗细"))}" data-tooltip="${th(msg("shell.strokeWidth", "笔画粗细"))}"></button>
    <input id="drawing-font" type="hidden" value="24"><button id="drawing-font-choice" class="choice-trigger" aria-label="${th(msg("shell.textSize", "文字大小"))}" data-tooltip="${th(msg("shell.textSize", "文字大小"))}"></button>
    <span class="drawing-divider"></span>
    <button id="drawing-undo" class="icon-button" aria-label="${th(msg("shell.undo", "撤销"))}" data-tooltip="${shortcutTooltip(t(msg("shell.undo", "撤销")), 'undo')}">${icon('undo')}</button>
    <button id="drawing-redo" class="icon-button" aria-label="${th(msg("shell.redo", "重做"))}" data-tooltip="${shortcutTooltip(t(msg("shell.redo", "重做")), 'redo')}">${icon('redo')}</button>
    <button id="drawing-delete" class="icon-button" aria-label="${th(msg("shell.deleteSelection", "删除选中对象"))}" data-tooltip="${shortcutTooltip(t(msg("shell.deleteSelection", "删除选中对象")), 'delete')}">${icon('trash')}</button>
    <button id="mark-close" class="icon-button" aria-label="${th(msg("shell.finishAnnotating", "结束标注"))}" data-tooltip="${shortcutTooltip(t(msg("shell.finishAnnotating", "结束标注")), 'close')}">${icon('close')}</button>
  </div>
  <output id="drawing-status" class="sr-only" aria-live="polite">${th(msg("shell.recorded", "已记录"))}</output>
  <p id="drawing-error" role="alert" hidden></p>
</section>
      </div>
      </section>
      <aside id="sources-panel" class="side-panel sources-panel glass" aria-label="${th(msg("shell.sources", "片源"))}" hidden>
        <div class="source-tools" id="source-tools"></div>
        <div id="source-list" class="source-list"></div>
        <div id="source-scrollbar" class="source-scrollbar" aria-hidden="true"><span id="source-scrollbar-thumb"></span></div>
        <div class="source-foot" id="source-foot">
        <section id="local-sources" class="local-sources" aria-label="${th(msg("shell.localFiles", "本地文件"))}"><h3 class="source-section"><span id="local-sources-heading">${th(msg("shell.localFiles", "本地文件"))}</span><button id="local-add" class="icon-button" aria-label="${th(msg("shell.chooseLocalFiles", "选择本地文件"))}" data-tooltip="${th(msg("shell.addLocalFilesToTheListLocal", "选择本地文件加入列表（仅本机预览，不上传）"))}">${icon('filePlus')}</button></h3><div id="local-list"></div></section>
        <section id="source-activity" class="source-activity" aria-label="${th(msg("shell.sourceLoadingStatus", "片源载入状态"))}" data-state="idle">
          <div class="source-activity-heading"><span id="source-activity-stage" role="status" aria-live="polite" aria-atomic="true">${th(msg("shell.waitingForASource", "等待添加片源"))}</span><button id="source-activity-cancel" hidden>${th(msg("shell.cancel", "取消"))}</button></div>
          <div id="source-activity-name" class="source-activity-name" hidden></div>
          <div class="source-activity-meter" aria-hidden="true"><span></span></div>
          <div class="source-activity-meta"><span id="source-activity-time"></span><span id="source-activity-hint"></span></div>
        </section>
        </div>
        <input id="source-files" type="file" multiple accept="video/*,.mkv,.mov,.mp4,.webm,.ts,.avi,.flv" hidden>
      </aside>
      <section id="subtracks-panel" class="subtracks-panel marks-collapsed" aria-label="${th(msg("shell.tracks", "子轨道"))}" hidden>
        <div id="dock-resize" class="dock-resize" role="separator" tabindex="0" aria-label="${th(msg("shell.resizeTracksPanel", "调整子轨道高度"))}" aria-orientation="horizontal" aria-valuemin="128" aria-valuemax="420" aria-valuenow="180"></div>

        <div class="subtrack-scroll"><div class="subtrack-columns"><span class="subtrack-name-heading">${th(msg("shell.track", "轨道"))}<span id="track-label-resize" role="separator" tabindex="0" aria-label="${th(msg("shell.resizeFilenameColumn", "调整文件名列宽度"))}" aria-orientation="vertical"></span></span><span class="track-offset">${th(msg("shell.offset", "偏移"))}</span><div id="subtrack-ruler" class="subtrack-ruler" aria-label="${th(msg("shell.timeRuler", "时间标尺"))}"></div><span></span></div><div id="subtrack-list"></div></div>
        <aside class="annotation-strip" aria-label="${th(msg("shell.allTrackAnnotations", "所有轨道标注"))}">
          <div class="annotation-strip-tools"><button id="toggle-marks" class="icon-button" aria-label="${th(msg("shell.showAnnotationCards", "显示标注卡片"))}" aria-expanded="false" aria-controls="selected-marks" title="${th(msg("shell.showAnnotationCards", "显示标注卡片"))}">${icon('grid')}</button><button id="subtrack-add-mark" class="icon-button" aria-label="${th(msg("shell.addAnnotation", "添加标注"))}" title="${th(msg("shell.addAnnotation", "添加标注"))}">${icon('plusRegular')}</button></div>
          <div id="selected-marks" class="selected-marks" aria-label="${th(msg("shell.annotations", "标注"))}"></div>
        </aside>
      </section>
    </div>
  </main>


  <input id="workspace-file" type="file" accept=".voidplayer,.json,.gz" hidden>
  ${settingsShell()}`;
}
