import { workspaceCopyName } from './workspace-copy-name.ts';
import { requestError } from './diagnostics.ts';
import { localizedText, localizedAttribute, type LocalizedValue } from '../ui/live-localization.ts';
import { formatDate, formatNumber, t, th, msg } from '../i18n.ts';
import { emptyState, properties } from './presentation.ts';
import { SavedWorkspaceClient } from '../saved-workspaces.ts';
import type { WorkspaceRecord, SavedWorkspace } from '../saved-workspaces.ts';
import { compressWorkspace } from '../workspace-file.ts';
import { icon } from '../ui/icons.ts';
export function workspaceAdminShell() {
  return `<section id="pane-workspaces" class="admin-logs" hidden><header class="admin-heading"><div><h1>${th(msg("admin.wsTitle", "工作区"))}</h1><p>${th(msg("admin.wsDesc", "打开已保存的评审，或修改名称、下载副本。"))}</p></div><button id="admin-workspaces-refresh" class="icon-button" aria-label="${th(msg("admin.refreshWorkspaces", "刷新工作区"))}">${icon('refresh')}</button></header>
    <div class="admin-workspaces-search"><input id="admin-workspaces-search" type="search" placeholder="${th(msg("admin.searchAllWorkspaces", "搜索全部工作区"))}" aria-label="${th(msg("admin.searchAllWorkspaces", "搜索全部工作区"))}"><button id="admin-workspaces-search-button">${th(msg("admin.search", "搜索"))}</button></div>
    <div class="admin-log-workspace"><div class="admin-log-sidebar"><div id="admin-workspaces-list"></div><div class="admin-actions"><button id="admin-workspaces-first" disabled>${th(msg("admin.backToLatest", "返回最新"))}</button><button id="admin-workspaces-next" disabled>${th(msg("admin.nextPage", "下一页"))}</button></div></div>
      <div class="admin-log-detail" data-empty="true"><div class="admin-workspace-title"><label>${th(msg("admin.wsName", "名称"))}<input id="admin-workspace-name" maxlength="200" disabled></label><button id="admin-workspace-rename" disabled>${th(msg("admin.saveName", "保存名称"))}</button></div><p id="admin-workspace-meta" class="admin-caption">${th(msg("admin.selectToView", "选择一个工作区查看详情"))}</p>
        <div class="admin-actions"><a id="admin-workspace-open" hidden target="_blank" rel="noopener">${icon('open')}${th(msg("admin.openInPlayerLink", "在播放器中打开"))}</a><button id="admin-workspace-download" disabled>${icon('download')}${th(msg("admin.download", "下载"))}</button><button id="admin-workspace-delete" class="icon-button admin-danger" aria-label="${th(msg("admin.deleteSelectedWorkspace", "删除选中工作区"))}" disabled>${icon('trash')}</button></div>
        <div id="admin-workspace-conflict" class="admin-inline-confirm" hidden><span>${th(msg("admin.serverChanged", "服务器内容已改变，未覆盖任何修改。"))}</span><button id="admin-workspace-reload">${th(msg("admin.loadLatest", "载入最新版本"))}</button><button id="admin-workspace-copy">${th(msg("admin.saveCopy", "将当前版本另存副本"))}</button></div>
        <div id="admin-workspace-delete-confirm" class="admin-inline-confirm" hidden><span>${th(msg("admin.deleteWsConfirm", "删除服务器工作区？不删除视频或已打开的会话。"))}</span><button id="admin-workspace-cancel-delete">${th(msg("admin.cancel", "取消"))}</button><button id="admin-workspace-confirm-delete">${th(msg("admin.deleteWorkspace", "删除工作区"))}</button></div>
        <dl id="admin-workspace-summary" class="admin-properties"></dl><details class="admin-raw-data"><summary>${th(msg("admin.rawData", "原始工作区数据"))}</summary><textarea id="admin-workspace-json" readonly aria-label="${th(msg("admin.wsJson", "工作区 JSON"))}" spellcheck="false"></textarea></details>
      </div></div></section>`;
}
export function installWorkspaceAdmin(signal: AbortSignal, notice: (value: LocalizedValue, error?: boolean) => void) {
  const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
  const client = new SavedWorkspaceClient(signal);
  let selected: WorkspaceRecord | null = null, busy = false, before = '', next: string | null = null, search = '', generation = 0;
  const users = new Map<string, string>();
  const userName = (id: string) => users.get(id) ?? (id.startsWith('guest-') ? t(msg("admin.guestId", "访客 · {id}"), { id: id.slice(6,14) }) : id);
  void fetch('/api/users', { signal }).then(r => r.json()).then(value => { for (const user of value.users ?? []) users.set(user.id, user.name); }).catch(() => {});
  function controls() {
    for (const id of ['rename', 'download', 'delete', 'name', 'reload', 'copy', 'confirm-delete']) $(`admin-workspace-${id}`).toggleAttribute('disabled', !selected || busy);
    $('admin-workspace-rename').toggleAttribute('disabled', !selected || busy || !$<HTMLInputElement>('admin-workspace-name').value.trim() || $<HTMLInputElement>('admin-workspace-name').value.trim() === selected.name);
    $('admin-workspaces-first').parentElement!.hidden = !before && !next;
    $('admin-workspaces-first').toggleAttribute('disabled', busy || !before); $('admin-workspaces-next').toggleAttribute('disabled', busy || !next);
  }
  async function act(work: () => Promise<void>) { if (busy) return; busy = true; controls(); try { await work(); } catch (error) { if (!signal.aborted) { notice(() => requestError(error), true); if (selected && [409, 404].includes((error as { status?: number }).status ?? 0)) $('admin-workspace-conflict').hidden = false; } } finally { busy = false; controls(); } }
  function render(record: WorkspaceRecord | null) {
    $('admin-workspace-json').closest<HTMLElement>('.admin-log-detail')!.dataset.empty = String(!record); selected = record; $('admin-workspace-conflict').hidden = true; $('admin-workspace-delete-confirm').hidden = true;
    $<HTMLInputElement>('admin-workspace-name').value = record?.name ?? '';
    localizedText($('admin-workspace-meta'), () => record ? t(msg("admin.wsMetaLine", "版本 {rev} · {tracks, plural, other {# 条轨道}} · {marks, plural, other {# 个标注}}"), { rev: record.revision, tracks: record.tracks, marks: record.marks }) : t(msg("admin.selectToView", "选择一个工作区查看详情")));
    $<HTMLTextAreaElement>('admin-workspace-json').value = record ? JSON.stringify(record.document, null, 2) : '';
    properties($('admin-workspace-summary'), () => record ? [[t(msg("admin.wsCreator", "创建者")), userName(record.owner)], [t(msg("admin.wsLastEdit", "最后编辑")), `${userName(record.updatedBy)} · ${formatDate(record.updatedAt)}`], [t(msg("admin.wsVideos", "视频")), record.document.media.map(media => media.name).join('、') || t(msg("admin.wsNoVideos", "无视频"))]] : []);
    $('admin-workspace-open').hidden = !record;
    if (record) $<HTMLAnchorElement>('admin-workspace-open').href = `/?workspace=${record.id}`;
    controls();
  }
  async function list() {
    const request = ++generation, page = await client.list(before, search, true); if (request !== generation) return; next = page.next;
    const rows = page.entries.map((record: SavedWorkspace) => {
      const button = document.createElement('button'); button.className = 'admin-log-item'; button.setAttribute('aria-pressed', String(record.id === selected?.id));
      const title = document.createElement('strong'); localizedText(title, () => record.name);
      const detail = document.createElement('span'); localizedText(detail, () => t(msg("admin.workspaceRow", "{owner} · {tracks, plural, other {# 条轨道}} · {marks, plural, other {# 个标注}}"), {owner:userName(record.owner),tracks:record.tracks,marks:record.marks}));
      button.append(title, detail); button.onclick = () => void act(async () => { render(await client.read(record.id)); for (const row of $('admin-workspaces-list').querySelectorAll('button')) row.setAttribute('aria-pressed', String(row === button)); }); return button;
    });
    if (!rows.length) $('admin-workspaces-list').replaceChildren(emptyState(() => search ? t(msg("admin.noMatchWs", "没有找到匹配的工作区")) : t(msg("admin.noWsYet", "还没有保存的工作区")), () => search ? t(msg("admin.tryOtherNames", "试试其他名称，或清空搜索。")) : t(msg("admin.wsEmptyHint", "在播放器的“设置 → 工作区”中点击“保存到服务器”，即可在这里打开和管理。")), !search)); else $('admin-workspaces-list').replaceChildren(...rows);
    controls();
  }
  $('admin-workspace-name').oninput = controls;
  const refresh = () => void act(async () => { before = ''; search = $<HTMLInputElement>('admin-workspaces-search').value.trim(); await list(); });
  $('admin-workspaces-search-button').onclick = $('admin-workspaces-refresh').onclick = refresh;
  $('admin-workspaces-search').onkeydown = event => { if (event.key === 'Enter') { event.preventDefault(); refresh(); } };
  $('admin-workspaces-first').onclick = () => void act(async () => { before = ''; await list(); });
  $('admin-workspaces-next').onclick = () => void act(async () => { if (next) { before = next; await list(); } });
  $('admin-workspace-rename').onclick = () => void act(async () => { if (!selected) return; const stored = await client.save($<HTMLInputElement>('admin-workspace-name').value, selected.document, selected); render({ ...stored, document: selected.document }); await list(); notice(() => t(msg("admin.nameSaved", "名称已保存。"))); });
  $('admin-workspace-reload').onclick = () => void act(async () => { if (selected) render(await client.read(selected.id)); });
  $('admin-workspace-copy').onclick = () => void act(async () => { if (!selected) return; const document = selected.document, saved = await client.save(workspaceCopyName($<HTMLInputElement>('admin-workspace-name').value, name => t(msg("admin.workspaceCopyName", "{name} 副本"), {name})), document); render({ ...saved, document }); before = ''; await list(); notice(() => t(msg("admin.savedAsCopy", "已另存为当前用户的副本。"))); });
  $('admin-workspace-download').onclick = () => void act(async () => { if (!selected) return; const url = URL.createObjectURL(await compressWorkspace(selected.document)); const link = document.createElement('a'); link.href = url; link.download = selected.name.replace(/[\\/:*?"<>|]/g, '_') + '.voidplayer'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); });
  $('admin-workspace-delete').onclick = () => { $('admin-workspace-delete-confirm').hidden = false; };
  $('admin-workspace-cancel-delete').onclick = () => { $('admin-workspace-delete-confirm').hidden = true; };
  $('admin-workspace-confirm-delete').onclick = () => void act(async () => { if (!selected) return; await client.remove(selected); render(null); await list(); notice(() => t(msg("admin.wsDeleted", "已删除服务器工作区。"))); });
  return { activate() { void act(list); } };
}
