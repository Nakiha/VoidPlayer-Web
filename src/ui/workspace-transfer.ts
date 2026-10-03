import { installWorkspaceRecovery } from './workspace-recovery.ts';
import { restoreHandleFile, handleKey } from '../file-handles.ts';
import { installWorkspaceSharing } from './workspace-sharing.ts';
import type { ToastStack } from './toast.ts';
import {updateMediaInfo} from '../media-state.ts';
import type { ReviewSession } from '../session.ts';
import type { MediaInfo } from '../model.ts';
import { openMedia, openMediaFromUrl } from '../media.ts';
import { parseWorkspace, readWorkspaceFile } from '../workspace-file.ts';
import type { WorkspaceFile } from '../workspace-file.ts';
import { mapSharedWorkspace } from '../shared-workspace.ts';
import { SavedWorkspaceClient } from '../saved-workspaces.ts';
import { annotationThumbnails } from './annotation-thumbnails.ts';
import { pinLibraryReference } from '../media-reference.ts';
import { describeMediaMismatch, matchMediaIdentity, mediaMtimeWarning } from '../media-identity.ts';
import { icon } from './icons.ts';
import { installSavedWorkspaces } from './saved-workspaces.ts';
import { t, th, msg } from '../i18n.ts';

export const isWorkspaceFile = (file: File) => /\.(voidplayer|json|gz)$/i.test(file.name);

/** Browser files cannot be reopened from a JSON path. Resolve every missing file before touching the session. */
async function resolveLocalFiles(media: MediaInfo[], supplied: File[], prompt = true, onMtimeWarning?: (name: string) => void) {
  const files = new Map<string, File>();
  const accept = (info: MediaInfo, file: File) => {
    const match = matchMediaIdentity(info, file);
    if (!match.ok) return false;
    if (match.mtimeChanged) onMtimeWarning?.(info.name);
    files.set(info.id, file);
    return true;
  };
  for (const info of media) { const file = supplied.find(f => matchMediaIdentity(info, f).ok); if (file) accept(info, file); }
  for (const info of media) if (!files.has(info.id)) {
    try { const file = await restoreHandleFile(handleKey(info), undefined, false); if (!accept(info, file)) continue; } catch {}
  }
  if (!prompt) return files;
  const missing = media.filter(info => !files.has(info.id));
  if (!missing.length) return files;
  const dialog = document.createElement('dialog'); dialog.className = 'workspace-relink'; dialog.setAttribute('aria-label', t(msg("transfer.relinkTitle", "重新连接本地视频")));
  dialog.innerHTML = `<header class="dialog-heading"><h2>${th(msg("transfer.relinkTitle", "重新连接本地视频"))}</h2><button class="icon-button" aria-label="${th(msg("transfer.cancelImport", "取消导入"))}">${icon('close')}</button></header><p>${th(msg("transfer.relinkBody", "工作区保存了视频引用。请重新选择这些本地文件，也可以稍后关联，先恢复轨道和标注。"))}</p><div class="relink-files"></div><p role="alert"></p><button class="relink-later">${th(msg("transfer.later", "稍后关联"))}</button><button class="relink-continue" disabled>${th(msg("transfer.openWorkspace", "打开工作区"))}</button>`;
  const proceed = dialog.querySelector<HTMLButtonElement>('.relink-continue')!;
  for (const info of missing) {
    const label = document.createElement('label'); label.className = 'relink-file';
    const name = document.createElement('span'); name.textContent = info.name;
    const input = document.createElement('input'); input.type = 'file'; input.accept = 'video/*,.mkv,.ts,.flv,.avi'; input.setAttribute('aria-label', t(msg("sources.reselectName", "重新选择 {name}"), { name: info.name }));
    input.onchange = () => {
      const file = input.files?.[0]; files.delete(info.id);
      const match = file ? matchMediaIdentity(info, file) : undefined;
      dialog.querySelector('[role=alert]')!.textContent = !match ? '' : !match.ok
        ? describeMediaMismatch(info.name, match.mismatches)
        : match.mtimeChanged ? mediaMtimeWarning(info.name) : '';
      if (match?.ok && file) files.set(info.id, file);
      proceed.disabled = files.size !== media.length;
    };
    label.append(name, input); dialog.querySelector('.relink-files')!.append(label);
  }
  document.body.append(dialog);
  return new Promise<Map<string, File> | null>(resolve => {
    dialog.querySelector('header button')!.addEventListener('click', () => dialog.close());
    proceed.onclick = () => dialog.close('open');
    dialog.querySelector<HTMLButtonElement>('.relink-later')!.onclick = () => dialog.close('open');
    dialog.addEventListener('close', () => { const result = dialog.returnValue === 'open' ? files : null; dialog.remove(); resolve(result); }, { once: true });
    dialog.showModal();
  });
}

