import { requestAuthority } from './http.ts';
import type { IncomingMessage } from './http.ts';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { clientAddress } from './client-address.ts';
export { setClientAddress } from './client-address.ts';

export const isLoopback = (host: string) => ['localhost', '127.0.0.1', '::1', '[::1]', '::ffff:127.0.0.1'].includes(host);

/** A remote browser must never open a file manager on the server's desktop. */
export function localRequest(req: IncomingMessage) {
  try {
    return isLoopback(clientAddress(req)) && isLoopback(new URL(`http://${requestAuthority(req)}`).hostname);
  } catch { return false; }
}

export function allowReveal(req: IncomingMessage) {
  if (!localRequest(req) || req.headers['x-voidplayer-action'] !== 'reveal') return false;
  try { return isLoopback(new URL(req.headers.origin ?? '').hostname); } catch { return false; }
}

export async function revealFile(absolutePath: string) {
  const run = promisify(execFile);
  if (process.platform === 'darwin') await run('/usr/bin/open', ['-R', absolutePath]);
  else if (process.platform === 'win32') await run('explorer.exe', ['/select,', absolutePath]);
  else throw new Error('此服务器未提供文件管理器定位。');
}
