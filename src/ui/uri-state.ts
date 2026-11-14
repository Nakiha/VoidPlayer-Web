import { localOnly } from '../services/build-profile.ts';
import { prefetchThumbnailStatuses } from '../thumbnails/client.ts';
import { currentActor } from '../services/identity.ts';
import { prepareOfflineUpdate } from './offline-app.ts';
import { parseWorkspace } from '../../shared/review/workspace-file.ts';
import type { WorkspaceFile } from '../../shared/review/workspace-file.ts';
import { emptyUriState, hasUriState, uriStateFromDocument, parseUriState } from '../../shared/review/uri-state.ts';
import { createShareUrl } from '../../shared/review/uri-binary.ts';
import { stageUpdateState, takeUpdateState } from '../services/update-state.ts';
import type { UriState } from '../../shared/review/uri-state.ts';
import { restoreHandleFile, handleKey } from '../services/file-handles.ts';
import { openMedia, openMediaFromUrl } from '../media/source.ts';
import { updateMediaInfo } from '../media/state.ts';
import type { MediaInfo } from '../../shared/media/types.ts';
import type { ReviewSession } from '../session.ts';
import type { ToastStack } from './toast.ts';
import { apiError } from '../services/api-error.ts';
import { t, msg, onLanguageChange } from '../i18n.ts';

