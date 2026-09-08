import { currentActor } from '../identity.ts';
import type { WorkspaceFile } from '../workspace-file.ts';
import { pinLibraryReference } from '../media-reference.ts';
import { icon } from './icons.ts';

/** Immutable server snapshots reuse the same restore contract as workspace files. */
export function installWorkspaceSharing(options: {
  signal: AbortSignal; ready: Promise<void>; snapshot(): WorkspaceFile;
  open(value: unknown): Promise<boolean>; canShare(): boolean; report(error: unknown): void;
}) {
  const button = document.getElementById('workspace-share') as HTMLButtonElement;
  const toast = document.createElement('div'); toast.className = 'workspace-share-toast'; toast.hidden = true;
  toast.setAttribute('role', 'status'); toast.setAttribute('aria-live', 'polite');
  document.body.append(toast);
  let busy = false, timer: ReturnType<typeof setTimeout> | undefined;
  function update() { button.disabled = busy || !options.canShare(); }
  function notify(message: string, link?: string) {
    clearTimeout(timer); toast.replaceChildren(); toast.hidden = false;
    const label = document.createElement('span'); label.textContent = message; toast.append(label);
    if (link) { const input = document.createElement('input'); input.readOnly = true; input.value = link; input.setAttribute('aria-label', '分享链接'); input.onclick = () => input.select(); toast.append(input); }
    const close = document.createElement('button'); close.textContent = '关闭'; close.onclick = () => { toast.hidden = true; }; toast.append(close);
    if (!link) timer = setTimeout(() => { toast.hidden = true; }, 7000);
  }
  async function create() {
    if (busy) throw new Error('分享正在创建，请等待完成。');
    if (!options.canShare()) throw new Error('请等待视频载入后再分享。');
    // Capture before any await: playback and later edits cannot alter this link.
    const actorId = currentActor()?.id;
    busy = true; update(); button.setAttribute('aria-busy', 'true'); button.innerHTML = `${icon('refresh', 'share-spinner')}<span>正在分享</span>`;
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
      try { await navigator.clipboard.writeText(link); notify('分享链接已在服务端创建，并已复制。'); }
      catch { notify('分享链接已在服务端创建，请复制下方链接。', link); }
      return { id: result.id as string, url: link };
    } catch(error) { if (!options.signal.aborted) { notify((error as Error).message); options.report(error); } throw error; }
    finally { busy = false; button.removeAttribute('aria-busy'); button.innerHTML = `${icon('export')}<span>分享</span>`; update(); }
  }
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
      if (await options.open(snapshot)) notify('已还原分享快照，后续编辑不会改变原链接。');
      else notify('已取消还原分享快照。');
    } catch(error) { if (!options.signal.aborted) { notify((error as Error).message); options.report(error); } }
  });
  update();
  return { create, update, dispose() { clearTimeout(timer); toast.remove(); } };
}
