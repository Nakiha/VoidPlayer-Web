import 'reflect-metadata';
import { X509CertificateGenerator, BasicConstraintsExtension, KeyUsagesExtension, KeyUsageFlags,
  ExtendedKeyUsageExtension, SubjectAlternativeNameExtension, SubjectKeyIdentifierExtension, AuthorityKeyIdentifierExtension } from '@peculiar/x509';
import { X509Certificate, createPrivateKey, randomBytes, randomUUID, webcrypto } from 'node:crypto';
import { isIP } from 'node:net';
import { readFile, writeFile, mkdir, rename, link, rm } from 'node:fs/promises';
import path from 'node:path';
import type { IncomingMessage } from 'node:http';

export type TlsConfig = { hosts: string[] } | { certFile: string; keyFile: string };
export const encryptedRequest = (req: IncomingMessage) => (req.socket as { encrypted?: boolean }).encrypted === true;
export function tlsHost(value: string) {
  const host = value.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host || host.length > 253 || (!isIP(host) && !host.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) || ['0.0.0.0', '::'].includes(host)) {
    throw new Error('HTTPS 地址必须是浏览器实际访问的 IP 或域名，不带协议、端口或路径。');
  }
  return host;
}
export function parseTls(value: unknown, base: string): TlsConfig | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('tls 必须是对象或 null。');
  const input = value as Record<string, unknown>;
  if (Array.isArray(input.hosts) && Object.keys(input).every(k => k === 'hosts') && input.hosts.length > 0 && input.hosts.length <= 32 && input.hosts.every(h => typeof h === 'string')) {
    return { hosts: [...new Set(input.hosts.map(h => tlsHost(h)))] };
  }
  if (Object.keys(input).every(k => ['certFile', 'keyFile'].includes(k)) && typeof input.certFile === 'string' && input.certFile.trim() && typeof input.keyFile === 'string' && input.keyFile.trim()) {
    return { certFile: path.resolve(base, input.certFile), keyFile: path.resolve(base, input.keyFile) };
  }
  throw new Error('tls 请设置 hosts 地址列表，或同时设置 certFile 与 keyFile。');
}

const crypto = webcrypto as unknown as Crypto;
const algorithm = { name: 'ECDSA', namedCurve: 'P-256' };
const signingAlgorithm = { name: 'ECDSA', hash: 'SHA-256' };
const day = 86400000;
const serial = () => `01${randomBytes(15).toString('hex')}`;
const pem = (type: string, bytes: ArrayBuffer) => `-----BEGIN ${type}-----\n${Buffer.from(bytes).toString('base64').match(/.{1,64}/g)!.join('\n')}\n-----END ${type}-----\n`;
async function readOptional(file: string) {
  try { return await readFile(file, 'utf8'); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; }
}
async function atomicWrite(file: string, text: string, exclusive = false) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, text, { flag: 'wx', mode: 0o600 });
    if (exclusive) await link(temporary, file); else await rename(temporary, file);
  } finally { await rm(temporary, { force: true }); }
}
function checkPair(cert: string, key: string) {
  const parsed = new X509Certificate(cert);
  if (!parsed.checkPrivateKey(createPrivateKey(key))) throw new Error('TLS 证书与私钥不匹配。');
  if (Date.parse(parsed.validFrom) > Date.now() || Date.parse(parsed.validTo) <= Date.now()) throw new Error('TLS 证书尚未生效或已过期。');
  return parsed;
}

