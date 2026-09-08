import type { CacheEntry, CacheKind, CacheManager } from '../../server/caches.ts';
import { icon } from '../ui/icons.ts';
import { frameIndexTools } from '../frame-index-admin.ts';
import { emptyState } from './presentation.ts';

type Overview = Awaited<ReturnType<CacheManager['overview']>>;
type Page = { entries: CacheEntry[]; nextOffset: number | null; count: number };
const bytes = (value: number) => { const unit = value >= 1024 ** 3 ? 3 : value >= 1024 ** 2 ? 2 : value >= 1024 ? 1 : 0; return `${(value / 1024 ** unit).toLocaleString(undefined, { maximumFractionDigits: unit ? 1 : 0 })} ${['B', 'KiB', 'MiB', 'GiB'][unit]}`; };
export function cacheShell() {
  return `<section id="pane-caches" hidden>
    <header class="admin-heading"><div><h1>缓存</h1><p>查看占用，清理可重新生成的数据。</p></div><button id="cache-refresh" class="icon-button" aria-label="刷新缓存">${icon('refresh')}</button></header>
    <div class="cache-overview"><div class="cache-total"><span>缓存内容</span><strong id="cache-total-bytes">—</strong><span id="cache-total-count">正在读取…</span></div><div class="cache-volume"><div class="cache-volume-heading"><span>所在磁盘</span><span id="cache-volume-free">—</span></div><div class="cache-volume-bar" role="meter" aria-label="磁盘占用"><span></span></div><div class="cache-volume-caption"><span id="cache-volume-used">—</span><span id="cache-volume-total">—</span></div></div></div>
    <div class="cache-toolbar"><div class="cache-tabs" role="group" aria-label="缓存类型"><button data-cache-kind="frame-indexes" aria-pressed="true">帧索引 <span id="cache-frame-count">—</span></button><button data-cache-kind="annotation-previews" aria-pressed="false">标注预览 <span id="cache-preview-count">—</span></button></div><button id="cache-clear" disabled>清理帧索引</button></div>
    <div class="cache-type-info"><div><p id="cache-description"></p><span id="cache-budget" class="admin-caption"></span><div class="cache-budget-bar" role="meter" aria-label="缓存限额占用"><span></span></div></div><details id="cache-location"><summary>存储位置</summary><div><code id="cache-path"></code><p id="cache-file-size"></p><p>与业务数据共用数据库。清理后空间可复用，文件不一定缩小。</p></div></details></div>
    <form id="cache-search-form" class="cache-search"><input id="cache-search" type="search" maxlength="200" aria-label="搜索缓存" placeholder="搜索媒体名称"><button type="submit">搜索</button></form>
    <div id="cache-confirm" class="admin-inline-confirm" hidden><span id="cache-confirm-text"></span><button id="cache-confirm-clear" class="admin-danger">确认清理</button><button id="cache-cancel">取消</button></div>
    <div class="cache-list-heading" aria-hidden="true"><span>媒体 / 内容</span><span>占用</span><span>更新时间</span><span></span></div><div id="cache-list" aria-live="polite"></div><div class="cache-list-footer"><button id="cache-more" hidden>加载更多</button></div>
  </section>`;
}
export function installCaches(signal: AbortSignal, notice: (text: string, error?: boolean) => void) {
  const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(`cache-${id}`) as T;
  let kind: CacheKind = 'frame-indexes', overview: Overview | null = null, next: number | null = null, search = '', busy = false;
  let selected: CacheEntry | 'all' | null = null;
  const label = () => kind === 'frame-indexes' ? '帧索引' : '标注预览';
  async function api<T>(url: string, body?: unknown): Promise<T> {
    const response = await fetch(url, { method: body ? 'DELETE' : 'GET', cache: 'no-store', signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]), headers: body ? { 'x-voidplayer-action': 'admin', 'content-type': 'application/json' } : {}, ...(body ? { body: JSON.stringify(body) } : {}) });
    const value = await response.json(); if (!response.ok) throw new Error(value.error ?? '缓存请求失败。'); return value;
  }
  function controls() {
    for (const button of document.querySelectorAll<HTMLButtonElement>('#pane-caches button')) button.disabled = busy;
    $('clear').toggleAttribute('disabled', busy || !overview?.types.find(type => type.kind === kind)?.count);
    $('more').hidden = next === null; $('list').setAttribute('aria-busy', String(busy));
  }
  async function act(work: () => Promise<void>) { if (busy) return; busy = true; controls(); try { await work(); notice(''); } catch (error) { if (!signal.aborted) notice((error as Error).message, true); } finally { busy = false; controls(); } }
  function meter(element: HTMLElement, used: number | null, total: number) {
    element.hidden = used === null; if (used === null) return;
    const percent = Math.min(100, Math.max(0, total ? used / total * 100 : 0)); element.setAttribute('aria-valuemin', '0'); element.setAttribute('aria-valuemax', '100'); element.setAttribute('aria-valuenow', percent.toFixed(1)); element.setAttribute('aria-valuetext', `${bytes(used)} / ${bytes(total)}`); element.querySelector<HTMLElement>('span')!.style.width = `${percent}%`;
  }
  function renderOverview() {
    if (!overview) return;
    $('total-bytes').textContent = bytes(overview.bytes); $('total-count').textContent = `${overview.count} 个缓存`;
    const volume = overview.volume;
    $('volume-free').textContent = volume ? `${bytes(volume.availableBytes)} 可用` : '磁盘容量不可用';
    $('volume-used').textContent = volume ? `已用 ${bytes(volume.usedBytes)}` : ''; $('volume-total').textContent = volume ? `共 ${bytes(volume.totalBytes)}` : '';
    meter(document.querySelector('.cache-volume-bar')!, volume?.usedBytes ?? null, volume?.totalBytes ?? 0);
    for (const type of overview.types) $(type.kind === 'frame-indexes' ? 'frame-count' : 'preview-count').textContent = String(type.count);
    const type = overview.types.find(type => type.kind === kind)!;
    $('description').textContent = kind === 'frame-indexes' ? '加快 FLV 视频再次打开和定位。清理后会在播放时重建。' : '标注卡片使用的画面预览。清理保留文字和绘图，再次编辑对应画面时生成。';
    $('budget').textContent = `${bytes(type.bytes)} / ${bytes(type.limitBytes)} 上限 · 达到上限后自动清理旧缓存`;
    meter(document.querySelector('.cache-budget-bar')!, type.bytes, type.limitBytes);
    $('path').textContent = type.location; $('file-size').textContent = `数据库 ${bytes(type.databaseBytes)} · 写入日志 ${bytes(type.journalBytes)}`;
    $('clear').textContent = `清理${label()}`;
    $<HTMLInputElement>('search').placeholder = kind === 'frame-indexes' ? '搜索媒体名称' : '搜索媒体、标注或评审空间';
  }
  function confirm(entry: CacheEntry | 'all') {
    selected = entry; $('confirm').hidden = false;
    $('confirm-text').textContent = entry === 'all' ? `清理全部${label()}？${kind === 'frame-indexes' ? '保留视频文件。' : '保留标注内容。'}` : `清理「${entry.name}」的${label()}？`;
    $('confirm-clear').focus(); $('confirm').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
  function row(entry: CacheEntry) {
    const row = document.createElement('div'); row.className = 'cache-row'; row.dataset.cacheId = entry.id;
    const content = document.createElement('div'); content.className = 'cache-row-content';
    const thumbnail = document.createElement('span'); thumbnail.className = 'cache-thumbnail'; thumbnail.innerHTML = icon(kind === 'frame-indexes' ? 'film' : 'note');
    if (entry.previewUrl) { const image = document.createElement('img'); image.src = entry.previewUrl; image.alt = ''; image.loading = 'lazy'; image.onerror = () => image.remove(); thumbnail.append(image); }
    const text = document.createElement('div'), name = document.createElement('strong'), detail = document.createElement('span'); name.textContent = entry.name; name.title = entry.name; detail.textContent = entry.detail; detail.title = entry.detail; text.append(name, detail); content.append(thumbnail, text);
    const size = document.createElement('span'); size.textContent = bytes(entry.bytes); size.className = 'cache-row-size';
    const date = document.createElement('time'); date.dateTime = new Date(entry.updatedAt).toISOString(); date.textContent = new Date(entry.updatedAt).toLocaleString(undefined, { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    const clear = document.createElement('button'); clear.className = 'icon-button'; clear.innerHTML = icon('trash'); clear.setAttribute('aria-label', `清理 ${entry.name} 的${label()}`); clear.title = '清理缓存'; clear.onclick = () => confirm(entry);
    row.append(content, size, date, clear); return row;
  }
  async function list(more = false) {
    const page = await api<Page>(`/api/admin/caches/${kind}?offset=${more ? next ?? 0 : 0}&search=${encodeURIComponent(search)}`);
    next = page.nextOffset;
    if (!more) $('list').replaceChildren();
    $('list').append(...page.entries.map(row));
    if (!more && !page.entries.length) $('list').append(emptyState(search ? '没有匹配的缓存' : `暂无${label()}缓存`, search ? '换个关键词试试。' : kind === 'frame-indexes' ? '打开 FLV 视频后，索引会自动保存在这里。' : '编辑标注后，画面预览会在播放暂停时保存。'));
  }
  async function refresh() { const value = await api<Overview>('/api/admin/caches'); overview = value; renderOverview(); await list(); }
  $('refresh').onclick = () => void act(refresh);
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-cache-kind]')) button.onclick = () => void act(async () => {
    kind = button.dataset.cacheKind as CacheKind; selected = null; $('confirm').hidden = true; search = ''; $<HTMLInputElement>('search').value = '';
    for (const tab of document.querySelectorAll('[data-cache-kind]')) tab.setAttribute('aria-pressed', String((tab as HTMLElement).dataset.cacheKind === kind));
    await refresh();
  });
  $('search-form').onsubmit = event => { event.preventDefault(); void act(async () => { search = $<HTMLInputElement>('search').value.trim(); await list(); }); };
  $('more').onclick = () => void act(() => list(true)); $('clear').onclick = () => confirm('all');
  $('cancel').onclick = () => { selected = null; $('confirm').hidden = true; };
  $('confirm-clear').onclick = () => void act(async () => {
    if (!selected) return;
    await api(`/api/admin/caches/${kind}`, selected === 'all' ? { all: true } : { id: selected.id, version: selected.version, scope: selected.scope });
    selected = null; $('confirm').hidden = true; await refresh();
  });
  // Keep the existing frame-index Agent API available while the GUI entry is unified.
  const tools = frameIndexTools(signal);
  const registry = (document as unknown as { modelContext?: { registerTool: (tool: unknown, options: { signal: AbortSignal }) => unknown } }).modelContext ?? (navigator as unknown as { modelContext?: { registerTool: (tool: unknown, options: { signal: AbortSignal }) => unknown } }).modelContext;
  for (const tool of tools) { try { void Promise.resolve(registry?.registerTool(tool, { signal })).catch(console.warn); } catch (error) { console.warn(error); } }
  Object.assign(window, { voidPlayerAdmin: { tools } });
  return { activate() { void act(refresh); } };
}
