import { installAdminLibraryBrowser } from './library-browser.ts';
import { PollingCadence } from '../services/polling-cadence.ts';
import { confirmedActor, observeIdentity } from '../services/identity.ts';
import { installAnalysisSettings } from './analysis.ts';
import { requestError, rootReason } from './diagnostics.ts';
import { apiError } from '../services/api-error.ts';
import { mountLocalizedShell } from '../ui/localized-shell.ts';
import { installLanguageControls } from '../ui/language.ts';
import { installFocusFeedback } from '../ui/focus-feedback.ts';
import { installToasts } from '../ui/toast.ts';
import { installTooltips } from '../ui/tooltips.ts';
import { installLiveLocalization, localizedText, localizedFragment, localizedAttribute, type LocalizedValue } from '../ui/live-localization.ts';
import { initializeLanguage, onLanguageChange, formatDate, t, th, msg } from '../i18n.ts';
import { chooseInitialIdentity } from '../ui/identity-onboarding.ts';
import { installAnnotationAdmin } from './annotations.ts';
import { emptyState } from './presentation.ts';
import { renderLogStorage } from './log-storage.ts';
import { installCaches } from './caches.ts';
import { randomUUID } from '../../shared/utils/uuid.ts';
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
import type {AdminStatus,RootConfiguration as RootConfig,LogPage,LogDocument,LibraryScanStatus} from '../../shared/service/admin.ts';

type Root = { id: string; name: string; path: string };

