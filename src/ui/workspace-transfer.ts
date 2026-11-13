import { localOnly } from '../services/build-profile.ts';
import { currentActor } from '../services/identity.ts';
import { prepareOfflineUpdate } from './offline-app.ts';
import { installWorkspaceRecovery } from './workspace-recovery.ts';
import { FileHandleError, restoreHandleFile, handleKey } from '../services/file-handles.ts';
import { LibraryAccessError } from '../../shared/media/io/source-access.ts';
import { libraryAccessMessage, localAccessMessage } from './source-access-message.ts';
import type { LocalAccessProblem } from '../../shared/media/io/source-access.ts';
import { installWorkspaceSharing } from './workspace-sharing.ts';
import type { ToastStack } from './toast.ts';
import {updateMediaInfo} from '../media/state.ts';
import type { ReviewSession } from '../session.ts';
import type { MediaInfo } from '../../shared/media/types.ts';
import { openMedia, openMediaFromUrl } from '../media/source.ts';
import { LocalInputError, selectVideoInputs } from './video-input.ts';
import { parseWorkspace, readWorkspaceFile, UnrecognizedWorkspaceFile } from '../../shared/review/workspace-file.ts';
import type { WorkspaceFile } from '../../shared/review/workspace-file.ts';
import { mapSharedWorkspace } from '../review/shared-workspace.ts';
import { annotationThumbnails } from './annotation-thumbnails.ts';
import { publishMarkPreview } from './mark-preview-publish.ts';
import { pinLibraryReference } from '../../shared/media/io/media-reference.ts';
import { matchMediaIdentity } from '../../shared/media/io/media-identity.ts';
import { installSavedWorkspaces } from './saved-workspaces.ts';
import type { WorkspaceOpenOperation } from './saved-workspaces.ts';
import { t, msg } from '../i18n.ts';

function fileMtimeWarning(name: string) {
  return t(msg('transfer.mtimeWarning','「{name}」修改时间与工作区记录不一致，已按同名同大小文件恢复；如内容被替换请重新检查标注'),{name});
}
export const isWorkspaceFile = (file: File) => /\.(voidplayer|json|gz)$/i.test(file.name);

