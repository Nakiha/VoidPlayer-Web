import { currentActor, identityHealth } from '../identity.ts';
import { SavedWorkspaceClient } from '../saved-workspaces.ts';
import type { SavedWorkspace } from '../saved-workspaces.ts';
import type { WorkspaceFile } from '../workspace-file.ts';
import { prepareSharedWorkspace } from '../shared-workspace.ts';
import { icon } from './icons.ts';
export function savedWorkspaceShell() {
  return `<div class="settings-section"><h4 class="settings-section-title">当前工作区</h4><div class="workspace-current-section settings-card">
    <div class="workspace-single-row"><input id="saved-workspace-name" maxlength="200" aria-label="工作区名称" placeholder="命名工作区"><button id="saved-workspace-save">保存工作区</button><button id="saved-workspace-share">${icon('export')}<span>分享</span></button></div>
    <p id="annotation-sync-status" class="settings-caption" role="status"></p>
    <div id="annotation-recovery" hidden>
      <div class="annotation-sync-actions"><button id="annotation-sync-now">重试保存</button><button id="annotation-drafts-export">导出未保存的批注</button></div>
      <div id="annotation-conflicts-section" hidden><div id="annotation-conflicts"></div></div>
      <div id="annotation-drafts-section" hidden><div id="annotation-other-drafts"></div></div>
    </div>
    <p id="saved-workspace-message" role="status" class="settings-caption" hidden></p>
    <div id="saved-workspace-conflict" class="saved-workspace-conflict" hidden><span>工作区已被更新，请重新打开后继续。</span><button id="saved-workspace-reload">重新打开</button></div>
    </div>
    </div><div class="workspace-saved-section settings-section"><div class="settings-section-heading"><h4 class="settings-section-title">已保存的工作区</h4></div>
    <div class="saved-workspace-search">${icon('search')}<input id="saved-workspace-search" type="search" aria-label="搜索工作区名或用户名" placeholder="搜索工作区名或用户名" maxlength="200"><button id="saved-workspace-search-button" class="icon-button" aria-label="清除搜索" hidden>${icon('close')}</button></div>
    <div class="workspace-list-wrapper settings-card"><div class="workspace-list-columns" aria-hidden="true"><span>名称 / 用户</span><span>最近更新 ↓</span></div><div id="saved-workspace-list" class="saved-workspace-list"></div></div>
    <div class="saved-workspace-pages" hidden><button id="saved-workspace-first" disabled>返回最新</button><button id="saved-workspace-next" disabled>下一页</button></div></div>`;
}

