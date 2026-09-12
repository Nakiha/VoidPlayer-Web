import { currentActor, identityHealth } from '../identity.ts';
import { SavedWorkspaceClient } from '../saved-workspaces.ts';
import type { SavedWorkspace } from '../saved-workspaces.ts';
import type { WorkspaceFile } from '../workspace-file.ts';
import { icon } from './icons.ts';
export function savedWorkspaceShell() {
  return `<div class="settings-section"><h4 class="settings-section-title">当前工作区</h4><div class="workspace-current-section settings-card">
    <div class="workspace-single-row"><input id="saved-workspace-name" maxlength="200" aria-label="工作区名称" placeholder="命名工作区"><button id="saved-workspace-share">${icon('export')}<span>分享</span></button></div>
    <p id="saved-workspace-message" role="status" class="settings-caption" hidden></p>
    <div id="saved-workspace-conflict" class="saved-workspace-conflict" hidden><span>工作区已被更新，请重新打开后改名。</span><button id="saved-workspace-reload">重新打开</button></div>
    </div>
    </div><div class="workspace-saved-section settings-section"><div class="settings-section-heading"><h4 class="settings-section-title">已保存的工作区</h4><button id="saved-workspace-refresh" class="icon-button" aria-label="刷新服务器工作区">${icon('refresh')}</button></div>
    <div class="saved-workspace-search">${icon('search')}<input id="saved-workspace-search" type="search" aria-label="搜索工作区名或用户名" placeholder="搜索工作区名或用户名" maxlength="200"><button id="saved-workspace-search-button" class="icon-button" aria-label="清除搜索" hidden>${icon('close')}</button></div>
    <div class="workspace-list-wrapper settings-card"><div class="workspace-list-columns" aria-hidden="true"><span>名称 / 用户</span><span>最近更新 ↓</span></div><div id="saved-workspace-list" class="saved-workspace-list"></div></div>
    <div class="saved-workspace-pages" hidden><button id="saved-workspace-first" disabled>返回最新</button><button id="saved-workspace-next" disabled>下一页</button></div></div>`;
}

