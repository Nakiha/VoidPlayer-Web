import { emptyState } from './presentation.ts';
import { listFrameIndexes, clearFrameIndexes, frameIndexTools } from '../frame-index-admin.ts';
import type { FrameIndexEntry } from '../frame-index-admin.ts';
import { icon } from '../ui/icons.ts';
export function frameIndexShell() {
  return `<section id="pane-frame-indexes" hidden><header class="admin-heading"><div><h1>帧索引缓存</h1><p>自动保存 FLV 视频的帧索引，减少下次打开和定位的等待。</p></div><button id="frame-index-refresh" aria-label="刷新帧索引">${icon('refresh')}刷新</button></header>
    <div class="admin-panel"><div class="admin-section-heading"><div><h2>缓存占用</h2><p id="frame-index-summary" class="admin-caption">正在读取…</p></div><button id="frame-index-clear-all" class="admin-danger" disabled>清理全部缓存</button></div><p class="admin-help">空间不足时自动清理旧缓存。手动清理不会删除视频，下次播放会重新生成。</p></div>
    <div class="admin-search"><input id="frame-index-search" type="search" maxlength="200" placeholder="搜索媒体名称" aria-label="搜索帧索引"><button id="frame-index-search-button">搜索</button></div>

    <div id="frame-index-confirm" class="admin-inline-confirm" hidden><span id="frame-index-confirm-text"></span><button id="frame-index-confirm-delete">清理缓存</button><button id="frame-index-cancel">取消</button></div>
    <div id="frame-index-list"></div><div id="frame-index-pages" class="admin-actions"><button id="frame-index-first">第一页</button><button id="frame-index-next" disabled>下一页</button></div></section>`;
}
export function installFrameIndexes(signal: AbortSignal, notice: (text: string, error?: boolean) => void) {
  const $ = (id: string) => document.getElementById(id)!;
  let offset = 0, next: number | null = null, search = '', busy = false, count = 0, selected: FrameIndexEntry | 'all' | null = null;
  const bytes = (n: number) => n >= 1024 ** 2 ? `${(n / 1024 ** 2).toFixed(1)} MiB` : n >= 1024 ? `${(n / 1024).toFixed(1)} KiB` : `${n} B`;
  function controls() { $('frame-index-pages').hidden = offset === 0 && next === null; for (const button of $('pane-frame-indexes').querySelectorAll('button')) button.disabled = busy;
    $('frame-index-next').toggleAttribute('disabled', busy || next === null); $('frame-index-first').toggleAttribute('disabled', busy || offset === 0); $('frame-index-clear-all').toggleAttribute('disabled', busy || count === 0); }
  async function act(work: () => Promise<void>) { if (busy) return; busy = true; controls(); try { await work(); } catch (error) { if (!signal.aborted) notice((error as Error).message, true); } finally { busy = false; controls(); } }
  function confirm(value: FrameIndexEntry | 'all') { selected = value; $('frame-index-confirm').hidden = false;
    $('frame-index-confirm-text').textContent = value === 'all' ? '清理全部帧索引缓存？' : `清理 ${value.name} 的帧索引缓存？`; }
  async function list() {
    const page = await listFrameIndexes(offset, search, signal); next = page.nextOffset; count = page.count;
    $('frame-index-summary').textContent = `${page.count} 个缓存 · 已用 ${bytes(page.bytes)} / ${bytes(page.limitBytes)}`;
    const rows = page.entries.map(entry => {
      const row = document.createElement('div'); row.className = 'admin-frame-index-row';
      const title = document.createElement('strong'); title.textContent = entry.name;
      const detail = document.createElement('span'); detail.textContent = `${entry.root} · ${entry.frames} 帧 · ${bytes(entry.bytes)} · ${new Date(entry.createdAt).toLocaleString()}`;
      const remove = document.createElement('button'); remove.textContent = '清理'; remove.setAttribute('aria-label', `清理 ${entry.name} 的帧索引`); remove.onclick = () => confirm(entry);
      row.append(title, detail, remove); return row;
    });
    if (!rows.length) $('frame-index-list').replaceChildren(emptyState(search ? '没有找到匹配的缓存' : '还没有帧索引缓存', search ? '试试其他视频名称。' : '在播放器打开 FLV 视频后会自动生成，无需手动添加。'));
    else $('frame-index-list').replaceChildren(...rows);
  }
  const refresh = () => void act(async () => { offset = 0; search = ($('frame-index-search') as HTMLInputElement).value; await list(); });
  $('frame-index-refresh').onclick = $('frame-index-search-button').onclick = refresh;
  $('frame-index-search').onkeydown = e => { if (e.key === 'Enter') refresh(); };
  $('frame-index-first').onclick = () => void act(async () => { offset = 0; await list(); });
  $('frame-index-next').onclick = () => void act(async () => { if (next !== null) { offset = next; await list(); } });
  $('frame-index-clear-all').onclick = () => confirm('all');
  $('frame-index-cancel').onclick = () => { selected = null; $('frame-index-confirm').hidden = true; };
  $('frame-index-confirm-delete').onclick = () => void act(async () => {
    if (!selected) return;
    const result = selected === 'all' ? await clearFrameIndexes('all', undefined, undefined, signal) : await clearFrameIndexes('media', selected.id, selected.version, signal);
    selected = null; $('frame-index-confirm').hidden = true; offset = 0; await list(); notice(`已清理 ${result.removed} 个帧索引缓存。`);
  });
  const tools = frameIndexTools(signal);
  const registry = (document as unknown as { modelContext?: { registerTool: (tool: unknown, options: { signal: AbortSignal }) => unknown } }).modelContext
    ?? (navigator as unknown as { modelContext?: { registerTool: (tool: unknown, options: { signal: AbortSignal }) => unknown } }).modelContext;
  for (const tool of tools) { try { void Promise.resolve(registry?.registerTool(tool, { signal })).catch(console.warn); } catch (error) { console.warn(error); } }
  Object.assign(window, { voidPlayerAdmin: { tools } });
  return { activate() { void act(list); } };
}
