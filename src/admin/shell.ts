import { t, th, msg } from '../i18n.ts';
import { annotationAdminShell } from './annotations.ts';
import { cacheShell } from './caches.ts';
import { workspaceAdminShell } from './workspaces.ts';
import { measurementShell } from './measurement.ts';
import { icon } from '../ui/icons.ts';
export const PANES = () => [['overview', t(msg("admin.overviewTitle", "概览")), 'diagnostics'], ['library', t(msg("admin.libraryTitle", "媒体库")), 'open'], ['caches', t(msg("admin.cacheTitle", "缓存")), 'film'], ['workspaces', t(msg("admin.wsTitle", "工作区")), 'film'], ['annotations', t(msg("admin.marksTab", "标注")), 'note'], ['logs', t(msg("admin.logsTitle", "日志")), 'note'], ['measurements', t(msg("admin.measureTitle", "测速")), 'diagnostics']] as const;
export function adminShell() {
  return `<div class="admin-layout">
    <nav class="admin-navigation" aria-label="${th(msg("admin.navCategory", "管理分类"))}"><a class="admin-brand" href="/">${icon('film')}<span>VoidPlayer</span></a><span class="admin-nav-caption">${th(msg("admin.navCaption", "服务管理"))}</span>
      ${PANES().map(([id, label, glyph]) => `<button data-pane="${id}" aria-current="${id === 'overview' ? 'page' : 'false'}">${icon(glyph)}${label}</button>`).join('')}
      <a class="admin-back" href="/">${icon('previous')}${th(msg("admin.backToPlayer", "返回播放器"))}</a>
    </nav>
    <main class="admin-content"><div class="admin-language"><button type="button" id="language-choice" class="choice-trigger" aria-label="${th(msg("language.label", "语言 / Language"))}"></button><span id="language-status" role="status"></span></div><p id="admin-message" role="status" aria-live="polite" hidden></p>
      <section id="pane-overview"><header class="admin-heading"><div><h1>${th(msg("admin.overviewTitle", "概览"))}</h1><p>${th(msg("admin.overviewDesc", "查看服务状态、资源占用和媒体扫描进度。"))}</p></div><button id="refresh-status" class="icon-button" aria-label="${th(msg("admin.refreshStatus", "刷新状态"))}">${icon('refresh')}</button></header>
        <div class="admin-metrics"><div><span>${th(msg("admin.uptime", "已运行"))}</span><strong id="uptime">—</strong></div><div><span>${th(msg("admin.procMemory", "进程内存"))}</span><strong id="memory">—</strong></div><div><span>${th(msg("admin.procCpu", "进程 CPU"))}</span><strong id="cpu">—</strong></div><div><span>${th(msg("admin.connections", "连接数"))}</span><strong id="connections">—</strong></div></div>
        <h2>${th(msg("admin.serviceTitle", "服务"))}</h2><p>${th(msg("admin.serviceDesc", "可信内网模式：用户名用于内容归属，不是身份认证。访问者可选择已有身份并使用管理功能；本服务不提供安全的多租户隔离。"))}</p><dl class="admin-properties"><div><dt>${th(msg("admin.version", "版本"))}</dt><dd id="version">—</dd></div><div><dt>${th(msg("admin.runtime", "运行环境"))}</dt><dd id="runtime">—</dd></div><div><dt>${th(msg("admin.dataDir", "数据目录"))}</dt><dd id="data-dir">—</dd></div><div><dt>${th(msg("admin.currentIdentity", "当前身份"))}</dt><dd id="identity">—</dd></div><div><dt>${th(msg("admin.systemMemory", "系统可用内存"))}</dt><dd id="system-memory">—</dd></div><div><dt>${th(msg("admin.httpRequests", "HTTP 请求"))}</dt><dd id="requests">—</dd></div></dl>
        <p class="admin-caption">${th(msg("admin.cpuCaption", "CPU 以一个逻辑核为 100%。连接数包含浏览器保持的空闲连接。"))}</p>
        <h2>${th(msg("admin.indexTitle", "媒体索引"))}</h2><dl class="admin-properties"><div><dt>${th(msg("admin.rootDirs", "根目录"))}</dt><dd id="root-summary">—</dd></div><div><dt>${th(msg("admin.scanJobs", "扫描任务"))}</dt><dd id="scan-summary">—</dd></div><div><dt>${th(msg("admin.watchDirs", "目录监听"))}</dt><dd id="watch-summary">—</dd></div></dl>
      </section>
      ${cacheShell()}
      ${workspaceAdminShell()}
      ${annotationAdminShell()}
      ${measurementShell()}
      <section id="pane-library" hidden><header class="admin-heading"><div><h1>${th(msg("admin.libraryTitle", "媒体库"))}</h1><p>${th(msg("admin.libraryDesc", "添加服务器目录，保存后即可在播放器中浏览视频。"))}</p></div></header>
        <form id="roots-form" class="admin-panel"><div class="admin-section-heading"><h2>${th(msg("admin.mediaDirs", "媒体目录"))}</h2><button type="button" id="add-root">${icon('plus')}${th(msg("admin.addDir", "添加目录"))}</button></div>
          <div id="root-editor" class="admin-root-editor"></div>
          <div class="admin-panel-footer"><span id="root-save-state" class="admin-caption" role="status"></span><div class="admin-button-group"><button type="button" id="reset-roots">${th(msg("admin.revertChanges", "还原修改"))}</button><button type="submit" id="save-roots" class="admin-primary">${icon('check')}${th(msg("admin.saveDirs", "保存目录"))}</button></div></div>
          <p class="admin-help">${th(msg("admin.dirHelp", "填写服务器上的完整路径。移除目录不会删除原文件。"))}</p>
        </form>
        <div class="admin-panel"><div class="admin-section-heading"><div><h2>${th(msg("admin.scanMedia", "扫描媒体"))}</h2><p>${th(msg("admin.scanDesc", "目录变化会自动更新；找不到新增视频时，可重新扫描。"))}</p></div><div class="admin-button-group"><button id="scan-cancel" hidden>${icon('close')}${th(msg("admin.stopScan", "停止扫描"))}</button><button id="scan-refresh">${icon('refresh')}${th(msg("admin.rescan", "重新扫描"))}</button></div></div>
          <div class="admin-scan-status"><strong id="scan-progress">${th(msg("admin.readingScan", "正在读取扫描状态…"))}</strong><p id="scan-detail" class="admin-caption"></p></div>
          <div id="scan-issues" hidden><div class="admin-section-heading"><h3 id="scan-error-count"></h3><div id="scan-error-pages" class="admin-button-group"><button id="errors-prev" class="icon-button" aria-label="${th(msg("admin.prevErrors", "上一页错误"))}">${icon('previous')}</button><button id="errors-next" class="icon-button" aria-label="${th(msg("admin.nextErrors", "下一页错误"))}">${icon('next')}</button></div></div><div id="scan-errors" class="admin-error-list"></div></div>
        </div>
      </section>
      <section id="pane-logs" class="admin-logs" hidden><header class="admin-heading"><div><h1>${th(msg("admin.logsTitle", "日志"))}</h1><p>${th(msg("admin.logsDesc", "查看用户上传的诊断日志，或检查服务器收到的请求。"))}</p></div><button id="refresh-logs" class="icon-button" aria-label="${th(msg("admin.refreshLogs", "刷新日志"))}">${icon('refresh')}</button></header>
        <div class="admin-log-tabs" role="group" aria-label="${th(msg("admin.logType", "日志类型"))}"><button data-log-mode="uploads" aria-pressed="true">${th(msg("admin.uploadedLogs", "上传日志"))}</button><button data-log-mode="requests" aria-pressed="false">${th(msg("admin.requestRecords", "请求记录"))}</button></div>
        <div id="uploads-view" class="admin-log-workspace"><div class="admin-log-sidebar"><div id="log-list"></div><button id="more-logs">${th(msg("admin.nextPage", "下一页"))}</button><button id="first-logs">${th(msg("admin.backToLatest", "返回最新"))}</button></div>
          <div class="admin-log-detail" data-empty="true"><div class="admin-actions"><span id="log-description" class="admin-caption">${th(msg("admin.selectLog", "选择一份日志查看内容"))}</span><button id="download-log" disabled>${icon('download')}${th(msg("admin.download", "下载"))}</button><button id="delete-log" class="icon-button admin-danger" aria-label="${th(msg("admin.deleteSelectedLog", "删除选中日志"))}" disabled>${icon('trash')}</button></div><div id="delete-log-confirm" class="admin-inline-confirm" hidden><span>${th(msg("admin.deleteLogConfirm", "从服务器删除这份日志？此操作无法撤销。"))}</span><button id="confirm-delete-log">${th(msg("admin.deleteLog", "删除日志"))}</button><button id="cancel-delete-log">${th(msg("admin.cancel", "取消"))}</button></div><textarea id="log-json" aria-label="${th(msg("admin.logJson", "日志 JSON"))}" readonly placeholder="${th(msg("admin.logPlaceholder", "日志内容会显示在这里"))}"></textarea></div>
        </div><div id="requests-view" hidden><p class="admin-caption">${th(msg("admin.recentRequests", "最近 200 条请求，服务重启后清空。"))}</p><div class="admin-request-head"><span>${th(msg("admin.reqTimeUser", "时间 / 用户"))}</span><span>${th(msg("admin.reqRequest", "请求"))}</span><span>${th(msg("admin.reqStatus", "状态"))}</span><span>${th(msg("admin.reqDuration", "耗时"))}</span></div><div id="request-list"></div></div>
      </section>
    </main></div>`;
}
