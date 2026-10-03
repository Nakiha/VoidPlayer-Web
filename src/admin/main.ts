import { requestError, rootReason } from './diagnostics.ts';
import { apiError } from '../api-error.ts';
import { mountLocalizedShell } from '../ui/localized-shell.ts';
import { installLanguageControls } from '../ui/language.ts';
import { installLiveLocalization, localizedText, localizedFragment, localizedAttribute, type LocalizedValue } from '../ui/live-localization.ts';
import { initializeLanguage, onLanguageChange, formatDate, t, th, msg } from '../i18n.ts';
import { chooseInitialIdentity } from '../ui/identity-onboarding.ts';
import { installAnnotationAdmin } from './annotations.ts';
import { emptyState } from './presentation.ts';
import { installCaches } from './caches.ts';
import { randomUUID } from '../uuid.ts';
// Theme palettes load via render-blocking links in admin/index.html (same as the
// player entry); feature styles load here in cascade order.
import '../themes/accessibility.css';
import '../style.css';
import './style.css';
import { observeTheme } from '../ui/theme.ts';
import { icon } from '../ui/icons.ts';
import { installWorkspaceAdmin } from './workspaces.ts';
import { installMeasurements } from './measurement.ts';
import { adminShell, PANES } from './shell.ts';
import type { AdminController } from '../../server/admin.ts';
import type { MediaLibraryIndex } from '../../server/library.ts';

