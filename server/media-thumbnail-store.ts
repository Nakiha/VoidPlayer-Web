// Server-side first-frame thumbnail cache. Small JPEG BLOBs in library.sqlite,
// keyed by (media_id, media_version, stream_selector, recipe_version) with a
// unique constraint: the first valid submission wins, later ones dedupe.
// An independent thumbnailEpoch rejects uploads accepted before a clear.
// Reads never decode, scan or schedule work: GET is strictly read-only.

import type { IndexDatabase } from './sqlite.ts';
import { AdminError } from './admin-error.ts';
import {
  THUMB_CACHE_LIMIT_BYTES, THUMB_MAX_BYTES, validateThumbnailImage,
} from '../src/thumbnails/contract.ts';

const ID_PATTERN = /^[0-9a-f]{24}$/;
const RECIPE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9;._-]{0,127}$/;
const SELECTOR_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const STREAM_SELECTOR = 'main-v1';

export interface ThumbnailRow {
  data: Buffer;
  mime: string;
  width: number;
  height: number;
  bytes: number;
  sourcePtsUs: number;
  createdAt: number;
}

function checkId(id: string) {
  if (!ID_PATTERN.test(id)) throw new AdminError(400, '媒体 ID 无效。');
}

function checkVersion(version: string | null): string {
  if (!version || !ID_PATTERN.test(version)) throw new AdminError(400, '缩略图需要媒体版本。');
  return version;
}

function checkRecipe(recipe: string | null): string {
  if (!recipe || !RECIPE_PATTERN.test(recipe)) throw new AdminError(400, '缩略图 recipe 无效。');
  return recipe;
}

export class MediaThumbnailStore {
  private db: IndexDatabase;
  constructor(db: IndexDatabase) { this.db = db; }

  get epoch(): number {
    return Number(this.db.prepare('SELECT epoch FROM thumbnail_epoch WHERE id=1').get()!.epoch);
  }

  get limitBytes(): number { return THUMB_CACHE_LIMIT_BYTES; }

  /** Metadata only; never loads image BLOBs. Missing never triggers work. */
  status(id: string, version: string, recipe: string): { epoch: number; ready: boolean; width?: number; height?: number } {
    checkId(id); checkVersion(version); checkRecipe(recipe);
    const epoch = this.epoch;
    const row = this.db.prepare(
      'SELECT width,height FROM media_thumbnails WHERE media_id=? AND media_version=? AND stream_selector=? AND recipe_version=?',
    ).get(id, version, STREAM_SELECTOR, recipe) as { width: number; height: number } | undefined;
    return row ? { epoch, ready: true, width: Number(row.width), height: Number(row.height) } : { epoch, ready: false };
  }

  /** Image bytes with accessed_at refresh. Authorization must match source media. */
  get(id: string, version: string, recipe: string): ThumbnailRow | null {
    checkId(id); checkVersion(version); checkRecipe(recipe);
    const row = this.db.prepare(
      'SELECT data,mime,width,height,bytes,source_pts_us AS sourcePtsUs,created_at AS createdAt FROM media_thumbnails WHERE media_id=? AND media_version=? AND stream_selector=? AND recipe_version=?',
    ).get(id, version, STREAM_SELECTOR, recipe) as
      { data: Buffer; mime: string; width: number; height: number; bytes: number; sourcePtsUs: number; createdAt: number } | undefined;
    if (!row) return null;
    this.db.prepare('UPDATE media_thumbnails SET accessed_at=? WHERE media_id=? AND media_version=? AND stream_selector=? AND recipe_version=?')
      .run(Date.now(), id, version, STREAM_SELECTOR, recipe);
    return { ...row, width: Number(row.width), height: Number(row.height), bytes: Number(row.bytes), sourcePtsUs: Number(row.sourcePtsUs), createdAt: Number(row.createdAt) };
  }

  /** Batch readiness for browse pages: exact (id, version) matches only. */
  readyKeys(ids: string[], recipe: string): Set<string> {
    if (!ids.length) return new Set();
    checkRecipe(recipe);
    const valid = ids.filter(id => ID_PATTERN.test(id));
    if (!valid.length) return new Set();
    const placeholders = valid.map(() => '?').join(',');
    const rows = this.db.prepare(
      `SELECT media_id AS id,media_version AS version FROM media_thumbnails WHERE recipe_version=? AND stream_selector=? AND media_id IN (${placeholders})`,
    ).all(recipe, STREAM_SELECTOR, ...valid) as { id: string; version: string }[];
    return new Set(rows.map(row => `${row.id}|${row.version}`));
  }

