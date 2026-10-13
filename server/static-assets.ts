import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { serveFile, sendJson } from './http-utils.ts';

type Asset = { sha256: string; variants: Partial<Record<'br' | 'gzip', { suffix: string; sha256: string }>> };
const hashPattern = /^[a-f0-9]{64}$/;
function encodings(header: string | undefined) {
  const weights = new Map<string, number>();
  for (const part of (header ?? '').split(',')) {
    const [name, ...params] = part.trim().toLowerCase().split(';');
    const q = params.find(value => value.trim().startsWith('q='));
    const weight = q ? Number(q.trim().slice(2)) : 1;
    weights.set(name, Number.isFinite(weight) && weight >= 0 && weight <= 1 ? weight : 0);
  }
  return (name: string) => weights.get(name) ?? (name === 'identity' ? weights.get('*') === 0 ? 0 : 1 : weights.get('*') ?? 0);
}

/** Only build-listed static bytes can be immutable or use precompressed sidecars. */
export class StaticAssets {
  private directory: string;
  private manifest: Promise<Record<string, Asset>>;
  private verified = new Map<string, { key: string; result: Promise<boolean> }>();
  constructor(directory: string) {
    this.directory = directory;
    this.manifest = fs.readFile(path.join(directory, 'static-assets.json'), 'utf8').then(text => {
      const value = JSON.parse(text);
      return value.version === 1 && value.assets && typeof value.assets === 'object' ? value.assets : {};
    }).catch(() => ({}));
  }
  private async matches(file: string, digest: string) {
    if (!hashPattern.test(digest)) return false;
    const real = await fs.realpath(file).catch(() => null);
    if (!real || !real.startsWith(this.directory + path.sep)) return false;
    const stat = await fs.stat(real).catch(() => null);
    if (!stat?.isFile()) return false;
    const key = `${real}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${digest}`;
    const cached = this.verified.get(file);
    if (cached?.key === key) return cached.result;
    const result = fs.readFile(real).then(bytes => createHash('sha256').update(bytes).digest('hex') === digest, () => false);
    this.verified.set(file, { key, result }); return result;
  }
  async serve(req: IncomingMessage, res: ServerResponse, url: URL, file: string) {
    const name = '/' + path.relative(this.directory, file).split(path.sep).join('/');
    const entry = (await this.manifest)[name];
    const valid = entry && typeof entry.sha256 === 'string' && await this.matches(file, entry.sha256);
    const version = url.searchParams.get('v');
    if (version && name.startsWith('/vendor/') && (!valid || version !== entry.sha256)) {
      sendJson(res, 409, { error: '静态资源版本已改变，请刷新页面。' }); return;
    }
    const cacheControl = valid && (version === entry.sha256 || /^\/assets\/[^/]+-[\w-]+\.(?:js|css)$/.test(name))
      ? 'public, max-age=31536000, immutable' : 'no-cache';
    const quality = encodings(req.headers['accept-encoding']);
    let encoding: string | undefined, selected = file, etag = valid ? `"${entry.sha256}"` : undefined;
    if (valid && !req.headers.range) {
      const candidates = ['br', 'gzip', 'identity'] as const;
      for (const candidate of [...candidates].sort((a, b) => quality(b) - quality(a))) {
        if (quality(candidate) <= 0) continue;
        if (candidate === 'identity') break;
        const variant = entry.variants?.[candidate];
        const suffix = candidate === 'br' ? '.br' : '.gz';
        if (variant?.suffix !== suffix || !await this.matches(file + suffix, variant.sha256)) continue;
        selected = file + suffix; encoding = candidate; etag = `"${variant.sha256}"`; break;
      }
    }
    if (!encoding && quality('identity') <= 0) { sendJson(res, 406, { error: 'No acceptable static asset encoding' }); return; }
    await serveFile(req, res, file, undefined, undefined, { file: selected, etag, cacheControl, encoding });
  }
}
