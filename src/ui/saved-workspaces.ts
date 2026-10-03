import { t, msg, th, onLanguageChange, formatDate } from '../i18n.ts';
import { currentActor, identityHealth } from '../identity.ts';
import { SavedWorkspaceClient } from '../saved-workspaces.ts';
import type { SavedWorkspace } from '../saved-workspaces.ts';
import type { WorkspaceFile } from '../workspace-file.ts';
import { prepareSharedWorkspace } from '../shared-workspace.ts';
import { icon } from './icons.ts';
export function savedWorkspaceShell() {
  return `<div class="settings-section"><h4 class="settings-section-title">${th(msg("savedWorkspaces.currentWorkspace", "当前工作区"))}</h4><div class="workspace-current-section settings-card">
    <div class="workspace-current-row"><input id="saved-workspace-name" maxlength="200" aria-label="${th(msg("savedWorkspaces.workspaceName", "工作区名称"))}" placeholder="${th(msg("savedWorkspaces.untitledWorkspace", "未命名工作区"))}"><div class="workspace-current-actions"><button id="saved-workspace-save">${th(msg("identitySettings.save", "保存"))}</button><button id="saved-workspace-share">${icon('copy')}<span>${th(msg("sharing.copyLink", "复制链接"))}</span></button></div></div>
    <div id="annotation-recovery" hidden>
      <div class="annotation-sync-actions"><button id="annotation-sync-now">${th(msg("workspace.retry", "重试保存"))}</button><button id="annotation-drafts-export">${th(msg("workspace.exportDrafts", "导出未保存的批注"))}</button></div>
      <div id="annotation-conflicts-section" hidden><div id="annotation-conflicts"></div></div>
      <div id="annotation-drafts-section" hidden><div id="annotation-other-drafts"></div></div>
    </div>
    <p id="saved-workspace-message" role="status" class="settings-caption" hidden></p>
    <div id="saved-workspace-conflict" class="saved-workspace-conflict" hidden><span>${th(msg("savedWorkspaces.updatedReopen", "工作区已被更新，请重新打开后继续。"))}</span><button id="saved-workspace-reload">${th(msg("savedWorkspaces.reopen", "重新打开"))}</button></div>
    </div>
    </div><div class="workspace-saved-section settings-section"><div class="settings-section-heading"><h4 class="settings-section-title">${th(msg("savedWorkspaces.savedWorkspaces", "已保存的工作区"))}</h4></div>
    <div class="saved-workspace-search">${icon('search')}<input id="saved-workspace-search" type="search" aria-label="${th(msg("savedWorkspaces.searchWorkspaceOrUserName", "搜索工作区名或用户名"))}" placeholder="${th(msg("savedWorkspaces.searchWorkspaceOrUserName", "搜索工作区名或用户名"))}" maxlength="200"><button id="saved-workspace-search-button" class="icon-button" aria-label="${th(msg("savedWorkspaces.clearSearch", "清除搜索"))}" hidden>${icon('close')}</button></div>
    <div class="workspace-list-wrapper settings-card"><div class="workspace-list-columns" aria-hidden="true"><span>${th(msg("workspace.columns", "名称 / 用户 · 最近更新 ↓"))}</span><span>${th(msg("sharing.link", "链接"))}</span></div><div id="saved-workspace-list" class="saved-workspace-list"></div></div>
    <div class="saved-workspace-pages" hidden><button id="saved-workspace-first" disabled>${th(msg("savedWorkspaces.backToLatest", "返回最新"))}</button><button id="saved-workspace-next" disabled>${th(msg("savedWorkspaces.nextPage", "下一页"))}</button></div></div>`;
}

