import { workspaceAdminShell } from './workspaces.ts';
import { measurementShell } from './measurement.ts';
import { icon } from '../ui/icons.ts';
export const PANES = [['overview', '概览', 'diagnostics'], ['library', '媒体库', 'open'], ['workspaces', '工作区', 'film'], ['logs', '日志', 'note'], ['measurements', '测速', 'diagnostics']] as const;
export function adminShell() {
  return `<div class="admin-layout">
    <nav class="admin-navigation" aria-label="管理分类"><a class="admin-brand" href="/">${icon('film')}<span>VoidPlayer</span></a><span class="admin-nav-caption">服务管理</span>
      ${PANES.map(([id, label, glyph]) => `<button data-pane="${id}" aria-current="${id === 'overview' ? 'page' : 'false'}">${icon(glyph)}${label}</button>`).join('')}
      <a class="admin-back" href="/">${icon('previous')}返回播放器</a>
    </nav>
    <main class="admin-content"><p id="admin-message" role="status" aria-live="polite" hidden></p>
      <section id="pane-overview"><header class="admin-heading"><div><h1>概览</h1><p>服务器的当前运行状态。</p></div><button id="refresh-status" class="icon-button" aria-label="刷新状态">${icon('refresh')}</button></header>
        <div class="admin-metrics"><div><span>已运行</span><strong id="uptime">—</strong></div><div><span>进程内存</span><strong id="memory">—</strong></div><div><span>进程 CPU</span><strong id="cpu">—</strong></div><div><span>连接数</span><strong id="connections">—</strong></div></div>
        <h2>服务</h2><dl class="admin-properties"><div><dt>版本</dt><dd id="version">—</dd></div><div><dt>运行环境</dt><dd id="runtime">—</dd></div><div><dt>数据目录</dt><dd id="data-dir">—</dd></div><div><dt>当前身份</dt><dd id="identity">—</dd></div><div><dt>系统可用内存</dt><dd id="system-memory">—</dd></div><div><dt>HTTP 请求</dt><dd id="requests">—</dd></div></dl>
        <p class="admin-caption">CPU 以一个逻辑核为 100%。连接数包含浏览器保持的空闲连接。</p>
        <h2>媒体索引</h2><dl class="admin-properties"><div><dt>根目录</dt><dd id="root-summary">—</dd></div><div><dt>扫描任务</dt><dd id="scan-summary">—</dd></div><div><dt>目录监听</dt><dd id="watch-summary">—</dd></div></dl>
      </section>
      ${workspaceAdminShell()}
      ${measurementShell()}
      <section id="pane-library" hidden><header class="admin-heading"><div><h1>媒体库</h1><p>配置服务器上的物理目录或已挂载的网络存储。</p></div><button id="add-root">${icon('plus')}添加目录</button></header>
        <form id="roots-form"><div class="admin-root-head"><span>名称</span><span>服务器路径</span><span></span></div><div id="root-editor" class="admin-root-editor"></div>
          <div class="admin-actions"><span id="root-save-state" class="admin-caption"></span><button type="button" id="reset-roots">还原修改</button><button type="submit" id="save-roots">${icon('check')}保存目录</button></div>
        </form><p class="admin-caption">更改路径会保留该目录的媒体身份。移除目录只移出索引，不删除磁盘上的文件；已开始的读取可以继续完成。</p>
        <h2>扫描任务</h2><div class="admin-actions admin-scan-actions"><span id="scan-progress">—</span><button id="scan-refresh">${icon('refresh')}校准全库</button><button id="scan-cancel">${icon('close')}停止扫描</button></div>
        <p id="scan-detail" class="admin-caption"></p><div id="scan-errors" class="admin-error-list"></div><div class="admin-actions"><span id="scan-error-count" class="admin-caption"></span><button id="errors-prev" class="icon-button" aria-label="上一页错误">${icon('previous')}</button><button id="errors-next" class="icon-button" aria-label="下一页错误">${icon('next')}</button></div>
      </section>
      <section id="pane-logs" class="admin-logs" hidden><header class="admin-heading"><div><h1>日志</h1><p>检视用户主动上传的诊断记录与本次运行的 HTTP 请求。</p></div><button id="refresh-logs" class="icon-button" aria-label="刷新日志">${icon('refresh')}</button></header>
        <div class="admin-log-tabs" role="group" aria-label="日志类型"><button data-log-mode="uploads" aria-pressed="true">上传日志</button><button data-log-mode="requests" aria-pressed="false">请求记录</button></div>
        <div id="uploads-view" class="admin-log-workspace"><div class="admin-log-sidebar"><div id="log-list"></div><button id="more-logs">下一页</button><button id="first-logs">返回最新</button></div>
          <div class="admin-log-detail"><div class="admin-actions"><span id="log-description" class="admin-caption">选择一份日志</span><button id="download-log" disabled>${icon('download')}下载</button><button id="delete-log" class="icon-button admin-danger" aria-label="删除选中日志" disabled>${icon('trash')}</button></div><div id="delete-log-confirm" class="admin-inline-confirm" hidden><span>从服务器删除这份日志？此操作无法撤销。</span><button id="confirm-delete-log">删除日志</button><button id="cancel-delete-log">取消</button></div><textarea id="log-json" aria-label="日志 JSON" readonly placeholder="日志内容会显示在这里"></textarea></div>
        </div><div id="requests-view" hidden><p class="admin-caption">保留本次运行最近 200 条请求；状态轮询不占用列表。重启后清空，完整记录由服务运行日志保留。</p><div class="admin-request-head"><span>时间 / 用户</span><span>请求</span><span>状态</span><span>耗时</span></div><div id="request-list"></div></div>
      </section>
    </main></div>`;
}
