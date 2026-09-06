import '../themes/silver-glass.css';
import '../themes/dark.css';
import '../themes/accents.css';
import '../themes/accessibility.css';
import '../style.css';
import './style.css';
import { observeTheme } from '../ui/theme.ts';
import { icon } from '../ui/icons.ts';
import { adminShell, PANES } from './shell.ts';
import type { AdminController } from '../../server/admin.ts';
import type { MediaLibraryIndex } from '../../server/library.ts';

type Root = { id: string; name: string; path: string };
type RootConfig = Awaited<ReturnType<AdminController['roots']>>;
type LogEntry = Awaited<ReturnType<AdminController['logs']>>['entries'][number];
type Scan = ReturnType<MediaLibraryIndex['status']> & { errors: Record<string, unknown>[]; offset: number };
type Status = ReturnType<AdminController['status']> & { identity: { id: string; name: string }; http: { activeRequests: number; connections: number; completedRequests: number; abortedRequests: number }; recentRequests: Record<string, unknown>[] };
const app = document.getElementById('admin-app')!; app.innerHTML = adminShell();
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const life = new AbortController(); const disposeTheme = observeTheme();
const text = (id: string, value: string) => { $(id).textContent = value; };
const bytes = (n: number) => n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : n >= 1024 ** 2 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${(n / 1024).toFixed(1)} KB`;
const stateLabels: Record<string, string> = { ready: '可用', offline: '存储离线', scanning: '扫描中', partial: '部分路径不可读', cancelled: '已停止', unscanned: '等待扫描', error: '扫描出错', completed: '已完成', failed: '失败', running: '进行中', interrupted: '上次任务被中断' };
let pane = 'overview', rootConfig: RootConfig | null = null, rootDirty = false, rootSaving = false;
let status: Status | null = null, polling = false, errorsOffset = 0, errorsJob: unknown = null;
let logCursor = '', nextLog: string | null = null, selectedLog: LogEntry | null = null;
let logDocument: unknown, logsMode = 'uploads', logSequence = 0, listSequence = 0, scanSequence = 0;
function notice(message: string, error = false) { text('admin-message', message); $('admin-message').hidden = !message; $('admin-message').dataset.error = String(error); }
async function api<T>(url: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}): Promise<T> {
  const response = await fetch(url, { method, cache: 'no-store', headers: { ...(method !== 'GET' ? { 'x-voidplayer-action': 'admin', 'content-type': 'application/json' } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.any([life.signal, AbortSignal.timeout(15000)]) });
  const value = await response.json();
  if (!response.ok) throw Object.assign(new Error(value.error ?? `请求失败 (${response.status})`), { status: response.status });
  return value;
}
const act = async (action: () => Promise<void>) => { try { await action(); } catch (error) { if (!life.signal.aborted) notice((error as Error).message, true); } };
function updateRootActions() {
  $('save-roots').toggleAttribute('disabled', !rootDirty || rootSaving || !rootConfig?.writable);
  $('reset-roots').toggleAttribute('disabled', !rootDirty || rootSaving);
  $('add-root').toggleAttribute('disabled', rootSaving || !rootConfig?.writable);
  for (const control of $('root-editor').querySelectorAll<HTMLInputElement | HTMLButtonElement>('input,button')) control.disabled = rootSaving || !rootConfig?.writable;
  text('root-save-state', rootConfig?.reason ?? (rootSaving ? '正在保存…' : rootDirty ? '有未保存的修改' : '目录配置已保存'));
}
function readDraft(): Root[] {
  return [...$('root-editor').querySelectorAll<HTMLElement>('.admin-root-row')].map(row => ({ id: row.dataset.id!, name: row.querySelector<HTMLInputElement>('[data-field=name]')!.value.trim(), path: row.querySelector<HTMLInputElement>('[data-field=path]')!.value.trim() }));
}
function rootRow(root: Root) {
  const row = document.createElement('div'); row.className = 'admin-root-row'; row.dataset.id = root.id;
  row.innerHTML = `<div><input data-field="name" aria-label="目录名称" required maxlength="120"><span data-root-state class="admin-root-state"></span></div><input data-field="path" aria-label="服务器上的目录路径" required maxlength="4096" spellcheck="false"><button type="button" class="icon-button admin-danger" aria-label="移除目录">${icon('trash')}</button>`;
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
    badge.textContent = root ? stateLabels[String(root.state)] ?? String(root.state) : '保存后开始索引';
    badge.dataset.state = String(root?.state ?? 'unscanned');
  }
}
function renderStatus(value: Status) {
  status = value;
  const seconds = Math.floor(value.uptimeSeconds), hours = Math.floor(seconds / 3600);
  text('uptime', hours ? `${hours} 小时 ${Math.floor(seconds % 3600 / 60)} 分` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`);
  text('memory', bytes(value.memory.rss)); text('cpu', `${value.cpuPercent.toFixed(1)}%`); text('connections', String(value.http.connections));
  text('version', `${value.version} · ${value.revision}`); text('runtime', `${value.runtime} · ${value.platform}`);
  text('data-dir', value.dataDir); text('identity', `${value.identity.name} · ${value.identity.id}`);
  text('system-memory', `${bytes(value.memory.systemFree)} / ${bytes(value.memory.systemTotal)}`);
  text('requests', `${value.http.completedRequests} 次完成 · ${value.http.activeRequests} 次处理中 · ${value.http.abortedRequests} 次中断`);
  text('root-summary', `${value.library.roots.length} 个目录 · ${value.library.roots.filter(r => r.state === 'offline').length} 个离线`);
  const job = value.library.job;
  text('scan-summary', value.library.scanning ? `扫描中 · ${job?.visited ?? 0} 个目录` : job ? `${stateLabels[String(job.state)] ?? job.state} · ${job.files} 个媒体` : '尚未扫描');
  const watch = value.library.watch;
  text('watch-summary', watch ? `${watch.active} / ${watch.limit} 个目录${watch.limited ? ' · 其余由周期校准覆盖' : ''}${watch.unavailableRoots.length ? ' · 部分目录监听不可用' : ''}` : '仅周期校准');
  renderRootStates();
  if (pane === 'logs' && logsMode === 'requests') renderRequests();
}
async function poll() {
  if (polling || document.hidden) return; polling = true;
  try { renderStatus(await api<Status>('/api/admin/status')); if (app.dataset.denied) { delete app.dataset.denied; notice(''); } if (pane === 'library') await loadScan(); }
  catch (error) { if (!life.signal.aborted) { if ([401, 403].includes(Number((error as { status?: number }).status))) app.dataset.denied = 'true'; notice((error as Error).message, true); } }
  finally { polling = false; }
}
async function loadScan() {
  const sequence = ++scanSequence;
  const value = await api<Scan>(`/api/admin/scan?offset=${errorsOffset}`);
  if (sequence !== scanSequence) return;
  if (errorsJob !== value.job?.id) { errorsJob = value.job?.id; if (errorsOffset) { errorsOffset = 0; return loadScan(); } }
  text('scan-progress', value.job ? `${stateLabels[String(value.job.state)] ?? value.job.state} · ${value.job.visited} 个目录 · ${value.job.files} 个媒体` : '尚无扫描任务');
  text('scan-detail', value.scanning ? String(value.job?.current_path || '正在读取根目录…') : '手动校准检查所有根目录；离线或不可读的路径保留上次索引。');
  $('scan-cancel').toggleAttribute('disabled', !value.scanning);
  const nodes = value.errors.map(error => { const row = document.createElement('div'); row.className = 'admin-error-row';
    const name = document.createElement('strong'); name.textContent = `${value.roots.find(r => r.id === error.root_id)?.name ?? error.root_id} / ${error.path || '(根目录)'}`;
    const code = document.createElement('span'); code.textContent = String(error.code); row.append(name, code); return row; });
  $('scan-errors').replaceChildren(...nodes);
  const count = Number(value.job?.errors ?? 0);
  text('scan-error-count', count ? `${count} 处读取错误${value.errorDetailsTruncated ? ' · 详情保留前 1000 条' : ''}` : '本次扫描没有读取错误');
  $('errors-prev').toggleAttribute('disabled', errorsOffset === 0);
  $('errors-next').toggleAttribute('disabled', errorsOffset + value.errors.length >= Math.min(count, 1000));
}
function clearLog() { selectedLog = null; logDocument = undefined; ++logSequence; $('log-json').textContent = ''; ($('log-json') as HTMLTextAreaElement).value = ''; text('log-description', '选择一份日志'); $('download-log').setAttribute('disabled', ''); $('delete-log').setAttribute('disabled', ''); $('delete-log-confirm').hidden = true; }
async function loadLogs() {
  const sequence = ++listSequence;
  const page = await api<Awaited<ReturnType<AdminController['logs']>>>(`/api/admin/logs?before=${encodeURIComponent(logCursor)}`);
  if (sequence !== listSequence) return;
  nextLog = page.next;
  $('more-logs').toggleAttribute('disabled', !nextLog); $('first-logs').toggleAttribute('disabled', !logCursor);
  if (!page.entries.length) {
    const empty = document.createElement('p'); empty.className = 'admin-empty'; empty.textContent = page.enabled ? '暂无上传日志' : '服务端未启用日志接收'; $('log-list').replaceChildren(empty); return;
  }
  const rows = page.entries.map(entry => {
    const button = document.createElement('button'); button.className = 'admin-log-item'; button.title = entry.name;
    button.setAttribute('aria-pressed', String(selectedLog?.name === entry.name));
    const title = document.createElement('strong'); title.textContent = new Date(entry.receivedAt).toLocaleString();
    const detail = document.createElement('span'); detail.textContent = `${bytes(entry.size)} · ${entry.name.split('-').at(-1)?.replace('.json', '')}`;
    button.append(title, detail); button.onclick = () => void act(async () => {
      clearLog(); selectedLog = entry; const request = ++logSequence;
      for (const row of $('log-list').querySelectorAll('button')) row.setAttribute('aria-pressed', String(row === button));
      const result = await api<Awaited<ReturnType<AdminController['readLog']>>>(`/api/admin/logs/${encodeURIComponent(entry.name)}?v=${entry.version}`);
      if (request !== logSequence) return;
      logDocument = result.document; ($('log-json') as HTMLTextAreaElement).value = JSON.stringify(result.document, null, 2);
      const receipt = (result.document as { serverReceipt?: { id?: string; actorId?: string } })?.serverReceipt;
      const received = receipt?.id && entry.name.includes(`-${receipt.id}-`);
      text('log-description', received ? `上传者：${receipt.actorId ?? '未知'} · ${bytes(entry.size)}` : `历史日志 · ${bytes(entry.size)}`);
      $('download-log').removeAttribute('disabled'); $('delete-log').removeAttribute('disabled');
    }); return button;
  }); $('log-list').replaceChildren(...rows);
}
function renderRequests() {
  $('request-list').replaceChildren(...[...(status?.recentRequests ?? [])].reverse().map(request => {
    const row = document.createElement('div'); row.className = 'admin-request-row';
    for (const value of [`${new Date(String(request.t)).toLocaleTimeString()} · ${request.actorId ?? '匿名'}`, `${request.method} ${request.url}`, String(request.status), `${request.ms} ms`]) { const span = document.createElement('span'); span.textContent = value; row.append(span); }
    return row;
  }));
}
for (const [id] of PANES) document.querySelector<HTMLButtonElement>(`[data-pane=${id}]`)!.onclick = () => {
  pane = id; if (!app.dataset.denied) notice(''); for (const [item] of PANES) { $(`pane-${item}`).hidden = id !== item; document.querySelector(`[data-pane=${item}]`)!.setAttribute('aria-current', id === item ? 'page' : 'false'); }
  if (id === 'library') void act(async () => { if (!rootConfig) await loadRoots(); await loadScan(); });
  if (id === 'logs') void act(loadLogs);
};
$('add-root').onclick = () => { const row = rootRow({ id: crypto.randomUUID().replaceAll('-', '').slice(0, 16), name: '', path: '' }); $('root-editor').append(row); row.querySelector('input')!.focus(); rootDirty = true; updateRootActions(); };
$('reset-roots').onclick = () => void act(loadRoots);
$('roots-form').onsubmit = event => { event.preventDefault(); if (!rootConfig?.writable || rootSaving) return;
  void act(async () => {
    rootSaving = true; updateRootActions();
    try { rootConfig = await api<RootConfig>('/api/admin/roots', 'PUT', { revision: rootConfig!.revision, roots: readDraft() }); rootDirty = false; notice('媒体目录已保存，后台开始校准索引。'); renderRootStates(); await poll(); }
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
$('confirm-delete-log').onclick = () => void act(async () => { if (!selectedLog) return; await api(`/api/admin/logs/${encodeURIComponent(selectedLog.name)}`, 'DELETE', undefined, { 'if-match': `"${selectedLog.version}"` }); clearLog(); await loadLogs(); notice('日志已从服务器删除。'); });
window.addEventListener('beforeunload', event => { if (rootDirty) { event.preventDefault(); event.returnValue = ''; } });
const timer = setInterval(() => void poll(), 3000);
window.addEventListener('pagehide', () => { clearInterval(timer); life.abort(); disposeTheme(); }, { once: true });
document.addEventListener('visibilitychange', () => { if (!document.hidden) void poll(); }, { signal: life.signal });
updateRootActions(); void poll();
