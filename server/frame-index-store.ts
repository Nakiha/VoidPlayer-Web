import {parseMp4QualityDocument} from '../shared/media/indexing/mp4-quality-index.ts';
import type {QualityIndexDocument} from '../shared/analysis/quality/source-index.ts';
import { preparePacketStorage, packetStorage, restorePacketDocument, invalidPackets } from './committed-packet-storage.ts';
import { flvCommittedHeader, tsCommittedHeader, COMMITTED_HEADER_BYTES } from '../shared/media/indexing/committed-index-header.ts';
import type { CommittedIndexHeader, ScanEvidence } from '../shared/media/indexing/committed-index-header.ts';
import { parseJsPacketIndex } from '../shared/media/indexing/js-packet-index-parser.ts';
import { JS_TS_INDEX_BYTES } from '../shared/media/indexing/ts-packet-index.ts';
import type { FrameIndexManifest, FrameIndexBatch } from './frame-index-protocol.ts';
import type { IndexDatabase } from './sqlite.ts';
import { randomUUID, createHash } from 'node:crypto';
import { AdminError } from './admin-error.ts';
import { FLV_INDEX_BYTES, FLV_INDEX_SCHEMA, parseFlvIndex, serializeFlvIndex } from '../shared/media/indexing/flv-index-cache.ts';
import type { FlvIndexDocument } from '../shared/media/indexing/flv-index-cache.ts';
import { FFMPEG_INDEX_BYTES, FFMPEG_INDEX_RECORD_BYTES, FFMPEG_INDEX_RECORD_LIMIT, encodeBase64, parseFfmpegIndex, lastFfmpegPts, FFMPEG_NO_TIMESTAMP } from '../shared/media/indexing/ffmpeg-index-cache.ts';
import { FLV_MEDIA_INDEX_IDENTITY, MP4_QUALITY_MEDIA_INDEX_IDENTITY, JS_TS_MEDIA_INDEX_IDENTITY, JS_MATROSKA_MEDIA_INDEX_IDENTITY } from '../shared/media/indexing/media-index-identity.ts';
import type { MediaIndexIdentity, MediaIndexKind } from '../shared/media/indexing/media-index-identity.ts';
import { validFfmpegRecovery } from '../shared/media/indexing/index-integrity.ts';
import type { LibraryPairBinding, FlvProducerEvidence, QualityProducerEvidence, Mp4ProducerEvidence } from '../shared/analysis/quality/library-pair.ts';
import { PAIR_LIMITS } from '../shared/analysis/quality/frame-pair.ts';
import type { PairBudget } from '../shared/analysis/quality/frame-pair.ts';
import type { FileStatWitness } from './file-stat.ts';
import type { FfmpegIndexRecovery } from '../shared/media/indexing/index-integrity.ts';

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

  /** Read evidence and optional bounded document under ONE SQLite snapshot.
   * producer_json is written here only for the server parser; POSTed JSON
   * never supplies this field, and an existing client cache cannot be blessed. */
  qualitySource(id: string, version: string, withIndex = false, limits: PairBudget = PAIR_LIMITS, expectedIdentity?:MediaIndexIdentity): LibraryPairBinding & { index: QualityIndexDocument | null } {
    this.db.exec('BEGIN');
    try {
      const identity = expectedIdentity??(this.has(id,version,'mp4',MP4_QUALITY_MEDIA_INDEX_IDENTITY)?MP4_QUALITY_MEDIA_INDEX_IDENTITY:FLV_MEDIA_INDEX_IDENTITY), epoch = this.epoch;
      if(!['flv','mp4'].includes(identity.kind))throw new AdminError(409,'Unsupported quality index identity.','untrusted-cache');
      const row = this.db.prepare('SELECT complete,frames,last_seq,bytes,scanned_bytes,packet_storage,producer_json,build_id FROM media_index_manifests WHERE media_id=? AND media_version=? AND '+identityWhere).get(id,version,...identityArgs(identity));
      if (!row?.complete) throw new AdminError(409,'An existing complete supported quality cache is required.','cache-miss');
      if (Number(row.frames)>limits.maxIndexPackets || Number(row.bytes)>limits.maxIndexBytes)
        throw new AdminError(413,'Cached index exceeds quality budget.','budget-exceeded');
      const storage = packetStorage(String(row.packet_storage),identity,`${id}@${version}`,Number(row.frames),Number(row.last_seq));
      let producer: QualityProducerEvidence | undefined;
      try { producer = JSON.parse(String(row.producer_json)); } catch {}
      if (!(identity.kind==='mp4'?typeof row.build_id==='string':!!storage) || !producer || producer.producer!==(identity.kind==='mp4'?'server-mp4-scan-v1':'server-flv-scan-v1') || producer.sourceVersion!==`${id}@${version}`
        || producer.epoch!==epoch || producer.packetCommitId!==(identity.kind==='mp4'?row.build_id:storage!.commitId) || (identity.kind==='flv'&&producer.documentSha256!==storage!.documentSha256)
        || producer.size!==Number(row.scanned_bytes) || !Number.isSafeInteger(producer.size) || producer.size<1
        || !producer.sourceStat || producer.sourceStat.size!==String(producer.size)
        || ['size','dev','ino','mtimeNs','ctimeNs'].some(key=>typeof producer!.sourceStat[key as keyof FileStatWitness]!=='string'||! /^-?\d{1,24}$/.test(producer!.sourceStat[key as keyof FileStatWitness])))
        throw new AdminError(409,'Cache lacks matching server producer evidence; explicitly clear and prepare it.','untrusted-cache');
      if(producer.producer==='server-mp4-scan-v1'&&(!/^[a-f0-9]{64}$/.test(producer.documentSha256)||!Number.isSafeInteger(producer.trackId)||producer.trackId<1||!Number.isSafeInteger(producer.timescale)||producer.timescale<1||!/^[a-f0-9]{64}$/.test(producer.tableSha256)))throw new AdminError(409,'Invalid MP4 producer witness.','untrusted-cache');
      const indexBuildId = createHash('sha256').update(JSON.stringify([identity,producer])).digest('hex');
      let index: QualityIndexDocument | null = null;
      if (withIndex) {
        const text = this.storedDocument(id,version,identity);
        if (!text || Buffer.byteLength(text)>limits.maxIndexBytes) throw new AdminError(413,'Invalid or oversized quality index.','budget-exceeded');
        if (createHash('sha256').update(text).digest('hex')!==producer.documentSha256) throw new AdminError(409,'Quality cache document changed.','identity-mismatch');
        index = JSON.parse(text) as QualityIndexDocument;
        if(producer.producer==='server-mp4-scan-v1'){const doc=parseMp4QualityDocument(index,producer.size);if(doc.trackId!==producer.trackId||doc.timescale!==producer.timescale||doc.moov.sha256!==producer.tableSha256||doc.samples.length!==Number(row.frames))throw new AdminError(409,'MP4 table/producer witness differs.','identity-mismatch');}
        else parseFlvIndex(index,producer.size);
      }
      this.db.exec('COMMIT');
      return { binding:{mediaId:id,mediaVersion:version,size:producer.size,indexIdentity:{...identity},indexBuildId},producer,index };
    } catch(error) { this.db.exec('ROLLBACK'); throw error; }
  }

  private storedDocument(id: string, version: string, identity: MediaIndexIdentity): string | null {
    const row = this.db.prepare('SELECT complete,frames,last_seq,packet_storage FROM media_index_manifests WHERE media_id=? AND media_version=? AND ' + identityWhere).get(id, version, ...identityArgs(identity));
    if (!row?.complete) return null;
    const rows = this.db.prepare('SELECT seq,payload,frames FROM media_index_batches WHERE media_id=? AND media_version=? AND ' + identityWhere + ' ORDER BY seq').all(id, version, ...identityArgs(identity)) as { seq: number; payload: string; frames: number }[];
    if (!row.packet_storage) {
      // An invalidated sharded cache must not masquerade as a legacy document.
      if (row.last_seq !== 0 || rows.length !== 1) return null;
      return rows[0].payload;
    }
    const storage = packetStorage(String(row.packet_storage), identity, `${id}@${version}`, Number(row.frames), Number(row.last_seq));
    if (!storage || rows[0]?.seq !== 0) return invalidPackets();
    return restorePacketDocument(rows[0].payload, rows.slice(1), storage);
  }

  /** JS documents can only be committed by the server's completed parser.
   * A separate stored seal detects damaged documents after process restart. */
  private validJsTsCache(id: string, version: string, identity: MediaIndexIdentity) {
    const row=this.db.prepare('SELECT metadata_json FROM media_index_manifests WHERE media_id=? AND media_version=? AND '+identityWhere+' AND complete=1').get(id,version,...identityArgs(identity));
    if(!row)return null; // A cache miss needs no eviction transaction.
    let valid=false;
    try {valid=JSON.parse(String(row.metadata_json)).jsIndexSha256===createHash('sha256').update(this.storedDocument(id,version,identity) ?? '').digest('hex');} catch {}
    return valid;
  }

  get(id: string, version: string): { epoch: number; index: FlvIndexDocument | null } {
    const json = this.getJson(id, version, 'flv', FLV_MEDIA_INDEX_IDENTITY);
    const result = JSON.parse(json) as { epoch: number; index: FlvIndexDocument | null };
    return result;
  }

  has(id: string, version: string, kind: FrameIndexKind = 'flv', identity?: MediaIndexIdentity): boolean {
    const selected = identity ?? (kind === 'flv' ? FLV_MEDIA_INDEX_IDENTITY : undefined);
    if (selected?.kind === 'js-ts' || selected?.kind === 'js-matroska') {
      // The seal and reconstructed document must come from the same snapshot;
      // a concurrent clear/recommit must never make us delete its valid winner.
      this.db.exec('BEGIN');
      let valid: boolean | null;
      try { valid = this.validJsTsCache(id, version, selected); this.db.exec('COMMIT'); }
      catch (error) { this.db.exec('ROLLBACK'); throw error; }
      if (valid !== false) return valid === true;
      // Corrupt-cache eviction is a separate write transaction. Revalidate under
      // the writer lock so a concurrent valid replacement cannot be deleted.
      this.db.exec('BEGIN IMMEDIATE');
      try {
        valid = this.validJsTsCache(id, version, selected);
        if (valid === false) this.db.prepare('DELETE FROM media_index_manifests WHERE media_id=? AND media_version=? AND ' + identityWhere)
          .run(id, version, ...identityArgs(selected));
        this.db.exec('COMMIT'); return valid === true;
      } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    }
    if (!selected) return !!this.db.prepare('SELECT 1 FROM media_index_manifests WHERE media_id=? AND media_version=? AND kind=? AND complete=1')
      .get(id, version, kind);
    return !!this.db.prepare('SELECT 1 FROM media_index_manifests WHERE media_id=? AND media_version=? AND ' + identityWhere + ' AND complete=1')
      .get(id, version, ...identityArgs(selected));
  }

  /** GUI compatibility: reassemble the single authoritative packet table under
   * one snapshot. Semantic queries never enter this whole-document path. */
  getJson(id: string, version: string, kind: FrameIndexKind = 'flv', identity?: MediaIndexIdentity): string {
    const selected = identity ?? (kind === 'flv' ? FLV_MEDIA_INDEX_IDENTITY : undefined);
    this.db.exec('BEGIN');
    let result: { json: string; hit: boolean };
    let touch: { buildId: string | null; packetStorage: string | null; epoch: number } | undefined;
    try {
      result = this.readJson(id, version, kind, identity);
      if (result.hit && selected) {
        const row = this.db.prepare('SELECT build_id,packet_storage FROM media_index_manifests WHERE media_id=? AND media_version=? AND ' + identityWhere + ' AND complete=1')
          .get(id, version, ...identityArgs(selected));
        // NULL/NULL legacy rows have no unique commit token: never touch them.
        if (row && (typeof row.build_id === 'string' || typeof row.packet_storage === 'string')) touch = { buildId: typeof row.build_id === 'string' ? row.build_id : null,
          packetStorage: typeof row.packet_storage === 'string' ? row.packet_storage : null, epoch: this.epoch };
      }
      this.db.exec('COMMIT');
    }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
    if (touch && selected) {
      // LRU is advisory. A reader must never upgrade its WAL snapshot to write,
      // and a contended/failed touch must not discard the validated document.
      try { this.db.prepare('UPDATE media_index_manifests SET accessed_at=? WHERE media_id=? AND media_version=? AND ' + identityWhere
        + ' AND complete=1 AND build_id IS ? AND packet_storage IS ? AND (SELECT epoch FROM frame_index_epoch WHERE id=1)=?')
        .run(Date.now(), id, version, ...identityArgs(selected), touch.buildId, touch.packetStorage, touch.epoch); } catch {}
    }
    return result.json;
  }

  private readJson(id: string, version: string, kind: FrameIndexKind, identity?: MediaIndexIdentity): { json: string; hit: boolean } {
    const selected = identity ?? (kind === 'flv' ? FLV_MEDIA_INDEX_IDENTITY : undefined);
    if((selected?.kind==='js-ts'||selected?.kind==='js-matroska')&&!this.validJsTsCache(id,version,selected))return { json: JSON.stringify({epoch:this.epoch,index:null}), hit: false };
    if (!selected) return { json: JSON.stringify({ epoch: this.epoch, index: null }), hit: false };
    if (selected.kind === 'ffmpeg') {
      const row = this.db.prepare('SELECT epoch,metadata_json FROM frame_index_epoch,media_index_manifests WHERE frame_index_epoch.id=1 AND media_id=? AND media_version=? AND ' + identityWhere + ' AND complete=1').get(id, version, ...identityArgs(selected));
      if (row?.metadata_json) {
        const rows = this.db.prepare('SELECT payload FROM media_index_batches WHERE media_id=? AND media_version=? AND ' + identityWhere + ' ORDER BY seq').all(id, version, ...identityArgs(selected)) as { payload: string }[];
        const metadata = JSON.parse(String(row.metadata_json)) as Record<string, unknown>;
        const records = Buffer.concat(rows.map(item => Buffer.from(item.payload, 'base64'))).toString('base64');
        return { json: JSON.stringify({ epoch: Number(row.epoch), index: { ...metadata, records } }), hit: true };
      }
    }
    const document = this.storedDocument(id, version, selected);
    return { json: '{"epoch":' + this.epoch + ',"index":' + (document ?? 'null') + '}', hit: document !== null };
  }

  put(id: string, version: string, size: number, value: unknown, epoch: unknown, identity: MediaIndexIdentity = FLV_MEDIA_INDEX_IDENTITY) {
    if((identity.kind==='js-ts'||identity.kind==='js-matroska'||identity.kind==='mp4'))throw new AdminError(405,'JS TS 索引只能由服务端完整扫描构建。');
    if (epoch !== this.epoch) throw new AdminError(409, '索引缓存已被清理，请在下次载入时重新提交。');
    return this.commit(id, version, prepareFrameIndex(value, size, identity, `${id}@${version}`), epoch);
  }

  commit(id: string, version: string, prepared: PreparedFrameIndex, epoch: unknown, producer?: {kind:'server-flv-scan-v1'|'server-mp4-scan-v1';sourceStat:FileStatWitness}) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (epoch !== this.epoch) throw new AdminError(409, '索引缓存已被清理，请在下次载入时重新提交。');
      const media = this.db.prepare("SELECT 1 FROM media JOIN roots ON media.root_id=roots.id WHERE media.id=? AND version=? AND media.state='ready' AND roots.active=1").get(id, version);
      if (!media) throw new AdminError(409, '媒体已改变，未保存旧索引。');
      const { text, bytes, frames, scannedBytes, identity } = prepared;
      if(identity.kind==='mp4'&&producer?.kind!=='server-mp4-scan-v1')throw new AdminError(409,'MP4 quality indexes require the server parser producer.','untrusted-cache');
      if ((identity.kind === 'js-ts'||identity.kind==='js-matroska') && !parseJsPacketIndex(JSON.parse(text), `${id}@${version}`, scannedBytes))
        throw new AdminError(409, 'JS TS 索引源身份与提交不匹配。');
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
      // Whole documents and their projections are immutable within one identity.
      // A racing/duplicate submission must never attach a new header or seal to old packets.
      if (this.db.prepare('SELECT 1 FROM media_index_manifests WHERE media_id=? AND media_version=? AND ' + identityWhere).get(id, version, ...identityArgs(identity))) {
        this.db.exec('COMMIT'); return { ok: true };
      }
      const sharded = identity.kind === 'flv' || identity.kind === 'js-ts'
        ? preparePacketStorage(text, `${id}@${version}`, identity) : undefined;
      const parts = sharded ? [{ payload: sharded.metadata, frames: 0 }, ...sharded.chunks] : [{ payload: text, frames }];
      const storedBytes = parts.reduce((sum, p) => sum + Buffer.byteLength(p.payload), 0);
      this.db.prepare(
        "INSERT INTO media_index_manifests(media_id,media_version,kind,stream_key,schema_version,indexer_build,state,last_seq,complete,scanned_bytes,stable_presentation_us,bytes,frames,created_at,accessed_at,build_id) VALUES(?,?,?,?,?,?,'complete',?,1,?,0,?,?,?,?,?)",
      ).run(id, version, ...identityArgs(identity), parts.length - 1, scannedBytes, storedBytes, frames, now, now, sharded ? null : randomBuildId());
      for (const [seq, part] of parts.entries()) this.db.prepare(
        'INSERT INTO media_index_batches(media_id,media_version,kind,stream_key,schema_version,indexer_build,seq,payload,bytes,frames,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
      ).run(id, version, ...identityArgs(identity), seq, part.payload, Buffer.byteLength(part.payload), part.frames, now);
      if (sharded) this.db.prepare('UPDATE media_index_manifests SET packet_storage=? WHERE media_id=? AND media_version=? AND ' + identityWhere)
        .run(JSON.stringify(sharded.storage), id, version, ...identityArgs(identity));
      if (producer?.kind === 'server-flv-scan-v1' && identity.kind==='flv' && sharded) {
        const proof: FlvProducerEvidence = {producer:producer.kind,sourceStat:producer.sourceStat,sourceVersion:`${id}@${version}`,size:scannedBytes,epoch:Number(epoch),
          packetCommitId:sharded.storage.commitId,documentSha256:sharded.storage.documentSha256};
        this.db.prepare('UPDATE media_index_manifests SET producer_json=? WHERE media_id=? AND media_version=? AND '+identityWhere)
          .run(JSON.stringify(proof),id,version,...identityArgs(identity));
      }
      if(producer?.kind==='server-mp4-scan-v1'&&identity.kind==='mp4'){
        const doc=parseMp4QualityDocument(JSON.parse(text),scannedBytes),row=this.db.prepare('SELECT build_id FROM media_index_manifests WHERE media_id=? AND media_version=? AND '+identityWhere).get(id,version,...identityArgs(identity))!;
        const proof:Mp4ProducerEvidence={producer:producer.kind,sourceStat:producer.sourceStat,sourceVersion:`${id}@${version}`,size:scannedBytes,epoch:Number(epoch),packetCommitId:String(row.build_id),documentSha256:createHash('sha256').update(text).digest('hex'),trackId:doc.trackId,timescale:doc.timescale,tableSha256:doc.moov.sha256};
        this.db.prepare('UPDATE media_index_manifests SET producer_json=? WHERE media_id=? AND media_version=? AND '+identityWhere).run(JSON.stringify(proof),id,version,...identityArgs(identity));
      }
      if ((identity.kind==='js-ts'||identity.kind==='js-matroska')) this.db.prepare('UPDATE media_index_manifests SET metadata_json=? WHERE media_id=? AND media_version=? AND '+identityWhere)
        .run(JSON.stringify({jsIndexSha256:createHash('sha256').update(text).digest('hex')}),id,version,...identityArgs(identity));
      if (prepared.semanticHeader) {
        const header = prepared.semanticHeader;
        if (header.sourceVersion !== `${id}@${version}` || header.size !== scannedBytes || header.recordCount !== frames)
          throw new AdminError(409, 'Semantic header source changed.');
        const json = JSON.stringify(header);
        const envelope = JSON.stringify({ header, sha256: createHash('sha256').update(json).digest('hex') });
        if (Buffer.byteLength(envelope) > COMMITTED_HEADER_BYTES) throw new AdminError(413, 'Semantic header exceeds budget.');
        this.db.prepare('UPDATE media_index_manifests SET semantic_json=? WHERE media_id=? AND media_version=? AND ' + identityWhere)
          .run(envelope, id, version, ...identityArgs(identity));
      }
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

  finishBuild(id: string, version: string, identity: MediaIndexIdentity, epoch: number, buildId: string, scannedBytes: number, stablePresentationUs: number, frames: number, recovery: FfmpegIndexRecovery & Pick<import('../shared/media/indexing/ffmpeg-index-cache.ts').FfmpegIndexMetadata, 'analysisConfiguration'> = {}) {
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
      if (!metadata?.metadata_json || !validFfmpegRecovery(recovery, Number(JSON.parse(metadata.metadata_json).size)))
        throw new AdminError(500, 'FFmpeg 索引损坏边界无效。');
      const metadataJson = metadata?.metadata_json ? JSON.stringify({ ...JSON.parse(metadata.metadata_json), ...recovery, count: frames }) : null;
      this.db.prepare("UPDATE media_index_manifests SET state='complete',complete=1,scanned_bytes=?,stable_presentation_us=?,frames=?,metadata_json=coalesce(?,metadata_json),accessed_at=? WHERE media_id=? AND media_version=? AND " + identityWhere)
        .run(scannedBytes, stablePresentationUs, frames, metadataJson, Date.now(), id, version, ...identityArgs(identity));
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  failBuild(id: string, version: string, identity: MediaIndexIdentity, buildId: string) {
    this.db.prepare("UPDATE media_index_manifests SET state='failed' WHERE media_id=? AND media_version=? AND " + identityWhere + ' AND build_id=? AND complete=0')
      .run(id, version, ...identityArgs(identity), buildId);
  }

  streamManifest(id: string, version: string, identity: MediaIndexIdentity): FrameIndexManifest {
    if (identity.kind === 'ffmpeg') this.migrateLegacyFfmpegBatches(id, version, identity);
    const row = this.db.prepare('SELECT e.epoch,m.* FROM frame_index_epoch e LEFT JOIN media_index_manifests m ON m.media_id=? AND m.media_version=? AND m.kind=? AND m.stream_key=? AND m.schema_version=? AND m.indexer_build=? WHERE e.id=1')
      .get(id, version, ...identityArgs(identity)) as Record<string, unknown>;
    if (!row?.media_id) return { epoch: Number(row?.epoch ?? this.epoch), manifest: null };
    this.db.prepare('UPDATE media_index_manifests SET accessed_at=? WHERE media_id=? AND media_version=? AND ' + identityWhere)
      .run(Date.now(), id, version, ...identityArgs(identity));
    if ((row.build_id !== null && typeof row.build_id !== 'string') || typeof row.state !== 'string') throw new AdminError(500, '索引 manifest 标识无效。');
    return { epoch: Number(row.epoch), manifest: { buildId: row.build_id, state: row.state, lastSeq: Number(row.last_seq), complete: !!row.complete,
      packets: Number(row.packets), scannedBytes: Number(row.scanned_bytes), stablePresentationUs: Number(row.stable_presentation_us), bytes: Number(row.bytes), frames: Number(row.frames),
      metadata: row.metadata_json ? JSON.parse(String(row.metadata_json)) as Record<string, unknown> : null } };
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

  streamBatches(id: string, version: string, identity: MediaIndexIdentity, after: number, limit = 16): FrameIndexBatch[] {
    return this.db.prepare('SELECT seq,payload,bytes,frames FROM media_index_batches WHERE media_id=? AND media_version=? AND ' + identityWhere + ' AND seq>? ORDER BY seq LIMIT ?')
      .all(id, version, ...identityArgs(identity), after, Math.max(1, Math.min(64, limit))) as FrameIndexBatch[];
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
  semanticHeader?: CommittedIndexHeader;
};

export function prepareFrameIndex(value: unknown, size: number, identityOrKind: MediaIndexIdentity | FrameIndexKind = FLV_MEDIA_INDEX_IDENTITY, sourceVersion?: string, scan?: ScanEvidence): PreparedFrameIndex {
  if (size < 0 || !Number.isSafeInteger(size)) throw new AdminError(400, '媒体大小无效。');
  const expectedKind = typeof identityOrKind === 'string' ? identityOrKind : identityOrKind.kind;
  let identity: MediaIndexIdentity;
  let text: string, bytes: number, frames: number;
  let semanticHeader: CommittedIndexHeader | undefined;
  if(expectedKind==='mp4'){
    const doc=parseMp4QualityDocument(value,size);identity=MP4_QUALITY_MEDIA_INDEX_IDENTITY;
    if(typeof identityOrKind!=='string'&&identityArgs(identityOrKind).some((v,i)=>v!==identityArgs(identity)[i]))throw new AdminError(409,'MP4 quality index identity differs.');
    text=JSON.stringify(doc);bytes=Buffer.byteLength(text);frames=doc.samples.length;if(bytes>PAIR_LIMITS.maxIndexBytes)throw new AdminError(413,'MP4 quality index exceeds byte budget.','budget-exceeded');
  } else if ((expectedKind === 'js-ts'||expectedKind==='js-matroska')) {
    const parsed = sourceVersion ? parseJsPacketIndex(value, sourceVersion, size) : undefined;
    if (!parsed||(parsed.kind==='js-ts-packets')!==(expectedKind==='js-ts')) throw new AdminError(400, 'JS TS 索引格式、源身份或范围无效。');
    identity = expectedKind==='js-ts'?JS_TS_MEDIA_INDEX_IDENTITY:JS_MATROSKA_MEDIA_INDEX_IDENTITY;
    if (typeof identityOrKind !== 'string' && identityArgs(identityOrKind).some((v,i)=>v !== identityArgs(identity)[i]))
      throw new AdminError(409, 'JS TS 索引身份与请求不匹配。');
    if (parsed.kind === 'js-ts-packets') semanticHeader = tsCommittedHeader(parsed);
    text = JSON.stringify(parsed); bytes = Buffer.byteLength(text); frames = parsed.packets.length;
    if (bytes > JS_TS_INDEX_BYTES) throw new AdminError(413, 'JS TS 帧索引过大。');
  } else if (expectedKind === 'ffmpeg') {
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
    try {
      const index = parseFlvIndex(value, size);
      document = serializeFlvIndex(index, size);
      if (sourceVersion) semanticHeader = flvCommittedHeader(index, size, sourceVersion, scan);
    }
    catch (error) { throw new AdminError(400, (error as Error).message); }
    identity = FLV_MEDIA_INDEX_IDENTITY;
    text = JSON.stringify(document);
    bytes = Buffer.byteLength(text);
    frames = document.packets.length;
    if (bytes > FLV_INDEX_BYTES) throw new AdminError(413, '帧索引过大。');
  }
  return { text, bytes, frames, scannedBytes: size, identity, semanticHeader };
}
