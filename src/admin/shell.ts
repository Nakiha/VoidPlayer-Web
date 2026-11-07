import { analysisSettingsShell } from './analysis.ts';
import { t, th, msg } from '../i18n.ts';
import { annotationAdminShell } from './annotations.ts';
import { cacheShell } from './caches.ts';
import { workspaceAdminShell } from './workspaces.ts';
import { measurementShell } from './measurement.ts';
import { icon } from '../ui/icons.ts';
export const PANES = () => [['overview', t(msg("admin.overviewTitle", "概览")), 'grid'], ['library', t(msg("admin.libraryTitle", "媒体库")), 'film'], ['caches', t(msg("admin.cacheTitle", "缓存")), 'database'], ['workspaces', t(msg("admin.wsTitle", "工作区")), 'stack'], ['annotations', t(msg("admin.marksTab", "标注")), 'note'], ['logs', t(msg("admin.logsTitle", "日志")), 'fileText'], ['measurements', t(msg("admin.measureTitle", "测速")), 'gauge'], ['preferences', t(msg('admin.preferencesTitle', '首选项')), 'settings']] as const;
export function adminShell() {
  return `<div class="admin-layout">
    <nav class="admin-navigation" aria-label="${th(msg("admin.navCategory", "管理分类"))}">
      <div class="admin-navigation-heading"><a class="admin-brand" href="/">VoidPlayer</a><button id="admin-navigation-toggle" class="icon-button" type="button" aria-controls="admin-navigation-items" aria-expanded="true" aria-label="${th(msg('admin.collapseNavigation', '折叠侧栏'))}">${icon('sidebar')}</button></div>
      <div id="admin-navigation-items" class="admin-navigation-items">${PANES().map(([id, label, glyph]) => `<button data-pane="${id}" aria-label="${label}" aria-current="${id === 'overview' ? 'page' : 'false'}">${icon(glyph)}<span class="admin-nav-label">${label}</span></button>`).join('')}</div>
      <a class="admin-back" href="/" aria-label="${th(msg("admin.backToPlayer", "返回播放器"))}">${icon('caretLeft')}<span class="admin-nav-label">${th(msg("admin.backToPlayer", "返回播放器"))}</span></a>
    </nav>
    <main class="admin-content">
      <section id="pane-overview"><header class="admin-heading"><h1>${th(msg("admin.overviewTitle", "概览"))}</h1></header>
        <div class="admin-metrics"><div><span>${th(msg("admin.uptime", "已运行"))}</span><strong id="uptime">—</strong></div><div><span>${th(msg("admin.procMemory", "进程内存"))}</span><strong id="memory">—</strong></div><div><span>${th(msg("admin.procCpu", "进程 CPU"))}</span><strong id="cpu">—</strong></div><div><span>${th(msg("admin.connections", "连接数"))}</span><strong id="connections">—</strong></div></div>
        <h2>${th(msg("admin.serviceTitle", "服务"))}</h2><dl class="admin-properties"><div><dt>${th(msg("admin.version", "版本"))}</dt><dd id="version">—</dd></div><div><dt>${th(msg("admin.runtime", "运行环境"))}</dt><dd id="runtime">—</dd></div><div><dt>${th(msg("admin.dataDir", "数据目录"))}</dt><dd id="data-dir">—</dd></div><div><dt>${th(msg("admin.currentIdentity", "当前身份"))}</dt><dd id="identity">—</dd></div><div><dt>${th(msg("admin.systemMemory", "系统可用内存"))}</dt><dd id="system-memory">—</dd></div><div><dt>${th(msg("admin.httpRequests", "HTTP 请求"))}</dt><dd id="requests">—</dd></div></dl>
        <h2>${th(msg("admin.indexTitle", "媒体索引"))}</h2><dl class="admin-properties"><div><dt>${th(msg("admin.rootDirs", "根目录"))}</dt><dd id="root-summary">—</dd></div><div><dt>${th(msg("admin.scanJobs", "扫描任务"))}</dt><dd id="scan-summary">—</dd></div><div><dt>${th(msg("admin.watchDirs", "目录监听"))}</dt><dd id="watch-summary">—</dd></div></dl>
      </section>
      ${cacheShell()}
      ${workspaceAdminShell()}
      ${annotationAdminShell()}
      ${measurementShell()}
      <section id="pane-preferences" hidden><header class="admin-heading"><h1>${th(msg('admin.preferencesTitle', '首选项'))}</h1></header>
        <div class="admin-panel"><div class="admin-preference-row"><h2>${th(msg('admin.interfaceLanguage', '界面语言'))}</h2><div class="admin-language"><button type="button" id="language-choice" class="choice-trigger" aria-label="${th(msg("language.label", "语言 / Language"))}"></button><span id="language-status" role="status"></span></div></div></div>
        ${analysisSettingsShell()}
      </section>
      <section id="pane-library" hidden><header class="admin-heading"><h1>${th(msg("admin.libraryTitle", "媒体库"))}</h1></header>
        <form id="roots-form" class="admin-panel"><div class="admin-section-heading admin-roots-heading">
          <h2>${th(msg('sources.mountList', '库列表'))}</h2>
          <div class="admin-button-group admin-root-actions">
            <button type="button" id="add-root">${icon('plus')}${th(msg("admin.addDir", "添加目录"))}</button>
            <button type="button" id="reset-roots">${th(msg("admin.revertChanges", "还原修改"))}</button>
            <button type="submit" id="save-roots" class="icon-button admin-primary" aria-label="${th(msg("admin.saveDirs", "保存目录"))}" title="${th(msg("admin.saveDirs", "保存目录"))}">${icon('save')}</button>
          </div>
        </div><div class="admin-root-columns" aria-hidden="true"><span>${th(msg("admin.wsName", "名称"))}</span><span>${th(msg("admin.serverPath", "服务器路径"))}</span></div><div id="root-editor" class="admin-root-editor"></div>
          <div id="scan-issues" hidden><div class="admin-section-heading"><h3 id="scan-error-count"></h3><div id="scan-error-pages" class="admin-button-group"><button type="button" id="errors-prev" class="icon-button" aria-label="${th(msg("admin.prevErrors", "上一页错误"))}">${icon('previous')}</button><button type="button" id="errors-next" class="icon-button" aria-label="${th(msg("admin.nextErrors", "下一页错误"))}">${icon('next')}</button></div></div><div id="scan-errors" class="admin-error-list"></div></div>
        </form>
        <div class="admin-panel admin-library-card"><div id="admin-library-browser" class="library-pane" aria-label="${th(msg('shell.browseLibrary', '浏览媒体库'))}"></div></div>
      </section>
      <section id="pane-logs" class="admin-logs" hidden><header class="admin-heading"><h1>${th(msg("admin.logsTitle", "日志"))}</h1><button id="refresh-logs" class="icon-button" aria-label="${th(msg("admin.refreshLogs", "刷新日志"))}">${icon('refresh')}</button></header>
        <div id="log-storage" hidden></div>
        <div class="admin-log-tabs" role="group" aria-label="${th(msg("admin.logType", "日志类型"))}"><button data-log-mode="uploads" aria-pressed="true">${th(msg("admin.uploadedLogs", "上传日志"))}</button><button data-log-mode="requests" aria-pressed="false">${th(msg("admin.requestRecords", "请求记录"))}</button></div>
        <div id="uploads-view" class="admin-log-workspace"><div class="admin-log-sidebar"><div id="log-list" class="library-row-surface"></div><button id="more-logs">${th(msg("admin.nextPage", "下一页"))}</button><button id="first-logs">${th(msg("admin.backToLatest", "返回最新"))}</button></div>
          <div class="admin-log-detail" data-empty="true"><div class="admin-actions"><span id="log-description" class="admin-caption">${th(msg("admin.selectLog", "选择一份日志查看内容"))}</span><button id="download-log" disabled>${icon('download')}${th(msg("admin.download", "下载"))}</button><button id="delete-log" class="icon-button admin-danger" aria-label="${th(msg("admin.deleteSelectedLog", "删除选中日志"))}" disabled>${icon('trash')}</button></div><div id="delete-log-confirm" class="admin-inline-confirm" hidden><span>${th(msg("admin.deleteLogConfirm", "从服务器删除这份日志？此操作无法撤销。"))}</span><button id="confirm-delete-log">${th(msg("admin.deleteLog", "删除日志"))}</button><button id="cancel-delete-log">${th(msg("admin.cancel", "取消"))}</button></div><textarea id="log-json" aria-label="${th(msg("admin.logJson", "日志 JSON"))}" readonly placeholder="${th(msg("admin.logPlaceholder", "日志内容会显示在这里"))}"></textarea></div>
        </div><div id="requests-view" hidden><p class="admin-caption">${th(msg("admin.recentRequests", "最近 200 条请求，服务重启后清空。"))}</p><div class="admin-request-head"><span>${th(msg("admin.reqTimeUser", "时间 / 用户"))} / IP</span><span>${th(msg("admin.reqRequest", "请求"))}</span><span>${th(msg("admin.reqStatus", "状态"))}</span><span>${th(msg("admin.reqDuration", "耗时"))}</span></div><div id="request-list"></div></div>
      </section>
    </main></div>`;
}