/** Resolve supplied files or already-authorized handles without interrupting workspace restore. */
async function resolveLocalFiles(media: MediaInfo[], supplied: File[], onMtimeWarning?: (name: string) => void, signal?: AbortSignal, problems = new Map<string, LocalAccessProblem>()) {
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
    try { const file = await restoreHandleFile(handleKey(info), undefined, false); if (!accept(info, file)) problems.set(info.id, 'stale'); }
    catch (error) { problems.set(info.id, error instanceof FileHandleError ? error.kind : 'unavailable'); }
  }
  if (signal?.aborted) return null;
  return files;
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
  editsReady(): boolean;
  toasts: ToastStack;
  openingChanged?(): void;
}) {
  const input = document.getElementById('workspace-file') as HTMLInputElement;
  const lifetime = new AbortController(); let importing = false;
  const params = new URL(location.href).searchParams;
  const savedId = localOnly ? null : params.get('workspace');
  const openingLink = /^[a-f0-9-]{36}$/.test(savedId ?? '');
  document.getElementById('app')!.toggleAttribute('data-workspace-opening', openingLink);
  let saved: ReturnType<typeof installSavedWorkspaces> | undefined;
  let sharing: ReturnType<typeof installWorkspaceSharing> | undefined;
  function exportWorkspace() {
    const document = { ...session.exportWorkspace(new URL('/', location.href).href), ...options.capture(), name: saved?.name() ?? (window.document.querySelector<HTMLInputElement>('#local-workspace-name')?.value.trim() || t(msg("savedWorkspaces.untitledWorkspace", "未命名工作区"))) };
    document.thumbnails = document.marks.flatMap(mark => { const image = annotationThumbnails.get(mark.id); return image?.url.startsWith('data:image/jpeg;base64,') ? [{ id: mark.id, ...image }] : []; });
    return document;
  }
  async function resolveLibraryReference(info: MediaInfo, signal: AbortSignal) {
    if (localOnly) throw new Error(t(msg('sites.remoteUnavailable', '此版本仅支持本地文件，请使用完整版访问媒体服务')));
    try { return await pinLibraryReference(info, location.href, fetch, signal); }
    catch (error) {
      if (error instanceof LibraryAccessError) error.message = libraryAccessMessage(info.name, error.kind) + (error.details ? ` ${error.details}` : '');
      throw error;
    }
  }
  async function importWorkspace(value: unknown, supplied: File[] = [], fromShare = false, operation?: WorkspaceOpenOperation, strict = false) {
    if (importing) throw new Error(t(msg("transfer.importing", "工作区正在导入，请等待完成")));
    operation ??= saved?.beginOpen();
    const current = () => !lifetime.signal.aborted && (!operation || operation.current());
    if (!current()) return false;
    importing = true;
    try {
      const document = parseWorkspace(value, location.href);
      await options.closeSettings();
      if (!current()) return false;
      const active = document.tracks.map(t => document.media.find(m => m.id === t.mediaId)!);
      const warnMtime = (name: string) => options.toasts.show(() => fileMtimeWarning(name));
      const problems = new Map<string, LocalAccessProblem>();
      const files = await resolveLocalFiles(active.filter(m => !m.source), supplied, warnMtime, operation?.signal ?? lifetime.signal, problems);
      if (!files || !current()) return false;
      const skipped: { name: string; error: string }[] = [];
      const rollback=options.beforeRestore();
      const progressive = !strict && session.getState().tracks.length === 0 && document.tracks.length > 0;
      let layout: Promise<void> | undefined, stopLayout: (() => void) | undefined;
      if (progressive) stopLayout = session.subscribe(() => {
        const state = session.getState(), selected = document.layout?.selected;
        if (layout || !state.tracks.length || selected && state.busy && !state.tracks.some(track => track.slot === selected)) return;
        stopLayout?.();
        // Restore panels only after the shared facade has published its slots;
        // an actually empty workbench deliberately closes the analysis panel.
        layout = Promise.resolve(options.restore(document, fromShare));
        void layout.catch(() => {});
      });
      try { await session.restoreWorkspace(document, async (info, signal, progress, configuration) => {
        if (!info.source) { const file = files.get(info.id); if (!file) throw new FileHandleError(problems.get(info.id) ?? 'unavailable', localAccessMessage(info.name, problems.get(info.id) ?? 'unavailable')); return openMedia(file, undefined, progress, signal, configuration); }
        const pinned = await resolveLibraryReference(info, signal);
        if (pinned.mtimeChanged) warnMtime(info.name);
        const { mtimeChanged: _ignored, ...reference } = pinned;
        const source = await openMediaFromUrl(reference.url, info, undefined, progress, signal,undefined,configuration); updateMediaInfo(source,{source:reference},'identity'); return source;
      }, { skipUnavailable: !strict, progressive, signal: operation?.signal, onSkipped: (info, error) => {
        skipped.push({ name: info.name, error: error instanceof Error ? error.message : String(error) });
      } });
        await layout;
      } catch(error) { await rollback?.(); throw error; }
      finally { stopLayout?.(); }
      if (!current()) return false;
      annotationThumbnails.clear();
      // Progressive restore may have already rendered the annotation cards.
      // Hydrate through the shared publisher so those cards receive previews too.
      for (const { id, ...image } of document.thumbnails ?? []) publishMarkPreview(id, image);
      if (!layout) await options.restore(document, fromShare);
      if (!current()) return false;
      if (!fromShare) { sharing?.detach(); const url=new URL(location.href);url.searchParams.delete('workspace');url.searchParams.delete('share');url.searchParams.delete('review');history.replaceState(null,'',url); }
      if (operation) operation.detach(document.name); else saved?.detach(document.name);
      const localName = window.document.querySelector<HTMLInputElement>('#local-workspace-name');
      if (localName) localName.value = document.name ?? '';
      if (skipped.length) options.toasts.show(() => t(msg('transfer.sourcesSkipped', '以下片源无法打开，已跳过：{details}'), {
        details: skipped.map(item => `${item.name}：${item.error}`).join('；'),
      }), { kind: 'warning', durationMs: 8000 });
      else if (!document.comparison) options.toasts.show(() => t(msg("transfer.legacyConditions", "旧工作区未记录比较条件，已沿用当前色彩和解码设置")));
      return true;
    } finally { importing = false; }
  }
  async function importFile(file: File, supplied: File[] = []) {
    if (importing) throw new Error(t(msg("transfer.importing", "工作区正在导入，请等待完成")));
    const operation = saved?.beginOpen();
    const document = await readWorkspaceFile(file, location.href).catch(error => {
      if (error instanceof UnrecognizedWorkspaceFile) throw new LocalInputError(t(msg('input.workspace', '「{name}」不是可读取的 VoidPlayer 工作区文件，请选择视频或已导出的工作区'), {name:file.name}));
      throw error;
    });
    if (operation && !operation.current()) return;
    await importWorkspace(document, supplied, false, operation);
  }
  if (!localOnly) {
    saved = installSavedWorkspaces({ signal: lifetime.signal, snapshot: exportWorkspace, open: async (value, space, operation) => { const opened=await importWorkspace(space ? mapSharedWorkspace(value,location.origin) : value, [], !!space, operation); if(opened && space && operation.current())await options.openSharedSpace(space); return opened && operation.current(); }, copyLink: id => sharing!.copySaved(id), canSave: () => session.getState().tracks.length > 0, changed: () => sharing?.update(), report: error => { if (!document.querySelector<HTMLDialogElement>('#settings')!.open) void options.act(() => { throw error; }, 'workspace.server'); } });
    // A seek keeps the last committed workspace snapshot valid. Sharing is
    // available once loaded tracks and their workspace binding are ready; the snapshot is captured
    // synchronously before any network work begins.
    sharing = installWorkspaceSharing({ signal:lifetime.signal, snapshot:exportWorkspace, binding:saved.binding, save:saved.share, toasts:options.toasts, openSpace:options.openSharedSpace, scope:options.annotationScope, isOpening:saved.isOpening, canShare:()=>session.getState().tracks.length>0&&!saved!.isOpening(), report:error=>void options.act(()=>{throw error;}, 'workspace.share') });
  }
  const recovery = installWorkspaceRecovery(session, { snapshot: exportWorkspace, restore: (document, update) => importWorkspace(document, [], false, undefined, update), ready: options.identityReady, toasts: options.toasts });
  if (localOnly) {
    document.getElementById('local-workspace-import')!.addEventListener('click', () => input.click(), { signal: lifetime.signal });
    document.getElementById('local-workspace-export')!.addEventListener('click', () => {
      const snapshot = exportWorkspace();
      const url = URL.createObjectURL(new Blob([JSON.stringify(snapshot)], { type: 'application/json' }));
      const link = document.createElement('a'); link.href = url; link.download = 'workspace.voidplayer';
      link.click(); setTimeout(() => URL.revokeObjectURL(url), 10000);
    }, { signal: lifetime.signal });
  }
  const unsubscribe = session.subscribe(() => { saved?.update(); sharing?.update(); });
  const finishOpening = () => { if (lifetime.signal.aborted) return; document.getElementById('app')!.removeAttribute('data-workspace-opening'); options.openingChanged?.(); };
  if (savedId && /^[a-f0-9-]{36}$/.test(savedId)) void options.identityReady.then(()=>saved!.open(savedId)).catch(error=>options.toasts.show((error as Error).message,{kind:'error',durationMs:0})).finally(finishOpening);
  input.addEventListener('change', () => {
    const files = Array.from(input.files ?? []); input.value = '';
    if (!files.length) return;
    if (!localOnly) { void options.act(() => importFile(files[0]), 'workspace.import'); return; }
    void options.act(async () => {
      const documents = files.filter(isWorkspaceFile);
      if (documents.length !== 1) throw new LocalInputError(t(msg('player.openOneWorkspaceFileAtATime', '每次请打开一个工作区文件')));
      const supplied = await selectVideoInputs(files.filter(file => !isWorkspaceFile(file)).map(file => ({ file })),
        error => options.toasts.show(error.message, { kind: 'warning' }));
      await importFile(documents[0], supplied.map(item => item.file));
    }, 'workspace.import');
  }, { signal: lifetime.signal });
  async function refreshForUpdate(target: string) {
    const owner = currentActor()?.id ?? 'local';
    function checkReady() {
      const state = session.getState();
      if ((currentActor()?.id ?? 'local') !== owner || importing || saved?.isOpening() || state.busy || state.playing || state.mediaLoad?.state === 'loading' || !options.editsReady())
        throw new Error(t(msg('update.wait', '请先暂停播放，完成标注并等载入和保存结束，再刷新。')));
      if (saved?.binding() || options.annotationScope() !== 'local' || new URL(location.href).searchParams.has('workspace'))
        throw new Error(t(msg('update.bound', '当前工作区已连接到服务器。请保存工作区后重新打开，当前窗口可以继续使用。')));
    }
    checkReady();
    const snapshot = exportWorkspace();
    for (const track of snapshot.tracks) {
      const media = snapshot.media.find(item => item.id === track.mediaId)!;
      if (media.source) await resolveLibraryReference(media, lifetime.signal);
      else {
        const file = await restoreHandleFile(handleKey(media), undefined, false).catch(() => null);
        if (!file || !matchMediaIdentity(media, file).ok) throw new Error(t(msg('update.localFile', '刷新后无法重新读取「{name}」。请继续使用当前窗口，或先导出工作区。'), { name: media.name }));
      }
    }
    await prepareOfflineUpdate(target);
    const response = await fetch('/api/health', { cache: 'no-store', signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(4000)]) });
    const health = response.ok ? await response.json() : null;
    if (health?.frontendBuildId !== target || (health.actor?.id ?? 'local') !== owner) throw new Error(t(msg('update.retry', '目标版本已变化或服务暂不可用，请稍后再刷新。')));
    await recovery.refresh(snapshot, target, checkReady);
  }
  return { exportWorkspace, importWorkspace, importFile, refreshForUpdate, shareWorkspace: sharing?.create, dispose() { recovery.dispose(); lifetime.abort(); unsubscribe(); sharing?.dispose(); } };
}