export function installSavedWorkspaces(options: { signal: AbortSignal; snapshot(): WorkspaceFile; open(document: WorkspaceFile, space?: string): Promise<boolean>; copyLink(id: string, trigger: HTMLElement): Promise<void>; canSave(): boolean; report(error: Error): void }) {
  const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(`saved-workspace-${id}`) as T;
  const client = new SavedWorkspaceClient(options.signal);
  let binding: SavedWorkspace | undefined, busy = false, available = false, before = '', next: string | null = null, search = '', sequence = 0;
  let refreshAfterBusy = false, bindingEpoch = 0;
  let idle: Promise<void> = Promise.resolve();
  const captureRequest = () => ({ binding, owner: currentActor()?.id, epoch: bindingEpoch });
  const isCurrent = (request: ReturnType<typeof captureRequest>) => !options.signal.aborted && request.epoch === bindingEpoch && request.owner === currentActor()?.id;
  let messageText: string | (() => string) = '';
  const message = (value: string | (() => string), error = false) => { messageText = value; const text = typeof value === 'function' ? value() : value; $('message').hidden = !text; $('message').textContent = text; $('message').dataset.error = String(error); };
  const title = () => $<HTMLInputElement>('name').value.trim() || '未命名工作区';
  function controls() {
    $('name').toggleAttribute('disabled', busy);
    $('save').toggleAttribute('disabled',busy || !options.canSave());
    $('reload').toggleAttribute('disabled', busy || $('reload').dataset.unavailable === 'true');
    $('first').toggleAttribute('disabled', busy || !before); $('next').toggleAttribute('disabled', busy || !next);
    $('list').querySelectorAll<HTMLButtonElement>('.saved-workspace-open').forEach(button => { const selected = button.dataset.workspaceId === binding?.id; button.setAttribute('aria-pressed', String(selected)); button.closest<HTMLElement>('.saved-workspace-row')!.dataset.selected = String(selected); button.disabled = busy; });
    document.querySelector<HTMLElement>('.saved-workspace-pages')!.hidden = !available || (!before && !next);
  }
  async function act<T>(work: () => Promise<T>, propagate = false, request?: ReturnType<typeof captureRequest>): Promise<T | undefined> {
    if (busy) return; busy = true; let release!: () => void; idle = new Promise(resolve => { release = resolve; }); controls();
    try { return await work(); }
    catch (error) { if (!options.signal.aborted && (!request || isCurrent(request))) { message((error as Error).message, true); if (!propagate) options.report(error as Error); } if (propagate) throw error; }
    finally { busy = false; release(); controls(); if (refreshAfterBusy && !options.signal.aborted) { refreshAfterBusy = false; refresh(); } }
  }
  // Saves and list work belong to the current document. Loading intentionally
  // detaches while opening, so its own later failures must still be reported.
  const actCurrent = <T>(work: () => Promise<T>, propagate = false) => act(work, propagate, captureRequest());
  async function list() {
    const request = ++sequence, context = captureRequest();
    const page = await client.list(before, search, true);
    if (request !== sequence || !isCurrent(context)) return;
    available = true; next = page.next;
    const rows = page.entries.map(record => {
      const row = document.createElement('div'); row.dataset.workspaceId = record.id; row.className = 'saved-workspace-row';
      const open = document.createElement('button'); open.type = 'button'; open.dataset.workspaceId = record.id; open.className = 'saved-workspace-open'; open.setAttribute('aria-pressed', String(record.id === binding?.id));
      const info = document.createElement('span'); info.className = 'saved-workspace-info';
      const name = document.createElement('strong'); name.textContent = record.name;
      const detail = document.createElement('span'); detail.dataset.localeGuest = String(!record.ownerName); detail.textContent = record.ownerName ?? t(msg("sources.guest", "访客"));
      const metadata = document.createElement('span'); metadata.className = 'saved-workspace-meta';
      open.onclick = () => void act(() => load(record.id));
      const time = document.createElement('time'); time.className = 'workspace-row-time'; time.dateTime = record.updatedAt; time.textContent = formatDate(record.updatedAt);
      metadata.append(detail, time); info.append(name, metadata); open.append(info);
      const copy = document.createElement('button'); copy.type = 'button'; copy.className = 'saved-workspace-copy'; copy.setAttribute('aria-label', t(msg("workspace.copyNamed", "复制工作区链接：{name}"), {name:record.name})); copy.innerHTML = `${icon('copy')}<span>${th(msg("sharing.copyLink", "复制链接"))}</span>`;
      copy.onclick = () => { copy.disabled = true; void options.copyLink(record.id, copy).catch(error => { message((error as Error).message, true); options.report(error as Error); }).finally(() => { copy.disabled = false; }); };
      row.append(open, copy); return row;
    });
    if (!rows.length) { const empty = document.createElement('p'); empty.className = 'settings-caption'; empty.textContent = search ? t(msg("savedWorkspaces.noMatchingWorkspaces", "没有匹配的工作区")) : t(msg("savedWorkspaces.noWorkspacesYet", "暂无工作区")); $('list').replaceChildren(empty); }
    else $('list').replaceChildren(...rows);
    controls();
  }
  onLanguageChange(() => {
    $('message').textContent = typeof messageText === 'function' ? messageText() : messageText;
    for(const row of $('list').querySelectorAll<HTMLElement>('.saved-workspace-row')) {
      const name = row.querySelector('strong')!.textContent!;
      row.querySelector('.saved-workspace-copy')!.setAttribute('aria-label',t(msg('workspace.copyNamed','复制工作区链接：{name}'),{name}));
      row.querySelector('.saved-workspace-copy span')!.textContent=t(msg('sharing.copyLink','复制链接'));
      const guest=row.querySelector<HTMLElement>('[data-locale-guest=true]'); if(guest)guest.textContent=t(msg('sources.guest','访客'));
      const time=row.querySelector('time')!;time.textContent=formatDate(time.dateTime);
    }
    const empty=$('list').querySelector('p'); if(empty)empty.textContent=search?t(msg('savedWorkspaces.noMatchingWorkspaces','没有匹配的工作区')):t(msg('savedWorkspaces.noWorkspacesYet','暂无工作区'));
  },options.signal);
  async function load(id: string) {
    const owner = (await identityHealth()).actor?.id;
    const record = await client.read(id);
    if (owner !== currentActor()?.id) return;
    if (!await options.open(record.document, record.space ?? undefined)) return;
    if (owner !== currentActor()?.id) return;
    binding = record; delete $('reload').dataset.unavailable; $<HTMLInputElement>('name').value = record.name; $('conflict').hidden = true; message(''); controls();
    const url = new URL(location.href); url.searchParams.delete('share'); url.searchParams.delete('review'); url.searchParams.set('workspace', record.id); history.replaceState(null, '', url);
  }
  async function persist(document = options.snapshot(), request = captureRequest()) {
    // Keep the target and document from before any preparation/network await.
    // An import or identity change invalidates this work, including its errors.
    const snapshot = structuredClone(document), name = document.name || title();
    try {
      const prepared = request.binding?.space ? await prepareSharedWorkspace(snapshot) : snapshot;
      if (!isCurrent(request)) return;
      const stored = await client.save(name, prepared, request.binding);
      if (!isCurrent(request)) return;
      binding = stored; $('conflict').hidden = true; before = ''; message(''); await list();
    } catch (error) {
      if (!isCurrent(request)) return;
      if ([409, 404].includes((error as { status?: number }).status ?? 0) && request.binding) {
        $('conflict').hidden = false;
        $('reload').dataset.unavailable = String((error as { status?: number }).status === 404);
      }
      throw error;
    }
  }
  $('save').onclick=()=>void actCurrent(()=>persist());
  $('name').addEventListener('change', () => {
    if (binding) void actCurrent(async () => {
      const request = captureRequest(), name = title();
      const stored = await client.read(request.binding!.id);
      if (!isCurrent(request)) return;
      // Renaming must not overwrite a newer server revision with the local session.
      if (stored.revision !== request.binding!.revision) { $('conflict').hidden = false; throw new Error(t(msg("workspace.conflict", "工作区已被更新，请重新打开后继续。"))); }
      await persist({ ...stored.document, name }, request);
    });
  }, { signal: options.signal });
  $('name').onkeydown = event => { if (event.key === 'Enter') { event.preventDefault(); $('name').blur(); } };
  $('reload').onclick = () => { if (binding) void act(() => load(binding!.id)); };
  const refresh = () => void actCurrent(async () => { message(''); before = ''; search = $<HTMLInputElement>('search').value.trim(); await list(); });
  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  const syncVisibleList = () => {
    if (options.signal.aborted || !available || document.getElementById('settings-pane-workspace')!.hidden) return;
    if (busy) { refreshAfterBusy = true; return; }
    void actCurrent(list);
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
  $('first').onclick = () => void actCurrent(async () => { before = ''; await list(); });
  $('next').onclick = () => void actCurrent(async () => { if (next) { before = next; await list(); } });
  window.addEventListener('voidplayer-identity-change', event => {
    const { actor, previous } = (event as CustomEvent).detail;
    if (actor?.id === previous?.id) return;
    ++sequence; ++bindingEpoch; binding = undefined; before = ''; next = null;
    $('conflict').hidden = true; $('list').replaceChildren();
    search = ''; $('search-button').hidden = true; $<HTMLInputElement>('search').value = ''; message(''); controls();
    if (actor && !document.getElementById('settings-pane-workspace')!.hidden) { if (busy) refreshAfterBusy = true; else refresh(); }
  }, { signal: options.signal });
  const settings = document.getElementById('settings')!;
  settings.addEventListener('settings-pane-change', event => { if ((event as CustomEvent).detail === 'workspace') void actCurrent(async () => {
    message(''); const health = await identityHealth(); available = !!health.capabilities?.workspaces; controls();
    if (available) await list(); else message(() => t(msg("savedWorkspaces.workspaceServiceUnavailable", "工作区服务不可用。")));
  }); }, { signal: options.signal });
  controls();
  return { name: title, binding: () => binding,
    async share(document: WorkspaceFile, id: string, previous?: SavedWorkspace) {
      const request = captureRequest(), snapshot = structuredClone(document), name = document.name || title();
      const ensureCurrent = () => {
        if (options.signal.aborted) throw new Error(t(msg("workspace.closed", "工作区页面已关闭。")));
        if (request.owner !== currentActor()?.id) throw new Error(t(msg("workspace.actorChanged", "用户已切换，请在当前工作区重新分享。")));
        if (request.epoch !== bindingEpoch) throw new Error(t(msg("workspace.changed", "当前工作区已切换，请在新工作区重新分享。")));
      };
      while (busy) await idle;
      ensureCurrent();
      const result = await actCurrent(async () => {
        try {
          const stored=await client.share(name, snapshot, id, previous);
          ensureCurrent();
          binding=stored; $<HTMLInputElement>('name').value=stored.name; $('conflict').hidden=true; before=''; message(''); await list(); ensureCurrent(); return stored;
        } catch(error) {
          if (isCurrent(request) && previous && [404,409].includes((error as {status?:number}).status ?? 0)) { $('conflict').hidden=false; $('reload').dataset.unavailable=String((error as {status?:number}).status===404); }
          throw error;
        }
      },true);
      if (!result) throw new Error(t(msg("workspace.saving", "工作区正在保存，请稍后再分享。")));
      return result;
    }, detach(name = '') { bindingEpoch++; binding = undefined; $<HTMLInputElement>('name').value = name; $('conflict').hidden = true; controls(); }, open(id: string) { return act(() => load(id)); }, update: controls };
}
