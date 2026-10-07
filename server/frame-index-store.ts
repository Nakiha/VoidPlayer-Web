import type { IndexDatabase } from './sqlite.ts';
import { randomUUID } from 'node:crypto';
import { AdminError } from './admin-error.ts';
import { FLV_INDEX_BYTES, FLV_INDEX_SCHEMA, parseFlvIndex, serializeFlvIndex } from '../src/flv-index-cache.ts';
import type { FlvIndexDocument } from '../src/flv-index-cache.ts';
import { FFMPEG_INDEX_BYTES, FFMPEG_INDEX_RECORD_BYTES, FFMPEG_INDEX_RECORD_LIMIT, encodeBase64, parseFfmpegIndex, lastFfmpegPts, FFMPEG_NO_TIMESTAMP } from '../src/ffmpeg-index-cache.ts';
import { FLV_MEDIA_INDEX_IDENTITY } from '../src/media-index-identity.ts';
import type { MediaIndexIdentity, MediaIndexKind } from '../src/media-index-identity.ts';

export type FrameIndexKind = MediaIndexKind;

const CACHE_LIMIT = 256 * 1024 * 1024;
const identityArgs = (identity: MediaIndexIdentity) => [
  identity.kind, identity.streamKey, identity.schemaVersion, identity.indexerBuild,
];
const identityWhere = 'kind=? AND stream_key=? AND schema_version=? AND indexer_build=?';
const randomBuildId = () => randomUUID();

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
    if (selected.kind === 'ffmpeg') {
      const row = this.db.prepare('SELECT epoch,metadata_json FROM frame_index_epoch,media_index_manifests WHERE frame_index_epoch.id=1 AND media_id=? AND media_version=? AND ' + identityWhere + ' AND complete=1').get(id, version, ...identityArgs(selected));
      if (row?.metadata_json) {
        const rows = this.db.prepare('SELECT payload FROM media_index_batches WHERE media_id=? AND media_version=? AND ' + identityWhere + ' ORDER BY seq').all(id, version, ...identityArgs(selected)) as { payload: string }[];
        this.db.prepare('UPDATE media_index_manifests SET accessed_at=? WHERE media_id=? AND media_version=? AND ' + identityWhere)
          .run(Date.now(), id, version, ...identityArgs(selected));
        const metadata = JSON.parse(String(row.metadata_json)) as Record<string, unknown>;
        const records = Buffer.concat(rows.map(item => Buffer.from(item.payload, 'base64'))).toString('base64');
        return JSON.stringify({ epoch: Number(row.epoch), index: { ...metadata, records } });
      }
    }
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
      if (identity.kind === 'ffmpeg') {
        const doc = JSON.parse(text) as Record<string, unknown>;
        const parsed = parseFfmpegIndex(doc, Number(doc.size));
        if (!parsed) throw new AdminError(400, 'FFmpeg 帧索引格式或范围无效。');
        const { records: _records, ...baseMetadata } = parsed.document;
        const metadata: Record<string, unknown> = { ...baseMetadata,
          firstPts: baseMetadata.firstPts ?? (parsed.records.length >= FFMPEG_INDEX_RECORD_BYTES
            ? new DataView(parsed.records.buffer, parsed.records.byteOffset, parsed.records.byteLength).getBigInt64(0, true).toString()
            : '0'),
          originVerified: baseMetadata.originVerified === true,
        };
        this.db.prepare('DELETE FROM media_index_manifests WHERE media_id=? AND media_version=? AND ' + identityWhere + ' AND complete=0')
          .run(id, version, ...identityArgs(identity));
        this.db.prepare("INSERT OR IGNORE INTO media_index_manifests(media_id,media_version,kind,stream_key,schema_version,indexer_build,state,last_seq,complete,scanned_bytes,stable_presentation_us,bytes,frames,created_at,accessed_at,build_id,metadata_json) VALUES(?,?,?,?,?,?,'complete',-1,1,?,0,0,?,?,?, ?,?)")
          .run(id, version, ...identityArgs(identity), scannedBytes, frames, now, now, randomBuildId(), JSON.stringify(metadata));
        const existing = this.db.prepare('SELECT complete FROM media_index_manifests WHERE media_id=? AND media_version=? AND ' + identityWhere)
          .get(id, version, ...identityArgs(identity)) as { complete: number } | undefined;
        if (existing?.complete) {
          const existingRows = this.db.prepare('SELECT count(*) AS count FROM media_index_batches WHERE media_id=? AND media_version=? AND ' + identityWhere)
            .get(id, version, ...identityArgs(identity)) as { count: number };
          if (Number(existingRows.count) === 0) {
            const chunkRecords = 768;
            const totalRecords = parsed.records.byteLength / FFMPEG_INDEX_RECORD_BYTES;
            for (let start = 0, seq = 0; start < totalRecords; start += chunkRecords, seq++) {
              const end = Math.min(totalRecords, start + chunkRecords);
              const part = parsed.records.subarray(start * FFMPEG_INDEX_RECORD_BYTES, end * FFMPEG_INDEX_RECORD_BYTES);
              this.db.prepare('INSERT INTO media_index_batches(media_id,media_version,kind,stream_key,schema_version,indexer_build,seq,payload,bytes,frames,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
                .run(id, version, ...identityArgs(identity), seq, encodeBase64(part), Buffer.byteLength(encodeBase64(part)), end - start, now);
            }
            const storedBytes = Number(this.db.prepare('SELECT coalesce(sum(bytes),0) AS bytes FROM media_index_batches WHERE media_id=? AND media_version=? AND ' + identityWhere).get(id, version, ...identityArgs(identity))!.bytes);
            this.db.prepare('UPDATE media_index_manifests SET last_seq=?,bytes=? WHERE media_id=? AND media_version=? AND ' + identityWhere)
              .run(Math.ceil((parsed.records.byteLength / FFMPEG_INDEX_RECORD_BYTES) / 768) - 1, storedBytes, id, version, ...identityArgs(identity));
          }
        }
        this.evictCache(id, version, identity);
        this.db.exec('COMMIT');
        return { ok: true };
      }
      this.db.prepare(
        "INSERT OR IGNORE INTO media_index_manifests(media_id,media_version,kind,stream_key,schema_version,indexer_build,state,last_seq,complete,scanned_bytes,stable_presentation_us,bytes,frames,created_at,accessed_at) VALUES(?,?,?,?,?,?,'complete',0,1,?,0,?,?,?,?)",
      ).run(id, version, ...identityArgs(identity), scannedBytes, bytes, frames, now, now);
      this.db.prepare(
        'INSERT OR IGNORE INTO media_index_batches(media_id,media_version,kind,stream_key,schema_version,indexer_build,seq,payload,bytes,frames,created_at) VALUES(?,?,?,?,?,?,0,?,?,?,?)',
      ).run(id, version, ...identityArgs(identity), text, bytes, frames, now);
      this.evictCache(id, version, identity);
      this.db.exec('COMMIT');
      return { ok: true };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  beginBuild(id: string, version: string, identity: MediaIndexIdentity, epoch: number, buildId: string, metadata: Record<string, unknown>) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (epoch !== this.epoch) throw new AdminError(409, '索引缓存已被清理，请重新请求。');
      if (!this.db.prepare("SELECT 1 FROM media JOIN roots ON media.root_id=roots.id WHERE media.id=? AND version=? AND media.state='ready' AND roots.active=1").get(id, version)) throw new AdminError(409, '媒体已改变，未保存旧索引。');
      this.db.prepare('DELETE FROM media_index_manifests WHERE media_id=? AND media_version=? AND ' + identityWhere).run(id, version, ...identityArgs(identity));
      const now = Date.now();
      this.db.prepare("INSERT INTO media_index_manifests(media_id,media_version,kind,stream_key,schema_version,indexer_build,state,last_seq,complete,scanned_bytes,stable_presentation_us,bytes,frames,created_at,accessed_at,build_id,metadata_json) VALUES(?,?,?,?,?,?,'building',-1,0,0,0,0,0,?,?,?,?)")
        .run(id, version, ...identityArgs(identity), now, now, buildId, JSON.stringify(metadata));
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  appendBuildBatch(id: string, version: string, identity: MediaIndexIdentity, epoch: number, buildId: string, seq: number, payload: string, frames: number, scannedBytes: number, stablePresentationUs: number) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (epoch !== this.epoch) throw new AdminError(409, '索引缓存已被清理，请重新请求。');
      const row = this.db.prepare('SELECT last_seq,build_id,complete,stable_presentation_us,scanned_bytes,bytes,frames,metadata_json FROM media_index_manifests WHERE media_id=? AND media_version=? AND ' + identityWhere)
        .get(id, version, ...identityArgs(identity)) as { last_seq: number; build_id: string; complete: number; stable_presentation_us: number; scanned_bytes: number; bytes: number; frames: number; metadata_json: string } | undefined;
      if (!row || row.complete || row.build_id !== buildId || seq !== Number(row.last_seq) + 1) throw new AdminError(409, '索引构建身份或 batch 序号已改变。');
      if (!Number.isSafeInteger(frames) || frames <= 0 || !Number.isSafeInteger(scannedBytes) || scannedBytes < 0
        || !Number.isSafeInteger(stablePresentationUs) || stablePresentationUs < Number(row.stable_presentation_us)) {
        throw new AdminError(400, 'FFmpeg 索引 batch 元数据无效。');
      }
      const metadata = JSON.parse(row.metadata_json) as Record<string, unknown>;
      if (scannedBytes > Number(metadata.size)) throw new AdminError(400, 'FFmpeg 索引扫描进度超过媒体长度。');
      const parsed = parseFfmpegIndex({ ...metadata, count: frames, records: payload }, Number(metadata.size));
      if (!parsed) throw new AdminError(400, 'FFmpeg 索引 batch 记录无效。');
      const lastPts = lastFfmpegPts(parsed.records);
      const expectedSafeUs = lastPts === FFMPEG_NO_TIMESTAMP ? Number(row.stable_presentation_us) : Math.max(0, Math.floor(Number(lastPts - BigInt(String(metadata.firstPts))) * 1_000_000
        * Number(metadata.timeBaseNum) / Number(metadata.timeBaseDen)));
      if (expectedSafeUs !== stablePresentationUs) throw new AdminError(400, 'FFmpeg 索引 watermark 与 batch 记录不匹配。');
      const bytes = Buffer.byteLength(payload);
      if (Number(row.frames) + frames > FFMPEG_INDEX_RECORD_LIMIT || Number(row.bytes) + bytes > FFMPEG_INDEX_BYTES) {
        throw new AdminError(413, 'FFmpeg 帧索引超过服务端容量上限。');
      }
      if (scannedBytes < Number(row.scanned_bytes)) throw new AdminError(400, 'FFmpeg 索引扫描进度不能回退。');
      const now = Date.now();
      this.db.prepare("INSERT INTO media_index_batches(media_id,media_version,kind,stream_key,schema_version,indexer_build,seq,payload,bytes,frames,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
        .run(id, version, ...identityArgs(identity), seq, payload, bytes, frames, now);
      this.db.prepare("UPDATE media_index_manifests SET state='streaming',last_seq=?,scanned_bytes=?,stable_presentation_us=?,bytes=bytes+?,frames=frames+?,accessed_at=? WHERE media_id=? AND media_version=? AND " + identityWhere)
        .run(seq, scannedBytes, stablePresentationUs, bytes, frames, now, id, version, ...identityArgs(identity));
      this.evictCache(id, version, identity);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  updateBuildProgress(id: string, version: string, identity: MediaIndexIdentity, buildId: string, packets: number, scannedBytes: number) {
    this.db.prepare('UPDATE media_index_manifests SET packets=max(packets,?),scanned_bytes=max(scanned_bytes,?),accessed_at=? WHERE media_id=? AND media_version=? AND ' + identityWhere + ' AND build_id=? AND complete=0')
      .run(packets, scannedBytes, Date.now(), id, version, ...identityArgs(identity), buildId);
  }

  finishBuild(id: string, version: string, identity: MediaIndexIdentity, epoch: number, buildId: string, scannedBytes: number, stablePresentationUs: number, frames: number) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (epoch !== this.epoch) throw new AdminError(409, '索引缓存已被清理，请重新请求。');
      const media = this.db.prepare("SELECT 1 FROM media JOIN roots ON media.root_id=roots.id WHERE media.id=? AND media.version=? AND media.state='ready' AND roots.active=1").get(id, version);
      if (!media) throw new AdminError(409, '媒体已改变，未完成旧版本索引。');
      const row = this.db.prepare('SELECT last_seq,build_id,frames,stable_presentation_us FROM media_index_manifests WHERE media_id=? AND media_version=? AND ' + identityWhere)
        .get(id, version, ...identityArgs(identity)) as { last_seq: number; build_id: string; frames: number; stable_presentation_us: number } | undefined;
      if (!row || row.build_id !== buildId) throw new AdminError(409, '索引构建身份已改变。');
      if (!Number.isSafeInteger(frames) || frames <= 0 || Number(row.frames) !== frames
        || !Number.isSafeInteger(stablePresentationUs) || Number(row.stable_presentation_us) !== stablePresentationUs) {
        throw new AdminError(500, 'FFmpeg 索引完成信息与持久化 batch 不一致。');
      }
      const metadata = row && this.db.prepare('SELECT metadata_json FROM media_index_manifests WHERE media_id=? AND media_version=? AND ' + identityWhere).get(id, version, ...identityArgs(identity)) as { metadata_json: string } | undefined;
      const metadataJson = metadata?.metadata_json ? JSON.stringify({ ...JSON.parse(metadata.metadata_json), count: frames }) : null;
      this.db.prepare("UPDATE media_index_manifests SET state='complete',complete=1,scanned_bytes=?,stable_presentation_us=?,frames=?,metadata_json=coalesce(?,metadata_json),accessed_at=? WHERE media_id=? AND media_version=? AND " + identityWhere)
        .run(scannedBytes, stablePresentationUs, frames, metadataJson, Date.now(), id, version, ...identityArgs(identity));
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  failBuild(id: string, version: string, identity: MediaIndexIdentity, buildId: string) {
    this.db.prepare("UPDATE media_index_manifests SET state='failed' WHERE media_id=? AND media_version=? AND " + identityWhere + ' AND build_id=? AND complete=0')
      .run(id, version, ...identityArgs(identity), buildId);
  }

  streamManifest(id: string, version: string, identity: MediaIndexIdentity) {
    if (identity.kind === 'ffmpeg') this.migrateLegacyFfmpegBatches(id, version, identity);
    const row = this.db.prepare('SELECT e.epoch,m.* FROM frame_index_epoch e LEFT JOIN media_index_manifests m ON m.media_id=? AND m.media_version=? AND m.kind=? AND m.stream_key=? AND m.schema_version=? AND m.indexer_build=? WHERE e.id=1')
      .get(id, version, ...identityArgs(identity)) as Record<string, unknown>;
    if (!row?.media_id) return { epoch: Number(row?.epoch ?? this.epoch), manifest: null };
    this.db.prepare('UPDATE media_index_manifests SET accessed_at=? WHERE media_id=? AND media_version=? AND ' + identityWhere)
      .run(Date.now(), id, version, ...identityArgs(identity));
    return { epoch: Number(row.epoch), manifest: { buildId: row.build_id, state: row.state, lastSeq: Number(row.last_seq), complete: !!row.complete,
      packets: Number(row.packets), scannedBytes: Number(row.scanned_bytes), stablePresentationUs: Number(row.stable_presentation_us), bytes: Number(row.bytes), frames: Number(row.frames),
      metadata: row.metadata_json ? JSON.parse(String(row.metadata_json)) : null } };
  }

  private migrateLegacyFfmpegBatches(id: string, version: string, identity: MediaIndexIdentity) {
    const manifest = this.db.prepare('SELECT complete,metadata_json FROM media_index_manifests WHERE media_id=? AND media_version=? AND ' + identityWhere)
      .get(id, version, ...identityArgs(identity)) as { complete: number; metadata_json: string | null } | undefined;
    if (!manifest?.complete || manifest.metadata_json) return;
    const legacy = this.db.prepare('SELECT payload FROM media_index_batches WHERE media_id=? AND media_version=? AND ' + identityWhere + ' AND seq=0')
      .get(id, version, ...identityArgs(identity)) as { payload: string } | undefined;
    if (!legacy) return;
    let value: unknown;
    try { value = JSON.parse(legacy.payload); } catch { return; }
    const document = value as { size?: unknown; firstPts?: unknown; originVerified?: unknown } | null;
    const parsed = document && Number.isSafeInteger(document.size) ? parseFfmpegIndex(value, Number(document.size)) : null;
    if (!document || !parsed) return;
    const { records: _records, ...baseMetadata } = parsed.document;
    const metadata: Record<string, unknown> = { ...baseMetadata,
      firstPts: typeof document.firstPts === 'string' && /^-?\d+$/.test(document.firstPts) ? document.firstPts
        : new DataView(parsed.records.buffer, parsed.records.byteOffset, parsed.records.byteLength).getBigInt64(0, true).toString(),
      originVerified: document.originVerified === true,
    };
    const recordsPerBatch = 768;
    const recordCount = parsed.records.byteLength / FFMPEG_INDEX_RECORD_BYTES;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.db.prepare('SELECT complete,metadata_json FROM media_index_manifests WHERE media_id=? AND media_version=? AND ' + identityWhere)
        .get(id, version, ...identityArgs(identity)) as { complete: number; metadata_json: string | null } | undefined;
      if (!current?.complete || current.metadata_json) { this.db.exec('ROLLBACK'); return; }
      this.db.prepare('DELETE FROM media_index_batches WHERE media_id=? AND media_version=? AND ' + identityWhere).run(id, version, ...identityArgs(identity));
      const now = Date.now();
      let totalBytes = 0;
      for (let start = 0, seq = 0; start < recordCount; start += recordsPerBatch, seq++) {
        const end = Math.min(recordCount, start + recordsPerBatch);
        const payload = encodeBase64(parsed.records.subarray(start * FFMPEG_INDEX_RECORD_BYTES, end * FFMPEG_INDEX_RECORD_BYTES));
        const bytes = Buffer.byteLength(payload);
        totalBytes += bytes;
        this.db.prepare('INSERT INTO media_index_batches(media_id,media_version,kind,stream_key,schema_version,indexer_build,seq,payload,bytes,frames,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
          .run(id, version, ...identityArgs(identity), seq, payload, bytes, end - start, now);
      }
      this.db.prepare('UPDATE media_index_manifests SET build_id=?,metadata_json=?,last_seq=?,bytes=?,frames=?,accessed_at=? WHERE media_id=? AND media_version=? AND ' + identityWhere)
        .run(randomBuildId(), JSON.stringify(metadata), Math.ceil(recordCount / recordsPerBatch) - 1, totalBytes, recordCount, now, id, version, ...identityArgs(identity));
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  streamBatches(id: string, version: string, identity: MediaIndexIdentity, after: number, limit = 16) {
    return this.db.prepare('SELECT seq,payload,bytes,frames FROM media_index_batches WHERE media_id=? AND media_version=? AND ' + identityWhere + ' AND seq>? ORDER BY seq LIMIT ?')
      .all(id, version, ...identityArgs(identity), after, Math.max(1, Math.min(64, limit)));
  }

  private evictCache(currentId: string, currentVersion: string, identity: MediaIndexIdentity) {
    let total = Number(this.db.prepare('SELECT coalesce(sum(bytes),0) AS bytes FROM media_index_manifests').get()!.bytes);
    while (total > CACHE_LIMIT) {
      const oldest = this.db.prepare('SELECT media_id,media_version,kind,stream_key,schema_version,indexer_build,bytes FROM media_index_manifests WHERE NOT(media_id=? AND media_version=? AND kind=? AND stream_key=? AND schema_version=? AND indexer_build=?) ORDER BY accessed_at,media_id LIMIT 1')
        .get(currentId, currentVersion, ...identityArgs(identity)) as Record<string, any> | undefined;
      if (!oldest) throw new AdminError(413, '帧索引缓存超过服务端容量上限。');
      this.db.prepare('DELETE FROM media_index_manifests WHERE media_id=? AND media_version=? AND ' + identityWhere)
        .run(oldest.media_id, oldest.media_version, oldest.kind, oldest.stream_key, oldest.schema_version, oldest.indexer_build);
      total -= Number(oldest.bytes);
    }
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