export function installSavedWorkspaces(options: { signal: AbortSignal; snapshot(): WorkspaceFile; open(document: WorkspaceFile): Promise<boolean>; canSave(): boolean; report(error: Error): void }) {
  const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(`saved-workspace-${id}`) as T;
  const client = new SavedWorkspaceClient(options.signal);
  let binding: SavedWorkspace | undefined, busy = false, available = false, before = '', next: string | null = null, search = '', sequence = 0;
  let refreshAfterBusy = false;
  let idle: Promise<void> = Promise.resolve();
  const message = (value: string, error = false) => { $('message').hidden = !value; $('message').textContent = value; $('message').dataset.error = String(error); };
  const title = () => $<HTMLInputElement>('name').value.trim() || '未命名工作区';
  function controls() {
    $('name').toggleAttribute('disabled', busy);
    $('reload').toggleAttribute('disabled', busy || $('reload').dataset.unavailable === 'true');
    $('first').toggleAttribute('disabled', busy || !before); $('next').toggleAttribute('disabled', busy || !next);
    $('list').querySelectorAll<HTMLButtonElement>('.saved-workspace-open').forEach(button => { button.setAttribute('aria-pressed', String(button.dataset.workspaceId === binding?.id)); button.disabled = busy; });
    document.querySelector<HTMLElement>('.saved-workspace-pages')!.hidden = !available || (!before && !next);
  }
  async function act(work: () => Promise<void>) {
    if (busy) return; busy = true; let release!: () => void; idle = new Promise(resolve => { release = resolve; }); controls();
    try { await work(); }
    catch (error) { if (!options.signal.aborted) { message((error as Error).message, true); options.report(error as Error); } }
    finally { busy = false; release(); controls(); if (refreshAfterBusy && !options.signal.aborted) { refreshAfterBusy = false; refresh(); } }
  }
  async function list() {
    const request = ++sequence;
    const page = await client.list(before, search, true);
    if (request !== sequence) return;
    available = true; next = page.next;
    const rows = page.entries.map(record => {
      const row = document.createElement('div'); row.className = 'saved-workspace-row';
      const open = document.createElement('button'); open.dataset.workspaceId = record.id; open.className = 'saved-workspace-open'; open.setAttribute('aria-pressed', String(record.id === binding?.id));
      const name = document.createElement('strong'); name.textContent = record.name;
      const detail = document.createElement('span'); detail.textContent = record.ownerName ?? '访客';
      open.append(name, detail); open.onclick = () => void act(() => load(record.id));
      const time = document.createElement('time'); time.className = 'workspace-row-time'; time.dateTime = record.updatedAt; time.textContent = new Date(record.updatedAt).toLocaleString();
      row.append(open, time); return row;
    });
    if (!rows.length) { const empty = document.createElement('p'); empty.className = 'settings-caption'; empty.textContent = search ? '没有匹配的工作区' : '暂无工作区'; $('list').replaceChildren(empty); }
    else $('list').replaceChildren(...rows);
    controls();
  }
  async function load(id: string) {
    const owner = (await identityHealth()).actor?.id;
    const record = await client.read(id);
    if (owner !== currentActor()?.id) return;
    if (!await options.open(record.document)) return;
    if (owner !== currentActor()?.id) return;
    binding = record; delete $('reload').dataset.unavailable; $<HTMLInputElement>('name').value = record.name; $('conflict').hidden = true; message(''); controls();
  }
  async function persist(document = options.snapshot()) {
    const owner = currentActor()?.id;
    try {
      const stored = await client.save(document.name || title(), document, binding);
      if (owner !== currentActor()?.id) return;
      binding = stored; $('conflict').hidden = true; before = ''; message(''); await list();
    } catch (error) {
      if ([409, 404].includes((error as { status?: number }).status ?? 0) && binding) {
        $('conflict').hidden = false;
        $('reload').dataset.unavailable = String((error as { status?: number }).status === 404);
      }
      throw error;
    }
  }
  $('name').addEventListener('change', () => {
    if (binding) void act(async () => {
      const stored = await client.read(binding!.id);
      // Renaming must not overwrite a newer server revision with the local session.
      if (stored.revision !== binding!.revision) { $('conflict').hidden = false; throw new Error('工作区已被更新，请重新打开后改名。'); }
      await persist({ ...stored.document, name: title() });
    });
  }, { signal: options.signal });
  $('name').onkeydown = event => { if (event.key === 'Enter') { event.preventDefault(); $('name').blur(); } };
  $('reload').onclick = () => { if (binding) void act(() => load(binding!.id)); };
  const refresh = () => void act(async () => { message(''); before = ''; search = $<HTMLInputElement>('search').value.trim(); await list(); });
  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  $('refresh').onclick = refresh;
  $('search-button').onclick = () => { $<HTMLInputElement>('search').value = ''; $('search-button').hidden = true; if (busy) refreshAfterBusy = true; else refresh(); $('search').focus(); };
  $('search').addEventListener('input', event => {
    $('search-button').hidden = !$<HTMLInputElement>('search').value;
    clearTimeout(searchTimer);
    if ((event as InputEvent).isComposing) return;
    searchTimer = setTimeout(() => { if (busy) refreshAfterBusy = true; else refresh(); }, 180);
  }, { signal: options.signal });
  options.signal.addEventListener('abort', () => clearTimeout(searchTimer), { once: true });
  $('search').onkeydown = event => { if (event.key === 'Enter') { event.preventDefault(); refresh(); } };
  $('first').onclick = () => void act(async () => { before = ''; await list(); });
  $('next').onclick = () => void act(async () => { if (next) { before = next; await list(); } });
  window.addEventListener('voidplayer-identity-change', event => {
    const { actor, previous } = (event as CustomEvent).detail;
    if (actor?.id === previous?.id) return;
    ++sequence; binding = undefined; before = ''; next = null;
    $('conflict').hidden = true; $('list').replaceChildren();
    search = ''; $('search-button').hidden = true; $<HTMLInputElement>('search').value = ''; message(''); controls();
    if (actor && !document.getElementById('settings-pane-workspace')!.hidden) { if (busy) refreshAfterBusy = true; else refresh(); }
  }, { signal: options.signal });
  const settings = document.getElementById('settings')!;
  settings.addEventListener('settings-pane-change', event => { if ((event as CustomEvent).detail === 'workspace') void act(async () => {
    message(''); const health = await identityHealth(); available = !!health.capabilities?.workspaces; controls();
    if (available) await list(); else message('工作区服务不可用。');
  }); }, { signal: options.signal });
  controls();
  return { name: title, async shared(document: WorkspaceFile) { while (busy) await idle; if (!options.signal.aborted) await act(() => persist(document)); }, detach(name = '') { binding = undefined; $<HTMLInputElement>('name').value = name; $('conflict').hidden = true; controls(); }, open(id: string) { return act(() => load(id)); }, update: controls };
}
