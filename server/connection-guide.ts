import { X509Certificate } from 'node:crypto';
import { isIP } from 'node:net';

export interface ConnectionOptions { port: number; cert: string; ca?: string; hosts: string[]; fingerprint: string; }
export function connectionDetails(options?: ConnectionOptions, host = '') {
  if (!options) return { httpsUrl: null, certificateUrl: null, fingerprint: null, configured: false };
  const cert = new X509Certificate(options.cert);
  let requested = '';
  try { requested = new URL(`http://${host}`).hostname.replace(/^\[|\]$/g, ''); } catch {}
  const matches = (value: string) => value && (isIP(value) ? cert.checkIP(value) : cert.checkHost(value));
  const candidates = [requested, ...options.hosts.filter(h => !['localhost', '127.0.0.1', '::1'].includes(h)), ...options.hosts];
  const address = candidates.find(matches);
  return {
    configured: true,
    httpsUrl: address ? `https://${address.includes(':') ? `[${address}]` : address}:${options.port}/` : null,
    certificateUrl: options.ca ? '/api/connection/certificate' : null,
    fingerprint: options.ca ? options.fingerprint : null,
  };
}
