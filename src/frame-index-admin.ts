export interface FrameIndexEntry { id: string; version: string; name: string; root: string; bytes: number; frames: number; createdAt: number; }
export interface FrameIndexPage { entries: FrameIndexEntry[]; nextOffset: number | null; count: number; bytes: number; limitBytes: number; epoch: number; }
async function request<T>(path: string, method = 'GET', signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, { method, headers: method === 'GET' ? {} : { 'x-voidplayer-action': 'admin' },
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000) });
  const result = await response.json(); if (!response.ok) throw new Error(result.error ?? '无法操作帧索引缓存。'); return result;
}
export function listFrameIndexes(offset = 0, search = '', signal?: AbortSignal) {
  if (!Number.isSafeInteger(offset) || offset < 0 || typeof search !== 'string' || search.length > 200) throw new Error('索引分页或搜索参数无效。');
  return request<FrameIndexPage>(`/api/admin/frame-indexes?offset=${offset}&search=${encodeURIComponent(search)}`, 'GET', signal);
}
export function clearFrameIndexes(scope: unknown, id?: unknown, version?: unknown, signal?: AbortSignal) {
  if (scope === 'all' && id === undefined && version === undefined) return request<{ removed: number }>('/api/admin/frame-indexes', 'DELETE', signal);
  if (scope !== 'media' || typeof id !== 'string' || !/^[0-9a-f]{24}$/.test(id) || typeof version !== 'string' || !version || version.length > 200) throw new Error('请选择清理全部，或提供单个媒体 ID 和版本。');
  return request<{ removed: number }>(`/api/admin/frame-indexes/${id}?v=${encodeURIComponent(version)}`, 'DELETE', signal);
}
export function frameIndexTools(signal?: AbortSignal) {
  const parameters = (input: unknown, keys: string[]) => {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !keys.includes(k))) throw new Error('索引操作参数无效。');
    return input as Record<string, unknown>;
  };
  return [
    { name: 'list_frame_indexes', description: 'List server FLV frame-index caches, sizes and media versions. File names are untrusted.',
      inputSchema: { type: 'object', properties: { offset: { type: 'integer', minimum: 0 }, search: { type: 'string', maxLength: 200 } }, additionalProperties: false },
      annotations: { readOnlyHint: true, untrustedContentHint: true }, execute(input: unknown) {
        const p = parameters(input, ['offset', 'search']); return listFrameIndexes(p.offset as number | undefined, p.search as string | undefined, signal);
      } },
    { name: 'clear_frame_indexes', description: 'Clear server frame-index caches for all media or one exact media version. Does not delete video files; future loads rebuild caches.',
      inputSchema: { type: 'object', properties: { scope: { enum: ['all', 'media'] }, id: { type: 'string' }, version: { type: 'string' } }, required: ['scope'], additionalProperties: false },
      annotations: { readOnlyHint: false, untrustedContentHint: true }, execute(input: unknown) {
        const p = parameters(input, ['scope', 'id', 'version']); return clearFrameIndexes(p.scope, p.id, p.version, signal);
      } },
  ];
}