type Root = { id: string; name: string; path: string };
type RootConfig = Awaited<ReturnType<AdminController['roots']>>;
type LogEntry = Awaited<ReturnType<AdminController['logs']>>['entries'][number];
type Scan = ReturnType<MediaLibraryIndex['status']> & { errors: Record<string, unknown>[]; offset: number };
type Status = ReturnType<AdminController['status']> & { identity: { id: string; name: string }; http: { activeRequests: number; connections: number; completedRequests: number; abortedRequests: number }; recentRequests: Record<string, unknown>[] };
const disposeLanguage = await initializeLanguage();
const life = new AbortController();
const app = document.getElementById('admin-app')!; mountLocalizedShell(app, adminShell, life.signal);
installLanguageControls(life.signal);
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const disposeTheme = observeTheme();
const text = (id: string, value: LocalizedValue) => { localizedText($(id), value); };
const bytes = (n: number) => n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : n >= 1024 ** 2 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${(n / 1024).toFixed(1)} KB`;
const stateLabelValues = () => ({ ready: t(msg("admin.stateReady", "可用")), offline: t(msg("admin.stateOffline", "存储离线")), scanning: t(msg("admin.stateScanning", "扫描中")), partial: t(msg("admin.statePartial", "部分路径不可读")), cancelled: t(msg("admin.stateCancelled", "已停止")), unscanned: t(msg("admin.stateUnscanned", "等待扫描")), error: t(msg("admin.stateError", "扫描出错")), completed: t(msg("admin.measureDone", "已完成")), failed: t(msg("admin.stateFailed", "失败")), running: t(msg("admin.measureRunning", "进行中")), interrupted: t(msg("admin.stateInterrupted", "上次任务被中断")) });
let stateLabels: Record<string,string> = stateLabelValues();
onLanguageChange(() => { stateLabels = stateLabelValues(); }, life.signal);
const updateTitle = () => { document.title = t(msg('admin.pageTitle', '管理 · VoidPlayer')); };
onLanguageChange(updateTitle, life.signal); updateTitle();
let statusError = false;
let pane = 'overview', rootConfig: RootConfig | null = null, rootDirty = false, rootSaving = false;
let status: Status | null = null, polling = false, errorsOffset = 0, errorsJob: unknown = null;
let logCursor = '', nextLog: string | null = null, selectedLog: LogEntry | null = null;
const userNames = new Map<string, string>();
let logDocument: unknown, logsMode = 'uploads', logSequence = 0, listSequence = 0, scanSequence = 0;
function notice(message: LocalizedValue, error = false) { statusError = false; text('admin-message', message); $('admin-message').hidden = !(typeof message === 'function' ? message() : message); $('admin-message').dataset.error = String(error); }
async function api<T>(url: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}): Promise<T> {
  const response = await fetch(url, { method, cache: 'no-store', headers: { ...(method !== 'GET' ? { 'x-voidplayer-action': 'admin', 'content-type': 'application/json' } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.any([life.signal, AbortSignal.timeout(15000)]) });
  const value = await response.json();
  if (!response.ok) throw apiError(response.status, value);
  return value;
}
const act = async (action: () => Promise<void>) => { try { await action(); } catch (error) { if (!life.signal.aborted) notice(() => requestError(error), true); } };
function updateRootActions() {
  $('save-roots').toggleAttribute('disabled', !rootDirty || rootSaving || !rootConfig?.writable);
  $('reset-roots').toggleAttribute('disabled', !rootDirty || rootSaving);
  $('add-root').toggleAttribute('disabled', rootSaving || !rootConfig?.writable);
  for (const control of $('root-editor').querySelectorAll<HTMLInputElement | HTMLButtonElement>('input,button')) control.disabled = rootSaving || !rootConfig?.writable;
  text('root-save-state', () => (rootConfig?.reason ? rootReason(rootConfig.reasonCode, rootConfig.reason) : null) ?? (rootSaving ? t(msg("admin.saving", "正在保存…")) : rootDirty ? t(msg("admin.unsavedChanges", "有未保存的修改")) : t(msg("admin.dirsSaved", "目录配置已保存"))));
}
function readDraft(): Root[] {
  return [...$('root-editor').querySelectorAll<HTMLElement>('.admin-root-row')].map(row => ({ id: row.dataset.id!, name: row.querySelector<HTMLInputElement>('[data-field=name]')!.value.trim(), path: row.querySelector<HTMLInputElement>('[data-field=path]')!.value.trim() }));
}
function rootRow(root: Root) {
  const row = document.createElement('div'); row.className = 'admin-root-row'; row.dataset.id = root.id;
  localizedFragment(row, () => `<label>${th(msg("admin.wsName", "名称"))}<input data-field="name" aria-label="${th(msg("admin.dirNameAria", "目录名称"))}" placeholder="${th(msg("admin.dirNamePh", "例如：拍摄素材"))}" required maxlength="120"></label><label>${th(msg("admin.serverPath", "服务器路径"))}<input data-field="path" aria-label="${th(msg("admin.serverPathAria", "服务器上的目录路径"))}" placeholder="${th(msg("admin.serverPathPh", "填写完整目录路径"))}" required maxlength="4096" spellcheck="false"></label><button type="button" class="icon-button admin-danger" aria-label="${th(msg("admin.removeDir", "移除目录"))}" title="${th(msg("admin.removeDirTitle", "移出媒体库，不删除文件"))}">${icon('trash')}</button><span data-root-state class="admin-root-state"></span>`);
  row.querySelector<HTMLInputElement>('[data-field=name]')!.value = root.name;
  row.querySelector<HTMLInputElement>('[data-field=path]')!.value = root.path;
  for (const input of row.querySelectorAll('input')) { input.disabled = !rootConfig?.writable; input.addEventListener('input', () => { rootDirty = true; updateRootActions(); }); }
  row.querySelector('button')!.disabled = !rootConfig?.writable;
  row.querySelector('button')!.onclick = () => { row.remove(); rootDirty = true; updateRootActions(); };
  return row;
}
async function loadRoots() {
  rootConfig = await api<RootConfig>('/api/admin/roots'); rootDirty = false;
  $('root-editor').replaceChildren(...rootConfig.roots.map(rootRow)); updateRootActions(); renderRootStates();
}
function renderRootStates() {
  for (const row of $('root-editor').querySelectorAll<HTMLElement>('.admin-root-row')) {
    const root = status?.library.roots.find(r => r.id === row.dataset.id);
    const badge = row.querySelector<HTMLElement>('[data-root-state]')!;
    localizedText(badge, () => root ? stateLabels[String(root.state)] ?? String(root.state) : t(msg("admin.indexAfterSave", "保存后开始索引")));
    badge.dataset.state = String(root?.state ?? 'unscanned');
  }
}
function renderStatus(value: Status) {
  status = value;
  const seconds = Math.floor(value.uptimeSeconds), hours = Math.floor(seconds / 3600);
  text('uptime', () => hours ? t(msg("admin.hoursMinutes", "{h} 小时 {m} 分"), { h: hours, m: Math.floor(seconds % 3600 / 60) }) : t(msg("activity.durationMinutesSeconds", "{m} 分 {s} 秒"), { m: Math.floor(seconds / 60), s: seconds % 60 }));
  text('memory', () => bytes(value.memory.rss)); text('cpu', () => `${value.cpuPercent.toFixed(1)}%`); text('connections', () => String(value.http.connections));
  text('version', () => `${value.version} · ${value.revision}`); text('runtime', () => `${value.runtime} · ${value.platform}`);
  text('data-dir', () => value.dataDir); text('identity', () => value.identity.name); localizedAttribute($('identity'), 'title', () => value.identity.id);
  text('system-memory', () => `${bytes(value.memory.systemFree)} / ${bytes(value.memory.systemTotal)}`);
  text('requests', () => t(msg("admin.requestsSummary", "{done} 次完成 · {active} 次处理中 · {aborted} 次中断"), { done: value.http.completedRequests, active: value.http.activeRequests, aborted: value.http.abortedRequests }));
  text('root-summary', () => t(msg("admin.rootsSummary", "{n, plural, other {# 个目录}} · {o} 个离线"), { n: value.library.roots.length, o: value.library.roots.filter(r => r.state === 'offline').length }));
  const job = value.library.job;
  text('scan-summary', () => value.library.scanning ? t(msg("admin.scanActive", "扫描中 · {visited, plural, other {# 个目录}}"), { visited: Number(job?.visited ?? 0) }) : job ? t(msg("admin.scanJobSummary", "{state} · {files} 个媒体"), { state: stateLabels[String(job.state)] ?? String(job.state), files: Number(job.files) }) : t(msg("admin.noScan", "尚未扫描")));
  const watch = value.library.watch;
  text('watch-summary', () => watch ? t(msg("admin.watchSummary", "{active} / {limit, plural, other {# 个目录}}{calibration}{partial}"), {active:watch.active,limit:watch.limit,calibration:watch.limited ? t(msg('admin.watchCalibrated', ' · 其余由周期校准覆盖')) : '',partial:watch.unavailableRoots.length ? t(msg('admin.watchPartial', ' · 部分目录监听不可用')) : ''}) : t(msg("admin.watchPollOnly", "仅周期校准")));
  renderRootStates();
  if (pane === 'logs' && logsMode === 'requests') renderRequests();
}
async function poll() {
  if (polling || document.hidden) return; polling = true;
  try { renderStatus(await api<Status>('/api/admin/status')); if (statusError) notice(() => ''); if (pane === 'library') await loadScan(); }
  catch (error) { if (!life.signal.aborted) { notice(() => requestError(error), true); statusError = true; } }
  finally { polling = false; }
}
async function loadScan() {
  const sequence = ++scanSequence;
  const value = await api<Scan>(`/api/admin/scan?offset=${errorsOffset}`);
  if (sequence !== scanSequence) return;
  if (errorsJob !== value.job?.id) { errorsJob = value.job?.id; if (errorsOffset) { errorsOffset = 0; return loadScan(); } }
  text('scan-progress', () => value.job ? t(msg("admin.scanProgressLine", "{state} · {visited, plural, other {# 个目录}} · {files} 个媒体"), { state: stateLabels[String(value.job.state)] ?? value.job.state, visited: Number(value.job.visited), files: Number(value.job.files) }) : t(msg("admin.noScanJob", "尚无扫描任务")));
  text('scan-detail', () => value.scanning ? String(value.job?.current_path || t(msg("admin.scanDetailReading", "正在读取根目录…"))) : Number(value.job?.errors ?? 0) ? t(msg("admin.scanDetailPartial", "部分目录无法读取，请检查下方路径或网络挂载。")) : t(msg("admin.scanDetailOk", "目录离线时保留已有视频索引。")));
  $('scan-cancel').hidden = !value.scanning; $('scan-refresh').toggleAttribute('disabled', value.scanning);
  $('scan-cancel').toggleAttribute('disabled', !value.scanning);
  const nodes = value.errors.map(error => { const row = document.createElement('div'); row.className = 'admin-error-row';
    const name = document.createElement('strong'); localizedText(name, () => `${value.roots.find(r => r.id === error.root_id)?.name ?? error.root_id} / ${error.path || t(msg("admin.rootFallback", "(根目录)"))}`);
    const code = document.createElement('span'); const rawCode = String(error.code); localizedText(code, () => ({ ENOENT: t(msg("admin.errNoEnt", "路径不存在")), EACCES: t(msg("admin.errAccess", "无法读取此目录")), EPERM: t(msg("admin.errAccess", "无法读取此目录")), ESTORAGECHANGED: t(msg("admin.errStorage", "网络存储已断开")) } as Record<string, string>)[rawCode] ?? rawCode); localizedAttribute(code, 'title', () => rawCode); row.append(name, code); return row; });
  $('scan-errors').replaceChildren(...nodes);
  const count = Number(value.job?.errors ?? 0); $('scan-issues').hidden = count === 0; $('scan-error-pages').hidden = count <= 100;
  text('scan-error-count', () => count ? t(msg("admin.scanErrors", "{count, plural, other {# 处读取错误}}{truncated}"), {count,truncated:value.errorDetailsTruncated ? t(msg('admin.errorTruncated', ' · 详情保留前 1000 条')) : ''}) : t(msg("admin.noReadErrors", "本次扫描没有读取错误")));
  $('errors-prev').toggleAttribute('disabled', errorsOffset === 0);
  $('errors-next').toggleAttribute('disabled', errorsOffset + value.errors.length >= Math.min(count, 1000));
}
function clearLog() { $('log-json').closest<HTMLElement>('.admin-log-detail')!.dataset.empty = 'true'; selectedLog = null; logDocument = undefined; ++logSequence; localizedText($('log-json'), () => ''); ($('log-json') as HTMLTextAreaElement).value = ''; text('log-description', () => t(msg("admin.selectLog", "选择一份日志查看内容"))); $('download-log').setAttribute('disabled', ''); $('delete-log').setAttribute('disabled', ''); $('delete-log-confirm').hidden = true; }
async function loadLogs() {
  const sequence = ++listSequence;
  const page = await api<Awaited<ReturnType<AdminController['logs']>>>(`/api/admin/logs?before=${encodeURIComponent(logCursor)}`);
  if (sequence !== listSequence) return;
  const users = await api<{ users: { id: string; name: string }[] }>('/api/users').catch(() => ({ users: [] }));
  if (sequence !== listSequence) return;
  for (const user of users.users) userNames.set(user.id, user.name);
  nextLog = page.next;
  $('more-logs').hidden = $('first-logs').hidden = !nextLog && !logCursor;
  $('more-logs').toggleAttribute('disabled', !nextLog); $('first-logs').toggleAttribute('disabled', !logCursor);
  if (!page.entries.length) {
    $('log-list').replaceChildren(emptyState(() => page.enabled ? t(msg("admin.noUploadedLogs", "暂无上传日志")) : t(msg("admin.logsDisabled", "未开启日志接收")), () => page.enabled ? t(msg("admin.logsEmptyHint", "在播放器的“设置 → 日志”中点击“上传日志”，即可在这里查看。")) : t(msg("admin.logsNoDir", "服务器未设置日志接收目录。你仍可在播放器中下载本地日志。")), true)); return;
  }
  const rows = page.entries.map(entry => {
    const button = document.createElement('button'); button.className = 'admin-log-item'; localizedAttribute(button, 'title', () => entry.name);
    button.setAttribute('aria-pressed', String(selectedLog?.name === entry.name));
    const title = document.createElement('strong'); localizedText(title, () => formatDate(entry.receivedAt));
    const detail = document.createElement('span'); localizedText(detail, () => `${bytes(entry.size)} · ${entry.name.split('-').at(-1)?.replace('.json', '')}`);
    button.append(title, detail); button.onclick = () => void act(async () => {
      clearLog(); selectedLog = entry; const request = ++logSequence;
      for (const row of $('log-list').querySelectorAll('button')) row.setAttribute('aria-pressed', String(row === button));
      const result = await api<Awaited<ReturnType<AdminController['readLog']>>>(`/api/admin/logs/${encodeURIComponent(entry.name)}?v=${entry.version}`);
      if (request !== logSequence) return;
      $('log-json').closest<HTMLElement>('.admin-log-detail')!.dataset.empty = 'false'; logDocument = result.document; ($('log-json') as HTMLTextAreaElement).value = JSON.stringify(result.document, null, 2);
      const receipt = (result.document as { serverReceipt?: { id?: string; actorId?: string } })?.serverReceipt;
      const received = receipt?.id && entry.name.includes(`-${receipt.id}-`);
      text('log-description', () => received ? t(msg("admin.logUploaderLine", "上传者：{user} · {size}"), { user: userNames.get(receipt.actorId ?? '') ?? receipt.actorId ?? t(msg("admin.unknownUser", "未知")), size: bytes(entry.size) }) : t(msg("admin.historyLogLine", "历史日志 · {size}"), { size: bytes(entry.size) }));
      $('download-log').removeAttribute('disabled'); $('delete-log').removeAttribute('disabled');
    }); return button;
  }); $('log-list').replaceChildren(...rows);
}
function renderRequests() {
  $('request-list').replaceChildren(...[...(status?.recentRequests ?? [])].reverse().map(request => {
    const row = document.createElement('div'); row.className = 'admin-request-row';
    const cells = () => [`${formatDate(String(request.t))} · ${userNames.get(String(request.actorId)) ?? (request.actorId === 'local' ? t(msg("admin.localUser", "本机用户")) : request.actorId ?? t(msg("admin.anonymous", "匿名")))}`, `${request.method} ${request.url}`, String(request.status), `${request.ms} ms`];
    for (let i=0; i<4; i++) { const span = document.createElement('span'); localizedText(span, () => cells()[i]); row.append(span); }
    return row;
  }));
}
const caches = installCaches(life.signal, notice);
const annotationAdmin = installAnnotationAdmin(life.signal, notice);
const savedWorkspaces = installWorkspaceAdmin(life.signal, notice);
const measurements = installMeasurements(life.signal, notice);
for (const [id] of PANES()) document.querySelector<HTMLButtonElement>(`[data-pane=${id}]`)!.onclick = () => {
  history.replaceState(null, '', `#${id}`); pane = id; measurements.activate(id === 'measurements'); notice(() => ''); for (const [item] of PANES()) { $(`pane-${item}`).hidden = id !== item; document.querySelector(`[data-pane=${item}]`)!.setAttribute('aria-current', id === item ? 'page' : 'false'); }
  if (id === 'library') void act(async () => { if (!rootConfig) await loadRoots(); await loadScan(); });
  if (id === 'caches') caches.activate();
  if (id === 'workspaces') savedWorkspaces.activate();
  if (id === 'annotations') annotationAdmin.activate();
  if (id === 'logs') void act(loadLogs);
};
$('add-root').onclick = () => { const row = rootRow({ id: randomUUID().replaceAll('-', '').slice(0, 16), name: '', path: '' }); $('root-editor').append(row); renderRootStates(); row.querySelector('input')!.focus(); rootDirty = true; updateRootActions(); };
$('reset-roots').onclick = () => void act(loadRoots);
$('roots-form').onsubmit = event => { event.preventDefault(); if (!rootConfig?.writable || rootSaving) return;
  void act(async () => {
    rootSaving = true; updateRootActions();
    try { rootConfig = await api<RootConfig>('/api/admin/roots', 'PUT', { revision: rootConfig!.revision, roots: readDraft() }); rootDirty = false; notice(() => t(msg("admin.dirsSavedNotice", "媒体目录已保存，后台开始校准索引。"))); renderRootStates(); await poll(); }
    finally { rootSaving = false; updateRootActions(); }
  });
};
$('scan-refresh').onclick = () => void act(async () => { await api('/api/admin/scan', 'POST', { action: 'refresh' }); await loadScan(); });
$('scan-cancel').onclick = () => void act(async () => { await api('/api/admin/scan', 'POST', { action: 'cancel' }); await loadScan(); });
$('errors-prev').onclick = () => { errorsOffset = Math.max(0, errorsOffset - 100); void act(loadScan); };
$('errors-next').onclick = () => { errorsOffset += 100; void act(loadScan); };
$('refresh-status').onclick = () => void poll(); $('refresh-logs').onclick = () => void act(logsMode === 'uploads' ? loadLogs : poll);
$('more-logs').onclick = () => { if (nextLog) { logCursor = nextLog; clearLog(); void act(loadLogs); } };
$('first-logs').onclick = () => { logCursor = ''; clearLog(); void act(loadLogs); };
for (const button of document.querySelectorAll<HTMLButtonElement>('[data-log-mode]')) button.onclick = () => {
  logsMode = button.dataset.logMode!; $('uploads-view').hidden = logsMode !== 'uploads'; $('requests-view').hidden = logsMode !== 'requests';
  for (const item of document.querySelectorAll('[data-log-mode]')) item.setAttribute('aria-pressed', String(item === button)); if (logsMode === 'requests') renderRequests();
};
$('download-log').onclick = () => { if (!selectedLog || logDocument === undefined) return; const url = URL.createObjectURL(new Blob([JSON.stringify(logDocument, null, 2)], { type: 'application/json' })); const a = document.createElement('a'); a.href = url; a.download = selectedLog.name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); };
$('delete-log').onclick = () => { $('delete-log-confirm').hidden = false; };
$('cancel-delete-log').onclick = () => { $('delete-log-confirm').hidden = true; };
$('confirm-delete-log').onclick = () => void act(async () => { if (!selectedLog) return; await api(`/api/admin/logs/${encodeURIComponent(selectedLog.name)}`, 'DELETE', undefined, { 'if-match': `"${selectedLog.version}"` }); clearLog(); await loadLogs(); notice(() => t(msg("admin.logDeleted", "日志已从服务器删除。"))); });
// Keep the original review alive when returning from its management tab.
// Direct visits, closed players, and modified clicks keep normal link behavior.
document.querySelector<HTMLAnchorElement>('.admin-back')!.onclick = event => {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  try {
    const player = window.opener as Window | null;
    if (!player || player.closed || player.location.origin !== location.origin || !['/', '/index.html'].includes(player.location.pathname)) return;
    event.preventDefault(); player.focus(); window.close();
  } catch { /* An opener on another origin is not a return destination. */ }
};
window.addEventListener('beforeunload', event => { if (rootDirty) { event.preventDefault(); event.returnValue = ''; } });
const timer = setInterval(() => void poll(), 3000);
window.addEventListener('pagehide', () => { clearInterval(timer); life.abort(); disposeTheme(); disposeLanguage(); }, { once: true });
document.addEventListener('visibilitychange', () => { if (!document.hidden) void poll(); }, { signal: life.signal });
installLiveLocalization(document.body, life.signal);
updateRootActions(); void poll();
void chooseInitialIdentity(life.signal).then(()=>poll()).catch(error=>notice(() => requestError(error),true));

const initialPane=location.hash.slice(1);if(PANES().some(([id])=>id===initialPane))document.querySelector<HTMLButtonElement>(`[data-pane="${initialPane}"]`)?.click();
