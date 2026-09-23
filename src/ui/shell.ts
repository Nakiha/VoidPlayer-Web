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

export function shell() {
  const revision = buildInfo?.revision ?? '开发版本';
  return `<header class="topbar glass">
    <button id="brand-about" class="brand" aria-label="关于 VoidPlayer">VoidPlayer</button>
    <div class="view-controls" role="group" aria-label="视图布局">
      <div class="segmented" id="layout-mode" role="group" aria-label="对比布局"><button type="button" data-mode="side-by-side" data-tooltip="${shortcutTooltip('切换并排 / 分屏', 'layout')}" aria-pressed="true" disabled>并排</button><button type="button" data-mode="split" data-tooltip="${shortcutTooltip('切换并排 / 分屏', 'layout')}" aria-pressed="false" disabled>分屏</button></div>
      ${iconButton({ glyph: 'grid', label: '切换为田字布局', tooltip: '田字排列轨道', attributes: { id: 'arrangement' } })}
      <button id="reset-view" class="icon-button" aria-label="重置视图" title="重置视图：恢复 1× 并居中">${icon('center')}</button>
      <button id="zoom-select" class="choice-trigger" aria-label="画面缩放" data-tooltip="画面缩放" disabled></button>
      <button id="pixel-size" class="choice-trigger" aria-label="像素尺寸模式" data-tooltip="像素尺寸模式" disabled></button>
      <button id="channel-select" class="choice-trigger" aria-label="YUV 通道" data-tooltip="YUV 通道：仅原始平面帧生效" disabled></button>
    </div>
    <span class="toolbar-spacer"></span>
    <div class="topbar-primary-actions">
      <button id="open" class="add-video" aria-label="添加本地视频">${icon('filePlus')}<span>添加本地视频</span></button>
      <button id="workspace-share" class="add-video" disabled>${icon('export')}<span>分享</span></button>
    </div>
    <div class="topbar-utility-actions"><div class="panel-switches" role="group" aria-label="工作区功能">
      <span class="connection-control"><a href="/admin" target="_blank" rel="opener" id="server-status" class="icon-button connection-status" data-state="checking" aria-label="正在检查媒体库连接，打开服务管理（新标签页）" data-tooltip="正在检查连接&#10;打开服务管理（新标签页）"><span class="connection-dot" aria-hidden="true"></span></a></span>
      ${panelButton('inspector', '轨道信息', 'info')}${panelButton('analysis', '码流分析', 'chart')}${panelButton('subtracks', '子轨道', 'rows')}${panelButton('sources', '片源', 'film')}
    </div>
    <button id="settings-open" class="icon-button" aria-label="设置" data-tooltip="${shortcutTooltip('打开设置', 'settings')}" aria-haspopup="dialog" aria-controls="settings" aria-expanded="false">${icon('settings')}</button></div>
  </header>
<output id="subtrack-preview" class="seek-preview" hidden></output><dialog id="replace-source-dialog" aria-labelledby="replace-source-title"><header class="dialog-heading"><h2 id="replace-source-title">选择要替换的视图</h2><button id="replace-source-close" class="icon-button" aria-label="取消添加">${icon('close')}</button></header><p id="replace-source-name"></p><div id="replace-source-targets"></div></dialog>
  <main>
    <div class="workspace" id="workspace"><div id="sources-resize" class="side-resize" hidden role="separator" tabindex="0" aria-label="调整片源宽度" aria-orientation="vertical" aria-controls="sources-panel"></div><div id="inspector-resize" class="side-resize" hidden role="separator" tabindex="0" aria-label="调整轨道信息宽度" aria-orientation="vertical" aria-controls="inspector-panel"></div>
      <aside id="inspector-panel" class="side-panel inspector-panel glass" aria-label="轨道信息" hidden>
        <header class="panel-heading"><h2>轨道</h2><button data-close-panel="inspector" class="icon-button" aria-label="收起轨道信息">${icon('sidebar')}</button></header>
        <div id="track-selector" class="track-selector" role="group" aria-label="选择检查轨道"></div>
        <div id="track-properties" class="track-properties"></div>
      </aside>
      <section id="analysis-panel" class="analysis-panel" aria-label="码流分析" hidden>
        <div id="analysis-resize" class="analysis-resize" role="separator" tabindex="0" aria-label="调整码流分析高度" aria-orientation="horizontal" aria-valuemin="140" aria-valuemax="420" aria-valuenow="220"></div>
      </section>
      <section class="comparison" aria-label="视频对比">
        <div class="viewport-surface"><div class="screens">${SLOTS.map(slot => `
          <article class="video-card" data-slot="${slot}"><div class="card-heading" data-track-drag="${slot}">
            <button class="track-identity" data-inspect="${slot}" data-drag-surface="${slot}" aria-label="检查轨道 ${slot}"><span class="slot slot-${slot}">${slot}</span><span id="name-${slot}" class="filename"></span></button>
            <output id="pts-${slot}" class="frame-time" aria-label="视频 ${slot} 当前帧时间">—</output>${iconButton({ glyph: 'more', label: `轨道 ${slot} 操作`, tooltip: '轨道操作', className: 'header-more', attributes: { id: `header-more-${slot}`, 'aria-expanded': 'false', 'aria-controls': `header-actions-${slot}`, hidden: '' } })}<div class="header-actions" id="header-actions-${slot}">
              ${iconButton({ glyph: 'copy', label: `拷贝轨道 ${slot} 绝对路径`, tooltip: '拷贝绝对路径', attributes: { id: `copy-path-${slot}` } })}
              ${iconButton({ glyph: 'open', label: `定位轨道 ${slot} 文件`, tooltip: '定位文件', attributes: { id: `source-action-${slot}` } })}
              ${iconButton({ glyph: 'close', label: `关闭轨道 ${slot}`, tooltip: '关闭轨道', className: 'remove-track', attributes: { id: `remove-track-${slot}` } })}
            </div><input id="file-${slot}" type="file" accept="video/*,.mkv,.mov,.mp4,.webm,.ts,.avi,.flv" aria-label="打开视频 ${slot}" hidden></div>
          <div class="frame-stage" id="stage-${slot}"><canvas id="grid-${slot}" class="pixel-grid" aria-hidden="true" hidden></canvas><span id="grid-label-${slot}" class="pixel-grid-label" hidden></span><div class="empty" id="empty-${slot}">${slot === 'A' ? `<section class="start-panel" aria-label="最近打开"><header class="start-header"><h3>最近打开</h3><span id="start-identity" class="start-identity"></span><button id="start-library-more" class="add-video" aria-label="浏览媒体库">${icon('sidebar', 'mirror')}<span>浏览媒体库</span></button></header><div id="start-workspace-recovery" hidden></div><div id="start-library-list"></div><footer class="start-version"><button id="start-version-about" type="button" aria-label="当前构建 ${revision}，打开关于页面">VoidPlayer · ${revision}</button></footer></section>` : `<label class="empty-open" for="file-${slot}">${icon('filePlus')}<span>添加本地视频</span></label><span class="empty-hint">或将文件拖入这里</span>`}</div><div id="image-${slot}" class="image-wrap" hidden><canvas id="canvas-${slot}" aria-label="视频 ${slot} 当前解码画面"></canvas></div><div id="failure-${slot}" class="track-failure" role="status" hidden></div><svg id="annotations-${slot}" class="frame-annotations" aria-hidden="true"></svg><svg id="drawing-${slot}" class="drawing-layer" aria-label="编辑视频 ${slot} 的标注" tabindex="0" hidden></svg><button id="recover-${slot}" class="recover-view" aria-label="居中轨道 ${slot} 画面，保留倍率" hidden>${icon('center')}画面已移出 · 居中</button></div>
          <div class="card-footer"><span id="meta-${slot}"></span></div></article>`).join('')}
          <section id="tracks-hidden" class="tracks-hidden" aria-labelledby="tracks-hidden-title" hidden>
            <div class="tracks-hidden-content">
              ${icon('eyeClosed', 'tracks-hidden-icon')}
              <h2 id="tracks-hidden-title">所有轨道已隐藏</h2>
              <p>点击轨道旁的眼睛图标，或显示所有轨道以继续查看。</p>
              <button id="show-all-tracks">${icon('eye')}<span>显示所有轨道</span></button>
            </div>
          </section>
          <div id="divider" role="slider" aria-label="分割线位置" aria-valuemin="0" aria-valuemax="100" aria-valuenow="50" tabindex="0" hidden><div class="divider-line"></div><div class="divider-grip" aria-hidden="true"></div></div>
        </div>

        <section class="transport glass" aria-label="共用播放控制" hidden>
          <div class="transport-actions" role="group" aria-label="播放功能">
            <div class="play-buttons"><button class="icon-button" id="previous" data-tooltip="${shortcutTooltip('上一帧', 'previous')}" aria-label="上一帧" disabled>${icon('previous')}</button><button class="icon-button" id="play" data-playing="false" aria-label="播放" data-tooltip="${shortcutTooltip('播放 / 暂停', 'play')}" disabled>${icon('play')}${icon('pause')}</button><button class="icon-button" id="next" data-tooltip="${shortcutTooltip('下一帧', 'next')}" aria-label="下一帧" disabled>${icon('next')}</button></div>
            <div class="transport-time"><input id="position" class="time-input" type="text" aria-label="定位时间" autocomplete="off" spellcheck="false" value="00:00.000" disabled><span class="duration"><span aria-hidden="true">/</span><span id="duration">00:00.000</span></span></div>
          <div class="timeline-control"><input id="timeline" type="range" min="0" max="1" step="1" value="0" aria-label="共用时间轴，微秒" disabled><span class="timeline-playhead" aria-hidden="true"></span><span id="timeline-hover" class="timeline-hover" aria-hidden="true" hidden></span><output id="timeline-preview" class="seek-preview" hidden></output></div>
            <button id="fullscreen" class="icon-button" aria-label="全屏" title="全屏">${icon('fit')}</button>
          </div><span id="status" class="sr-only" role="status"></span>
        </section>
        ${iconButton({ glyph: 'focus', label: '专注模式', tooltip: '专注模式', className: 'viewport-eye', attributes: { id: 'toggle-chrome', 'aria-pressed': 'false', hidden: '' } })}

<section id="annotation-toolbar" class="annotation-toolbar" aria-label="标注工具条" hidden>
  <div class="drawing-tools" role="toolbar" aria-label="标注工具">
    <button id="drawing-grip" class="icon-button" aria-label="拖动工具条" data-tooltip="拖动工具条">${icon('grip')}</button>
    ${([['select','选择 / 移动'],['pen','画笔'],['ellipse','椭圆'],['rect','矩形'],['line','线条'],['text','文字'],['eraser','橡皮擦']] as const).map(([tool,label]) => `<button type="button" data-drawing-tool="${tool}" class="icon-button" aria-label="${label}" data-tooltip="${shortcutTooltip(label, tool as Shortcut)}" aria-pressed="false">${icon(tool)}</button>`).join('')}
    <span class="drawing-divider"></span>
    <input id="drawing-color" type="hidden" value="${DEFAULT_ANNOTATION_COLOR}"><button id="drawing-color-choice" class="icon-button" aria-label="标注颜色" data-tooltip="标注颜色"></button>
    <input id="drawing-width" type="hidden" value="4"><button id="drawing-width-choice" class="choice-trigger" aria-label="笔画粗细" data-tooltip="笔画粗细"></button>
    <input id="drawing-font" type="hidden" value="24"><button id="drawing-font-choice" class="choice-trigger" aria-label="文字大小" data-tooltip="文字大小"></button>
    <span class="drawing-divider"></span>
    <button id="drawing-undo" class="icon-button" aria-label="撤销" data-tooltip="${shortcutTooltip('撤销', 'undo')}">${icon('undo')}</button>
    <button id="drawing-redo" class="icon-button" aria-label="重做" data-tooltip="${shortcutTooltip('重做', 'redo')}">${icon('redo')}</button>
    <button id="drawing-delete" class="icon-button" aria-label="删除选中对象" data-tooltip="${shortcutTooltip('删除选中对象', 'delete')}">${icon('trash')}</button>
    <button id="mark-close" class="icon-button" aria-label="结束标注" data-tooltip="${shortcutTooltip('结束标注', 'close')}">${icon('close')}</button>
  </div>
  <output id="drawing-status" class="sr-only" aria-live="polite">已记录</output>
  <p id="drawing-error" role="alert" hidden></p>
</section>
      </div>
      </section>
      <aside id="sources-panel" class="side-panel sources-panel glass" aria-label="片源" hidden>
        <div class="source-tools" id="source-tools"></div>
        <div id="source-list" class="source-list"></div>
        <div id="source-scrollbar" class="source-scrollbar" aria-hidden="true"><span id="source-scrollbar-thumb"></span></div>
        <div class="source-foot" id="source-foot">
        <section id="local-sources" class="local-sources" aria-label="本地文件"><h3 class="source-section"><span id="local-sources-heading">本地文件</span><button id="local-add" class="icon-button" aria-label="选择本地文件" data-tooltip="选择本地文件加入列表（仅本机预览，不上传）">${icon('filePlus')}</button></h3><div id="local-list"></div></section>
        <section id="source-activity" class="source-activity" aria-label="片源载入状态" data-state="idle">
          <div class="source-activity-heading"><span id="source-activity-stage" role="status" aria-live="polite" aria-atomic="true">等待添加片源</span><button id="source-activity-cancel" hidden>取消</button></div>
          <div id="source-activity-name" class="source-activity-name" hidden></div>
          <div class="source-activity-meter" aria-hidden="true"><span></span></div>
          <div class="source-activity-meta"><span id="source-activity-time"></span><span id="source-activity-hint"></span></div>
        </section>
        </div>
        <input id="source-files" type="file" multiple accept="video/*,.mkv,.mov,.mp4,.webm,.ts,.avi,.flv" hidden>
      </aside>
      <section id="subtracks-panel" class="subtracks-panel marks-collapsed" aria-label="子轨道" hidden>
        <div id="dock-resize" class="dock-resize" role="separator" tabindex="0" aria-label="调整子轨道高度" aria-orientation="horizontal" aria-valuemin="128" aria-valuemax="420" aria-valuenow="180"></div>

        <div class="subtrack-scroll"><div class="subtrack-columns"><span class="subtrack-name-heading">轨道<span id="track-label-resize" role="separator" tabindex="0" aria-label="调整文件名列宽度" aria-orientation="vertical"></span></span><span class="track-offset">偏移</span><div id="subtrack-ruler" class="subtrack-ruler" aria-label="时间标尺"></div><span></span></div><div id="subtrack-list"></div></div>
        <aside class="annotation-strip" aria-label="所有轨道标注">
          <div class="annotation-strip-tools"><button id="toggle-marks" class="icon-button" aria-label="显示标注卡片" aria-expanded="false" aria-controls="selected-marks" title="显示标注卡片">${icon('grid')}</button><button id="subtrack-add-mark" class="icon-button" aria-label="添加标注" title="添加标注">${icon('plusRegular')}</button></div>
          <div id="selected-marks" class="selected-marks" aria-label="标注"></div>
        </aside>
      </section>
    </div>
  </main>


  <input id="workspace-file" type="file" accept=".voidplayer,.json,.gz" hidden>
  ${settingsShell()}`;
}
