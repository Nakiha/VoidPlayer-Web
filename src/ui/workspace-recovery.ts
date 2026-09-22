import { WorkspaceCheckpoints } from '../workspace-checkpoint.ts';
import { currentActor } from '../identity.ts';
import type { ReviewSession } from '../session.ts';
import type { WorkspaceFile } from '../workspace-file.ts';
import type { ToastStack } from './toast.ts';

export function installWorkspaceRecovery(session: ReviewSession, options: {
  snapshot(): WorkspaceFile; restore(document: WorkspaceFile): Promise<boolean>; ready: Promise<void>; toasts: ToastStack;
}) {
  const store = new WorkspaceCheckpoints(), id = crypto.randomUUID();
  let previousId = '', actor = '', active = false, initialized = false, disposed = false;
  let last = '', timer: ReturnType<typeof setTimeout> | undefined, writing = false, again = false, warned = false;
  let generation = 0;
  let dismiss: (() => void) | undefined;
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
    initialized = false; active = false; last = ''; dismiss?.();
    actor = currentActor()?.id ?? 'local';
    const expectedActor = actor;
    try {
      const checkpoint = await store.read(actor, `${previousId}:${actor}`);
      if (disposed || actor !== expectedActor || generation !== currentGeneration) return;
      const url = new URL(location.href);
      if (checkpoint?.document.tracks.length && !session.getState().tracks.length && !url.searchParams.has('share') && !url.searchParams.has('workspace')) {
        dismiss = options.toasts.show('发现上次的工作区：可恢复轨道、位置、布局和比较条件。', { durationMs: 0,
          action: { label: '恢复工作区', onClick: () => {
            void options.restore(checkpoint.document).then(ok => { if (ok) { active = true; schedule(); options.toasts.show('工作区已恢复。'); } })
              .catch(error => options.toasts.show(String(error), { kind: 'error' }));
          } } });
      }
    } catch {
      options.toasts.show('无法读取本机工作区恢复记录，请检查浏览器存储。', { kind: 'error' });
    } finally { if (!disposed && actor === expectedActor && generation === currentGeneration) initialized = true; }
  }
  void options.ready.then(initialize);
  window.addEventListener('voidplayer-identity-change', () => { void initialize(); }, { signal: lifetime.signal });
  return { flush, dispose() { disposed = true; clearTimeout(timer); clearInterval(interval); unsubscribe(); lifetime.abort(); dismiss?.(); store.close(); } };
}
