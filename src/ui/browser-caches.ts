import { AnnotationStorage } from '../review/annotation-storage.ts';
import { clearLocalThumbnailCache, localThumbnailCacheEntries } from '../thumbnails/local-store.ts';
import { formatDate, formatNumber, msg, onLanguageChange, t, th } from '../i18n.ts';
import { createIconButton } from './controls.ts';
import { icon } from './icons.ts';
import type { ToastStack } from './toast.ts';
import './browser-caches.css';

const kinds = ['thumbnails', 'previews'] as const;
type Kind = typeof kinds[number];
type Entry = { key: string; name: string; bytes: number; updatedAt: number; protected?: boolean };
const label = (kind: Kind) => kind === 'thumbnails' ? t(msg('admin.kindThumbs', '媒体缩略图')) : t(msg('admin.kindPreviews', '标注预览'));
const sizeText = (value: number) => {
  const unit = value >= 1024 ** 3 ? 3 : value >= 1024 ** 2 ? 2 : value >= 1024 ? 1 : 0;
  return `${formatNumber(value / 1024 ** unit, { maximumFractionDigits: unit ? 1 : 0 })} ${['B', 'KiB', 'MiB', 'GiB'][unit]}`;
};
export function browserCachesShell() {
  return `<div class="settings-section"><div class="settings-section-heading browser-cache-heading"><h4 class="settings-section-title">${th(msg('admin.storageUsage', '存储占用'))}</h4>
    <button id="browser-cache-refresh" class="icon-button" aria-label="${th(msg('admin.refreshCaches', '刷新缓存'))}">${icon('refreshRegular')}</button></div>
    <div class="browser-cache-overview settings-group"><div><span>${th(msg('frontCache.images', '图像缓存'))}</span><strong id="browser-cache-bytes">—</strong><span id="browser-cache-count">—</span></div>
      <div><span>${th(msg('frontCache.storage', '浏览器存储（估算）'))}</span><strong id="browser-cache-usage">—</strong><div id="browser-cache-quota" class="browser-cache-bar" role="meter" aria-valuemin="0" aria-valuemax="100" hidden><span></span></div><span id="browser-cache-quota-label">—</span></div></div>
    <div class="browser-cache-types" role="group" aria-label="${th(msg('admin.cacheType', '缓存类型'))}">${kinds.map(kind => `<button data-browser-cache-kind="${kind}" aria-pressed="${kind === 'thumbnails'}"><span>${label(kind)}</span><strong id="browser-cache-${kind}-bytes">—</strong><span id="browser-cache-${kind}-count">—</span></button>`).join('')}</div></div>
    <div class="settings-section"><div class="settings-section-heading browser-cache-heading"><h4 class="settings-section-title" id="browser-cache-title">${label('thumbnails')}</h4><button id="browser-cache-clear" disabled>${icon('trash')}${th(msg('frontCache.clearType', '清理此类缓存'))}</button></div>
    <div class="settings-card browser-cache-entries"><input id="browser-cache-search" type="search" aria-label="${th(msg('admin.searchCaches', '搜索缓存'))}" placeholder="${th(msg('admin.searchCaches', '搜索缓存'))}">
    <div id="browser-cache-confirm" class="browser-cache-confirm" hidden><span>${th(msg('frontCache.confirm', '清理所选缓存？图像可重新生成。'))}</span><button id="browser-cache-confirm-clear" class="remove-track">${th(msg('admin.confirmClear', '确认清理'))}</button><button id="browser-cache-cancel">${th(msg('admin.cancel', '取消'))}</button></div>
    <div class="browser-cache-list-heading" aria-hidden="true"><span>${th(msg('admin.listHeadMedia', '媒体 / 内容'))}</span><span>${th(msg('admin.listHeadSize', '占用'))}</span><span>${th(msg('admin.listHeadUpdated', '更新时间'))}</span><span></span></div>
    <div id="browser-cache-list" aria-live="polite"></div><button id="browser-cache-more" hidden>${th(msg('admin.loadMore', '加载更多'))}</button></div></div>`;
}

