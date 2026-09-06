import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

export type Actor = { id: string; name: string };
/** Only the authenticated gateway may set identity. Never trust browser headers alone. */
export function requestActor(req: IncomingMessage, proxyToken?: string): Actor | null {
  if (!proxyToken) return null;
  const provided = req.headers['x-voidplayer-proxy-token'];
  const user = req.headers['x-voidplayer-user'];
  if (typeof provided !== 'string' || typeof user !== 'string' || !/^[a-zA-Z0-9_.@-]{1,128}$/.test(user)) return null;
  const expected = Buffer.from(proxyToken), actual = Buffer.from(provided);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  return { id: user, name: user };
}
