import { stat, statfs } from 'node:fs/promises';
import path from 'node:path';
import type { FrameIndexStore } from './frame-index-store.ts';
import type { AnnotationStore } from './annotations.ts';
import { AdminError } from './admin-error.ts';

export type CacheKind = 'frame-indexes' | 'annotation-previews';
export type CacheEntry = { id: string; version: string; scope?: string; name: string; detail: string; bytes: number; updatedAt: number; previewUrl?: string };
export class CacheManager {
  private directory: string; private frames: FrameIndexStore; private annotations: AnnotationStore;
  constructor(directory: string, frames: FrameIndexStore, annotations: AnnotationStore) { this.directory=directory; this.frames=frames; this.annotations=annotations; }
  async overview() {
    const frames = this.frames.list(), previews = this.annotations.previewList();
    const definitions = [
      { kind: 'frame-indexes' as const, name: '帧索引', count: frames.count, bytes: frames.bytes, limitBytes: frames.limitBytes, file: 'library.sqlite', table: 'frame_indexes' },
      { kind: 'annotation-previews' as const, name: '标注预览', count: previews.count, bytes: previews.bytes, limitBytes: previews.limitBytes, file: 'annotations.sqlite', table: 'annotation_previews' },
    ];
    const types = await Promise.all(definitions.map(async ({ file, ...definition }) => {
      const location = path.join(this.directory, file);
      const sizes = await Promise.all([location, `${location}-wal`].map(async file => {
        try { return (await stat(file)).size; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0; throw error; }
      }));
      return { ...definition, location, databaseBytes: sizes[0]!, journalBytes: sizes[1]!, shared: true };
    }));
    let volume: { totalBytes: number; availableBytes: number; usedBytes: number } | null = null;
    try { const disk = await statfs(this.directory); const totalBytes = disk.blocks * disk.bsize, availableBytes = disk.bavail * disk.bsize;
      if (totalBytes > 0) volume = { totalBytes, availableBytes, usedBytes: Math.max(0, totalBytes - disk.bfree * disk.bsize) };
    } catch { /* Network and virtual filesystems may not expose disk capacity. */ }
    return { directory: this.directory, volume, types, bytes: types.reduce((sum, type) => sum + type.bytes, 0), count: types.reduce((sum, type) => sum + type.count, 0) };
  }
  list(kind: string, offset = 0, search = '') {
    if (kind === 'frame-indexes') {
      const page = this.frames.list(offset, search);
      return { ...page, entries: page.entries.map(row => ({ id: String(row.id), version: String(row.version), name: String(row.name), detail: `${row.root} · ${row.frames} 帧`, bytes: Number(row.bytes), updatedAt: Number(row.createdAt) } satisfies CacheEntry)) };
    }
    if (kind === 'annotation-previews') return this.annotations.previewList(offset, search);
    throw new AdminError(400, '缓存类型无效。');
  }
  remove(kind: string, value: unknown) {
    if (!value || typeof value !== 'object') throw new AdminError(400, '清理范围无效。');
    const input = value as { all?: unknown; id?: unknown; version?: unknown; scope?: unknown };
    if (input.all === true) {
      if (kind === 'frame-indexes') return this.frames.remove();
      if (kind === 'annotation-previews') return this.annotations.clearPreviews();
    } else if (typeof input.id === 'string' && typeof input.version === 'string') {
      if (kind === 'frame-indexes') return this.frames.remove(input.id, input.version);
      if (kind === 'annotation-previews' && typeof input.scope === 'string') return this.annotations.removePreview(input.scope, input.id, Number(input.version));
    }
    throw new AdminError(400, '请指定缓存类型及清理范围。');
  }
}