  /**
   * Atomic check-and-write: epoch/version validation and the insert happen in
   * one transaction, so a concurrent clear cannot leave a pre-clear image.
   * Same key: first valid submission wins, repeats dedupe without overwrite.
   */
  put(id: string, version: string, recipe: string, epoch: unknown, bytes: Uint8Array, meta: { width: unknown; height: unknown; sourcePtsUs: unknown }) {
    checkId(id); checkVersion(version); checkRecipe(recipe);
    if (!Number.isSafeInteger(epoch)) throw new AdminError(400, '缩略图上传需要缓存 epoch。');
    const width = meta.width, height = meta.height, sourcePtsUs = meta.sourcePtsUs;
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || !Number.isSafeInteger(sourcePtsUs) ||
      (width as number) < 1 || (height as number) < 1 || (sourcePtsUs as number) < 0) {
      throw new AdminError(400, '缩略图元数据无效。');
    }
    if (bytes.length === 0 || bytes.length > THUMB_MAX_BYTES) throw new AdminError(413, '图片超过单张上限。');
    const checked = validateThumbnailImage(bytes, width as number, height as number);
    if ('error' in checked) throw new AdminError(400, checked.error);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (epoch !== this.epoch) throw new AdminError(409, '缩略图缓存已被清理，请在下次载入时重新提交。');
      const media = this.db.prepare(
        "SELECT 1 FROM media JOIN roots ON media.root_id=roots.id WHERE media.id=? AND version=? AND media.state='ready' AND roots.active=1",
      ).get(id, version);
      if (!media) throw new AdminError(409, '媒体不可用或已改变。');
      const now = Date.now();
      const result = this.db.prepare(
        'INSERT OR IGNORE INTO media_thumbnails(media_id,media_version,stream_selector,recipe_version,source_pts_us,width,height,mime,bytes,data,created_at,accessed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
      ).run(id, version, STREAM_SELECTOR, recipe, sourcePtsUs as number, checked.width, checked.height,
        'image/jpeg', bytes.length, Buffer.from(bytes), now, now);
      if (result.changes === 0) { this.db.exec('COMMIT'); return { ok: true, deduped: true }; }
      let total = Number(this.db.prepare('SELECT coalesce(sum(bytes),0) AS bytes FROM media_thumbnails').get()!.bytes);
      while (total > THUMB_CACHE_LIMIT_BYTES) {
        const oldest = this.db.prepare('SELECT media_id,media_version,bytes FROM media_thumbnails ORDER BY accessed_at,media_id LIMIT 1').get() as
          { media_id: string; media_version: string; bytes: number } | undefined;
        if (!oldest) break;
        this.db.prepare('DELETE FROM media_thumbnails WHERE media_id=? AND media_version=? AND stream_selector=? AND recipe_version=?')
          .run(oldest.media_id, oldest.media_version, STREAM_SELECTOR, recipe);
        total -= Number(oldest.bytes);
      }
      this.db.exec('COMMIT');
      return { ok: true };
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch {}
      throw error;
    }
  }

  overview() {
    const total = this.db.prepare('SELECT count(*) AS count,coalesce(sum(bytes),0) AS bytes FROM media_thumbnails').get()!;
    return { count: Number(total.count), bytes: Number(total.bytes), limitBytes: THUMB_CACHE_LIMIT_BYTES, epoch: this.epoch };
  }

  list(offset = 0, search = '') {
    if (!Number.isSafeInteger(offset) || offset < 0 || typeof search !== 'string' || search.length > 200) {
      throw new AdminError(400, '缩略图分页或搜索参数无效。');
    }
    const total = this.db.prepare('SELECT count(*) AS count,coalesce(sum(bytes),0) AS bytes FROM media_thumbnails').get()!;
    const rows = this.db.prepare(
      `SELECT t.media_id AS id,t.media_version AS version,t.recipe_version AS recipe,t.width,t.height,t.bytes,t.created_at AS createdAt,m.path AS name,r.name AS root
       FROM media_thumbnails t JOIN media m ON m.id=t.media_id JOIN roots r ON r.id=m.root_id
       WHERE instr(lower(m.path),lower(?))>0 ORDER BY t.created_at DESC,t.media_id LIMIT 51 OFFSET ?`,
    ).all(search, offset);
    return { entries: rows.slice(0, 50), nextOffset: rows.length > 50 ? offset + 50 : null, count: Number(total.count), bytes: Number(total.bytes), limitBytes: THUMB_CACHE_LIMIT_BYTES, epoch: this.epoch };
  }

  remove(id?: string, version?: string) {
    if (id !== undefined || version !== undefined) {
      if (!id || !ID_PATTERN.test(id) || !version || !ID_PATTERN.test(version)) throw new AdminError(400, '清理单个缩略图需要媒体 ID 和版本。');
    }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const removed = id
        ? this.db.prepare('DELETE FROM media_thumbnails WHERE media_id=? AND media_version=?').run(id, version!)
        : this.db.prepare('DELETE FROM media_thumbnails').run();
      // Single-item clears also advance the global epoch so other in-flight
      // uploads fail closed; documented phase-1 simplification.
      this.db.exec('UPDATE thumbnail_epoch SET epoch=epoch+1 WHERE id=1');
      this.db.exec('COMMIT');
      return { removed: Number(removed.changes) };
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch {}
      throw error;
    }
  }
}

export { STREAM_SELECTOR as THUMBNAIL_STREAM_SELECTOR };
export { SELECTOR_PATTERN as THUMBNAIL_SELECTOR_PATTERN };