export function installUriState(session: ReviewSession, options: {
  act(action: () => unknown | Promise<unknown>, name: string): Promise<void>;
  capture(): Pick<WorkspaceFile, 'viewport' | 'layout' | 'panBasis'>;
  restore(document: WorkspaceFile, resumeCloudAnnotations: boolean): void | Promise<void>;
  beforeRestore(): void;
  closeSettings(): Promise<void>;
  identityReady: Promise<void>;
  editsReady(): boolean;
  toasts: ToastStack;
  openingChanged?(): void;
}) {
  const life = new AbortController();
  let opening = false, epoch = 0, operation = new AbortController(), syncingUrl = false;
  let focusedMark: string | undefined, focusedPosition = -1;
  let addressEpoch = 0, addressOperation = new AbortController();
  const defaultLayout = structuredClone(options.capture().layout);
  const original = new URL(location.href), explicit = hasUriState(original);
  const updating = !localOnly && !explicit && original.searchParams.has('vp-update');
  opening = explicit || updating;
  let startupPending = opening;
  const root = document.getElementById('app')!;
  root.toggleAttribute('data-workspace-opening', opening);
  document.getElementById('start-panel')?.removeAttribute('data-recovery-pending');
  function exportWorkspace(): WorkspaceFile {
    return { ...session.exportWorkspace(new URL('/', location.href).href), ...options.capture() };
  }
  const exportState = () => {
    const state = uriStateFromDocument(exportWorkspace(), location.href);
    if (focusedMark && state.positionUs === focusedPosition) state.mark = focusedMark;
    return state;
  };
  // Compare the restored scene, including recipient-side layout and pan scaling.
  // Frame/index metadata and annotation bodies are not part of this snapshot.
  function stateSignature() {
    const { panBasis, ...state } = exportState();
    if (panBasis) state.viewport = { ...state.viewport,
      offsetX: Math.round(state.viewport.offsetX / panBasis.width * 1e12) / 1e12,
      offsetY: Math.round(state.viewport.offsetY / panBasis.height * 1e12) / 1e12 };
    return JSON.stringify(state);
  }
  let addressSnapshot: { pathname: string; search: string; state: string } | undefined;
  let changeFrame: number | null = null;
  function watchAddress(url: URL) {
    addressSnapshot = hasUriState(url) ? { pathname: url.pathname, search: url.search, state: stateSignature() } : undefined;
  }
  function changed() {
    if (!addressSnapshot || life.signal.aborted || opening || syncingUrl || session.getState().busy) return;
    const url = new URL(location.href);
    if (url.pathname !== addressSnapshot.pathname || url.search !== addressSnapshot.search) return;
    if (stateSignature() === addressSnapshot.state) return;
    addressSnapshot = undefined;
    url.search = '';
    history.replaceState(history.state, '', url);
  }
  function scheduleChanged(event: Event) {
    if (!addressSnapshot || opening || syncingUrl || changeFrame !== null) return;
    if (event.type === 'pointermove' && !(event as PointerEvent).buttons) return;
    changeFrame = requestAnimationFrame(() => { changeFrame = null; changed(); });
  }
  async function focusMark(state: UriState, signal: AbortSignal, current: () => boolean) {
    focusedMark = undefined;
    if (!state.mark) return;
    const { annotationTarget } = await import('../../shared/review/annotation-target.ts');
    const { AnnotationClient } = await import('../review/annotation-client.ts');
    const client = new AnnotationClient(signal);
    for (const track of session.getState().tracks) {
      const requested = state.tracks.find(item => item.slot === track.slot);
      if (!requested) continue;
      let mark = session.getState().marks.find(mark => mark.id === state.mark && mark.mediaId === track.id);
      if (!mark && track.source && !localOnly) {
        try { const record = await client.read(await annotationTarget(track, location.href), state.mark); if (!record.deleted) mark = record.document.mark; }
        catch (error) { if ((error as { status?: number }).status !== 404) throw error; }
      }
      if (!current()) return;
      if (mark) {
        await session.seek(Math.max(0, mark.frame.ptsUs + requested.offsetUs));
        focusedMark = state.mark; focusedPosition = session.getState().positionUs; return;
      }
    }
    throw new Error(t(msg('uriState.markUnavailable', '当前片源版本中找不到这条标注。')));
  }
  async function restoreState(value: unknown, dismissSettings = true) {
    const state = parseUriState(value), capturedActor = currentActor()?.id, stamp = ++epoch;
    operation.abort();
    operation = new AbortController();
    const signal = AbortSignal.any([life.signal, operation.signal]);
    const sourceSignature = () => JSON.stringify(session.getState().tracks.map(track => [track.slot, track.id, track.source?.url]));
    const expectedSources = sourceSignature();
    let staged = false;
    const current = () => !signal.aborted && stamp === epoch && capturedActor === currentActor()?.id && (staged || sourceSignature() === expectedSources);
    opening = true; root.toggleAttribute('data-workspace-opening', state.tracks.length > 0); options.openingChanged?.();
    try {
      if (localOnly && state.tracks.some(track => !track.local)) throw new Error(t(msg('sites.remoteUnavailable', '此版本仅支持本地文件，请使用完整版访问媒体服务')));
      const currentState = session.getState();
      const sameSources = state.tracks.length === currentState.tracks.length && state.tracks.every(track => {
        const loaded = currentState.tracks.find(item => item.slot === track.slot);
        return loaded && (track.local ? loaded.id === track.id && !loaded.source
          : loaded.source?.id === track.id && new URL(loaded.source.url, location.href).searchParams.get('v') === track.version && new URL(loaded.source.url, location.href).origin === (track.origin ?? location.origin));
      });
      if (sameSources && state.tracks.length) {
        for (const track of state.tracks) if (!track.local) {
          const response = await fetch(`${track.origin ?? location.origin}/api/media/${track.id}`, { cache: 'no-store', signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]) });
          if (!response.ok) throw new Error(t(msg('uriState.sourceReadFailed', '无法读取片源 {id}（HTTP {status}）。'), { id: track.id, status: response.status }));
          const entry = await response.json();
          if (entry.id !== track.id || entry.version !== track.version || entry.state !== 'ready') throw new Error(t(msg('uriState.sourceChanged', '片源已不可用或内容版本发生变化。')));
        }
        if (!current()) return false;
        staged = true;
        options.beforeRestore();
        session.pause();
        if (state.comparison) await session.setColorMode(state.comparison.colorMode, state.comparison.referenceDecode,
          state.comparison.version === 2 ? state.comparison.colorOutput : undefined);
        if (!current()) return false;
        for (const track of state.tracks) { await session.setTrackOffset(track.slot, track.offsetUs); session.setTrackVisibility(track.slot, track.visible); }
        await session.reorderTracks(state.tracks.map(track => track.slot));
        await session.seek(state.positionUs);
        if (!current()) return false;
        await options.restore({ ...exportWorkspace(), viewport: state.viewport, panBasis: state.panBasis, layout: state.layout ?? defaultLayout }, true);
        await focusMark(state, signal, current);
        return current();
      }
      const media: MediaInfo[] = [];
      // No media IO on the server: resolve and version-check each reference in the recipient's browser.
      for (const track of state.tracks) {
        if (track.local) {
          media.push({ id: track.id, ...track.local, codec: '', decoder: 'webcodecs', width: 0, height: 0, durationUs: 1e12, firstPtsUs: 0 });
          continue;
        }
        const origin = track.origin ?? location.origin;
        const response = await fetch(`${origin}/api/media/${track.id}`, { cache: 'no-store', signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]) });
        if (!response.ok) throw new Error(t(msg('uriState.sourceReadFailed', '无法读取片源 {id}（HTTP {status}）。'), { id: track.id, status: response.status }));
        const entry = await response.json();
        if (entry.id !== track.id || entry.version !== track.version || entry.state !== 'ready') throw new Error(t(msg('uriState.sourceChanged', '片源已不可用或内容版本发生变化。')));
        if (origin === location.origin && typeof entry.thumbnail === 'boolean' && Number.isSafeInteger(entry.thumbnailEpoch))
          prefetchThumbnailStatuses([entry], 1, entry.thumbnailEpoch);
        media.push({ id: `${track.slot}-${track.id}`, name: entry.name, size: entry.size, lastModified: entry.lastModified,
          codec: '', decoder: 'webcodecs', width: 0, height: 0, durationUs: 1e12, firstPtsUs: 0,
          source: { kind: 'library', id: track.id, url: `${origin}/api/media/${track.id}/content?v=${track.version}` } });
      }
      if (!current()) return false;
      const document = parseWorkspace({ schema: 'voidplayer-workspace', version: 1, generatedAt: new Date().toISOString(),
        serverUrl: location.origin + '/', tracks: state.tracks.map((track, i) => ({ slot: track.slot, mediaId: media[i].id,
          offsetUs: track.offsetUs, visible: track.visible })), media, marks: [], positionUs: state.positionUs,
        viewport: state.viewport, panBasis: state.panBasis, comparison: state.comparison, layout: state.layout ?? defaultLayout });
      staged = true;
      options.beforeRestore();
      if (dismissSettings) await options.closeSettings();
      if (!current()) return false;
      await session.restoreWorkspace(document, async (info, signal, progress, configuration) => {
        if (!info.source) {
          const file = await restoreHandleFile(handleKey(info), undefined, false);
          if (file.name !== info.name || file.size !== info.size || file.lastModified !== info.lastModified)
            throw new Error(t(msg('uriState.sourceChanged', '片源已不可用或内容版本发生变化。')));
          return openMedia(file, undefined, progress, signal, configuration);
        }
        const source = await openMediaFromUrl(info.source.url, info, undefined, progress, signal, undefined, configuration);
        updateMediaInfo(source, { source: info.source }, 'identity'); return source;
      }, { signal, progressive: session.getState().tracks.length === 0, skipUnavailable: false });
      if (!current()) return false;
      await options.restore(document, true);
      await focusMark(state, signal, current);
      return current();
    } catch (error) {
      if (!current() || error instanceof Error && error.name === 'AbortError') return false;
      throw error;
    } finally {
      if (stamp === epoch) { opening = false; root.removeAttribute('data-workspace-opening'); options.openingChanged?.(); }
    }
  }
  async function openAddress(url: URL, dismissSettings = true) {
    const ticket = ++addressEpoch;
    addressOperation.abort();
    addressOperation = new AbortController();
    const signal = AbortSignal.any([life.signal, addressOperation.signal]);
    watchAddress(url);
    syncingUrl = true;
    try {
      let state = emptyUriState();
      if (url.searchParams.has('s')) {
        if (localOnly) throw new Error(t(msg('sites.remoteUnavailable', '此版本仅支持本地文件，请使用完整版访问媒体服务')));
        const response = await fetch('/api/uri/decode?s=' + encodeURIComponent(url.searchParams.get('s')!), { signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]) });
        const result = await response.json(); if (!response.ok) throw apiError(response.status, result);
        state = result.state;
      }
      if (ticket !== addressEpoch || signal.aborted) return;
      if (await restoreState(state, dismissSettings) && ticket === addressEpoch && !signal.aborted)
        watchAddress(url);
    } catch (error) { if (!signal.aborted) throw error; }
    finally { if (ticket === addressEpoch) { syncingUrl = false; changed(); } }
  }
  async function applyState(value: unknown) {
    addressEpoch++; addressOperation.abort(); syncingUrl = false;
    await restoreState(value);
    changed();
  }
  async function copy(url: string) {
    try { await navigator.clipboard.writeText(url); options.toasts.show(() => t(msg('uriState.copied', '状态链接已复制'))); }
    catch {
      window.prompt(t(msg('uriState.copyFallback', '请手动复制以下分享链接')), url);
    }
  }
  let sharing: Promise<{ url: string; abi: 1 }> | undefined;
  const shareButtons = ['workspace-share'].flatMap(id => {
    const element = document.getElementById(id) as HTMLButtonElement | null; return element ? [element] : [];
  });
  function controls() {
    const tracks = session.getState().tracks;
    const reason = tracks.some(track => !track.source) ? t(msg('uriState.localShare', '本地文件不能分享，请先放入媒体库。'))
      : opening ? t(msg('uriState.wait', '请等待状态载入或分享完成')) : !tracks.length ? t(msg('sharing.addVideo', '请先添加视频再分享')) : '';
    for (const button of shareButtons) {
      if (button.disabled !== !!reason) button.disabled = !!reason;
      button.dataset.tooltip = reason || t(msg('shell.share', '分享'));
      if (sharing) button.setAttribute('aria-busy', 'true'); else button.removeAttribute('aria-busy');
    }
  }
  async function shareState() {
    if (sharing) return sharing;
    if (opening) throw new Error(t(msg('uriState.wait', '请等待状态载入或分享完成')));
    const state = exportState();
    if (state.tracks.some(track => track.local)) throw new Error(t(msg('uriState.localShare', '本地文件不能分享，请先放入媒体库。')));
    if (!state.tracks.length) throw new Error(t(msg('sharing.addVideo', '请先添加视频再分享')));
    sharing = (async () => {
      const response = await fetch('/api/uri/encode', { method: 'POST', headers: { 'content-type': 'application/json',
        'x-voidplayer-action': 'uri' }, body: JSON.stringify({ state }), signal: AbortSignal.any([life.signal, AbortSignal.timeout(10000)]) });
      const result = await response.json(); if (!response.ok) throw apiError(response.status, result);
      const url = new URL(result.url, location.origin).href; await copy(url); return { url, abi: 1 as const };
    })();
    controls();
    try { return await sharing; }
    finally { sharing = undefined; controls(); }
  }
  for (const button of shareButtons) button.addEventListener('click', () => void options.act(shareState, 'state.share'), { signal: life.signal });
  const unsubscribe = session.subscribe(() => { controls(); changed(); });
  const unsubscribeProgress = session.subscribeProgress(changed);
  for (const event of ['click', 'input', 'change', 'pointermove', 'pointerup', 'keyup'])
    window.addEventListener(event, scheduleChanged, { signal: life.signal });
  window.addEventListener('popstate', () => void options.act(() => openAddress(new URL(location.href)), 'state.navigate'), { signal: life.signal });
  window.addEventListener('voidplayer-identity-change', () => {
    if (startupPending && !syncingUrl) return;
    epoch++; addressEpoch++; addressOperation.abort(); operation.abort(); opening = false;
    root.removeAttribute('data-workspace-opening'); controls(); }, { signal: life.signal });
  if (explicit || updating) void options.identityReady.then(async () => {
    const handoff = updating ? takeUpdateState(original.searchParams.get('vp-update')!) : undefined;
    if (!handoff) return openAddress(original, false);
    if (await restoreState(handoff, false)) {
      const url = new URL(location.href); url.search = ''; history.replaceState(history.state, '', url);
    }
  }).catch(error => {
    options.toasts.show((error as Error).message, { kind: 'error', durationMs: 0 });
  }).finally(() => { startupPending = false; opening = false; controls(); root.removeAttribute('data-workspace-opening'); options.openingChanged?.(); });
  controls();
  onLanguageChange(controls, life.signal);
  async function refreshForUpdate(target: string) {
    const state = session.getState();
    if (opening || state.busy || state.playing || !options.editsReady())
      throw new Error(t(msg('update.wait', '请先暂停播放，完成标注并等载入和保存结束，再刷新。')));
    const saved = exportState();
    for (const track of saved.tracks) if (track.local) {
      try {
        const file = await restoreHandleFile(handleKey(track.local), undefined, false);
        if (file.name !== track.local.name || file.size !== track.local.size || file.lastModified !== track.local.lastModified) throw new Error('changed');
      }
      catch { throw new Error(t(msg('uriState.localUnavailable', '刷新后无法读取本地片源，请继续使用当前窗口。'))); }
    }
    const local = saved.tracks.some(track => track.local);
    const uri = local ? new URL('/', location.href) : createShareUrl(saved, location.href);
    await prepareOfflineUpdate(target);
    if (local) stageUpdateState(target, saved);
    uri.searchParams.set('vp-update', target); location.assign(uri.href);
  }
  return { exportState, applyState, shareState: localOnly ? undefined : shareState, refreshForUpdate, changed,
    dispose() {
      life.abort(); addressOperation.abort(); operation.abort(); unsubscribe(); unsubscribeProgress();
      if (changeFrame !== null) cancelAnimationFrame(changeFrame);
    } };
}
