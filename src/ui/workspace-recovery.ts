import { WorkspaceCheckpoints } from '../workspace-checkpoint.ts';
import { currentActor } from '../identity.ts';
import type { ReviewSession } from '../session.ts';
import type { WorkspaceFile } from '../workspace-file.ts';
import type { ToastStack } from './toast.ts';
import { referenceVersion } from '../media-reference.ts';
import { localCacheKey, serverCacheKey } from '../thumbnails/contract.ts';
import { fillThumbnailImage, serverThumbnailImageUrl } from '../thumbnails/client.ts';
import { icon } from './icons.ts';

function recoveryCard(checkpoint: WorkspaceFile, restore: () => Promise<void>) {
  const button = document.createElement('button');
  button.id = 'start-workspace-card';
  button.className = 'start-workspace-card';
  button.type = 'button';
  button.setAttribute('aria-label', '恢复工作区');
  const heading = document.createElement('span');
  heading.className = 'start-workspace-heading';
  const title = document.createElement('strong');
  title.textContent = checkpoint.name && checkpoint.name !== '未命名工作区' ? checkpoint.name : '上次的工作区';
  const arrow = document.createElement('span');
  arrow.innerHTML = icon('arrowRight');
  heading.append(title, arrow);
  const tracks = document.createElement('span');
  tracks.className = 'start-workspace-tracks';
  for (const track of checkpoint.tracks) {
    const info = checkpoint.media.find(media => media.id === track.mediaId);
    if (!info) continue;
    const row = document.createElement('span'); row.className = 'start-workspace-track';
    const thumb = document.createElement('span'); thumb.className = 'start-workspace-thumb';
    thumb.innerHTML = icon('film');
    const img = document.createElement('img'); img.alt = ''; img.loading = 'lazy'; img.style.opacity = '0';
    const version = referenceVersion(info.source?.url);
    const key = info.source && version ? serverCacheKey({ mediaId: info.source.id, mediaVersion: version })
      : localCacheKey(info.name, info.size, info.lastModified);
    img.onload = () => { img.style.opacity = ''; thumb.replaceChildren(img); };
    thumb.append(img);
    const name = document.createElement('span'); name.className = 'start-workspace-track-name';
    const slot = document.createElement('b'); slot.textContent = `${track.slot} · `;
    name.append(slot, document.createTextNode(info.name));
    row.append(thumb, name); tracks.append(row);
    fillThumbnailImage(img, key, info.source && version ? new URL(serverThumbnailImageUrl(info.source.id, version), checkpoint.serverUrl).href : undefined);
  }
  const meta = document.createElement('span'); meta.className = 'start-workspace-meta';
  const seconds = Math.floor(checkpoint.positionUs / 1_000_000);
  const time = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
  meta.textContent = `${checkpoint.tracks.length} 条轨道 · ${checkpoint.marks.length} 条标注 · 停在 ${time}`;
  button.append(heading, tracks, meta);
  button.onclick = () => { button.disabled = true; void restore().finally(() => { if (button.isConnected) button.disabled = false; }); };
  return button;
}

export function installWorkspaceRecovery(session: ReviewSession, options: {
  snapshot(): WorkspaceFile; restore(document: WorkspaceFile): Promise<boolean>; ready: Promise<void>; toasts: ToastStack;
}) {
  const store = new WorkspaceCheckpoints(), id = crypto.randomUUID();
  let previousId = '', actor = '', active = false, initialized = false, disposed = false;
  let last = '', timer: ReturnType<typeof setTimeout> | undefined, writing = false, again = false, warned = false;
  let generation = 0;
  const recovery = document.getElementById('start-workspace-recovery')!;
  const clearRecovery = () => { recovery.replaceChildren(); recovery.hidden = true; };
  try { previousId = sessionStorage.getItem('voidplayer.checkpoint') ?? ''; sessionStorage.setItem('voidplayer.checkpoint', id); } catch {}
  async function flush() {
    if (!initialized || disposed) return;
    if (writing) { again = true; return; }
    const state = session.getState();
    if (state.busy || state.mediaLoad?.state === 'loading') return;
    if (state.tracks.length) active = true;
    if (!active) return; // An empty startup never replaces the recoverable scene.
    const savingActor = actor;
    const snapshot = options.snapshot();
    // Thumbnail JPEGs are derived; vector marks and all source references stay.
    snapshot.thumbnails = [];
    const signature = JSON.stringify({ ...snapshot, generatedAt: '' });
    if (signature === last) return;
    writing = true;
    try {
      await store.save({ id: `${id}:${savingActor}`, actor: savingActor, updatedAt: Date.now(), document: snapshot }); if (actor === savingActor) last = signature;
      if (warned) { warned = false; options.toasts.show('工作区本机自动恢复已恢复保存。'); }
    } catch {
      if (!warned) { warned = true; options.toasts.show('工作区本机自动恢复保存失败，请导出文件或显式保存到服务器。', { kind: 'error' }); }
    } finally { writing = false; if (again) { again = false; void flush(); } }
  }
  const schedule = () => { clearTimeout(timer); timer = setTimeout(() => void flush(), 500); };
  const unsubscribe = session.subscribe(schedule);
  // Also samples viewport/layout changes and advancing playback, neither of
  // which needs a full session event. At most one write + one coalesced update.
  const interval = setInterval(() => void flush(), 5000);
  const lifetime = new AbortController();
  window.addEventListener('pagehide', () => void flush(), { signal: lifetime.signal });
  document.addEventListener('visibilitychange', () => { if (document.hidden) void flush(); }, { signal: lifetime.signal });
  async function initialize() {
    const currentGeneration = ++generation;
    initialized = false; active = false; last = ''; clearRecovery();
    actor = currentActor()?.id ?? 'local';
    const expectedActor = actor;
    try {
      const checkpoint = await store.read(actor, `${previousId}:${actor}`);
      if (disposed || actor !== expectedActor || generation !== currentGeneration) return;
      const url = new URL(location.href);
      if (checkpoint?.document.tracks.length && !session.getState().tracks.length && !url.searchParams.has('share') && !url.searchParams.has('workspace')) {
        recovery.replaceChildren(recoveryCard(checkpoint.document, async () => {
          try {
            const ok = await options.restore(checkpoint.document);
            if (ok) { active = true; clearRecovery(); schedule(); options.toasts.show('工作区已恢复。'); }
          } catch (error) { options.toasts.show(String(error), { kind: 'error' }); }
        }));
        recovery.hidden = false;
      }
    } catch {
      options.toasts.show('无法读取本机工作区恢复记录，请检查浏览器存储。', { kind: 'error' });
    } finally { if (!disposed && actor === expectedActor && generation === currentGeneration) initialized = true; }
  }
  void options.ready.then(initialize);
  window.addEventListener('voidplayer-identity-change', () => { void initialize(); }, { signal: lifetime.signal });
  return { flush, dispose() { disposed = true; clearTimeout(timer); clearInterval(interval); unsubscribe(); lifetime.abort(); clearRecovery(); store.close(); } };
}
