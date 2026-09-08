import { emptyState, properties } from './presentation.ts';
import { SavedWorkspaceClient } from '../saved-workspaces.ts';
import type { WorkspaceRecord, SavedWorkspace } from '../saved-workspaces.ts';
import { compressWorkspace } from '../workspace-file.ts';
import { icon } from '../ui/icons.ts';
export function workspaceAdminShell() {
  return `<section id="pane-workspaces" class="admin-logs" hidden><header class="admin-heading"><div><h1>工作区</h1><p>打开已保存的评审，或修改名称、下载副本。</p></div><button id="admin-workspaces-refresh" class="icon-button" aria-label="刷新工作区">${icon('refresh')}</button></header>
    <div class="admin-workspaces-search"><input id="admin-workspaces-search" type="search" placeholder="搜索全部工作区" aria-label="搜索全部工作区"><button id="admin-workspaces-search-button">搜索</button></div>
    <div class="admin-log-workspace"><div class="admin-log-sidebar"><div id="admin-workspaces-list"></div><div class="admin-actions"><button id="admin-workspaces-first" disabled>返回最新</button><button id="admin-workspaces-next" disabled>下一页</button></div></div>
      <div class="admin-log-detail" data-empty="true"><div class="admin-workspace-title"><label>名称<input id="admin-workspace-name" maxlength="200" disabled></label><button id="admin-workspace-rename" disabled>保存名称</button></div><p id="admin-workspace-meta" class="admin-caption">选择一个工作区查看详情</p>
        <div class="admin-actions"><a id="admin-workspace-open" hidden target="_blank" rel="noopener">${icon('open')}在播放器打开</a><button id="admin-workspace-download" disabled>${icon('download')}下载</button><button id="admin-workspace-delete" class="icon-button admin-danger" aria-label="删除选中工作区" disabled>${icon('trash')}</button></div>
        <div id="admin-workspace-conflict" class="admin-inline-confirm" hidden><span>服务器内容已改变，未覆盖任何修改。</span><button id="admin-workspace-reload">载入最新版本</button><button id="admin-workspace-copy">将当前版本另存副本</button></div>
        <div id="admin-workspace-delete-confirm" class="admin-inline-confirm" hidden><span>删除服务器工作区？不删除视频或已打开的会话。</span><button id="admin-workspace-cancel-delete">取消</button><button id="admin-workspace-confirm-delete">删除工作区</button></div>
        <dl id="admin-workspace-summary" class="admin-properties"></dl><details class="admin-raw-data"><summary>原始工作区数据</summary><textarea id="admin-workspace-json" readonly aria-label="工作区 JSON" spellcheck="false"></textarea></details>
      </div></div></section>`;
}
export function installWorkspaceAdmin(signal: AbortSignal, notice: (value: string, error?: boolean) => void) {
  const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
  const client = new SavedWorkspaceClient(signal);
  let selected: WorkspaceRecord | null = null, busy = false, before = '', next: string | null = null, search = '', generation = 0;
  const users = new Map<string, string>();
  const userName = (id: string) => users.get(id) ?? id;
  void fetch('/api/users', { signal }).then(r => r.json()).then(value => { for (const user of value.users ?? []) users.set(user.id, user.name); }).catch(() => {});
  function controls() {
    for (const id of ['rename', 'download', 'delete', 'name', 'reload', 'copy', 'confirm-delete']) $(`admin-workspace-${id}`).toggleAttribute('disabled', !selected || busy);
    $('admin-workspace-rename').toggleAttribute('disabled', !selected || busy || !$<HTMLInputElement>('admin-workspace-name').value.trim() || $<HTMLInputElement>('admin-workspace-name').value.trim() === selected.name);
    $('admin-workspaces-first').parentElement!.hidden = !before && !next;
    $('admin-workspaces-first').toggleAttribute('disabled', busy || !before); $('admin-workspaces-next').toggleAttribute('disabled', busy || !next);
  }
  async function act(work: () => Promise<void>) { if (busy) return; busy = true; controls(); try { await work(); } catch (error) { if (!signal.aborted) { notice((error as Error).message, true); if (selected && [409, 404].includes((error as { status?: number }).status ?? 0)) $('admin-workspace-conflict').hidden = false; } } finally { busy = false; controls(); } }
  function render(record: WorkspaceRecord | null) {
    $('admin-workspace-json').closest<HTMLElement>('.admin-log-detail')!.dataset.empty = String(!record); selected = record; $('admin-workspace-conflict').hidden = true; $('admin-workspace-delete-confirm').hidden = true;
    $<HTMLInputElement>('admin-workspace-name').value = record?.name ?? '';
    $('admin-workspace-meta').textContent = record ? `版本 ${record.revision} · ${record.tracks} 条轨道 · ${record.marks} 个标注` : '选择一个工作区查看详情';
    $<HTMLTextAreaElement>('admin-workspace-json').value = record ? JSON.stringify(record.document, null, 2) : '';
    properties($('admin-workspace-summary'), record ? [['创建者', userName(record.owner)], ['最后编辑', `${userName(record.updatedBy)} · ${new Date(record.updatedAt).toLocaleString()}`], ['视频', record.document.media.map(media => media.name).join('、') || '无视频']] : []);
    $('admin-workspace-open').hidden = !record;
    if (record) $<HTMLAnchorElement>('admin-workspace-open').href = `/?workspace=${record.id}`;
    controls();
  }
  async function list() {
    const request = ++generation, page = await client.list(before, search, true); if (request !== generation) return; next = page.next;
    const rows = page.entries.map((record: SavedWorkspace) => {
      const button = document.createElement('button'); button.className = 'admin-log-item'; button.setAttribute('aria-pressed', String(record.id === selected?.id));
      const title = document.createElement('strong'); title.textContent = record.name;
      const detail = document.createElement('span'); detail.textContent = `${userName(record.owner)} · ${record.tracks} 条轨道 · ${record.marks} 个标注`;
      button.append(title, detail); button.onclick = () => void act(async () => { render(await client.read(record.id)); for (const row of $('admin-workspaces-list').querySelectorAll('button')) row.setAttribute('aria-pressed', String(row === button)); }); return button;
    });
    if (!rows.length) $('admin-workspaces-list').replaceChildren(emptyState(search ? '没有找到匹配的工作区' : '还没有保存的工作区', search ? '试试其他名称，或清空搜索。' : '在播放器的“设置 → 工作区”中点击“保存到服务器”，即可在这里打开和管理。', !search)); else $('admin-workspaces-list').replaceChildren(...rows);
    controls();
  }
  $('admin-workspace-name').oninput = controls;
  const refresh = () => void act(async () => { before = ''; search = $<HTMLInputElement>('admin-workspaces-search').value.trim(); await list(); });
  $('admin-workspaces-search-button').onclick = $('admin-workspaces-refresh').onclick = refresh;
  $('admin-workspaces-search').onkeydown = event => { if (event.key === 'Enter') { event.preventDefault(); refresh(); } };
  $('admin-workspaces-first').onclick = () => void act(async () => { before = ''; await list(); });
  $('admin-workspaces-next').onclick = () => void act(async () => { if (next) { before = next; await list(); } });
  $('admin-workspace-rename').onclick = () => void act(async () => { if (!selected) return; const stored = await client.save($<HTMLInputElement>('admin-workspace-name').value, selected.document, selected); render({ ...stored, document: selected.document }); await list(); notice('名称已保存。'); });
  $('admin-workspace-reload').onclick = () => void act(async () => { if (selected) render(await client.read(selected.id)); });
  $('admin-workspace-copy').onclick = () => void act(async () => { if (!selected) return; const document = selected.document, saved = await client.save(`${$<HTMLInputElement>('admin-workspace-name').value.trim().slice(0, 197)} 副本`, document); render({ ...saved, document }); before = ''; await list(); notice('已另存为当前用户的副本。'); });
  $('admin-workspace-download').onclick = () => void act(async () => { if (!selected) return; const url = URL.createObjectURL(await compressWorkspace(selected.document)); const link = document.createElement('a'); link.href = url; link.download = selected.name.replace(/[\\/:*?"<>|]/g, '_') + '.voidplayer'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); });
  $('admin-workspace-delete').onclick = () => { $('admin-workspace-delete-confirm').hidden = false; };
  $('admin-workspace-cancel-delete').onclick = () => { $('admin-workspace-delete-confirm').hidden = true; };
  $('admin-workspace-confirm-delete').onclick = () => void act(async () => { if (!selected) return; await client.remove(selected); render(null); await list(); notice('已删除服务器工作区。'); });
  return { activate() { void act(list); } };
}
