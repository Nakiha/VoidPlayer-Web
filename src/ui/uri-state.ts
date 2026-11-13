import { localOnly } from '../services/build-profile.ts';
import { prefetchThumbnailStatuses } from '../thumbnails/client.ts';
import { currentActor } from '../services/identity.ts';
import { prepareOfflineUpdate } from './offline-app.ts';
import { parseWorkspace } from '../../shared/review/workspace-file.ts';
import type { WorkspaceFile } from '../../shared/review/workspace-file.ts';
import { applyUriParameters, hasUriState, uriStateFromDocument, writeUriState, parseUriState } from '../../shared/review/uri-state.ts';
import type { UriState } from '../../shared/review/uri-state.ts';
import { restoreHandleFile, handleKey } from '../services/file-handles.ts';
import { openMedia, openMediaFromUrl } from '../media/source.ts';
import { updateMediaInfo } from '../media/state.ts';
import type { MediaInfo } from '../../shared/media/types.ts';
import type { ReviewSession } from '../session.ts';
import type { ToastStack } from './toast.ts';
import { apiError } from '../services/api-error.ts';
import { t, msg } from '../i18n.ts';
import { Viewport } from '../../shared/presentation/viewport.ts';

export function installUriState(session: ReviewSession, options: {
  act(action: () => unknown | Promise<unknown>, name: string): Promise<void>;
  capture(): Pick<WorkspaceFile, 'viewport' | 'layout'>;
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
  let previousSignature = '', previousSources = '', disposed = false;
  let focusedMark: string | undefined, focusedPosition = -1;
  let addressEpoch = 0, addressOperation = new AbortController();
  const defaultLayout = structuredClone(options.capture().layout);
  const original = new URL(location.href), explicit = hasUriState(original);
  opening = explicit;
  let startupPending = explicit;
  const root = document.getElementById('app')!;
  root.toggleAttribute('data-workspace-opening', explicit && (original.searchParams.has('s') || ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'].some(slot => original.searchParams.has(slot))));
  document.getElementById('start-panel')?.removeAttribute('data-recovery-pending');
  function exportWorkspace(): WorkspaceFile {
    return { ...session.exportWorkspace(new URL('/', location.href).href), ...options.capture() };
  }
  const exportState = () => {
    const state = uriStateFromDocument(exportWorkspace(), location.href);
    if (focusedMark && state.positionUs === focusedPosition) state.mark = focusedMark;
    return state;
  };
  function updateUrl() {
    if (disposed || opening || syncingUrl || session.getState().busy) return;
    const state = exportState(), url = writeUriState(state, location.href);
    const signature = url.search;
    if (signature === previousSignature) return;
    const sources = JSON.stringify(state.tracks);
    const push = !!previousSignature && sources !== previousSources;
    previousSignature = signature; previousSources = sources;
    if (push) history.pushState(null, '', url); else history.replaceState(null, '', url);
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
  async function restoreState(value: unknown) {
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
        await options.restore({ ...exportWorkspace(), viewport: state.viewport, layout: state.layout ?? defaultLayout }, true);
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
        viewport: state.viewport, comparison: state.comparison, layout: state.layout ?? defaultLayout });
      staged = true;
      options.beforeRestore(); await options.closeSettings();
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
  async function openAddress(url: URL) {
    const ticket = ++addressEpoch;
    addressOperation.abort();
    addressOperation = new AbortController();
    const signal = AbortSignal.any([life.signal, addressOperation.signal]);
    syncingUrl = true;
    try {
      let base: UriState | undefined;
      if (url.searchParams.has('s')) {
        if (localOnly) throw new Error(t(msg('sites.remoteUnavailable', '此版本仅支持本地文件，请使用完整版访问媒体服务')));
        const response = await fetch('/api/uri/decode?s=' + encodeURIComponent(url.searchParams.get('s')!), { signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]) });
        const result = await response.json(); if (!response.ok) throw apiError(response.status, result);
        base = result.state;
      }
      if (ticket !== addressEpoch || signal.aborted) return;
      const state = applyUriParameters(url, base);
      if (!await restoreState(state) || ticket !== addressEpoch || signal.aborted) return;
      // Expand the immutable shared payload into editable parameters after restoring.
      state.positionUs = session.getState().positionUs;
      const expanded = writeUriState(state, location.href); previousSignature = expanded.search; previousSources = JSON.stringify(state.tracks);
      history.replaceState(null, '', expanded);
    } catch (error) { if (!signal.aborted) throw error; }
    finally { if (ticket === addressEpoch) syncingUrl = false; }
  }
  async function applyState(value: unknown) {
    addressEpoch++; addressOperation.abort(); syncingUrl = false;
    if (await restoreState(value)) {
      const url = writeUriState(parseUriState(value), location.href); previousSignature = url.search; previousSources = JSON.stringify(parseUriState(value).tracks);
      history.pushState(null, '', url);
    }
  }
  async function copy(url: string) {
    try { await navigator.clipboard.writeText(url); options.toasts.show(() => t(msg('uriState.copied', '状态链接已复制'))); }
    catch {
      const fallback = document.getElementById('state-link-fallback')!;
      const link = fallback.querySelector('a')!; link.href = url; link.textContent = url; fallback.hidden = false;
      options.toasts.show(() => t(msg('uriState.copyFallback', '请在设置中的状态链接上手动复制')));
    }
  }
  let sharing = false;
  const shareButtons = ['workspace-share', 'saved-workspace-share'].flatMap(id => {
    const element = document.getElementById(id) as HTMLButtonElement | null; return element ? [element] : [];
  });
  function controls() { for (const button of shareButtons) button.disabled = sharing || opening || !session.getState().tracks.length; }
  async function shareState() {
    if (sharing || opening) throw new Error(t(msg('uriState.wait', '请等待状态载入或分享完成')));
    const state = exportState();
    if (state.tracks.some(track => track.local)) throw new Error(t(msg('uriState.localShare', '本地文件不能分享，请先放入媒体库。')));
    if (!state.tracks.length) throw new Error(t(msg('sharing.addVideo', '请先添加视频再分享')));
    sharing = true; controls();
    try {
      const response = await fetch('/api/uri/encode', { method: 'POST', headers: { 'content-type': 'application/json',
        'x-voidplayer-action': 'uri' }, body: JSON.stringify({ state }), signal: AbortSignal.any([life.signal, AbortSignal.timeout(10000)]) });
      const result = await response.json(); if (!response.ok) throw apiError(response.status, result);
      const url = new URL(result.url, location.origin).href; await copy(url); return { url, abi: 1 };
    } finally { sharing = false; controls(); }
  }
  for (const button of shareButtons) button.addEventListener('click', () => void options.act(shareState, 'state.share'), { signal: life.signal });
  document.getElementById('state-copy-readable')!.addEventListener('click', () => void options.act(async () => {
    await copy(writeUriState(exportState(), location.href).href);
  }, 'state.copy'), { signal: life.signal });
  const unsubscribe = session.subscribe(controls), timer = setInterval(() => { try { updateUrl(); } catch {} }, 500);
  window.addEventListener('popstate', () => void options.act(() => openAddress(new URL(location.href)), 'state.navigate'), { signal: life.signal });
  window.addEventListener('voidplayer-identity-change', () => {
    if (startupPending && !syncingUrl) return;
    epoch++; addressEpoch++; addressOperation.abort(); operation.abort(); opening = false;
    root.removeAttribute('data-workspace-opening'); controls(); }, { signal: life.signal });
  if (explicit) void options.identityReady.then(() => openAddress(original)).catch(error => {
    options.toasts.show((error as Error).message, { kind: 'error', durationMs: 0 });
  }).finally(() => { startupPending = false; opening = false; controls(); root.removeAttribute('data-workspace-opening'); options.openingChanged?.(); });
  controls();
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
    const uri = writeUriState(saved, location.href);
    await prepareOfflineUpdate(target);
    uri.searchParams.set('vp-update', target); location.assign(uri.href);
  }
  return { exportState, applyState, shareState: localOnly ? undefined : shareState, refreshForUpdate,
    dispose() { disposed = true; life.abort(); addressOperation.abort(); operation.abort(); clearInterval(timer); unsubscribe(); } };
}
