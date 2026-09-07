import { listFrameIndexes, clearFrameIndexes, frameIndexTools } from '../frame-index-admin.ts';
import type { FrameIndexEntry } from '../frame-index-admin.ts';
import { icon } from '../ui/icons.ts';
export function frameIndexShell() {
  return `<section id="pane-frame-indexes" hidden><header class="admin-heading"><div><h1>帧索引缓存</h1><p>复用客户端已完成的 FLV 索引，加快后续载入和定位。</p></div><button id="frame-index-refresh" aria-label="刷新帧索引">${icon('refresh')}刷新</button></header>
    <p id="frame-index-summary" class="admin-caption">正在读取…</p>
    <div class="admin-actions"><input id="frame-index-search" type="search" maxlength="200" placeholder="搜索媒体名称" aria-label="搜索帧索引"><button id="frame-index-search-button">搜索</button><button id="frame-index-clear-all" class="admin-danger">清理全部缓存</button></div>
    <p class="admin-caption">文件变化或确认消失后自动清理；存储暂时离线会保留缓存。清理后，下次播放会重新建立索引，视频文件不会删除。</p>
    <div id="frame-index-confirm" class="admin-inline-confirm" hidden><span id="frame-index-confirm-text"></span><button id="frame-index-confirm-delete">清理缓存</button><button id="frame-index-cancel">取消</button></div>
    <div id="frame-index-list"></div><div class="admin-actions"><button id="frame-index-first">第一页</button><button id="frame-index-next" disabled>下一页</button></div></section>`;
}
export function installFrameIndexes(signal: AbortSignal, notice: (text: string, error?: boolean) => void) {
  const $ = (id: string) => document.getElementById(id)!;
  let offset = 0, next: number | null = null, search = '', busy = false, selected: FrameIndexEntry | 'all' | null = null;
  const bytes = (n: number) => `${(n / 1024 ** 2).toFixed(2)} MiB`;
  function controls() { for (const button of $('pane-frame-indexes').querySelectorAll('button')) button.disabled = busy;
    $('frame-index-next').toggleAttribute('disabled', busy || next === null); $('frame-index-first').toggleAttribute('disabled', busy || offset === 0); }
  async function act(work: () => Promise<void>) { if (busy) return; busy = true; controls(); try { await work(); } catch (error) { if (!signal.aborted) notice((error as Error).message, true); } finally { busy = false; controls(); } }
  function confirm(value: FrameIndexEntry | 'all') { selected = value; $('frame-index-confirm').hidden = false;
    $('frame-index-confirm-text').textContent = value === 'all' ? '清理全部帧索引缓存？' : `清理 ${value.name} 的帧索引缓存？`; }
  async function list() {
    const page = await listFrameIndexes(offset, search, signal); next = page.nextOffset;
    $('frame-index-summary').textContent = `${page.count} 个缓存 · ${bytes(page.bytes)} / ${bytes(page.limitBytes)} · 超过容量后清理最久未使用的缓存`;
    const rows = page.entries.map(entry => {
      const row = document.createElement('div'); row.className = 'admin-frame-index-row';
      const title = document.createElement('strong'); title.textContent = entry.name;
      const detail = document.createElement('span'); detail.textContent = `${entry.root} · ${entry.frames} 帧 · ${bytes(entry.bytes)} · ${new Date(entry.createdAt).toLocaleString()}`;
      const remove = document.createElement('button'); remove.textContent = '清理'; remove.setAttribute('aria-label', `清理 ${entry.name} 的帧索引`); remove.onclick = () => confirm(entry);
      row.append(title, detail, remove); return row;
    });
    if (!rows.length) { const empty = document.createElement('p'); empty.className = 'admin-empty'; empty.textContent = '暂无匹配的帧索引缓存'; $('frame-index-list').replaceChildren(empty); }
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