/** Generates certificates inside data/tls, with no openssl or system trust-store writes. */
export async function prepareTls(config: TlsConfig, dataDir: string) {
  if ('certFile' in config) {
    const [cert, key] = await Promise.all([readFile(config.certFile, 'utf8'), readFile(config.keyFile, 'utf8')]);
    checkPair(cert, key);
    return { cert, key, ca: undefined as string | undefined, caFile: undefined as string | undefined, fingerprint: new X509Certificate(cert).fingerprint256, hosts: [] as string[] };
  }
  const hosts = [...new Set([...config.hosts.map(tlsHost), 'localhost', '127.0.0.1', '::1'])].sort();
  const directory = path.join(dataDir, 'tls');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const authorityFile = path.join(directory, 'authority.json');
  if (await readOptional(authorityFile) === null) {
    const keys = await crypto.subtle.generateKey(algorithm, true, ['sign', 'verify']);
    const cert = await X509CertificateGenerator.createSelfSigned({ name: `CN=VoidPlayer Local CA ${randomBytes(6).toString('hex')}`,
      keys, serialNumber: serial(), signingAlgorithm, notBefore: new Date(Date.now() - day), notAfter: new Date(Date.now() + 3650 * day),
      extensions: [new BasicConstraintsExtension(true, 0, true), new KeyUsagesExtension(KeyUsageFlags.keyCertSign | KeyUsageFlags.cRLSign, true), await SubjectKeyIdentifierExtension.create(keys.publicKey, false, crypto)],
    }, crypto);
    const authority = { cert: cert.toString('pem'), key: pem('PRIVATE KEY', await crypto.subtle.exportKey('pkcs8', keys.privateKey)) };
    try { await atomicWrite(authorityFile, JSON.stringify(authority), true); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
  }
  // Never silently replace an existing authority: clients already trust its fingerprint.
  const authority = JSON.parse((await readFile(authorityFile, 'utf8'))) as { cert: string; key: string };
  const ca = checkPair(authority.cert, authority.key);
  if (!ca.ca || !ca.verify(ca.publicKey)) throw new Error('本地 TLS CA 无效，请检查 data/tls/authority.json。');
  const caFile = path.join(directory, 'voidplayer-ca.crt');
  await atomicWrite(caFile, authority.cert);
  const leafFile = path.join(directory, 'server.json');
  const previous = await readOptional(leafFile);
  let leaf: { cert: string; key: string; hosts: string[] } | null = previous ? JSON.parse(previous) : null;
  if (leaf) {
    const cert = new X509Certificate(leaf.cert);
    if (JSON.stringify(leaf.hosts) !== JSON.stringify(hosts) || Date.parse(cert.validTo) - Date.now() < 7 * day || !cert.verify(ca.publicKey)) leaf = null;
    else checkPair(leaf.cert, leaf.key);
  }
  if (!leaf) {
    const keys = await crypto.subtle.generateKey(algorithm, true, ['sign', 'verify']);
    const signingKey = await crypto.subtle.importKey('pkcs8', createPrivateKey(authority.key).export({ format: 'der', type: 'pkcs8' }), algorithm, false, ['sign']);
    const cert = await X509CertificateGenerator.create({ subject: 'CN=VoidPlayer', issuer: ca.subject.replaceAll('\n', ','), publicKey: keys.publicKey,
      signingKey, signingAlgorithm, serialNumber: serial(), notBefore: new Date(Date.now() - day), notAfter: new Date(Math.min(Date.now() + 90 * day, Date.parse(ca.validTo))),
      extensions: [new BasicConstraintsExtension(false, undefined, true), new KeyUsagesExtension(KeyUsageFlags.digitalSignature, true),
        new ExtendedKeyUsageExtension(['1.3.6.1.5.5.7.3.1']), new SubjectAlternativeNameExtension(hosts.map(value => ({ type: isIP(value) ? 'ip' as const : 'dns' as const, value }))),
        await SubjectKeyIdentifierExtension.create(keys.publicKey, false, crypto), await AuthorityKeyIdentifierExtension.create(ca.publicKey.export({ format: 'der', type: 'spki' }), false, crypto)],
    }, crypto);
    leaf = { cert: cert.toString('pem'), key: pem('PRIVATE KEY', await crypto.subtle.exportKey('pkcs8', keys.privateKey)), hosts };
    await atomicWrite(leafFile, JSON.stringify(leaf));
  }
  return { cert: leaf.cert, key: leaf.key, ca: authority.cert, caFile, fingerprint: ca.fingerprint256, hosts };
}