type LogEntry = LogPage['entries'][number];
type Scan = LibraryScanStatus & { errors: Record<string, unknown>[]; offset: number };
type Status = AdminStatus & { identity: { id: string; name: string }; http: { activeRequests: number; connections: number; completedRequests: number; abortedRequests: number } };
const disposeLanguage = await initializeLanguage();
const life = new AbortController();
const toasts = installToasts(life.signal);
toasts.stack.classList.add('admin-toast-stack');
installFocusFeedback(life.signal);
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
let polling = false, errorsOffset = 0, errorsJob: unknown = null;
let scanStatus: LibraryScanStatus | null = null;
const postingScans = new Set<string>();
let rootStates: LibraryScanStatus['roots'] = [], recentRequests: Record<string, unknown>[] = [];
let requestSnapshot: { actor: string; etag?: string; records: Record<string, unknown>[] } | undefined;
let requestEpoch = 0, requestAbort: AbortController | undefined;
const scanCadence = new PollingCadence(3000), requestCadence = new PollingCadence(3000);
let logCursor = '', nextLog: string | null = null, selectedLog: LogEntry | null = null;
const userNames = new Map<string, string>();
let logDocument: unknown, logsMode = 'uploads', logSequence = 0, listSequence = 0, scanSequence = 0;
let dismissNotice: (() => void) | undefined;
function notice(message: LocalizedValue, error = false) {
  statusError = false;
  const value = typeof message === 'function' ? message() : message;
  const kind = error ? 'error' : 'info';
  const current = toasts.stack.querySelector('.toast:not([data-leaving])');
  if (value && current?.querySelector('.toast-message')?.textContent === value && current.classList.contains('toast-error') === error) return;
  dismissNotice?.();
  dismissNotice = value ? toasts.show(message, {kind}) : undefined;
}
async function api<T>(url: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}): Promise<T> {
  const response = await fetch(url, { method, cache: 'no-store', headers: { ...(method !== 'GET' ? { 'x-voidplayer-action': 'admin', 'content-type': 'application/json' } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.any([life.signal, AbortSignal.timeout(15000)]) });
  const value = await response.json();
  if (!response.ok) throw apiError(response.status, value);
  return value;
}
const act = async (action: () => Promise<void>) => { try { await action(); } catch (error) { if (!life.signal.aborted) notice(() => requestError(error), true); } };
function pendingRoot() {
  return [...$('root-editor').querySelectorAll<HTMLElement>('.admin-root-row')].find(row => !rootConfig?.roots.some(root => root.id === row.dataset.id));
}
function updateRootActions() {
  $('save-roots').toggleAttribute('disabled', !rootDirty || rootSaving || !rootConfig?.writable);
  $('reset-roots').toggleAttribute('disabled', !rootDirty || rootSaving);
  $('add-root').toggleAttribute('disabled', rootSaving || !rootConfig?.writable || !!pendingRoot());
  for (const control of $('root-editor').querySelectorAll<HTMLInputElement | HTMLButtonElement>('input,button:not(.admin-root-scan)')) control.disabled = rootSaving || !rootConfig?.writable;
  $('roots-form').setAttribute('aria-busy',String(rootSaving));
  renderRootStates();
}
function readDraft(): Root[] {
  return [...$('root-editor').querySelectorAll<HTMLElement>('.admin-root-row')].map(row => ({ id: row.dataset.id!, name: row.querySelector<HTMLInputElement>('[data-field=name]')!.value.trim(), path: row.querySelector<HTMLInputElement>('[data-field=path]')!.value.trim() }));
}
function rootRow(root: Root) {
  const row = document.createElement('div'); row.className = 'admin-root-row'; row.dataset.id = root.id;
  localizedFragment(row, () => `<label><input data-field="name" aria-label="${th(msg("admin.dirNameAria", "目录名称"))}" placeholder="${th(msg("admin.dirNamePh", "例如：拍摄素材"))}" required maxlength="120"></label><label><input data-field="path" aria-label="${th(msg("admin.serverPathAria", "服务器上的目录路径"))}" placeholder="${th(msg("admin.serverPathPh", "填写完整目录路径"))}" required maxlength="4096" spellcheck="false"></label><button type="button" class="icon-button admin-root-scan">${icon('refresh')}</button><button type="button" class="icon-button admin-danger" aria-label="${th(msg("admin.removeDir", "移除目录"))}" title="${th(msg("admin.removeDirTitle", "移出媒体库，不删除文件"))}">${icon('trash')}</button>`);
  row.querySelector<HTMLInputElement>('[data-field=name]')!.value = root.name;
  row.querySelector<HTMLInputElement>('[data-field=path]')!.value = root.path;
  for (const input of row.querySelectorAll('input')) { input.disabled = !rootConfig?.writable; input.addEventListener('input', () => { rootDirty = true; updateRootActions(); renderRootStates(); }); }
  row.querySelector<HTMLButtonElement>('.admin-danger')!.disabled = !rootConfig?.writable;
  row.querySelector<HTMLButtonElement>('.admin-danger')!.onclick = () => { row.remove(); rootDirty = true; updateRootActions(); };
  const scan=row.querySelector<HTMLButtonElement>('.admin-root-scan')!;
  scan.onclick=() => void act(async () => {
    if (scan.getAttribute('aria-disabled')==='true') return;
    postingScans.add(root.id); renderRootStates();
    try {
      scanStatus=await api<LibraryScanStatus>('/api/admin/scan','POST',{action:'refresh',rootId:root.id});
      rootStates=scanStatus.roots;
      scanCadence.reset(); await loadScan();
    } finally { postingScans.delete(root.id); renderRootStates(); }
  });
  return row;
}
async function loadRoots() {
  rootConfig = await api<RootConfig>('/api/admin/roots'); rootDirty = false;
  $('root-editor').replaceChildren(...rootConfig.roots.map(rootRow)); updateRootActions(); renderRootStates();
  const {reasonCode,reason}=rootConfig;
  if (reason) notice(() => rootReason(reasonCode,reason),true);
}
function renderRootStates() {
  for (const row of $('root-editor').querySelectorAll<HTMLElement>('.admin-root-row')) {
    const root = rootStates.find(r => r.id === row.dataset.id);
    const button=row.querySelector<HTMLButtonElement>('.admin-root-scan')!;
    const configured=rootConfig?.roots.find(item => item.id===row.dataset.id);
    const input=row.querySelector<HTMLInputElement>('[data-field=path]')!;
    const name=row.querySelector<HTMLInputElement>('[data-field=name]')!;
    const draft=!configured || input.value.trim()!==configured.path || name.value.trim()!==configured.name;
    const requested=postingScans.has(row.dataset.id!) || !!root?.scanRequested;
    const busy=requested || root?.state==='scanning';
    const code=draft ? 'draft' : root?.state==='scanning' ? 'scanning' : requested ? 'unscanned' : String(root?.state??'unscanned');
    button.setAttribute('aria-disabled',String(rootSaving || draft || busy));
    button.setAttribute('aria-busy',String(busy));
    button.dataset.state=code;
    button.querySelector('.icon')!.classList.toggle('share-spinner',busy);
    localizedAttribute(button,'aria-label',() => t(msg('admin.scanRoot','扫描目录：{name}'),{name:name.value.trim()}));
    localizedAttribute(button,'data-tooltip',() => {
      const label=t(msg('admin.scanRoot','扫描目录：{name}'),{name:name.value.trim()});
      const state=draft ? t(msg('admin.rootDraft','待保存'))
        : code==='ready' ? t(msg('admin.rootScanned','已扫描')) : stateLabels[code]??code;
      const current=scanStatus?.scanning && scanStatus.job?.current_root===root?.id;
      const progress=current ? t(msg('admin.scanCurrentProgress','本轮已读取 {directories, plural, other {# 个目录}}、{media, plural, other {# 个媒体}}'),
        {directories:Number(scanStatus?.job?.visited??0),media:Number(scanStatus?.job?.files??0)}) : '';
      return [label,state,progress,current ? String(scanStatus?.job?.current_path??'') : '',
        draft ? '' : String(root?.error??''),!busy && root?.scannedAt ? formatDate(Number(root.scannedAt)) : ''].filter(Boolean).join('\n');
    });
  }
}
function scanSummary(value: LibraryScanStatus) {
  const offline=value.roots.filter(root => root.state==='offline').length;
  const errors=Number(value.job?.errors??0), state=String(value.job?.state??'');
  const phase=value.scanning ? value.scanMode==='full' ? t(msg('admin.scanFullActive','全量扫描中')) : t(msg('admin.scanIncrementalActive','增量扫描中'))
    : value.queuedDirectories>0 ? t(msg('admin.scanQueued','等待扫描'))
    : ['failed','interrupted','cancelled'].includes(state) ? stateLabels[state]
    : !value.ready ? t(msg('admin.stateUnscanned','等待扫描'))
    : errors || value.roots.some(root => root.state==='partial'||root.state==='error') ? t(msg('admin.scanHasIssues','扫描存在异常'))
    : t(msg('admin.scanIdle','扫描空闲'));
  return [phase,t(msg('admin.libraryInventory','已收录 {count} 个媒体'),{count:value.inventory.media}),
    value.inventory.pending ? t(msg('admin.scanPendingFiles','{count} 个文件等待稳定'),{count:value.inventory.pending}) : '',
    value.queuedDirectories ? t(msg('admin.scanQueuedDirectories','{count} 个目录待扫描'),{count:value.queuedDirectories}) : '',
    offline ? t(msg('admin.scanOfflineRoots','{count} 个媒体库离线'),{count:offline}) : '',
    errors ? t(msg('admin.scanErrorTotal','{count} 处读取错误'),{count:errors}) : ''].filter(Boolean).join(' · ');
}
function renderStatus(value: Status) {
  scanStatus=value.library; rootStates = value.library.roots;
  analysisSettings.update(value.analysis);
  const seconds = Math.floor(value.uptimeSeconds), hours = Math.floor(seconds / 3600);
  text('uptime', () => hours ? t(msg("admin.hoursMinutes", "{h} 小时 {m} 分"), { h: hours, m: Math.floor(seconds % 3600 / 60) }) : t(msg("activity.durationMinutesSeconds", "{m} 分 {s} 秒"), { m: Math.floor(seconds / 60), s: seconds % 60 }));
  text('memory', () => bytes(value.memory.rss)); text('cpu', () => `${value.cpuPercent.toFixed(1)}%`); text('connections', () => String(value.http.connections));
  text('version', () => `${value.version} · ${value.revision}`); text('runtime', () => `${value.runtime} · ${value.platform}`);
  text('data-dir', () => value.dataDir); text('identity', () => value.identity.name); localizedAttribute($('identity'), 'title', () => value.identity.id);
  text('system-memory', () => `${bytes(value.memory.systemFree)} / ${bytes(value.memory.systemTotal)}`);
  text('requests', () => t(msg("admin.requestsSummary", "{done} 次完成 · {active} 次处理中 · {aborted} 次中断"), { done: value.http.completedRequests, active: value.http.activeRequests, aborted: value.http.abortedRequests }));
  text('root-summary', () => t(msg("admin.rootsSummary", "{n, plural, other {# 个目录}} · {o} 个离线"), { n: value.library.roots.length, o: value.library.roots.filter(r => r.state === 'offline').length }));
  text('scan-summary', () => scanSummary(value.library));
  const watch = value.library.watch;
  text('watch-summary', () => watch ? t(msg("admin.watchSummary", "{active} / {limit, plural, other {# 个目录}}{calibration}{partial}"), {active:watch.active,limit:watch.limit,calibration:watch.limited ? t(msg('admin.watchCalibrated', ' · 其余由周期校准覆盖')) : '',partial:watch.unavailableRoots.length ? t(msg('admin.watchPartial', ' · 部分目录监听不可用')) : ''}) : t(msg("admin.watchPollOnly", "仅周期校准")));
  renderRootStates();
  if (pane === 'logs' && logsMode === 'requests') renderRequests();
}
async function poll(force = false) {
  if (polling || document.hidden) return; polling = true;
  try {
    if (pane === 'overview') renderStatus(await api<Status>('/api/admin/status?view=overview'));
    if (scanCadence.ready(pane === 'library') || force && pane === 'library') await loadScan();
    if (requestCadence.ready(pane === 'logs' && logsMode === 'requests') || force && pane === 'logs' && logsMode === 'requests') {
      await loadRequests();
    }
    if (statusError) notice(() => '');
  }
  catch (error) { if (!life.signal.aborted) { notice(() => requestError(error), true); statusError = true; } }
  finally { polling = false; }
}
async function loadRequests() {
  const actor = confirmedActor()?.id, epoch = requestEpoch;
  if (!actor) return;
  const cached = requestSnapshot?.actor === actor ? requestSnapshot : undefined;
  const controller = requestAbort = new AbortController();
  try {
    const response = await fetch('/api/admin/requests', { cache: 'no-store', headers: cached?.etag ? { 'if-none-match': cached.etag } : {},
      signal: AbortSignal.any([life.signal, controller.signal, AbortSignal.timeout(15000)]) });
    if (epoch !== requestEpoch || actor !== confirmedActor()?.id || controller.signal.aborted) return;
    let records: Record<string, unknown>[];
    if (response.status === 304 && cached) records = cached.records;
    else {
      const value = await response.json();
      if (!response.ok) throw apiError(response.status, value);
      records = value.recentRequests;
    }
    if (epoch !== requestEpoch || actor !== confirmedActor()?.id || controller.signal.aborted) return;
    requestSnapshot = { actor, etag: response.headers.get('etag') ?? (response.status === 304 ? cached?.etag : undefined), records };
    recentRequests = records; requestCadence.observe(records); renderRequests();
  } catch (error) { if (!controller.signal.aborted) throw error; }
  finally { if (requestAbort === controller) requestAbort = undefined; }
}
async function loadScan() {
  const sequence = ++scanSequence;
  const value = await api<Scan>(`/api/admin/scan?offset=${errorsOffset}`);
  if (sequence !== scanSequence) return;
  scanStatus=value; rootStates = value.roots; renderRootStates();
  scanCadence.observe([value.ready, value.scanning, value.job?.state, value.job?.files, value.job?.errors,
    value.inventory,value.queuedDirectories,value.job?.current_path,value.roots.map(root => [root.id, root.state, root.error])], value.scanning || value.queuedDirectories>0 || value.inventory.pending>0);
  if (errorsJob !== value.job?.id) { errorsJob = value.job?.id; if (errorsOffset) { errorsOffset = 0; return loadScan(); } }
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
  const page = await api<LogPage>(`/api/admin/logs?before=${encodeURIComponent(logCursor)}`);
  if (sequence !== listSequence) return;
  renderLogStorage($('log-storage'), page.storage, bytes);
  const users = await api<{ users: { id: string; name: string }[] }>('/api/users').catch(() => ({ users: [] }));
  if (sequence !== listSequence) return;
  for (const user of users.users) userNames.set(user.id, user.name);
  nextLog = page.next;
  $('more-logs').hidden = $('first-logs').hidden = !nextLog && !logCursor;
  $('more-logs').toggleAttribute('disabled', !nextLog); $('first-logs').toggleAttribute('disabled', !logCursor);
  if (!page.entries.length) {
    $('log-list').replaceChildren(emptyState(() => page.enabled ? t(msg("admin.noUploadedLogs", "暂无上传日志")) : t(msg("admin.logsDisabled", "未开启日志接收")), () => page.enabled ? t(msg("admin.logsEmptyHint", "在播放器的“设置 → 日志”中点击“上传日志”，即可在这里查看。")) : t(msg("admin.logsNoDir", "服务器未设置日志接收目录。你仍可在播放器中下载本地日志。")), true)); return;
  }
  const rows = page.entries.map((entry, index) => {
    const button = document.createElement('button'); button.className = 'admin-log-item source-row';
    button.classList.toggle('source-striped', index % 2 === 1);
    button.classList.toggle('in-use', selectedLog?.name === entry.name); localizedAttribute(button, 'title', () => entry.name);
    button.setAttribute('aria-pressed', String(selectedLog?.name === entry.name));
    const title = document.createElement('strong'); localizedText(title, () => formatDate(entry.receivedAt));
    const detail = document.createElement('span'); localizedText(detail, () => `${bytes(entry.size)} · ${entry.name.split('-').at(-1)?.replace('.json', '')}`);
    button.append(title, detail); button.onclick = () => void act(async () => {
      clearLog(); selectedLog = entry; const request = ++logSequence;
      for (const row of $('log-list').querySelectorAll('button')) {
        row.setAttribute('aria-pressed', String(row === button));
        row.classList.toggle('in-use', row === button);
      }
      const result = await api<LogDocument>(`/api/admin/logs/${encodeURIComponent(entry.name)}?v=${entry.version}`);
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
  $('request-list').replaceChildren(...recentRequests.slice().reverse().map(request => {
    const row = document.createElement('div'); row.className = 'admin-request-row';
    const cells = () => [`${formatDate(String(request.t))} · ${userNames.get(String(request.actorId)) ?? (request.actorId === 'local' ? t(msg("admin.localUser", "本机用户")) : request.actorId ?? t(msg("admin.anonymous", "匿名")))} · ${request.clientIp ?? '—'}`, `${request.method} ${request.url}`, String(request.status), `${request.ms} ms`];
    for (let i=0; i<4; i++) { const span = document.createElement('span'); localizedText(span, () => cells()[i]); row.append(span); }
    return row;
  }));
}
const analysisSettings = installAnalysisSettings(life.signal, api, notice);
const caches = installCaches(life.signal, notice);
const annotationAdmin = installAnnotationAdmin(life.signal, notice);
const savedWorkspaces = installWorkspaceAdmin(life.signal, notice);
const measurements = installMeasurements(life.signal, notice);
const libraryBrowser = installAdminLibraryBrowser(life.signal, message => notice(message));
const disposeTooltips=installTooltips(app);
life.signal.addEventListener('abort',disposeTooltips,{once:true});
for (const [id] of PANES()) document.querySelector<HTMLButtonElement>(`[data-pane=${id}]`)!.onclick = () => {
  history.replaceState(null, '', `#${id}`); pane = id; measurements.activate(id === 'measurements'); notice(() => ''); for (const [item] of PANES()) { $(`pane-${item}`).hidden = id !== item; document.querySelector(`[data-pane=${item}]`)!.setAttribute('aria-current', id === item ? 'page' : 'false'); }
  libraryBrowser.activate(id === 'library');
  scanCadence.reset(); requestCadence.reset();
  if (id === 'overview') {void analysisSettings.load();}
  if (id === 'library') void act(async () => { if (!rootConfig || !rootDirty) await loadRoots(); await loadScan(); });
  if (id === 'caches') caches.activate();
  if (id === 'workspaces') savedWorkspaces.activate();
  if (id === 'annotations') annotationAdmin.activate();
  if (id === 'logs') void act(logsMode === 'requests' ? () => poll(true) : loadLogs);
};
$('add-root').onclick = () => {
  if (rootSaving || !rootConfig?.writable) return;
  const pending = pendingRoot();
  if (pending) { pending.querySelector('input')!.focus(); return; }
  const row = rootRow({ id: randomUUID().replaceAll('-', '').slice(0, 16), name: '', path: '' });
  $('root-editor').append(row); row.querySelector('input')!.focus(); rootDirty = true; updateRootActions();
};
$('reset-roots').onclick = () => void act(loadRoots);
$('roots-form').onsubmit = event => { event.preventDefault(); if (!rootConfig?.writable || rootSaving) return;
  void act(async () => {
    rootSaving = true; updateRootActions();
    try { rootConfig = await api<RootConfig>('/api/admin/roots', 'PUT', { revision: rootConfig!.revision, roots: readDraft() }); rootDirty = false; renderRootStates(); await libraryBrowser.refresh(); await poll(); }
    finally { rootSaving = false; updateRootActions(); }
  });
};
$('errors-prev').onclick = () => { errorsOffset = Math.max(0, errorsOffset - 100); void act(loadScan); };
$('errors-next').onclick = () => { errorsOffset += 100; void act(loadScan); };
$('refresh-status').onclick = () => void poll(true); $('refresh-logs').onclick = () => void act(logsMode === 'uploads' ? loadLogs : () => poll(true));
$('more-logs').onclick = () => { if (nextLog) { logCursor = nextLog; clearLog(); void act(loadLogs); } };
$('first-logs').onclick = () => { logCursor = ''; clearLog(); void act(loadLogs); };
for (const button of document.querySelectorAll<HTMLButtonElement>('[data-log-mode]')) button.onclick = () => {
  logsMode = button.dataset.logMode!; $('uploads-view').hidden = logsMode !== 'uploads'; $('requests-view').hidden = logsMode !== 'requests';
  for (const item of document.querySelectorAll('[data-log-mode]')) item.setAttribute('aria-pressed', String(item === button)); if (logsMode === 'requests') void poll(true);
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
window.addEventListener('beforeunload', event => { if (rootDirty || analysisSettings.dirty) { event.preventDefault(); event.returnValue = ''; } });
const timer = setInterval(() => void poll(), 3000);
window.addEventListener('pagehide', () => { clearInterval(timer); life.abort(); disposeTheme(); disposeLanguage(); }, { once: true });
document.addEventListener('visibilitychange', () => { if (!document.hidden) { scanCadence.reset(); requestCadence.reset(); void poll(true); } }, { signal: life.signal });
installLiveLocalization(document.body, life.signal);
observeIdentity(life.signal, {
  invalidated() {
    requestEpoch++; requestAbort?.abort(); requestSnapshot = undefined; recentRequests = [];
    requestCadence.reset(); renderRequests();
  },
  confirmed() { if (pane === 'logs' && logsMode === 'requests') void poll(true); },
});
updateRootActions(); void analysisSettings.load();
void chooseInitialIdentity(life.signal).then(()=>poll()).catch(error=>notice(() => requestError(error),true));

const initialPane=location.hash.slice(1);if(PANES().some(([id])=>id===initialPane))document.querySelector<HTMLButtonElement>(`[data-pane="${initialPane}"]`)?.click();
