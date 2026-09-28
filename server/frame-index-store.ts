import type { IndexDatabase } from './sqlite.ts';
import { AdminError } from './admin-error.ts';
import { FLV_INDEX_BYTES, FLV_INDEX_SCHEMA, parseFlvIndex, serializeFlvIndex } from '../src/flv-index-cache.ts';
import type { FlvIndexDocument } from '../src/flv-index-cache.ts';
import { FFMPEG_INDEX_BYTES, parseFfmpegIndex } from '../src/ffmpeg-index-cache.ts';
import { FLV_MEDIA_INDEX_IDENTITY } from '../src/media-index-identity.ts';
import type { MediaIndexIdentity, MediaIndexKind } from '../src/media-index-identity.ts';

export type FrameIndexKind = MediaIndexKind;

const CACHE_LIMIT = 256 * 1024 * 1024;
const identityArgs = (identity: MediaIndexIdentity) => [
  identity.kind, identity.streamKey, identity.schemaVersion, identity.indexerBuild,
];
const identityWhere = 'kind=? AND stream_key=? AND schema_version=? AND indexer_build=?';

export class FrameIndexStore {
  private db: IndexDatabase;
  constructor(db: IndexDatabase) { this.db = db; }
  get epoch(): number { return Number(this.db.prepare('SELECT epoch FROM frame_index_epoch WHERE id=1').get()!.epoch); }

  get(id: string, version: string): { epoch: number; index: FlvIndexDocument | null } {
    const json = this.getJson(id, version, 'flv', FLV_MEDIA_INDEX_IDENTITY);
    const result = JSON.parse(json) as { epoch: number; index: FlvIndexDocument | null };
    return result;
  }

  has(id: string, version: string, kind: FrameIndexKind = 'flv', identity?: MediaIndexIdentity): boolean {
    const selected = identity ?? (kind === 'flv' ? FLV_MEDIA_INDEX_IDENTITY : undefined);
    if (!selected) return !!this.db.prepare('SELECT 1 FROM media_index_manifests WHERE media_id=? AND media_version=? AND kind=? AND complete=1')
      .get(id, version, kind);
    return !!this.db.prepare('SELECT 1 FROM media_index_manifests WHERE media_id=? AND media_version=? AND ' + identityWhere + ' AND complete=1')
      .get(id, version, ...identityArgs(selected));
  }

  /** Stored documents are validated on ingress. This returns the complete
   * document without parsing and stringifying its large record payload. */
  getJson(id: string, version: string, kind: FrameIndexKind = 'flv', identity?: MediaIndexIdentity): string {
    const selected = identity ?? (kind === 'flv' ? FLV_MEDIA_INDEX_IDENTITY : undefined);
    if (!selected) return JSON.stringify({ epoch: this.epoch, index: null });
    const row = this.db.prepare(
      'SELECT epoch,(SELECT b.payload FROM media_index_batches b JOIN media_index_manifests m USING(media_id,media_version,kind,stream_key,schema_version,indexer_build) ' +
      'WHERE b.media_id=? AND b.media_version=? AND b.kind=? AND b.stream_key=? AND b.schema_version=? AND b.indexer_build=? AND b.seq=0 AND m.complete=1) ' +
      'AS document FROM frame_index_epoch WHERE id=1',
    ).get(id, version, ...identityArgs(selected))!;
    if (row.document) this.db.prepare('UPDATE media_index_manifests SET accessed_at=? WHERE media_id=? AND media_version=? AND ' + identityWhere)
      .run(Date.now(), id, version, ...identityArgs(selected));
    return '{"epoch":' + Number(row.epoch) + ',"index":' + (row.document ? String(row.document) : 'null') + '}';
  }

  put(id: string, version: string, size: number, value: unknown, epoch: unknown, identity: MediaIndexIdentity = FLV_MEDIA_INDEX_IDENTITY) {
    if (epoch !== this.epoch) throw new AdminError(409, '索引缓存已被清理，请在下次载入时重新提交。');
    return this.commit(id, version, prepareFrameIndex(value, size, identity), epoch);
  }

