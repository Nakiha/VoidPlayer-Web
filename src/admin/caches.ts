import { requestError, cacheName, cacheDetail } from './diagnostics.ts';
import { apiError } from '../api-error.ts';
import { localizedText, localizedAttribute, type LocalizedValue } from '../ui/live-localization.ts';
import { formatDate, formatNumber, t, th, msg } from '../i18n.ts';
import type { CacheEntry, CacheKind, CacheManager } from '../../server/caches.ts';
import { icon } from '../ui/icons.ts';
import { frameIndexTools } from '../frame-index-admin.ts';
import { emptyState } from './presentation.ts';

type Overview = Awaited<ReturnType<CacheManager['overview']>>;
type Page = { entries: CacheEntry[]; nextOffset: number | null; count: number };
const bytes = (value: number) => { const unit = value >= 1024 ** 3 ? 3 : value >= 1024 ** 2 ? 2 : value >= 1024 ? 1 : 0; return `${formatNumber(value / 1024 ** unit, { maximumFractionDigits: unit ? 1 : 0 })} ${['B', 'KiB', 'MiB', 'GiB'][unit]}`; };
export function cacheShell() {
  return `<section id="pane-caches" hidden>
    <header class="admin-heading"><div><h1>${th(msg("admin.cacheTitle", "缓存"))}</h1><p>${th(msg("admin.cacheDesc", "查看占用，清理可重新生成的数据。"))}</p></div><button id="cache-refresh" class="icon-button" aria-label="${th(msg("admin.refreshCaches", "刷新缓存"))}">${icon('refresh')}</button></header>
    <div class="cache-overview"><div class="cache-total"><span>${th(msg("admin.cacheContents", "缓存内容"))}</span><strong id="cache-total-bytes">—</strong><span id="cache-total-count">${th(msg("admin.reading", "正在读取…"))}</span></div><div class="cache-volume"><div class="cache-volume-heading"><span>${th(msg("admin.disk", "所在磁盘"))}</span><span id="cache-volume-free">—</span></div><div class="cache-volume-bar" role="meter" aria-label="${th(msg("admin.diskUsage", "磁盘占用"))}"><span></span></div><div class="cache-volume-caption"><span id="cache-volume-used">—</span><span id="cache-volume-total">—</span></div></div></div>
    <div class="cache-toolbar"><div class="cache-tabs" role="group" aria-label="${th(msg("admin.cacheType", "缓存类型"))}"><button data-cache-kind="frame-indexes" aria-pressed="true">${th(msg("admin.kindFrameIndexes", "帧索引"))} <span id="cache-frame-count">—</span></button><button data-cache-kind="annotation-previews" aria-pressed="false">${th(msg("admin.kindPreviews", "标注预览"))} <span id="cache-preview-count">—</span></button><button data-cache-kind="media-thumbnails" aria-pressed="false">${th(msg("admin.kindThumbs", "媒体缩略图"))} <span id="cache-thumb-count">—</span></button></div><button id="cache-clear" disabled>${th(msg("admin.clearFrames", "清理帧索引"))}</button></div>
    <div class="cache-type-info"><div><p id="cache-description"></p><span id="cache-budget" class="admin-caption"></span><div class="cache-budget-bar" role="meter" aria-label="${th(msg("admin.cacheQuota", "缓存限额占用"))}"><span></span></div></div><details id="cache-location"><summary>${th(msg("admin.storageLocation", "存储位置"))}</summary><div><code id="cache-path"></code><p id="cache-file-size"></p><p>${th(msg("admin.sharedDb", "与业务数据共用数据库。清理后空间可复用，文件不一定缩小。"))}</p></div></details></div>
    <form id="cache-search-form" class="cache-search"><input id="cache-search" type="search" maxlength="200" aria-label="${th(msg("admin.searchCaches", "搜索缓存"))}" placeholder="${th(msg("admin.searchMediaName", "搜索媒体名称"))}"><button type="submit">${th(msg("admin.search", "搜索"))}</button></form>
    <div id="cache-confirm" class="admin-inline-confirm" hidden><span id="cache-confirm-text"></span><button id="cache-confirm-clear" class="admin-danger">${th(msg("admin.confirmClear", "确认清理"))}</button><button id="cache-cancel">${th(msg("admin.cancel", "取消"))}</button></div>
    <div class="cache-list-heading" aria-hidden="true"><span>${th(msg("admin.listHeadMedia", "媒体 / 内容"))}</span><span>${th(msg("admin.listHeadSize", "占用"))}</span><span>${th(msg("admin.listHeadUpdated", "更新时间"))}</span><span></span></div><div id="cache-list" aria-live="polite"></div><div class="cache-list-footer"><button id="cache-more" hidden>${th(msg("admin.loadMore", "加载更多"))}</button></div>
  </section>`;
}
export function installCaches(signal: AbortSignal, notice: (text: LocalizedValue, error?: boolean) => void) {
  const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(`cache-${id}`) as T;
  let kind: CacheKind = 'frame-indexes', overview: Overview | null = null, next: number | null = null, search = '', busy = false;
  let selected: CacheEntry | 'all' | null = null;
  const label = () => kind === 'frame-indexes' ? t(msg("admin.kindFrameIndexes", "帧索引")) : kind === 'annotation-previews' ? t(msg("admin.kindPreviews", "标注预览")) : t(msg("admin.kindThumbs", "媒体缩略图"));
  async function api<T>(url: string, body?: unknown): Promise<T> {
    const response = await fetch(url, { method: body ? 'DELETE' : 'GET', cache: 'no-store', signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]), headers: body ? { 'x-voidplayer-action': 'admin', 'content-type': 'application/json' } : {}, ...(body ? { body: JSON.stringify(body) } : {}) });
    const value = await response.json(); if (!response.ok) throw apiError(response.status, value); return value;
  }
  function controls() {
    for (const button of document.querySelectorAll<HTMLButtonElement>('#pane-caches button')) button.disabled = busy;
    $('clear').toggleAttribute('disabled', busy || !overview?.types.find(type => type.kind === kind)?.count);
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
    for (const type of overview.types) localizedText($(type.kind === 'frame-indexes' ? 'frame-count' : type.kind === 'annotation-previews' ? 'preview-count' : 'thumb-count'), () => String(type.count));
    const type = overview.types.find(type => type.kind === kind)!;
    localizedText($('description'), () => kind === 'frame-indexes' ? t(msg("admin.framesDescription", "加快媒体库视频再次打开和定位。支持的 FFmpeg 容器由服务端重建索引；FLV 仍在播放时重建。")) : kind === 'annotation-previews' ? t(msg("admin.descPreviews", "标注卡片使用的画面预览。清理保留文字和绘图，再次编辑对应画面时生成。")) : t(msg("admin.descThumbs", "媒体库首帧小图。清理后只在正常从头打开时重建，不主动解码。")));
    localizedText($('budget'), () => t(msg("admin.cacheBudget", "{used} / {limit} 上限 · 达到上限后自动清理旧缓存"), {used:bytes(type.bytes),limit:bytes(type.limitBytes)}));
    meter(document.querySelector('.cache-budget-bar')!, type.bytes, type.limitBytes);
    localizedText($('path'), () => type.location); localizedText($('file-size'), () => t(msg("admin.dbSize", "数据库 {db} · 写入日志 {journal}"), { db: bytes(type.databaseBytes), journal: bytes(type.journalBytes) }));
    localizedText($('clear'), () => t(msg("admin.clearLabel", "清理{label}"), { label: label() }));
    localizedAttribute($<HTMLInputElement>('search'), 'placeholder', () => kind === 'frame-indexes' ? t(msg("admin.searchMediaName", "搜索媒体名称")) : kind === 'annotation-previews' ? t(msg("admin.searchMediaMark", "搜索媒体、标注或评审空间")) : t(msg("admin.searchMediaName", "搜索媒体名称")));
  }
  function confirm(entry: CacheEntry | 'all') {
    selected = entry; $('confirm').hidden = false;
    localizedText($('confirm-text'), () => entry === 'all' ? kind === 'frame-indexes' ? t(msg("admin.clearAllFrames", "清理全部帧索引？保留视频文件。")) : kind === 'annotation-previews' ? t(msg("admin.clearAllPreviews", "清理全部标注预览？保留标注内容。")) : t(msg("admin.clearAllThumbnails", "清理全部媒体缩略图？保留视频文件，仅删小图。清理后从头打开可重建。")) : t(msg("admin.confirmOne", "清理「{name}」的{label}？"), { name: cacheName(entry), label: label() }));
    $('confirm-clear').focus(); $('confirm').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
  function row(entry: CacheEntry) {
    const row = document.createElement('div'); row.className = 'cache-row'; row.dataset.cacheId = entry.id;
    const content = document.createElement('div'); content.className = 'cache-row-content';
    const thumbnail = document.createElement('span'); thumbnail.className = 'cache-thumbnail'; thumbnail.innerHTML = icon(kind === 'annotation-previews' ? 'note' : 'film');
    if (entry.previewUrl) { const image = document.createElement('img'); image.src = entry.previewUrl; image.alt = ''; image.loading = 'lazy'; image.onerror = () => image.remove(); thumbnail.append(image); }
    const text = document.createElement('div'), name = document.createElement('strong'), detail = document.createElement('span'); localizedText(name, () => cacheName(entry)); localizedAttribute(name, 'title', () => cacheName(entry)); localizedText(detail, () => cacheDetail(entry)); localizedAttribute(detail, 'title', () => cacheDetail(entry)); text.append(name, detail); content.append(thumbnail, text);
    const size = document.createElement('span'); localizedText(size, () => bytes(entry.bytes)); size.className = 'cache-row-size';
    const date = document.createElement('time'); date.dateTime = new Date(entry.updatedAt).toISOString(); localizedText(date, () => formatDate(entry.updatedAt));
    const clear = document.createElement('button'); clear.className = 'icon-button'; clear.innerHTML = icon('trash'); localizedAttribute(clear, 'aria-label', () => t(msg("admin.clearName", "清理 {name} 的{label}"), { name: cacheName(entry), label: label() })); localizedAttribute(clear, 'title', () => t(msg("admin.clearCache", "清理缓存"))); clear.onclick = () => confirm(entry);
    row.append(content, size, date, clear); return row;
  }
  async function list(more = false) {
    const page = await api<Page>(`/api/admin/caches/${kind}?offset=${more ? next ?? 0 : 0}&search=${encodeURIComponent(search)}`);
    next = page.nextOffset;
    if (!more) $('list').replaceChildren();
    $('list').append(...page.entries.map(row));
    if (!more && !page.entries.length) $('list').append(emptyState(() => search ? t(msg("admin.noMatchCache", "没有匹配的缓存")) : t(msg("admin.noCacheKind", "暂无{label}缓存"), { label: label() }), () => search ? t(msg("admin.tryKeywords", "换个关键词试试。")) : kind === 'frame-indexes' ? t(msg("admin.framesEmpty", "打开支持的媒体库视频后，索引会自动保存在这里。")) : kind === 'annotation-previews' ? t(msg("admin.emptyPreviews", "编辑标注后，画面预览会在播放暂停时保存。")) : t(msg("admin.emptyThumbs", "从头打开媒体库视频后，首帧小图会保存在这里。"))));
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
