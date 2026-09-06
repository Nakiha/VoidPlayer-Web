import { DEFAULT_ANNOTATION_COLOR } from '../annotation.ts';
import { SLOTS } from '../model.ts';
import { iconButton } from './controls.ts';
import { icon } from './icons.ts';
import type { Slot } from '../model.ts';

const panelButton = (id: string, label: string, glyph: 'sidebar' | 'rows', extra = '') =>
  iconButton({ glyph, label, iconClass: extra, attributes: { id: `toggle-${id}`, 'aria-controls': `${id}-panel`, 'aria-expanded': 'false' } });

export function shell() {
  return `<header class="topbar glass">
    <span class="brand">VoidPlayer</span>
    <div class="view-controls" role="group" aria-label="视图布局">
      <div class="segmented" id="layout-mode" role="group" aria-label="对比布局"><button type="button" data-mode="side-by-side" aria-pressed="true" disabled>并排</button><button type="button" data-mode="split" aria-pressed="false" disabled>分屏</button></div>
      ${iconButton({ glyph: 'grid', label: '切换为田字布局', tooltip: '田字排列轨道', attributes: { id: 'arrangement' } })}
      <button id="reset-view" class="icon-button" aria-label="重置视图" title="重置视图：恢复 1× 并居中">${icon('center')}</button>
      <button id="zoom-select" class="choice-trigger" aria-label="画面缩放" data-tooltip="画面缩放" disabled></button>
      <button id="pixel-size" class="choice-trigger" aria-label="像素尺寸模式" data-tooltip="像素尺寸模式" disabled></button>
    </div>
    <span class="toolbar-spacer"></span>
    <button id="open" class="add-video" aria-label="添加视频">${icon('filePlus')}<span>添加视频</span></button>
    <div class="panel-switches" role="group" aria-label="工作区功能">
      <span class="connection-control"><button id="server-status" class="icon-button connection-status" data-state="checking" aria-label="正在检查媒体库连接" data-tooltip="媒体库连接：正在检查…"><span class="connection-dot" aria-hidden="true"></span></button></span>
      ${panelButton('inspector', '轨道检查', 'sidebar')}${panelButton('subtracks', '子轨道', 'rows')}${panelButton('sources', '片源', 'sidebar', 'mirror')}
    </div>
    <button id="more-actions" class="icon-button" aria-label="更多操作">${icon('more')}</button><div id="more-actions-menu" class="action-menu" popover="auto">
      <button role="menuitem" id="export" disabled>${icon('export')}导出评审</button><button role="menuitem" id="export-log">${icon('rows')}诊断日志</button><button role="menuitem" id="help-open">${icon('more')}快捷键与说明</button>
    </div>
  </header>
<output id="subtrack-preview" class="seek-preview" hidden></output><dialog id="replace-source-dialog" aria-labelledby="replace-source-title"><header class="dialog-heading"><h2 id="replace-source-title">选择要替换的视图</h2><button id="replace-source-close" aria-label="取消添加">${icon('close')}</button></header><p id="replace-source-name"></p><div id="replace-source-targets"></div></dialog>
  <main><div id="notice" role="alert" hidden></div>
    <div class="workspace" id="workspace"><div id="sources-resize" class="side-resize" hidden role="separator" tabindex="0" aria-label="调整片源宽度" aria-orientation="vertical" aria-controls="sources-panel"></div><div id="inspector-resize" class="side-resize" hidden role="separator" tabindex="0" aria-label="调整轨道检查宽度" aria-orientation="vertical" aria-controls="inspector-panel"></div>
      <aside id="inspector-panel" class="side-panel inspector-panel glass" aria-label="轨道检查" hidden>
        <header class="panel-heading"><h2>轨道</h2><button data-close-panel="inspector" class="icon-button" aria-label="收起轨道检查">${icon('sidebar')}</button></header>
        <div id="track-selector" class="track-selector" role="group" aria-label="选择检查轨道"></div>
        <div id="track-properties" class="track-properties"></div>
      </aside>
      <section class="comparison" aria-label="视频对比">
        <div class="viewport-surface"><div class="screens">${SLOTS.map(slot => `
          <article class="video-card" data-slot="${slot}"><div class="card-heading" data-track-drag="${slot}">
            <button class="track-identity" data-inspect="${slot}" data-drag-surface="${slot}" aria-label="检查轨道 ${slot}"><span class="slot slot-${slot}">${slot}</span><span id="name-${slot}" class="filename"></span></button>
            <output id="pts-${slot}" class="frame-time" aria-label="视频 ${slot} 当前帧时间">—</output>${iconButton({ glyph: 'more', label: `轨道 ${slot} 操作`, tooltip: '轨道操作', className: 'header-more', attributes: { id: `header-more-${slot}`, 'aria-expanded': 'false', 'aria-controls': `header-actions-${slot}`, hidden: '' } })}<div class="header-actions" id="header-actions-${slot}">
              ${iconButton({ glyph: 'copy', label: `拷贝轨道 ${slot} 绝对路径`, tooltip: '拷贝绝对路径', attributes: { id: `copy-path-${slot}` } })}
              ${iconButton({ glyph: 'open', label: `定位轨道 ${slot} 文件`, tooltip: '定位文件', attributes: { id: `source-action-${slot}` } })}
              ${iconButton({ glyph: 'close', label: `关闭轨道 ${slot}`, tooltip: '关闭轨道', className: 'remove-track', attributes: { id: `remove-track-${slot}` } })}
            </div><input id="file-${slot}" type="file" accept="video/*,.mkv,.mov,.mp4,.webm,.ts,.avi,.flv" aria-label="打开视频 ${slot}" hidden></div>
          <div class="frame-stage" id="stage-${slot}"><canvas id="grid-${slot}" class="pixel-grid" aria-hidden="true" hidden></canvas><span id="grid-label-${slot}" class="pixel-grid-label" hidden></span><div class="empty" id="empty-${slot}"><label class="empty-open" for="file-${slot}">${icon('filePlus')}<span>添加视频</span></label><span class="empty-hint">或将文件拖入这里</span>${slot === 'A' ? `<section class="start-library" aria-label="启动片源"><header><div class="segmented"><button data-start-tab="available" aria-pressed="true">可用片源</button><button data-start-tab="recent" aria-pressed="false">最近打开</button></div><button id="start-library-more">全部片源</button></header><div id="start-library-list"></div><p id="start-library-status" class="muted"></p></section>` : ''}</div><div id="image-${slot}" class="image-wrap" hidden><canvas id="canvas-${slot}" aria-label="视频 ${slot} 当前解码画面"></canvas></div><svg id="annotations-${slot}" class="frame-annotations" aria-hidden="true"></svg><svg id="drawing-${slot}" class="drawing-layer" aria-label="编辑视频 ${slot} 的标注" tabindex="0" hidden></svg><button id="recover-${slot}" class="recover-view" aria-label="居中轨道 ${slot} 画面，保留倍率" hidden>${icon('center')}画面已移出 · 居中</button></div>
          <div class="card-footer"><span id="meta-${slot}"></span></div></article>`).join('')}
          <div id="divider" role="slider" aria-label="分割线位置" aria-valuemin="0" aria-valuemax="100" aria-valuenow="50" tabindex="0" hidden><div class="divider-line"></div><div class="divider-grip" aria-hidden="true"></div></div>
        </div>

        <section class="transport glass" aria-label="共用播放控制" hidden>
          <div class="transport-actions" role="group" aria-label="播放功能">
            <div class="play-buttons"><button class="icon-button" id="previous" title="上一帧，左方向键" aria-label="上一帧" disabled>${icon('previous')}</button><button class="icon-button" id="play" data-playing="false" aria-label="播放" disabled>${icon('play')}${icon('pause')}</button><button class="icon-button" id="next" title="下一帧，右方向键" aria-label="下一帧" disabled>${icon('next')}</button></div>
            <div class="transport-time"><input id="position" class="time-input" type="text" aria-label="定位时间" autocomplete="off" spellcheck="false" value="00:00.000" disabled><span class="duration"><span aria-hidden="true">/</span><span id="duration">00:00.000</span></span></div>
          <div class="timeline-control"><input id="timeline" type="range" min="0" max="1" step="1" value="0" aria-label="共用时间轴，微秒" disabled><span class="timeline-playhead" aria-hidden="true"></span><span id="timeline-hover" class="timeline-hover" aria-hidden="true" hidden></span><output id="timeline-preview" class="seek-preview" hidden></output></div>
            <button id="fullscreen" class="icon-button" aria-label="全屏" title="全屏">${icon('fit')}</button>
          </div><span id="status" class="sr-only" role="status"></span>
        </section>
        ${iconButton({ glyph: 'eye', label: '隐藏标题和播放控件', tooltip: '专注观察：隐藏标题、控制栏和提示', className: 'viewport-eye', attributes: { id: 'toggle-chrome', 'aria-pressed': 'false', hidden: '' } })}

<section id="annotation-toolbar" class="annotation-toolbar" aria-label="标注工具条" hidden>
  <div class="drawing-tools" role="toolbar" aria-label="标注工具">
    <button id="drawing-grip" class="icon-button" aria-label="拖动工具条" data-tooltip="拖动工具条">${icon('grip')}</button>
    ${([['select','选择 / 移动 (V)'],['pen','画笔 (P)'],['ellipse','椭圆 (O)'],['rect','矩形 (R)'],['line','线条 (L)'],['text','文字 (T)'],['eraser','橡皮擦 (E)']] as const).map(([tool,label]) => `<button type="button" data-drawing-tool="${tool}" class="icon-button" aria-label="${label}" data-tooltip="${label}${['pen', 'ellipse', 'rect', 'line'].includes(tool) ? ' · 单击标注以选择，拖动绘制' : ''}" aria-pressed="false">${icon(tool)}</button>`).join('')}
    <span class="drawing-divider"></span>
    <input id="drawing-color" type="hidden" value="${DEFAULT_ANNOTATION_COLOR}"><button id="drawing-color-choice" class="icon-button" aria-label="标注颜色" data-tooltip="标注颜色"></button>
    <input id="drawing-width" type="hidden" value="4"><button id="drawing-width-choice" class="choice-trigger" aria-label="笔画粗细" data-tooltip="笔画粗细"></button>
    <input id="drawing-font" type="hidden" value="24"><button id="drawing-font-choice" class="choice-trigger" aria-label="文字大小" data-tooltip="文字大小"></button>
    <span class="drawing-divider"></span>
    <button id="drawing-undo" class="icon-button" aria-label="撤销" data-tooltip="撤销 (⌘/Ctrl Z)">${icon('undo')}</button>
    <button id="drawing-redo" class="icon-button" aria-label="重做" data-tooltip="重做 (⌘/Ctrl Shift Z)">${icon('redo')}</button>
    <button id="drawing-delete" class="icon-button" aria-label="删除选中对象" data-tooltip="删除选中对象 (Delete)">${icon('trash')}</button>
    <button id="mark-close" class="icon-button" aria-label="结束标注" data-tooltip="结束编辑 (Esc)，改动自动记录">${icon('close')}</button>
  </div>
  <output id="drawing-status" class="sr-only" aria-live="polite">已记录</output>
  <p id="drawing-error" role="alert" hidden></p>
</section>
      </div>
      </section>
      <aside id="sources-panel" class="side-panel sources-panel glass" aria-label="片源" hidden>
        <header class="panel-heading"><h2>片源</h2><button data-close-panel="sources" class="icon-button" aria-label="收起片源">${icon('sidebar', 'mirror')}</button></header>
        <div class="source-tools"><div class="segmented" role="group" aria-label="片源范围"><button data-source-tab="available" aria-pressed="true">可用</button><button data-source-tab="recent" aria-pressed="false">最近</button></div><button id="sources-refresh" class="icon-button" aria-label="刷新片源" title="刷新片源">${icon('refresh')}</button></div>
        <label class="search-field">${icon('search')}<input id="source-search" type="search" placeholder="搜索片源" aria-label="搜索片源"></label>
        <p id="source-status" class="source-status" role="status"></p><div id="source-list" class="source-list"></div>
        <footer class="panel-foot"><button id="sources-import">${icon('filePlus')}添加片源</button><input id="source-files" type="file" multiple accept="video/*,.mkv,.mov,.mp4,.webm,.ts,.avi,.flv" hidden></footer>
      </aside>
      <section id="subtracks-panel" class="subtracks-panel marks-collapsed" aria-label="子轨道" hidden>
        <div id="dock-resize" class="dock-resize" role="separator" tabindex="0" aria-label="调整子轨道高度" aria-orientation="horizontal" aria-valuemin="128" aria-valuemax="420" aria-valuenow="180"></div>
        <div class="subtrack-tools-clip"><aside class="subtrack-tools" aria-label="子轨道工具"><header class="panel-heading"><h2>子轨道</h2><span id="subtrack-count" class="muted"></span><span class="toolbar-spacer"></span><button id="toggle-marks" class="icon-button" aria-label="展开标注面板" aria-expanded="false" aria-controls="selected-marks" title="展开标注面板">${icon('sidebar')}</button></header><div class="mark-tools"><span id="selected-mark-label">标注</span><button id="subtrack-add-mark" class="icon-button" aria-label="添加标注" title="在当前帧添加标注">${icon('plus')}</button></div><div id="selected-marks" class="selected-marks"></div></aside></div><div id="marks-resize" class="marks-resize" role="separator" tabindex="0" aria-label="调整标注面板宽度" aria-orientation="vertical" aria-controls="selected-marks" hidden></div>
        <div class="subtrack-scroll"><div class="subtrack-columns"><span>轨道</span><span class="track-offset">偏移</span><div id="subtrack-ruler" class="subtrack-ruler" aria-label="时间标尺"></div><span></span></div><div id="subtrack-list"></div></div>
      </section>
    </div>
  </main>


  <dialog id="help"><header class="dialog-heading"><h2>快捷键与说明</h2><button id="help-close" class="icon-button" aria-label="关闭说明">${icon('close')}</button></header><p>← / → 逐帧 · 空格播放 / 暂停（输入文字时除外）· M 切换并排 / 分屏。</p><p>滚轮或捏合缩放；右键拖动或双指滚动平移。暂停后可框选并标注。</p><p>本地文件不上传。标注保留在本次会话，关闭前请导出。最近片源保留文件信息，重新打开本地文件需要再次选择。</p><p>当前静音播放。HDR 来源会单独标识，浏览器最终色彩输出尚未验证，WASM 路径为 SDR。</p><details><summary>呈现诊断</summary><p class="evidence"><span id="alignment"></span><span id="decode"></span></p><button id="benchmark">检查当前视频播放性能</button></details></dialog>`;
}
