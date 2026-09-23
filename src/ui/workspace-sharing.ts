import { currentActor } from '../identity.ts';
import type { WorkspaceFile } from '../workspace-file.ts';
import { pinLibraryReference } from '../media-reference.ts';
import { icon } from './icons.ts';
import type { ToastStack } from './toast.ts';

/** Immutable server snapshots reuse the same restore contract as workspace files. */
export function installWorkspaceSharing(options: {
  signal: AbortSignal; ready: Promise<void>; snapshot(): WorkspaceFile; toasts: ToastStack;
  created?(document: WorkspaceFile): Promise<void>; open(value: unknown): Promise<boolean>; canShare(): boolean; report(error: unknown): void;
}) {
  const button = document.getElementById('workspace-share') as HTMLButtonElement;
  const settingsButton = document.getElementById('saved-workspace-share') as HTMLButtonElement;
  const toasts = options.toasts;
  let busy = false;
  function update() {
    for (const control of [button, settingsButton]) {
      control.disabled = busy || !options.canShare();
      control.setAttribute('aria-busy', String(busy));
      control.innerHTML = `${busy ? icon('refresh', 'share-spinner') : icon('export')}<span>${busy ? '正在分享' : '分享'}</span>`;
    }
  }
  function notify(message: string, link?: string, kind?: 'info' | 'error') {
    // A modal settings dialog traps focus; show the toast where it is reachable.
    (document.querySelector<HTMLDialogElement>('#settings[open]') ?? document.body).append(toasts.stack);
    if (!link) { toasts.show(message, { kind, durationMs: kind === 'error' ? 0 : 7000 }); return; }
    toasts.show(message, { kind, durationMs: 0, action: { label: '复制链接', onClick: () => void navigator.clipboard.writeText(link).catch(() => {}) } });
  }
  async function create() {
    if (busy) throw new Error('分享正在创建，请等待完成。');
    if (!options.canShare()) throw new Error('请等待视频载入后再分享。');
    // Capture before any await: playback and later edits cannot alter this link.
    const actorId = currentActor()?.id;
    busy = true; update();
    try {
      const snapshot = structuredClone(options.snapshot());
      for (const media of snapshot.media) {
        if (!media.source) throw new Error(`「${media.name}」是本地文件，请先放入服务端媒体库再分享。`);
        media.source = await pinLibraryReference(media, location.href);
      }
      const response = await fetch('/api/shares', {method:'POST', headers:{'content-type':'application/json','x-voidplayer-action':'workspace',...(actorId ? {'x-voidplayer-actor':actorId} : {})}, body:JSON.stringify(snapshot), signal:AbortSignal.any([options.signal,AbortSignal.timeout(30000)])});
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? '分享创建失败。');
      const link = new URL(result.path, location.origin).href;
      await options.created?.(snapshot);
      try { await navigator.clipboard.writeText(link); notify('分享链接已在服务端创建，并已复制'); }
      catch { notify('分享链接已在服务端创建，请复制下方链接', link); }
      return { id: result.id as string, url: link };
    } catch(error) { if (!options.signal.aborted) { notify((error as Error).message, undefined, 'error'); options.report(error); } throw error; }
    finally { busy = false; update(); }
  }
  settingsButton.addEventListener('click', () => void create().catch(() => {}), { signal: options.signal });
  button.addEventListener('click', () => void create().catch(() => {}), {signal:options.signal});
  const id = new URL(location.href).searchParams.get('share');
  if (id) void options.ready.then(async () => {
    try {
      if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('分享链接无效。');
      notify('正在还原分享的工作区…');
      const response = await fetch(`/api/shares/${id}`, {signal:AbortSignal.any([options.signal,AbortSignal.timeout(30000)]),cache:'no-store'});
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? '无法读取分享快照。');
      const snapshot = result.document as WorkspaceFile;
      // Same server can be visited through another hostname; external libraries retain their origin.
      const previousOrigin = new URL(snapshot.serverUrl).origin;
      for (const media of snapshot.media) if (media.source && new URL(media.source.url).origin === previousOrigin) {
        const old = new URL(media.source.url); media.source.url = new URL(old.pathname + old.search, location.origin).href;
      }
      snapshot.serverUrl = location.origin + '/';
      if (await options.open(snapshot)) notify('已还原分享快照，可继续添加云端标注；再次分享会生成新链接');
      else notify('已取消还原分享快照');
    } catch(error) { if (!options.signal.aborted) { notify((error as Error).message, undefined, 'error'); options.report(error); } }
  });
  update();
  // Toast stack lifetime is owned by the caller (shared across notifiers).
  return { create, update, dispose() {} };
}
