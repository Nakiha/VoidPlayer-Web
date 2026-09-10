import { annotationAdminShell } from './annotations.ts';
import { cacheShell } from './caches.ts';
import { workspaceAdminShell } from './workspaces.ts';
import { measurementShell } from './measurement.ts';
import { icon } from '../ui/icons.ts';
export const PANES = [['overview', '概览', 'diagnostics'], ['library', '媒体库', 'open'], ['caches', '缓存', 'film'], ['workspaces', '工作区', 'film'], ['annotations', '标注', 'note'], ['logs', '日志', 'note'], ['measurements', '测速', 'diagnostics']] as const;
export function adminShell() {
  return `<div class="admin-layout">
    <nav class="admin-navigation" aria-label="管理分类"><a class="admin-brand" href="/">${icon('film')}<span>VoidPlayer</span></a><span class="admin-nav-caption">服务管理</span>
      ${PANES.map(([id, label, glyph]) => `<button data-pane="${id}" aria-current="${id === 'overview' ? 'page' : 'false'}">${icon(glyph)}${label}</button>`).join('')}
      <a class="admin-back" href="/">${icon('previous')}返回播放器</a>
    </nav>
    <main class="admin-content"><p id="admin-message" role="status" aria-live="polite" hidden></p>
      <section id="pane-overview"><header class="admin-heading"><div><h1>概览</h1><p>查看服务状态、资源占用和媒体扫描进度。</p></div><button id="refresh-status" class="icon-button" aria-label="刷新状态">${icon('refresh')}</button></header>
        <div class="admin-metrics"><div><span>已运行</span><strong id="uptime">—</strong></div><div><span>进程内存</span><strong id="memory">—</strong></div><div><span>进程 CPU</span><strong id="cpu">—</strong></div><div><span>连接数</span><strong id="connections">—</strong></div></div>
        <h2>服务</h2><dl class="admin-properties"><div><dt>版本</dt><dd id="version">—</dd></div><div><dt>运行环境</dt><dd id="runtime">—</dd></div><div><dt>数据目录</dt><dd id="data-dir">—</dd></div><div><dt>当前身份</dt><dd id="identity">—</dd></div><div><dt>系统可用内存</dt><dd id="system-memory">—</dd></div><div><dt>HTTP 请求</dt><dd id="requests">—</dd></div></dl>
        <p class="admin-caption">CPU 以一个逻辑核为 100%。连接数包含浏览器保持的空闲连接。</p>
        <h2>媒体索引</h2><dl class="admin-properties"><div><dt>根目录</dt><dd id="root-summary">—</dd></div><div><dt>扫描任务</dt><dd id="scan-summary">—</dd></div><div><dt>目录监听</dt><dd id="watch-summary">—</dd></div></dl>
      </section>
      ${cacheShell()}
      ${workspaceAdminShell()}
      ${annotationAdminShell()}
      ${measurementShell()}
      <section id="pane-library" hidden><header class="admin-heading"><div><h1>媒体库</h1><p>添加服务器目录，保存后即可在播放器中浏览视频。</p></div></header>
        <form id="roots-form" class="admin-panel"><div class="admin-section-heading"><h2>媒体目录</h2><button type="button" id="add-root">${icon('plus')}添加目录</button></div>
          <div id="root-editor" class="admin-root-editor"></div>
          <div class="admin-panel-footer"><span id="root-save-state" class="admin-caption" role="status"></span><div class="admin-button-group"><button type="button" id="reset-roots">还原修改</button><button type="submit" id="save-roots" class="admin-primary">${icon('check')}保存目录</button></div></div>
          <p class="admin-help">填写服务器上的完整路径。移除目录不会删除原文件。</p>
        </form>
        <div class="admin-panel"><div class="admin-section-heading"><div><h2>扫描媒体</h2><p>目录变化会自动更新；找不到新增视频时，可重新扫描。</p></div><div class="admin-button-group"><button id="scan-cancel" hidden>${icon('close')}停止扫描</button><button id="scan-refresh">${icon('refresh')}重新扫描</button></div></div>
          <div class="admin-scan-status"><strong id="scan-progress">正在读取扫描状态…</strong><p id="scan-detail" class="admin-caption"></p></div>
          <div id="scan-issues" hidden><div class="admin-section-heading"><h3 id="scan-error-count"></h3><div id="scan-error-pages" class="admin-button-group"><button id="errors-prev" class="icon-button" aria-label="上一页错误">${icon('previous')}</button><button id="errors-next" class="icon-button" aria-label="下一页错误">${icon('next')}</button></div></div><div id="scan-errors" class="admin-error-list"></div></div>
        </div>
      </section>
      <section id="pane-logs" class="admin-logs" hidden><header class="admin-heading"><div><h1>日志</h1><p>查看用户上传的诊断日志，或检查服务器收到的请求。</p></div><button id="refresh-logs" class="icon-button" aria-label="刷新日志">${icon('refresh')}</button></header>
        <div class="admin-log-tabs" role="group" aria-label="日志类型"><button data-log-mode="uploads" aria-pressed="true">上传日志</button><button data-log-mode="requests" aria-pressed="false">请求记录</button></div>
        <div id="uploads-view" class="admin-log-workspace"><div class="admin-log-sidebar"><div id="log-list"></div><button id="more-logs">下一页</button><button id="first-logs">返回最新</button></div>
          <div class="admin-log-detail" data-empty="true"><div class="admin-actions"><span id="log-description" class="admin-caption">选择一份日志查看内容</span><button id="download-log" disabled>${icon('download')}下载</button><button id="delete-log" class="icon-button admin-danger" aria-label="删除选中日志" disabled>${icon('trash')}</button></div><div id="delete-log-confirm" class="admin-inline-confirm" hidden><span>从服务器删除这份日志？此操作无法撤销。</span><button id="confirm-delete-log">删除日志</button><button id="cancel-delete-log">取消</button></div><textarea id="log-json" aria-label="日志 JSON" readonly placeholder="日志内容会显示在这里"></textarea></div>
        </div><div id="requests-view" hidden><p class="admin-caption">最近 200 条请求，服务重启后清空。</p><div class="admin-request-head"><span>时间 / 用户</span><span>请求</span><span>状态</span><span>耗时</span></div><div id="request-list"></div></div>
      </section>
    </main></div>`;
}
