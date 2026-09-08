import type { IncomingMessage } from 'node:http';

export type Actor = { id: string; name: string; kind?: 'named' | 'guest' };
export function guestActor(id: string | undefined): Actor | null {
  return id && /^guest-[a-f0-9-]{36}$/.test(id) ? { id, name: '访客', kind: 'guest' } : null;
}
/** Persistent browser identity; deliberately unsigned in this trusted intranet model. */
export function browserUserId(req: IncomingMessage): string | undefined {
  const value = req.headers.cookie?.split(';').map(part => part.trim()).find(part => part.startsWith('voidplayer-user='))?.slice(16);
  try { return value ? decodeURIComponent(value) : undefined; } catch { return undefined; }
}
export function identityCookie(actor: Actor, secure = false): string {
  return `voidplayer-user=${encodeURIComponent(actor.id)}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
}