export function installWorkspaceTransfer(session: ReviewSession, options: {
  act(action: () => unknown | Promise<unknown>, name: string): Promise<void>;
  capture(): Pick<WorkspaceFile, 'viewport' | 'layout'>;
  restore(document: WorkspaceFile, resumeCloudAnnotations: boolean): void | Promise<void>;
  beforeRestore(): void | (() => void | Promise<void>);
  closeSettings(): Promise<void>;
  identityReady: Promise<void>;
  openSharedSpace(space: string, seededIds?: string[]): Promise<void>;
  annotationScope(): string;
  toasts: ToastStack;
}) {
  const input = document.getElementById('workspace-file') as HTMLInputElement;
  const lifetime = new AbortController(); let importing = false;
  let saved: ReturnType<typeof installSavedWorkspaces> | undefined;
  let sharing: ReturnType<typeof installWorkspaceSharing> | undefined;
  function exportWorkspace() {
    const document = { ...session.exportWorkspace(new URL('/', location.href).href), ...options.capture(), name: saved?.name() ?? t(msg("savedWorkspaces.untitledWorkspace", "未命名工作区")) };
    document.thumbnails = document.marks.flatMap(mark => { const image = annotationThumbnails.get(mark.id); return image?.url.startsWith('data:image/jpeg;base64,') ? [{ id: mark.id, ...image }] : []; });
    return document;
  }
  async function importWorkspace(value: unknown, supplied: File[] = [], recovery = false, fromShare = false) {
    if (importing) throw new Error(t(msg("transfer.importing", "工作区正在导入，请等待完成。")));
    importing = true;
    try {
      const document = parseWorkspace(value, location.href);
      await options.closeSettings();
      const active = document.tracks.map(t => document.media.find(m => m.id === t.mediaId)!);
      const warnMtime = (name: string) => options.toasts.show(mediaMtimeWarning(name));
      const files = await resolveLocalFiles(active.filter(m => !m.source), supplied, !recovery, warnMtime);
      if (!files) return false;
      const rollback=options.beforeRestore();
      try { await session.restoreWorkspace(document, async (info, signal, progress) => {
        if (!info.source) { const file = files.get(info.id); if (!file) throw new Error(t(msg("transfer.notAuthorized", "本地文件尚未授权，请重新选择。"))); return openMedia(file, undefined, progress, signal); }
        const pinned = await pinLibraryReference(info, location.href, fetch, signal);
        if (pinned.mtimeChanged) warnMtime(info.name);
        const { mtimeChanged: _ignored, ...reference } = pinned;
        const source = await openMediaFromUrl(reference.url, info, undefined, progress, signal); updateMediaInfo(source,{source:reference},'identity'); return source;
      }, { allowUnavailable: true });
      } catch(error) { await rollback?.(); throw error; }
      annotationThumbnails.clear();
      for (const { id, ...image } of document.thumbnails ?? []) annotationThumbnails.set(id, image);
      await options.restore(document, fromShare);
      if (!fromShare) { sharing?.detach(); const url=new URL(location.href);url.searchParams.delete('workspace');url.searchParams.delete('share');url.searchParams.delete('review');history.replaceState(null,'',url); }
      saved?.detach(document.name);
      if (!document.comparison) options.toasts.show(() => t(msg("transfer.legacyConditions", "旧工作区未记录比较条件，已沿用当前色彩和解码设置。")));
      return true;
    } finally { importing = false; }
  }
  async function importFile(file: File, supplied: File[] = []) { await importWorkspace(await readWorkspaceFile(file, location.href), supplied); }
  saved = installSavedWorkspaces({ signal: lifetime.signal, snapshot: exportWorkspace, open: async (value, space) => { const opened=await importWorkspace(space ? mapSharedWorkspace(value,location.origin) : value, [], false, !!space); if(opened && space)await options.openSharedSpace(space); return opened; }, copyLink: (id, trigger) => sharing!.copySaved(id, trigger), canSave: () => session.getState().tracks.length > 0, report: error => { if (!document.querySelector<HTMLDialogElement>('#settings')!.open) void options.act(() => { throw error; }, 'workspace.server'); } });
  // A seek keeps the last committed workspace snapshot valid. Sharing is
  // available whenever there is a loaded track; the snapshot is captured
  // synchronously before any network work begins.
  sharing = installWorkspaceSharing({ signal:lifetime.signal, snapshot:exportWorkspace, binding:saved.binding, save:saved.share, toasts:options.toasts, closeSettings:options.closeSettings, openSpace:options.openSharedSpace, scope:options.annotationScope, canShare:()=>session.getState().tracks.length>0, report:error=>void options.act(()=>{throw error;}, 'workspace.share') });
  let missingSignature = '', dismissMissing: (() => void) | undefined;
  async function relinkMissing() {
    const pending = session.getState().tracks.filter(t => t.pendingRelink);
    const warnMtime = (name: string) => options.toasts.show(mediaMtimeWarning(name));
    const files = await resolveLocalFiles(pending.filter(t => !t.source), [], true, warnMtime);
    if (!files) return;
    for (const info of pending) {
      if (!info.source && !files.has(info.id)) continue;
      await options.act(() => session.relinkTrack(info.slot, async (signal, progress) => {
        if (!info.source) return openMedia(files.get(info.id)!, undefined, progress, signal);
        const pinned = await pinLibraryReference(info, location.href, fetch, signal);
        if (pinned.mtimeChanged) warnMtime(info.name);
        const { mtimeChanged: _ignored, ...reference } = pinned;
        const source = await openMediaFromUrl(reference.url, info, undefined, progress, signal);
        updateMediaInfo(source, { source: reference }, 'identity'); return source;
      }), 'workspace.relink');
    }
  }
  function updateMissing() {
    const pending = session.getState().tracks.filter(t => t.pendingRelink);
    const signature = pending.map(t => `${t.slot}:${t.id}`).join('|');
    if (signature === missingSignature) return;
    missingSignature = signature; dismissMissing?.();
    if (pending.length) dismissMissing = options.toasts.show(() => t(msg("transfer.pendingRelink", "{n} 个片源待重新关联；轨道、偏移和标注已保留。"), { n: pending.length }), { durationMs: 0,
      action: { label: () => t(msg("transfer.relinkNow", "重新关联")), onClick: () => { void relinkMissing().catch(error => options.toasts.show(String(error), { kind: 'error' })).finally(() => { missingSignature = ''; updateMissing(); }); } } });
  }
  const recovery = installWorkspaceRecovery(session, { snapshot: exportWorkspace, restore: document => importWorkspace(document, [], true), ready: options.identityReady, toasts: options.toasts });
  const unsubscribe = session.subscribe(() => { saved?.update(); sharing?.update(); updateMissing(); });
  const params = new URL(location.href).searchParams;
  const savedId = params.get('workspace'), legacyId=params.get('share') ?? params.get('review');
  if (savedId && /^[a-f0-9-]{36}$/.test(savedId)) void options.identityReady.then(()=>saved!.open(savedId));
  else if (legacyId && /^[a-f0-9-]{36}$/.test(legacyId)) void options.identityReady.then(async()=>{
    // Old share/review URLs join the same writable workspace flow.
    const client=new SavedWorkspaceClient(lifetime.signal);
    await client.request(`/api/${params.has('share')?'shares':'reviews'}/${legacyId}`);
    await saved!.open(legacyId);
  }).catch(error=>options.toasts.show((error as Error).message,{kind:'error',durationMs:0}));
  input.addEventListener('change', () => { const file = input.files?.[0]; input.value = ''; if (file) void options.act(() => importFile(file), 'workspace.import'); }, { signal: lifetime.signal });
  return { exportWorkspace, importWorkspace, importFile, relinkMissing, shareWorkspace: sharing.create, dispose() { recovery.dispose(); dismissMissing?.(); lifetime.abort(); unsubscribe(); sharing.dispose(); } };
}
