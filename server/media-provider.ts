import { createHash } from 'node:crypto';
import { AdminError } from './admin-error.ts';

export interface ProviderConfig { endpoint: string; tokenEnv?: string }
export interface ProviderFile { objectId: string; revision: string; size: number; lastModified: number }
export type ProviderEntry = {kind:'directory'; name:string} | ({kind:'file'; name:string} & ProviderFile);
export interface ProviderSource extends ProviderFile { provider: ProviderConfig }
const invalid = () => new AdminError(502, '媒体适配器响应不符合 v1 协议。', 'provider-invalid-response');
export const PROVIDER_BLOCK = 1024 * 1024;

function validFile(f: ProviderFile) {
  return f && typeof f.objectId === 'string' && f.objectId.length > 0 && f.objectId.length <= 4096
    && typeof f.revision === 'string' && /^[A-Za-z0-9_-]{1,512}$/.test(f.revision)
    && Number.isSafeInteger(f.size) && f.size >= 0 && Number.isSafeInteger(f.lastModified) && f.lastModified >= 0;
}
export function providerVersion(provider: ProviderConfig, file: ProviderFile) {
  return createHash('sha256').update(JSON.stringify([provider.endpoint,file.objectId,file.revision,file.size])).digest('hex').slice(0,24);
}

async function request(config: ProviderConfig, operation: string, params: Record<string,string>, headers: Record<string,string>,
  signal: AbortSignal | undefined, consume: (response: Response) => Promise<Uint8Array>) {
  const url = new URL(config.endpoint + '/v1/' + operation);
  url.search = new URLSearchParams(params).toString();
  if (config.tokenEnv) {
    const token = process.env[config.tokenEnv];
    if (!token) throw new AdminError(503, '媒体适配器凭据未配置。', 'provider-auth');
    headers.authorization = 'Bearer ' + token;
  }
  const timeout = AbortSignal.timeout(15000);
  try {
    const response = await fetch(url, {headers, redirect:'error', signal:signal ? AbortSignal.any([signal,timeout]) : timeout});
    try {
      if (response.status === 404 || response.status === 412)
        throw new AdminError(response.status === 404 ? 404 : 409, '媒体对象不存在或版本已改变。', 'media-version-changed');
      if ([401,403].includes(response.status)) throw new AdminError(503, '媒体适配器拒绝读取。', 'provider-auth');
      if (!response.ok) throw new AdminError(503, '媒体适配器暂时不可用。', 'provider-unavailable');
      return await consume(response);
    } finally { await response.body?.cancel().catch(() => {}); }
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof AdminError) throw error;
    throw new AdminError(503, '媒体适配器读取失败。', 'provider-unavailable');
  }
}

async function boundedBody(response: Response, limit: number) {
  if (!response.body || Number(response.headers.get('content-length')) > limit) throw invalid();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.length;
      if (length > limit) throw invalid();
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks,length);
}
async function json(config: ProviderConfig, operation: string, params: Record<string,string>, signal?: AbortSignal) {
  const bytes = await request(config,operation,params,{},signal,async response => {
    if (response.status !== 200) throw invalid();
    return boundedBody(response,1024 * 1024);
  });
  try { return JSON.parse(Buffer.from(bytes).toString('utf8')); } catch { throw invalid(); }
}
export async function* listProvider(config: ProviderConfig, directory: string, signal: AbortSignal) {
  const cursors = new Set<string>(), names = new Set<string>();
  let cursor = '';
  do {
    const page = await json(config,'list',{directory,limit:'128',...(cursor ? {cursor} : {})},signal);
    if (!page || !Array.isArray(page.entries) || page.entries.length > 128 || !(page.nextCursor === null
      || (typeof page.nextCursor === 'string' && page.nextCursor.length > 0 && page.nextCursor.length <= 4096))) throw invalid();
    for (const entry of page.entries as ProviderEntry[]) {
      if (!entry || typeof entry.name !== 'string' || !entry.name || entry.name.length > 255
        || /[/\\\x00-\x1f]/.test(entry.name) || ['.','..'].includes(entry.name) || names.has(entry.name)
        || !(entry.kind === 'directory' || (entry.kind === 'file' && validFile(entry)))) throw invalid();
      names.add(entry.name);
    }
    cursor = page.nextCursor;
    if (cursor && (cursors.has(cursor) || !page.entries.length)) throw invalid();
    if (cursor) cursors.add(cursor);
    yield page.entries as ProviderEntry[];
  } while (cursor);
}
export async function verifyProvider(source: ProviderSource, signal?: AbortSignal) {
  const file = await json(source.provider,'stat',{objectId:source.objectId},signal) as ProviderFile;
  if (!validFile(file)) throw invalid();
  if (file.objectId !== source.objectId || file.revision !== source.revision || file.size !== source.size)
    throw new AdminError(409, '媒体对象的内容版本已改变。', 'media-version-changed');
}
export async function readProvider(source: ProviderSource, offset: number, length: number, signal?: AbortSignal) {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || length > 64*1024*1024
    || offset > source.size - length) throw new RangeError('Invalid provider byte range');
  const bytes = new Uint8Array(length);
  for (let filled = 0; filled < length;) {
    const start = offset + filled, count = Math.min(PROVIDER_BLOCK,length - filled), end = start + count - 1;
    const etag = '"' + source.revision + '"';
    const part = await request(source.provider,'content',{objectId:source.objectId},{range:`bytes=${start}-${end}`,'if-match':etag,'accept-encoding':'identity'},signal,
      async response => {
        const encoding = response.headers.get('content-encoding');
        if (response.status !== 206 || (encoding && encoding !== 'identity') || response.headers.get('etag') !== etag
          || response.headers.get('content-range') !== `bytes ${start}-${end}/${source.size}`) throw invalid();
        const body = await boundedBody(response,count);
        if (body.length !== count) throw invalid();
        return body;
      });
    bytes.set(part,filled);
    filled += count;
  }
  return bytes;
}
