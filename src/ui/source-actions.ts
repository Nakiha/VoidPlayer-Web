import { identityHealth } from '../identity.ts';
import { SLOTS } from '../model.ts';
import type { ReviewSession } from '../session.ts';
import type { Slot } from '../model.ts';
import { mediaActionUrl } from '../media-reference.ts';
import { icon } from './icons.ts';
import { onLanguageChange, t, msg } from '../i18n.ts';

type Action = (action: () => unknown | Promise<unknown>, name?: string, data?: unknown) => Promise<void>;
type Location = { absolutePath: string; reveal: boolean };
const localPage = () => ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);

export function installSourceActions(session: ReviewSession, act: Action, onReconnect: () => void = () => {}, notify: (message: string) => void = () => {}) {
  const status = document.getElementById('server-status')!;
  const locations = new Map<string, Location>();
  const pending = new Set<string>();
  let disposed = false, probing = false, canReveal = false, statusActor = '';
  const lifetime = new AbortController();
  const signal = () => AbortSignal.any([lifetime.signal, AbortSignal.timeout(4000)]);
  async function probe() {
    if (probing || disposed) return;
    probing = true;
    const prior = status.dataset.state;
    if (!prior || prior === 'checking') status.dataset.state = 'checking';
    let state = 'disconnected'; statusActor = '';
    try {
      const health = await identityHealth();
      if (health?.service === 'voidplayer-media') {
        state = 'connected';
        const actor = health.actor && typeof health.actor.id === 'string' && typeof health.actor.name === 'string' ? health.actor : null;

        if (actor) statusActor = actor.name; canReveal = !!health.capabilities?.reveal && localPage();
      } else canReveal = false;
    } catch { canReveal = false; }
    if (state !== 'connected' && !navigator.onLine) { state = 'offline'; }
    probing = false;
    if (disposed) return;
    status.dataset.state = state; renderStatus();
    render();
    if (state === 'connected' && (prior === 'disconnected' || prior === 'offline')) onReconnect();
  }
  function renderStatus() {
    const state = status.dataset.state;
    const label = state === 'connected' ? t(msg("sourceActions.connected", "媒体服务已连接")) : state === 'offline' ? t(msg("sourceActions.offline", "网络离线；本地文件仍可播放")) : t(msg("sourceActions.disconnected", "媒体服务未连接；本地文件仍可播放"));
    status.setAttribute('aria-label', label + (statusActor ? ` · ${statusActor}` : '') + t(msg("sourceActions.openAdminSuffix", "，打开服务管理（新标签页）")));
    status.dataset.tooltip = label + t(msg("sourceActions.openAdminNewLine", "\n打开服务管理（新标签页）"));
  }
  function render(state = session.getState()) {
    for (const slot of SLOTS) {
      const track = state.tracks.find(t => t.slot === slot);
      const copy = document.getElementById(`copy-path-${slot}`) as HTMLButtonElement;
      const action = document.getElementById(`source-action-${slot}`) as HTMLButtonElement;
      const source = track?.source;
      const loc = source && locations.get(source.url);
      copy.disabled = !loc;
      copy.title = copy.dataset.copied === 'true' ? t(msg("sourceActions.copied", "绝对路径已拷贝")) : !source ? t(msg("sourceActions.noAbsolutePath", "浏览器未提供本地绝对路径；从本机媒体库打开可使用路径和定位")) : loc ? t(msg("sourceActions.copyAbsolutePath", "拷贝绝对路径")) : t(msg("sourceActions.fetchingPath", "正在获取路径；服务需支持文件位置接口"));
      const reveal = !!loc?.reveal && canReveal;
      action.disabled = !source;
      const label = source ? reveal ? t(msg("sourceActions.locateInManager", "在文件管理器中定位")) : t(msg("sourceActions.downloadFile", "下载文件")) : t(msg("sourceActions.noLocate", "浏览器未提供本地文件定位；可从本机媒体库打开"));
      action.title = label; action.setAttribute('aria-label', `${label} ${slot}`);
      if (action.dataset.action !== (reveal ? 'reveal' : 'download')) {
        action.dataset.action = reveal ? 'reveal' : 'download'; action.innerHTML = icon(reveal ? 'open' : 'download');
      }
      copy.onclick = () => { if (loc) void act(async () => { await navigator.clipboard.writeText(loc.absolutePath); copy.dataset.copied = 'true'; copy.title = t(msg("sourceActions.copied", "绝对路径已拷贝")); notify(t(msg("sourceActions.copied", "绝对路径已拷贝"))); setTimeout(() => { delete copy.dataset.copied; if (!disposed) render(); }, 1600); }, 'ui.copy-path'); };
      action.onclick = () => {
        if (!source) return;
        if (!reveal) {
          const a = document.createElement('a'); a.href = mediaActionUrl(source.url, 'download', location.href); a.download = track!.name.split('/').at(-1)!; a.click(); return;
        }
        void act(async () => {
          const response = await fetch(mediaActionUrl(source.url, 'reveal', location.href), { method: 'POST', headers: { 'x-voidplayer-action': 'reveal' }, signal: signal() });
          if (!response.ok) throw new Error((await response.json()).error ?? t(msg("sourceActions.locateFailed", "文件定位失败")));
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

  const stopLanguage = onLanguageChange(() => { if (!disposed) { renderStatus(); render(); } }, lifetime.signal);
  window.addEventListener('online', () => void probe(), { signal: lifetime.signal });
  window.addEventListener('offline', () => void probe(), { signal: lifetime.signal });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void probe(); }, { signal: lifetime.signal });
  const timer = setInterval(() => { if (!document.hidden) { pending.clear(); void probe(); } }, 10000);
  void probe();
  return { render, dispose() { disposed = true; clearInterval(timer); stopLanguage(); lifetime.abort(); } };
}
