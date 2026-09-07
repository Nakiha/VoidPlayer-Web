import type { IndexDatabase } from './sqlite.ts';
import { AdminError } from './admin-error.ts';
import { FLV_INDEX_BYTES, FLV_INDEX_SCHEMA, parseFlvIndex, serializeFlvIndex } from '../src/flv-index-cache.ts';
import type { FlvIndexDocument } from '../src/flv-index-cache.ts';

const CACHE_LIMIT = 256 * 1024 * 1024;
export class FrameIndexStore {
  private db: IndexDatabase;
  constructor(db: IndexDatabase) { this.db = db; }
  get epoch(): number { return Number(this.db.prepare('SELECT epoch FROM frame_index_epoch WHERE id=1').get()!.epoch); }
  get(id: string, version: string): { epoch: number; index: FlvIndexDocument | null } {
    const row = this.db.prepare('SELECT document FROM frame_indexes WHERE media_id=? AND version=?').get(id, version);
    let index: FlvIndexDocument | null = null;
    if (row) {
      try { index = JSON.parse(String(row.document)); } catch { /* discard an unreadable cache */ }
      if (index?.schema !== FLV_INDEX_SCHEMA) { this.db.prepare('DELETE FROM frame_indexes WHERE media_id=?').run(id); index = null; }
      else this.db.prepare('UPDATE frame_indexes SET accessed_at=? WHERE media_id=?').run(Date.now(), id);
    }
    return { epoch: this.epoch, index };
  }
  put(id: string, version: string, size: number, value: unknown, epoch: unknown) {
    if (epoch !== this.epoch) throw new AdminError(409, '索引缓存已被清理，请在下次载入时重新提交。');
    let document: FlvIndexDocument;
    try { document = serializeFlvIndex(parseFlvIndex(value, size), size); }
    catch (error) { throw new AdminError(400, (error as Error).message); }
    const text = JSON.stringify(document), bytes = Buffer.byteLength(text);
    if (bytes > FLV_INDEX_BYTES) throw new AdminError(413, '帧索引过大。');
    const media = this.db.prepare("SELECT 1 FROM media JOIN roots ON media.root_id=roots.id WHERE media.id=? AND version=? AND media.state='ready' AND roots.active=1").get(id, version);
    if (!media) throw new AdminError(409, '媒体已改变，未保存旧索引。');
    // First complete upload wins; concurrent clients cannot replace a cache.
    const now = Date.now();
    this.db.prepare('INSERT OR IGNORE INTO frame_indexes(media_id,version,document,bytes,frames,created_at,accessed_at) VALUES(?,?,?,?,?,?,?)')
      .run(id, version, text, bytes, document.packets.length, now, now);
    let total = Number(this.db.prepare('SELECT coalesce(sum(bytes),0) AS bytes FROM frame_indexes').get()!.bytes);
    while (total > CACHE_LIMIT) {
      const oldest = this.db.prepare('SELECT media_id,bytes FROM frame_indexes ORDER BY accessed_at,media_id LIMIT 1').get()!;
      this.db.prepare('DELETE FROM frame_indexes WHERE media_id=?').run(oldest.media_id); total -= Number(oldest.bytes);
    }
    return { ok: true };
  }
  list(offset = 0, search = '') {
    if (!Number.isSafeInteger(offset) || offset < 0 || typeof search !== 'string' || search.length > 200) throw new AdminError(400, '索引分页或搜索参数无效。');
    const total = this.db.prepare('SELECT count(*) AS count,coalesce(sum(bytes),0) AS bytes FROM frame_indexes').get()!;
    const rows = this.db.prepare(`SELECT f.media_id AS id,f.version,m.path AS name,r.name AS root,f.bytes,f.frames,f.created_at AS createdAt
      FROM frame_indexes f JOIN media m ON m.id=f.media_id JOIN roots r ON r.id=m.root_id
      WHERE instr(lower(m.path),lower(?))>0 ORDER BY f.created_at DESC,f.media_id LIMIT 51 OFFSET ?`).all(search, offset);
    return { entries: rows.slice(0, 50), nextOffset: rows.length > 50 ? offset + 50 : null, count: Number(total.count), bytes: Number(total.bytes), limitBytes: CACHE_LIMIT, epoch: this.epoch };
  }
  remove(id?: string, version?: string) {
    if (id && (!/^[0-9a-f]{24}$/.test(id) || !version)) throw new AdminError(400, '清理单个索引需要媒体 ID 和版本。');
    if (id && this.db.prepare('SELECT 1 FROM frame_indexes WHERE media_id=? AND version!=?').get(id, version!)) throw new AdminError(409, '索引版本已改变，请刷新后重试。');
    const removed = id ? this.db.prepare('DELETE FROM frame_indexes WHERE media_id=? AND version=?').run(id, version!) : this.db.prepare('DELETE FROM frame_indexes').run();
    this.db.exec('UPDATE frame_index_epoch SET epoch=epoch+1 WHERE id=1');
    return { removed: Number(removed.changes) };
  }
}
