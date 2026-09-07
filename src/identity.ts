export type Actor = { id: string; name: string };
type Health = { service: string; actor: Actor | null; capabilities?: { admin?: boolean; workspaces?: boolean; reveal?: boolean } };
let actor: Actor | null = null;
let pending: Promise<Health> | undefined;
let queue: Promise<unknown> = Promise.resolve();
export const currentActor = () => actor;
function remember(next: Actor | null) {
  if (actor?.id === next?.id && actor?.name === next?.name) return;
  const previous = actor; actor = next;
  try { localStorage.setItem('voidplayer.identity', JSON.stringify(actor)); } catch {}
  window.dispatchEvent(new CustomEvent('voidplayer-identity-change', { detail: { actor, previous } }));
}
function serialize<T>(run: () => Promise<T>): Promise<T> {
  const result = queue.then(run); queue = result.catch(() => {}); return result;
}
export function identityHealth(): Promise<Health> {
  return pending ??= serialize(async () => {
    const response = await fetch('/api/health', { cache: 'no-store', signal: AbortSignal.timeout(4000) });
    const health = await response.json() as Health;
    if (!response.ok || health.service !== 'voidplayer-media') throw new Error('媒体服务未连接。');
    remember(health.actor); return health;
  }).finally(() => { pending = undefined; });
}
export function chooseIdentity(input: { name: string } | { id: string }): Promise<Actor> {
  return serialize(async () => {
    const response = await fetch('/api/identity', { method: 'POST', headers: { 'content-type': 'application/json', 'x-voidplayer-action': 'identity' }, body: JSON.stringify(input), signal: AbortSignal.timeout(10000) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? '用户名设置失败。');
    remember(result.actor);
    return result.actor;
  });
}