export function installBrowserCaches(signal: AbortSignal, toasts: ToastStack) {
  const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(`browser-cache-${id}`) as T;
  const root = document.getElementById('settings-pane-caches')!, storage = new AnnotationStorage();
  let entries: Record<Kind, Entry[]> = { thumbnails: [], previews: [] }, kind: Kind = 'thumbnails', busy = false, loaded = false;
  let quota: StorageEstimate | undefined, selected: string[] | undefined, confirming = false, limit = 40;
  const count = (n: number) => t(msg('admin.itemsCount', '{n, plural, other {# 条}}'), { n });
  function render() {
    for (const button of root.querySelectorAll<HTMLButtonElement>('button')) button.disabled = busy;
    const all = kinds.flatMap(kind => entries[kind]);
    $('bytes').textContent = loaded ? sizeText(all.reduce((sum, entry) => sum + entry.bytes, 0)) : '—';
    $('count').textContent = loaded ? count(all.length) : '—';
    $('usage').textContent = quota?.usage !== undefined ? sizeText(quota.usage) : '—';
    $('quota-label').textContent = quota?.quota ? t(msg('frontCache.quota', '可用配额 {bytes}'), { bytes: sizeText(quota.quota) }) : t(msg('frontCache.unavailable', '浏览器未提供容量估算'));
    const meter = $('quota'), used = quota?.quota ? Math.min(100, (quota.usage ?? 0) / quota.quota * 100) : 0;
    meter.hidden = !quota?.quota; meter.setAttribute('aria-valuenow', used.toFixed(1));
    meter.querySelector<HTMLElement>('span')!.style.width = `${used}%`;
    meter.setAttribute('aria-label', t(msg('frontCache.storage', '浏览器存储（估算）')));
    for (const type of kinds) {
      $(`${type}-bytes`).textContent = loaded ? sizeText(entries[type].reduce((sum, entry) => sum + entry.bytes, 0)) : '—';
      $(`${type}-count`).textContent = loaded ? count(entries[type].length) : '—';
      root.querySelector(`[data-browser-cache-kind="${type}"]`)!.setAttribute('aria-pressed', String(type === kind));
    }
    $('title').textContent = label(kind);
    $<HTMLButtonElement>('clear').disabled = busy || !entries[kind].some(entry => !entry.protected);
    $('confirm').hidden = !confirming;
    const query = $<HTMLInputElement>('search').value.toLocaleLowerCase();
    const filtered = entries[kind].filter(entry => `${entry.name} ${entry.key}`.toLocaleLowerCase().includes(query));
    const rows = filtered.slice(0, limit).map(entry => {
      const row = document.createElement('div'); row.className = 'browser-cache-row'; row.dataset.cacheKey = entry.key;
      const name = document.createElement('span'); name.textContent = entry.name; name.title = entry.key;
      const size = document.createElement('span'); size.textContent = sizeText(entry.bytes);
      const date = document.createElement('time'); date.textContent = entry.updatedAt ? formatDate(entry.updatedAt) : '—';
      const remove = createIconButton({ glyph: 'trash', label: t(msg('admin.clearCache', '清理缓存')), className: 'remove-track' });
      remove.disabled = busy || !!entry.protected;
      if (entry.protected) remove.dataset.tooltip = t(msg('frontCache.pending', '这条标注尚未同步，暂时保留预览'));
      remove.onclick = () => { selected = [entry.key]; confirming = true; render(); };
      row.append(name, size, date, remove); return row;
    });
    $('list').replaceChildren(...rows); $('more').hidden = limit >= filtered.length;
  }
  async function read() {
    const [thumbs, previews, estimate] = await Promise.all([localThumbnailCacheEntries(), storage.previewCacheEntries(),
      navigator.storage?.estimate?.().catch(() => undefined)]);
    if (signal.aborted) return;
    entries = { thumbnails: thumbs.map(entry => {
      let name = entry.key;
      try { const parsed = JSON.parse(entry.key); if (Array.isArray(parsed) && typeof parsed[1] === 'string') name = parsed[1]; } catch {}
      return { ...entry, name };
    }), previews };
    quota = estimate; loaded = true;
  }
  async function act(action: () => Promise<void>) {
    if (busy || signal.aborted) return;
    busy = true; render();
    try { await action(); }
    catch (error) { if (!signal.aborted) toasts.show(error instanceof Error ? error.message : String(error), { kind: 'error' }); }
    finally { busy = false; if (!signal.aborted) render(); }
  }
  $('refresh').onclick = () => void act(read);
  for (const button of root.querySelectorAll<HTMLButtonElement>('[data-browser-cache-kind]')) button.onclick = () => {
    kind = button.dataset.browserCacheKind as Kind; limit = 40; confirming = false; render();
  };
  $('search').addEventListener('input', () => { limit = 40; confirming = false; render(); }, { signal });
  $('more').onclick = () => { limit += 40; render(); };
  $('clear').onclick = () => { selected = undefined; confirming = true; render(); };
  $('cancel').onclick = () => { confirming = false; render(); };
  $('confirm-clear').onclick = () => void act(async () => {
    if (!confirming) return;
    if (kind === 'thumbnails') await clearLocalThumbnailCache(selected); else await storage.clearPreviewCache(selected);
    confirming = false; await read();
  });
  document.getElementById('settings')!.addEventListener('settings-pane-change', event => {
    if ((event as CustomEvent).detail === 'caches') void act(read);
  }, { signal });
  onLanguageChange(render, signal);
  signal.addEventListener('abort', () => storage.close(), { once: true });
}
