import { AdminError } from './admin-error.ts';
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

/** An optional captured identity is an expectation, never a replacement for the
 * request cookie. Check before reading private facts or accepting side effects;
 * browser identity notifications can arrive after another window changed it. */
export function requireCapturedActor(req:IncomingMessage,actor:Actor|null){
  const expected=req.headers['x-voidplayer-actor'];
  if(expected!==undefined&&expected!==actor?.id)throw new AdminError(409,
    'The service identity changed; this captured request was not applied.', 'actor-changed');
}