export function installSavedWorkspaces(options: { signal: AbortSignal; snapshot(): WorkspaceFile; open(document: WorkspaceFile, space?: string): Promise<boolean>; canSave(): boolean; report(error: Error): void }) {
  const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(`saved-workspace-${id}`) as T;
  const client = new SavedWorkspaceClient(options.signal);
  let binding: SavedWorkspace | undefined, busy = false, available = false, before = '', next: string | null = null, search = '', sequence = 0;
  let refreshAfterBusy = false, bindingEpoch = 0;
  let idle: Promise<void> = Promise.resolve();
  const message = (value: string, error = false) => { $('message').hidden = !value; $('message').textContent = value; $('message').dataset.error = String(error); };
  const title = () => $<HTMLInputElement>('name').value.trim() || '未命名工作区';
  function controls() {
    $('name').toggleAttribute('disabled', busy);
    $('save').toggleAttribute('disabled',busy || !options.canSave());
    $('reload').toggleAttribute('disabled', busy || $('reload').dataset.unavailable === 'true');
    $('first').toggleAttribute('disabled', busy || !before); $('next').toggleAttribute('disabled', busy || !next);
    $('list').querySelectorAll<HTMLButtonElement>('.saved-workspace-open').forEach(button => { button.setAttribute('aria-pressed', String(button.dataset.workspaceId === binding?.id)); button.disabled = busy; });
    document.querySelector<HTMLElement>('.saved-workspace-pages')!.hidden = !available || (!before && !next);
  }
  async function act<T>(work: () => Promise<T>, propagate = false): Promise<T | undefined> {
    if (busy) return; busy = true; let release!: () => void; idle = new Promise(resolve => { release = resolve; }); controls();
    try { return await work(); }
    catch (error) { if (!options.signal.aborted) { message((error as Error).message, true); if (!propagate) options.report(error as Error); } if (propagate) throw error; }
    finally { busy = false; release(); controls(); if (refreshAfterBusy && !options.signal.aborted) { refreshAfterBusy = false; refresh(); } }
  }
  async function list() {
    const request = ++sequence;
    const page = await client.list(before, search, true);
    if (request !== sequence) return;
    available = true; next = page.next;
    const rows = page.entries.map(record => {
      const row = document.createElement('button'); row.type = 'button'; row.dataset.workspaceId = record.id; row.className = 'saved-workspace-row saved-workspace-open'; row.setAttribute('aria-pressed', String(record.id === binding?.id));
      const info = document.createElement('span'); info.className = 'saved-workspace-info';
      const name = document.createElement('strong'); name.textContent = record.name;
      const detail = document.createElement('span'); detail.textContent = record.ownerName ?? '访客';
      info.append(name, detail); row.onclick = () => void act(() => load(record.id));
      const time = document.createElement('time'); time.className = 'workspace-row-time'; time.dateTime = record.updatedAt; time.textContent = new Date(record.updatedAt).toLocaleString();
      row.append(info, time); return row;
    });
    if (!rows.length) { const empty = document.createElement('p'); empty.className = 'settings-caption'; empty.textContent = search ? '没有匹配的工作区' : '暂无工作区'; $('list').replaceChildren(empty); }
    else $('list').replaceChildren(...rows);
    controls();
  }
  async function load(id: string) {
    const owner = (await identityHealth()).actor?.id;
    const record = await client.read(id);
    if (owner !== currentActor()?.id) return;
    if (!await options.open(record.document, record.space ?? undefined)) return;
    if (owner !== currentActor()?.id) return;
    binding = record; delete $('reload').dataset.unavailable; $<HTMLInputElement>('name').value = record.name; $('conflict').hidden = true; message(''); controls();
    const url = new URL(location.href); url.searchParams.delete('share'); url.searchParams.delete('review'); url.searchParams.set('workspace', record.id); history.replaceState(null, '', url);
  }
  async function persist(document = options.snapshot()) {
    const owner = currentActor()?.id;
    try {
      const stored = await client.save(document.name || title(), binding?.space ? await prepareSharedWorkspace(document) : document, binding);
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
  $('save').onclick=()=>void act(()=>persist());
  $('name').addEventListener('change', () => {
    if (binding) void act(async () => {
      const stored = await client.read(binding!.id);
      // Renaming must not overwrite a newer server revision with the local session.
      if (stored.revision !== binding!.revision) { $('conflict').hidden = false; throw new Error('工作区已被更新，请重新打开后继续。'); }
      await persist({ ...stored.document, name: title() });
    });
  }, { signal: options.signal });
  $('name').onkeydown = event => { if (event.key === 'Enter') { event.preventDefault(); $('name').blur(); } };
  $('reload').onclick = () => { if (binding) void act(() => load(binding!.id)); };
  const refresh = () => void act(async () => { message(''); before = ''; search = $<HTMLInputElement>('search').value.trim(); await list(); });
  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  const syncVisibleList = () => {
    if (options.signal.aborted || !available || document.getElementById('settings-pane-workspace')!.hidden) return;
    if (busy) { refreshAfterBusy = true; return; }
    void act(list);
  };
  window.addEventListener('focus', syncVisibleList, { signal: options.signal });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) syncVisibleList(); }, { signal: options.signal });
  const syncTimer = window.setInterval(syncVisibleList, 30_000);
  options.signal.addEventListener('abort', () => clearInterval(syncTimer), { once: true });
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
  return { name: title, binding: () => binding,
    async share(document: WorkspaceFile, id: string, previous?: SavedWorkspace) {
      while (busy) await idle;
      if (options.signal.aborted) throw new Error('工作区页面已关闭。');
      const stamp=bindingEpoch;
      const result = await act(async () => {
        const owner=currentActor()?.id;
        try {
          const stored=await client.share(document.name || title(), document, id, previous);
          if (owner !== currentActor()?.id) throw new Error('用户已切换，工作区已保存，请重新打开。');
          if (stamp !== bindingEpoch) throw new Error('工作区已保存，但当前页面已切换，请在新工作区重新分享。');
          binding=stored; $<HTMLInputElement>('name').value=stored.name; $('conflict').hidden=true; before=''; message(''); await list(); return stored;
        } catch(error) {
          if (previous && [404,409].includes((error as {status?:number}).status ?? 0)) { $('conflict').hidden=false; $('reload').dataset.unavailable=String((error as {status?:number}).status===404); }
          throw error;
        }
      },true);
      if (!result) throw new Error('工作区正在保存，请稍后再分享。');
      return result;
    }, detach(name = '') { bindingEpoch++; binding = undefined; $<HTMLInputElement>('name').value = name; $('conflict').hidden = true; controls(); }, open(id: string) { return act(() => load(id)); }, update: controls };
}
