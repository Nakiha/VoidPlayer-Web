import { isIP } from 'node:net';
import type { IncomingMessage } from './http.ts';

const peers = new WeakMap<IncomingMessage,string>();
export const setClientAddress = (req: IncomingMessage, address: string) => peers.set(req,address);
/** Only the transport and the built-in gateway supply peer identity; request headers never do. */
export const clientAddress = (req: IncomingMessage) => peers.get(req) ?? req.socket.remoteAddress ?? '';

export function clientIp(req: IncomingMessage): string | null {
  const address = clientAddress(req).toLowerCase();
  const ipv4 = address.startsWith('::ffff:') ? address.slice(7) : '';
  if (isIP(ipv4) === 4) return ipv4;
  return isIP(address) ? address : null;
}
