import { SLOTS } from '../model.ts';
import type { ReviewSession } from '../session.ts';
import type { Slot } from '../model.ts';
import { mediaActionUrl } from '../media-reference.ts';
import { icon } from './icons.ts';

type Action = (action: () => unknown | Promise<unknown>, name?: string, data?: unknown) => Promise<void>;
type Location = { absolutePath: string; reveal: boolean };
const localPage = () => ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);

export function installSourceActions(session: ReviewSession, act: Action, onReconnect: () => void = () => {}) {
  const status = document.getElementById('server-status')!;
  const locations = new Map<string, Location>();
  const pending = new Set<string>();
  let disposed = false, probing = false, canReveal = false;
  const lifetime = new AbortController();
  const signal = () => AbortSignal.any([lifetime.signal, AbortSignal.timeout(4000)]);
  async function probe() {
    if (probing || disposed) return;
    probing = true;
    const prior = status.dataset.state;
    if (!prior || prior === 'checking') status.dataset.state = 'checking';
    let state = 'disconnected', label = '媒体服务未连接；本地文件仍可播放。点击重试';
    try {
      const response = await fetch('/api/health', { cache: 'no-store', signal: signal() });
      const health = response.ok ? await response.json() : null;
      if (health?.service === 'voidplayer-media') {
        state = 'connected'; label = '媒体服务已连接';
        const actor = health.actor && typeof health.actor.id === 'string' && typeof health.actor.name === 'string' ? health.actor : null;
        session.setActor(actor);
        if (actor) label += ` · ${actor.name}`; canReveal = !!health.capabilities?.reveal && localPage();
      } else canReveal = false;
    } catch { canReveal = false; }
    if (state !== 'connected' && !navigator.onLine) { state = 'offline'; label = '网络离线；本地文件仍可播放'; }
    probing = false;
    if (disposed) return;
    status.dataset.state = state; status.setAttribute('aria-label', label);
    status.dataset.tooltip = state === 'connected' ? '媒体服务已连接\n可浏览媒体库片源。点击重新检查连接。' : state === 'offline' ? '媒体库连接：网络离线\n本地文件仍可播放。' : '媒体库连接：未连接\n本地文件仍可播放。点击重试。';
    render();
    if (state === 'connected' && (prior === 'disconnected' || prior === 'offline')) onReconnect();
  }
  function render(state = session.getState()) {
    for (const slot of SLOTS) {
      const track = state.tracks.find(t => t.slot === slot);
      const copy = document.getElementById(`copy-path-${slot}`) as HTMLButtonElement;
      const action = document.getElementById(`source-action-${slot}`) as HTMLButtonElement;
      const source = track?.source;
      const loc = source && locations.get(source.url);
      copy.disabled = !loc;
      copy.title = copy.dataset.copied === 'true' ? '绝对路径已拷贝' : !source ? '浏览器未提供本地绝对路径；从本机媒体库打开可使用路径和定位' : loc ? '拷贝绝对路径' : '正在获取路径；服务需支持文件位置接口';
      const reveal = !!loc?.reveal && canReveal;
      action.disabled = !source;
      const label = source ? reveal ? '在文件管理器中定位' : '下载文件' : '浏览器未提供本地文件定位；可从本机媒体库打开';
      action.title = label; action.setAttribute('aria-label', `${label} ${slot}`);
      if (action.dataset.action !== (reveal ? 'reveal' : 'download')) {
        action.dataset.action = reveal ? 'reveal' : 'download'; action.innerHTML = icon(reveal ? 'open' : 'download');
      }
      copy.onclick = () => { if (loc) void act(async () => { await navigator.clipboard.writeText(loc.absolutePath); copy.dataset.copied = 'true'; copy.title = '绝对路径已拷贝'; setTimeout(() => { delete copy.dataset.copied; if (!disposed) render(); }, 1600); }, 'ui.copy-path'); };
      action.onclick = () => {
        if (!source) return;
        if (!reveal) {
          const a = document.createElement('a'); a.href = mediaActionUrl(source.url, 'download', location.href); a.download = track!.name.split('/').at(-1)!; a.click(); return;
        }
        void act(async () => {
          const response = await fetch(mediaActionUrl(source.url, 'reveal', location.href), { method: 'POST', headers: { 'x-voidplayer-action': 'reveal' }, signal: signal() });
          if (!response.ok) throw new Error((await response.json()).error ?? '文件定位失败');
        }, 'ui.reveal-file');
      };
      if (source && !loc && !pending.has(source.url) && status.dataset.state === 'connected') {
        pending.add(source.url);
        void fetch(mediaActionUrl(source.url, 'location', location.href), { signal: signal(), cache: 'no-store' }).then(async response => {
          if (!response.ok) return;
          const body = await response.json();
          if (typeof body.absolutePath === 'string') locations.set(source.url, body);
        }).catch(() => {}).finally(() => { if (!disposed) render(); });
      }
    }
  }
  status.onclick = () => { pending.clear(); void probe(); };
  window.addEventListener('online', () => void probe(), { signal: lifetime.signal });
  window.addEventListener('offline', () => void probe(), { signal: lifetime.signal });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void probe(); }, { signal: lifetime.signal });
  const timer = setInterval(() => { if (!document.hidden) { pending.clear(); void probe(); } }, 10000);
  void probe();
  return { render, dispose() { disposed = true; clearInterval(timer); lifetime.abort(); } };
}
