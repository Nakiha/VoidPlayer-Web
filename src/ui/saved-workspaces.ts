import { currentActor, identityHealth } from '../identity.ts';
import { SavedWorkspaceClient } from '../saved-workspaces.ts';
import type { SavedWorkspace } from '../saved-workspaces.ts';
import type { WorkspaceFile } from '../workspace-file.ts';
import { icon } from './icons.ts';
export function savedWorkspaceShell() {
  return `<h4 class="settings-section-title">服务器工作区</h4><p class="settings-caption">主动保存到当前服务器，按当前用户整理。保存视频引用和标注，不上传视频文件。</p>
    <div class="saved-workspace-editor"><label>工作区名称<input id="saved-workspace-name" maxlength="200" placeholder="为这次评审命名"></label><button id="saved-workspace-copy" hidden>另存副本</button><button id="saved-workspace-save">${icon('check')}保存到服务器</button></div>
    <p id="saved-workspace-binding" class="settings-caption">尚未关联服务器工作区</p><p id="saved-workspace-message" role="status" class="settings-caption" hidden></p>
    <div id="saved-workspace-conflict" class="saved-workspace-conflict" hidden><span>当前会话保持不变。可以载入服务器版本，或把当前内容另存为副本。</span><button id="saved-workspace-reload">载入服务器版本</button><button id="saved-workspace-conflict-copy">另存副本</button></div>
    <div class="saved-workspace-search"><input id="saved-workspace-search" type="search" aria-label="搜索服务器工作区" placeholder="搜索自己的工作区"><button id="saved-workspace-search-button">搜索</button><button id="saved-workspace-refresh" class="icon-button" aria-label="刷新服务器工作区">${icon('refresh')}</button></div>
    <div id="saved-workspace-list" class="saved-workspace-list"></div><div class="saved-workspace-pages"><button id="saved-workspace-first" disabled>返回最新</button><button id="saved-workspace-next" disabled>下一页</button></div>
    <div id="saved-workspace-delete" class="saved-workspace-conflict" hidden><span></span><button id="saved-workspace-delete-cancel">取消</button><button id="saved-workspace-delete-confirm">删除工作区</button></div>`;
}
export function installSavedWorkspaces(options: { signal: AbortSignal; snapshot(): WorkspaceFile; open(document: WorkspaceFile): Promise<boolean>; canSave(): boolean; report(error: Error): void }) {
  const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(`saved-workspace-${id}`) as T;
  const client = new SavedWorkspaceClient(options.signal);
  let binding: SavedWorkspace | undefined, busy = false, available = false, before = '', next: string | null = null, search = '', sequence = 0;
  let deleting: SavedWorkspace | null = null;
  const message = (value: string, error = false) => { $('message').hidden = !value; $('message').textContent = value; $('message').dataset.error = String(error); };
  const title = () => $<HTMLInputElement>('name').value.trim();
  function controls() {
    $('save').toggleAttribute('disabled', busy || !available || !options.canSave()); $('copy').hidden = !binding;
    for (const id of ['copy', 'name', 'reload', 'conflict-copy', 'delete-confirm']) $(id).toggleAttribute('disabled', busy);
    $('reload').toggleAttribute('disabled', busy || $('reload').dataset.unavailable === 'true');
    $('first').toggleAttribute('disabled', busy || !before); $('next').toggleAttribute('disabled', busy || !next);
    $('binding').textContent = binding ? `已关联「${binding.name}」· 版本 ${binding.revision} · 最后保存 ${new Date(binding.updatedAt).toLocaleString()}` : '尚未关联服务器工作区';
  }
  async function act(work: () => Promise<void>) {
    if (busy) return; busy = true; controls();
    try { await work(); }
    catch (error) { if (!options.signal.aborted) { message((error as Error).message, true); options.report(error as Error); } }
    finally { busy = false; controls(); }
  }
  async function list() {
    const request = ++sequence;
    const page = await client.list(before, search);
    if (request !== sequence) return;
    available = true; next = page.next;
    const rows = page.entries.map(record => {
      const row = document.createElement('div'); row.className = 'saved-workspace-row';
      const open = document.createElement('button'); open.className = 'saved-workspace-open'; open.setAttribute('aria-pressed', String(record.id === binding?.id));
      const name = document.createElement('strong'); name.textContent = record.name;
      const detail = document.createElement('span'); detail.textContent = `版本 ${record.revision} · ${record.tracks} 轨 · ${record.marks} 个标注 · ${new Date(record.updatedAt).toLocaleString()}`;
      open.append(name, detail); open.onclick = () => void act(() => load(record.id));
      const remove = document.createElement('button'); remove.className = 'icon-button saved-workspace-danger'; remove.setAttribute('aria-label', `删除工作区 ${record.name}`); remove.innerHTML = icon('trash');
      remove.onclick = () => { if (busy) return; deleting = record; $('delete').hidden = false; $('delete').querySelector('span')!.textContent = `从服务器删除「${record.name}」？当前会话和视频文件会保留。`; };
      row.append(open, remove); return row;
    });
    if (!rows.length) { const empty = document.createElement('p'); empty.className = 'settings-caption'; empty.textContent = '暂无匹配的服务器工作区'; $('list').replaceChildren(empty); }
    else $('list').replaceChildren(...rows);
    controls();
  }
  async function load(id: string) {
    const owner = (await identityHealth()).actor?.id;
    const record = await client.read(id);
    if (owner !== currentActor()?.id) return;
    if (!await options.open(record.document)) return;
    if (owner !== currentActor()?.id) return;
    binding = record; delete $('reload').dataset.unavailable; $<HTMLInputElement>('name').value = record.name; $('conflict').hidden = true; message(`已载入「${record.name}」版本 ${record.revision}。`); controls();
  }
  async function save(copy = false) {
    if (!options.canSave()) throw new Error('请先打开视频再保存工作区。');
    const name = title(); if (!name) { $<HTMLInputElement>('name').focus(); throw new Error('请填写工作区名称。'); }
    try {
      const owner = currentActor()?.id;
      const stored = await client.save(copy ? `${name.slice(0, 197)} 副本` : name, options.snapshot(), copy ? undefined : binding);
      if (owner !== currentActor()?.id) return;
      binding = stored; delete $('reload').dataset.unavailable; $<HTMLInputElement>('name').value = stored.name; $('conflict').hidden = true; before = ''; message(`已保存到服务器，版本 ${stored.revision}。`); await list();
    } catch (error) { if ([409, 404].includes((error as { status?: number }).status ?? 0) && binding) { $('conflict').hidden = false; $('reload').dataset.unavailable = String((error as { status?: number }).status === 404); } throw error; }
  }
  $('save').onclick = () => void act(() => save()); $('copy').onclick = $('conflict-copy').onclick = () => void act(() => save(true));
  $('reload').onclick = () => { if (binding) void act(() => load(binding!.id)); };
  const refresh = () => void act(async () => { before = ''; search = $<HTMLInputElement>('search').value.trim(); await list(); });
  $('search-button').onclick = $('refresh').onclick = refresh;
  $('search').onkeydown = event => { if (event.key === 'Enter') { event.preventDefault(); refresh(); } };
  $('first').onclick = () => void act(async () => { before = ''; await list(); });
  $('next').onclick = () => void act(async () => { if (next) { before = next; await list(); } });
  $('delete-cancel').onclick = () => { deleting = null; $('delete').hidden = true; };
  $('delete-confirm').onclick = () => void act(async () => { const record = deleting; if (!record) return; await client.remove(record); if (deleting !== record) return; if (binding?.id === record.id) binding = undefined; deleting = null; $('delete').hidden = true; message('已从服务器删除，当前会话保留。'); await list(); });
  window.addEventListener('voidplayer-identity-change', event => {
    const { actor, previous } = (event as CustomEvent).detail;
    if (actor?.id === previous?.id) return;
    ++sequence; binding = undefined; deleting = null; before = ''; next = null;
    $('conflict').hidden = $('delete').hidden = true; $('list').replaceChildren();
    message('用户已切换，打开或刷新列表以查看该用户的工作区。'); controls();
  }, { signal: options.signal });
  const settings = document.getElementById('settings')!;
  settings.addEventListener('settings-pane-change', event => { if ((event as CustomEvent).detail === 'workspace') void act(async () => {
    const health = await identityHealth(); available = !!health.capabilities?.workspaces; controls();
    if (available) await list(); else message('当前服务尚未提供工作区保存。导出文件仍然可用。');
  }); }, { signal: options.signal });
  controls();
  return { detach() { binding = undefined; $('conflict').hidden = true; controls(); }, open(id: string) { return act(() => load(id)); }, update: controls };
}
