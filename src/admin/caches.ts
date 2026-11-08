import { requestError, cacheName, cacheDetail } from './diagnostics.ts';
import { apiError } from '../services/api-error.ts';
import { localizedText, localizedAttribute, type LocalizedValue } from '../ui/live-localization.ts';
import { formatDate, formatNumber, t, th, msg } from '../i18n.ts';
import type {CacheEntry,CacheKind} from '../../shared/service/caches.ts';
import type {CacheOverview as Overview} from '../../shared/service/admin.ts';
import { icon } from '../ui/icons.ts';
import { frameIndexTools } from '../services/frame-index.ts';
import { emptyState } from './presentation.ts';

type Page = { entries: CacheEntry[]; nextOffset: number | null; count: number };
const bytes = (value: number) => { const unit = value >= 1024 ** 3 ? 3 : value >= 1024 ** 2 ? 2 : value >= 1024 ? 1 : 0; return `${formatNumber(value / 1024 ** unit, { maximumFractionDigits: unit ? 1 : 0 })} ${['B', 'KiB', 'MiB', 'GiB'][unit]}`; };
const cacheKinds: CacheKind[] = ['frame-indexes', 'annotation-previews', 'media-thumbnails'];
function kindLabel(kind: CacheKind) {
  if (kind === 'frame-indexes') return t(msg('admin.kindFrameIndexes', '帧索引'));
  if (kind === 'annotation-previews') return t(msg('admin.kindPreviews', '标注预览'));
  return t(msg('admin.kindThumbs', '媒体缩略图'));
}
export function cacheShell() {
  return `<section id="pane-caches" hidden>
    <header class="admin-heading"><h1>${th(msg("admin.cacheTitle", "缓存"))}</h1><button id="cache-refresh" class="icon-button" aria-label="${th(msg("admin.refreshCaches", "刷新缓存"))}">${icon('refreshRegular')}</button></header>
    <h2>${th(msg('admin.storageUsage', '存储占用'))}</h2><div class="cache-overview admin-panel"><div class="cache-total"><span>${th(msg("admin.listHeadSize", "占用"))}</span><strong id="cache-total-bytes">—</strong><div class="cache-distribution" aria-hidden="true">${cacheKinds.map(kind => `<span data-segment="${kind}"></span>`).join('')}</div><span id="cache-total-count">${th(msg("admin.reading", "正在读取…"))}</span></div><div class="cache-volume"><div class="cache-volume-heading"><span>${th(msg("admin.disk", "所在磁盘"))}</span><span id="cache-volume-free">—</span></div><div class="cache-volume-bar" role="meter" aria-label="${th(msg("admin.diskUsage", "磁盘占用"))}"><span></span></div><div class="cache-volume-caption"><span id="cache-volume-used">—</span><span id="cache-volume-total">—</span></div></div></div>
    <h2>${th(msg('admin.cacheType', '缓存类型'))}</h2>
    <div class="cache-types" role="group" aria-label="${th(msg('admin.cacheType', '缓存类型'))}">${cacheKinds.map((kind, i) => `
      <button data-cache-kind="${kind}" aria-pressed="${i === 0}"><span class="cache-type-name"><i aria-hidden="true"></i>${kindLabel(kind)}</span>
        <strong id="cache-${kind}-bytes">—</strong><span id="cache-${kind}-count" class="cache-type-count">—</span></button>`).join('')}</div>
    <div class="admin-section-title"><h2 id="cache-detail-title">${kindLabel('frame-indexes')}</h2><button id="cache-clear" disabled>${icon('trash')}<span id="cache-clear-label">${th(msg('admin.clearFrames', '清理帧索引'))}</span></button></div>
    <div class="admin-panel cache-entries">
      <dl class="cache-facts">
        <div><dt>${th(msg('admin.cacheQuota', '缓存限额占用'))}</dt><dd><span id="cache-budget">—</span><div class="cache-budget-bar" role="meter" aria-label="${th(msg('admin.cacheQuota', '缓存限额占用'))}"><span></span></div></dd></div>
        <div><dt>${th(msg('admin.databaseSize', '数据库'))}</dt><dd id="cache-db">—</dd></div>
        <div><dt>${th(msg('admin.journalSize', '写入日志'))}</dt><dd id="cache-journal">—</dd></div>
      </dl>
      <dl class="cache-location"><dt>${th(msg('admin.storageLocation', '存储位置'))}</dt><dd><code id="cache-path">—</code></dd></dl>
    <form id="cache-search-form" class="cache-search"><input id="cache-search" type="search" maxlength="200" aria-label="${th(msg("admin.searchCaches", "搜索缓存"))}" placeholder="${th(msg("admin.searchMediaName", "搜索媒体名称"))}"><button type="submit">${th(msg("admin.search", "搜索"))}</button></form>
    <div id="cache-confirm" class="admin-inline-confirm" hidden><span id="cache-confirm-text"></span><button id="cache-confirm-clear" class="admin-danger">${th(msg("admin.confirmClear", "确认清理"))}</button><button id="cache-cancel">${th(msg("admin.cancel", "取消"))}</button></div>
    <div class="cache-list-heading" aria-hidden="true"><span>${th(msg("admin.listHeadMedia", "媒体 / 内容"))}</span><span>${th(msg("admin.listHeadSize", "占用"))}</span><span>${th(msg("admin.listHeadUpdated", "更新时间"))}</span><span></span></div><div id="cache-list" class="library-row-surface" aria-live="polite"></div><div class="cache-list-footer"><button id="cache-more" hidden>${th(msg("admin.loadMore", "加载更多"))}</button></div>
    </div>
  </section>`;
}
export function installCaches(signal: AbortSignal, notice: (text: LocalizedValue, error?: boolean) => void) {
  const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(`cache-${id}`) as T;
  let kind: CacheKind = 'frame-indexes', overview: Overview | null = null, next: number | null = null, search = '', busy = false;
  let selected: CacheEntry | 'all' | null = null;
  let renderedList = '';
  const panel = document.getElementById('pane-caches')!;
  panel.addEventListener('click', event => {
    if (!busy) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, { capture: true, signal });

  async function api<T>(url: string, body?: unknown): Promise<T> {
    const response = await fetch(url, { method: body ? 'DELETE' : 'GET', cache: 'no-store', signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]), headers: body ? { 'x-voidplayer-action': 'admin', 'content-type': 'application/json' } : {}, ...(body ? { body: JSON.stringify(body) } : {}) });
    const value = await response.json(); if (!response.ok) throw apiError(response.status, value); return value;
  }
  function controls() {
    for (const button of panel.querySelectorAll('button')) button.setAttribute('aria-disabled', String(busy));
    $('clear').toggleAttribute('disabled', !overview?.types.find(type => type.kind === kind)?.count);
    $('more').hidden = next === null; $('list').setAttribute('aria-busy', String(busy));
  }
  async function act(work: () => Promise<void>) { if (busy) return; busy = true; controls(); try { await work(); notice(() => ''); } catch (error) { if (!signal.aborted) notice(() => requestError(error), true); } finally { busy = false; controls(); } }
  function meter(element: HTMLElement, used: number | null, total: number) {
    element.hidden = used === null; if (used === null) return;
    const percent = Math.min(100, Math.max(0, total ? used / total * 100 : 0)); element.setAttribute('aria-valuemin', '0'); element.setAttribute('aria-valuemax', '100'); element.setAttribute('aria-valuenow', percent.toFixed(1)); localizedAttribute(element, 'aria-valuetext', () => `${bytes(used)} / ${bytes(total)}`); element.querySelector<HTMLElement>('span')!.style.width = `${percent}%`;
  }
  function renderOverview() {
    if (!overview) return; const snapshot = overview;
    localizedText($('total-bytes'), () => bytes(snapshot.bytes)); localizedText($('total-count'), () => t(msg("admin.cachesCount", "{n, plural, other {# 个缓存}}"), { n: snapshot.count }));
    const volume = overview.volume;
    localizedText($('volume-free'), () => volume ? t(msg("admin.diskFree", "{bytes} 可用"), { bytes: bytes(volume.availableBytes) }) : t(msg("admin.diskUnavailable", "磁盘容量不可用")));
    localizedText($('volume-used'), () => volume ? t(msg("admin.diskUsed", "已用 {bytes}"), { bytes: bytes(volume.usedBytes) }) : ''); localizedText($('volume-total'), () => volume ? t(msg("admin.diskTotal", "共 {bytes}"), { bytes: bytes(volume.totalBytes) }) : '');
    meter(document.querySelector('.cache-volume-bar')!, volume?.usedBytes ?? null, volume?.totalBytes ?? 0);
    for (const type of snapshot.types) {
      const segment = panel.querySelector<HTMLElement>(`[data-segment="${type.kind}"]`)!;
      segment.style.width = `${snapshot.bytes ? type.bytes / snapshot.bytes * 100 : 0}%`;
      localizedText($(`${type.kind}-bytes`), () => bytes(type.bytes));
      localizedText($(`${type.kind}-count`), () => t(msg('admin.itemsCount', '{n, plural, other {# 条}}'), { n: type.count }));
    }
    const type = snapshot.types.find(type => type.kind === kind)!;
    localizedText($('detail-title'), () => kindLabel(type.kind));
    localizedText($('budget'), () => `${bytes(type.bytes)} / ${bytes(type.limitBytes)}`);
    meter(panel.querySelector('.cache-budget-bar')!, type.bytes, type.limitBytes);
    localizedText($('path'), type.location);
    localizedText($('db'), () => bytes(type.databaseBytes));
    localizedText($('journal'), () => bytes(type.journalBytes));
    localizedText($('clear-label'), () => t(msg("admin.clearLabel", "清理{label}"), { label: kindLabel(type.kind) }));
    localizedAttribute($<HTMLInputElement>('search'), 'placeholder', () => kind === 'frame-indexes' ? t(msg("admin.searchMediaName", "搜索媒体名称")) : kind === 'annotation-previews' ? t(msg("admin.searchMediaMark", "搜索媒体、标注或评审空间")) : t(msg("admin.searchMediaName", "搜索媒体名称")));
  }
  function confirm(entry: CacheEntry | 'all') {
    selected = entry; $('confirm').hidden = false;
    localizedText($('confirm-text'), () => entry === 'all' ? kind === 'frame-indexes' ? t(msg("admin.clearAllFrames", "清理全部帧索引？保留视频文件")) : kind === 'annotation-previews' ? t(msg("admin.clearAllPreviews", "清理全部标注预览？保留标注内容")) : t(msg("admin.clearAllThumbnails", "清理全部媒体缩略图？保留视频文件，仅删小图，清理后从头打开可重建")) : t(msg("admin.confirmOne", "清理「{name}」的{label}？"), { name: cacheName(entry), label: kindLabel(kind) }));
    $('confirm-clear').focus(); $('confirm').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
  function row(entry: CacheEntry) {
    const row = document.createElement('div'); row.className = 'cache-row source-row'; row.dataset.cacheId = entry.id;
    const content = document.createElement('div'); content.className = 'cache-row-content';
    const thumbnail = document.createElement('span'); thumbnail.className = 'cache-thumbnail source-thumb'; thumbnail.innerHTML = icon(kind === 'annotation-previews' ? 'note' : 'film');
    if (entry.previewUrl) { const image = document.createElement('img'); image.src = entry.previewUrl; image.alt = ''; image.loading = 'lazy'; image.onerror = () => image.remove(); thumbnail.append(image); }
    const text = document.createElement('div'), name = document.createElement('strong'), detail = document.createElement('span'); localizedText(name, () => cacheName(entry)); localizedAttribute(name, 'title', () => cacheName(entry)); localizedText(detail, () => cacheDetail(entry)); localizedAttribute(detail, 'title', () => cacheDetail(entry)); text.append(name, detail); content.append(thumbnail, text);
    const size = document.createElement('span'); localizedText(size, () => bytes(entry.bytes)); size.className = 'cache-row-size';
    const date = document.createElement('time'); date.dateTime = new Date(entry.updatedAt).toISOString(); localizedText(date, () => formatDate(entry.updatedAt));
    const clear = document.createElement('button'); clear.className = 'icon-button'; clear.innerHTML = icon('trash'); localizedAttribute(clear, 'aria-label', () => t(msg("admin.clearName", "清理 {name} 的{label}"), { name: cacheName(entry), label: kindLabel(kind) })); localizedAttribute(clear, 'title', () => t(msg("admin.clearCache", "清理缓存"))); clear.onclick = () => confirm(entry);
    row.append(content, size, date, clear); return row;
  }
  function readEntries(type: CacheKind, query: string, offset = 0) {
    return api<Page>(`/api/admin/caches/${type}?offset=${offset}&search=${encodeURIComponent(query)}`);
  }
  function renderEntries(page: Page, more = false) {
    next = page.nextOffset;
    const snapshot = JSON.stringify([kind, search, page]);
    if (!more && renderedList === snapshot) return;
    renderedList = more ? '' : snapshot;
    const offset = more ? $('list').querySelectorAll('.cache-row').length : 0;
    const rows = page.entries.map((entry, index) => {
      const item = row(entry); item.classList.toggle('source-striped', (offset + index) % 2 === 1); return item;
    });
    if (more) $('list').append(...rows); else $('list').replaceChildren(...rows);
    if (!more && !page.entries.length) $('list').append(emptyState(() => search ? t(msg("admin.noMatchCache", "没有匹配的缓存")) : t(msg("admin.noCacheKind", "暂无{label}缓存"), { label: kindLabel(kind) }), () => search ? t(msg("admin.tryKeywords", "换个关键词试试")) : kind === 'frame-indexes' ? t(msg("admin.framesEmpty", "打开支持的媒体库视频后，索引会自动保存在这里")) : kind === 'annotation-previews' ? t(msg("admin.emptyPreviews", "编辑标注后，画面预览会在播放暂停时保存")) : t(msg("admin.emptyThumbs", "从头打开媒体库视频后，首帧小图会保存在这里"))));
  }
  async function refresh(type = kind) {
    const query = type === kind ? search : '';
    const [summary, page] = await Promise.all([api<Overview>('/api/admin/caches'), readEntries(type, query)]);
    if (type !== kind) {
      selected = null; $('confirm').hidden = true;
      $<HTMLInputElement>('search').value = query;
    }
    kind = type; search = query; overview = summary;
    for (const button of panel.querySelectorAll<HTMLButtonElement>('[data-cache-kind]')) button.setAttribute('aria-pressed', String(button.dataset.cacheKind === kind));
    renderOverview(); renderEntries(page);
  }
  $('refresh').onclick = () => void act(refresh);
  for (const button of panel.querySelectorAll<HTMLButtonElement>('[data-cache-kind]'))
    button.onclick = () => void act(() => refresh(button.dataset.cacheKind as CacheKind));
  $('search-form').onsubmit = event => {
    event.preventDefault();
    void act(async () => {
      const query = $<HTMLInputElement>('search').value.trim(), page = await readEntries(kind, query);
      search = query; renderEntries(page);
    });
  };
  $('more').onclick = () => void act(async () => { if (next !== null) renderEntries(await readEntries(kind, search, next), true); });
  $('clear').onclick = () => confirm('all');
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