  commit(id: string, version: string, prepared: PreparedFrameIndex, epoch: unknown) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (epoch !== this.epoch) throw new AdminError(409, '索引缓存已被清理，请在下次载入时重新提交。');
      const media = this.db.prepare("SELECT 1 FROM media JOIN roots ON media.root_id=roots.id WHERE media.id=? AND version=? AND media.state='ready' AND roots.active=1").get(id, version);
      if (!media) throw new AdminError(409, '媒体已改变，未保存旧索引。');
      const { text, bytes, frames, scannedBytes, identity } = prepared;
      const now = Date.now();
      this.db.prepare(
        "INSERT OR IGNORE INTO media_index_manifests(media_id,media_version,kind,stream_key,schema_version,indexer_build,state,last_seq,complete,scanned_bytes,stable_presentation_us,bytes,frames,created_at,accessed_at) VALUES(?,?,?,?,?,?,'complete',0,1,?,0,?,?,?,?)",
      ).run(id, version, ...identityArgs(identity), scannedBytes, bytes, frames, now, now);
      this.db.prepare(
        'INSERT OR IGNORE INTO media_index_batches(media_id,media_version,kind,stream_key,schema_version,indexer_build,seq,payload,bytes,frames,created_at) VALUES(?,?,?,?,?,?,0,?,?,?,?)',
      ).run(id, version, ...identityArgs(identity), text, bytes, frames, now);
      let total = Number(this.db.prepare('SELECT coalesce(sum(bytes),0) AS bytes FROM media_index_manifests').get()!.bytes);
      while (total > CACHE_LIMIT) {
        const oldest = this.db.prepare('SELECT media_id,media_version,kind,stream_key,schema_version,indexer_build,bytes FROM media_index_manifests ORDER BY accessed_at,media_id LIMIT 1').get()!;
        this.db.prepare('DELETE FROM media_index_manifests WHERE media_id=? AND media_version=? AND ' + identityWhere)
          .run(oldest.media_id, oldest.media_version, oldest.kind, oldest.stream_key, oldest.schema_version, oldest.indexer_build);
        total -= Number(oldest.bytes);
      }
      this.db.exec('COMMIT');
      return { ok: true };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  list(offset = 0, search = '') {
    if (!Number.isSafeInteger(offset) || offset < 0 || typeof search !== 'string' || search.length > 200) throw new AdminError(400, '索引分页或搜索参数无效。');
    const total = this.db.prepare('SELECT count(*) AS count,coalesce(sum(bytes),0) AS bytes FROM media_index_manifests').get()!;
    const rows = this.db.prepare(`SELECT f.media_id AS id,f.media_version AS version,f.kind,f.stream_key AS streamKey,
      f.schema_version AS schemaVersion,f.indexer_build AS indexerBuild,f.state,f.complete,f.scanned_bytes AS scannedBytes,
      f.stable_presentation_us AS stablePresentationUs,f.bytes,f.frames,f.created_at AS createdAt,
      m.path AS name,r.name AS root
      FROM media_index_manifests f JOIN media m ON m.id=f.media_id JOIN roots r ON r.id=m.root_id
      WHERE instr(lower(m.path),lower(?))>0 ORDER BY f.created_at DESC,f.media_id,f.kind LIMIT 51 OFFSET ?`).all(search, offset);
    return { entries: rows.slice(0, 50), nextOffset: rows.length > 50 ? offset + 50 : null, count: Number(total.count), bytes: Number(total.bytes), limitBytes: CACHE_LIMIT, epoch: this.epoch };
  }

  remove(id?: string, version?: string) {
    if (id && (!/^[0-9a-f]{24}$/.test(id) || !version)) throw new AdminError(400, '清理单个索引需要媒体 ID 和版本。');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (id && this.db.prepare('SELECT 1 FROM media_index_manifests WHERE media_id=? AND media_version!=?').get(id, version!)) throw new AdminError(409, '索引版本已改变，请刷新后重试。');
      const removedCount = Number(id
        ? this.db.prepare('SELECT count(*) AS count FROM media_index_manifests WHERE media_id=? AND media_version=?').get(id, version!)!.count
        : this.db.prepare('SELECT count(*) AS count FROM media_index_manifests').get()!.count);
      if (id) this.db.prepare('DELETE FROM media_index_manifests WHERE media_id=? AND media_version=?').run(id, version!);
      else this.db.prepare('DELETE FROM media_index_manifests').run();
      this.db.exec('UPDATE frame_index_epoch SET epoch=epoch+1 WHERE id=1');
      this.db.exec('COMMIT');
      return { removed: removedCount };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
}

export type PreparedFrameIndex = {
  text: string;
  bytes: number;
  frames: number;
  scannedBytes: number;
  identity: MediaIndexIdentity;
};

export function prepareFrameIndex(value: unknown, size: number, identityOrKind: MediaIndexIdentity | FrameIndexKind = FLV_MEDIA_INDEX_IDENTITY): PreparedFrameIndex {
  if (size < 0 || !Number.isSafeInteger(size)) throw new AdminError(400, '媒体大小无效。');
  const expectedKind = typeof identityOrKind === 'string' ? identityOrKind : identityOrKind.kind;
  let identity: MediaIndexIdentity;
  let text: string, bytes: number, frames: number;
  if (expectedKind === 'ffmpeg') {
    const parsed = parseFfmpegIndex(value, size);
    if (!parsed) throw new AdminError(400, 'FFmpeg 帧索引格式或范围无效。');
    const inferred: MediaIndexIdentity = {
      kind: 'ffmpeg',
      streamKey: 'video:' + parsed.document.streamIndex,
      schemaVersion: parsed.document.schema,
      indexerBuild: parsed.document.indexerBuild,
    };
    if (typeof identityOrKind !== 'string' && (identityOrKind.kind !== inferred.kind
      || identityOrKind.streamKey !== inferred.streamKey || identityOrKind.schemaVersion !== inferred.schemaVersion
      || identityOrKind.indexerBuild !== inferred.indexerBuild)) throw new AdminError(409, 'FFmpeg 索引身份与请求不匹配。');
    identity = inferred;
    text = JSON.stringify(parsed.document);
    bytes = Buffer.byteLength(text);
    frames = parsed.document.count;
    if (bytes > FFMPEG_INDEX_BYTES + 1024) throw new AdminError(413, 'FFmpeg 帧索引过大。');
  } else {
    if (typeof identityOrKind !== 'string' && (
      identityOrKind.kind !== FLV_MEDIA_INDEX_IDENTITY.kind
      || identityOrKind.streamKey !== FLV_MEDIA_INDEX_IDENTITY.streamKey
      || identityOrKind.schemaVersion !== FLV_INDEX_SCHEMA
      || identityOrKind.indexerBuild !== FLV_MEDIA_INDEX_IDENTITY.indexerBuild
    )) throw new AdminError(409, 'FLV 索引身份与请求不匹配。');
    let document: FlvIndexDocument;
    try { document = serializeFlvIndex(parseFlvIndex(value, size), size); }
    catch (error) { throw new AdminError(400, (error as Error).message); }
    identity = FLV_MEDIA_INDEX_IDENTITY;
    text = JSON.stringify(document);
    bytes = Buffer.byteLength(text);
    frames = document.packets.length;
    if (bytes > FLV_INDEX_BYTES) throw new AdminError(413, '帧索引过大。');
  }
  return { text, bytes, frames, scannedBytes: size, identity };
}
