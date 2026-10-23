import { packetStorage, readPacketChunk, invalidPackets, PACKET_CHUNK_BYTES, PACKET_READ_BYTES, PACKET_CHUNK_RECORDS } from './committed-packet-storage.ts';
import { committedSemanticRecord, committedRecordSemantics } from '../shared/media/indexing/committed-record-query.ts';
import { COMMITTED_HEADER_BYTES, COMMITTED_HEADER_SCHEMA, COMMITTED_HEADER_VERSION, validCommittedHeader } from '../shared/media/indexing/committed-index-header.ts';
import { createHash } from 'node:crypto';
import type { IndexDatabase } from './sqlite.ts';
import { AdminError } from './admin-error.ts';
import type { MediaIndexIdentity } from '../shared/media/indexing/media-index-identity.ts';
import { describeCachedIndex, supportedCachedMetadata, cachedIndexClock, FFMPEG_INDEX_RECORD_BYTES, MEDIA_QUERY_SCHEMA, MEDIA_QUERY_VERSION, MEDIA_QUERY_DICTIONARY,
  QUERY_SCAN_LIMIT, recordMatches, semanticRecord } from '../shared/media/indexing/semantic-query.ts';
import type { SemanticQuery, SemanticRecord } from '../shared/media/indexing/semantic-query.ts';

const where = 'media_id=? AND media_version=? AND kind=? AND stream_key=? AND schema_version=? AND indexer_build=?';
const args = (id: string, version: string, identity: MediaIndexIdentity) => [id, version, identity.kind, identity.streamKey, identity.schemaVersion, identity.indexerBuild];
const columns = 'CASE WHEN octet_length(packet_storage)<=4096 THEN packet_storage END AS packet_storage,octet_length(packet_storage) AS storage_length,kind,stream_key,schema_version,indexer_build,build_id,state,complete,last_seq,frames,packets,scanned_bytes,stable_presentation_us,CASE WHEN octet_length(metadata_json)<=32768 THEN metadata_json END AS metadata_json,octet_length(metadata_json) AS metadata_length,CASE WHEN octet_length(semantic_json)<=8192 THEN semantic_json END AS semantic_json,octet_length(semantic_json) AS semantic_length,(SELECT size FROM media WHERE media.id=media_id AND media.version=media_version) AS source_size';
type Row = { packet_storage: string | null; storage_length: number | null; kind: string; stream_key: string; schema_version: number; indexer_build: string; build_id: string | null; state: string; complete: number; last_seq: number; frames: number; packets: number; scanned_bytes: number; stable_presentation_us: number; metadata_json: string | null; metadata_length: number | null; semantic_json: string | null; semantic_length: number | null; source_size: number };
const header = { schema: MEDIA_QUERY_SCHEMA, version: MEDIA_QUERY_VERSION, describedBy: MEDIA_QUERY_DICTIONARY };
function metadata(row: Row | undefined): Record<string, unknown> | null {
  if (!row?.metadata_json || Number(row.metadata_length) > 32768) return null;
  try { return JSON.parse(row.metadata_json); } catch { return null; }
}
function committedHeader(row: Row, identity: MediaIndexIdentity, sourceVersion: string) {
  const unavailable = (semanticReason: string) => ({ semanticHeader: null, semanticReason });
  if (row.semantic_length === null) return unavailable('semantic-header-missing');
  if (row.semantic_length > COMMITTED_HEADER_BYTES) return unavailable('semantic-header-too-large');
  try {
    const envelope = JSON.parse(row.semantic_json!);
    if (!envelope?.header || typeof envelope.sha256 !== 'string' || envelope.sha256 !== createHash('sha256').update(JSON.stringify(envelope.header)).digest('hex')) return unavailable('semantic-header-invalid');
    if (envelope.header.schema !== COMMITTED_HEADER_SCHEMA || envelope.header.version !== COMMITTED_HEADER_VERSION) return unavailable('semantic-header-version-unsupported');
    if (!validCommittedHeader(envelope.header, identity, sourceVersion, row.source_size, row.frames)) return unavailable('semantic-header-invalid');
    return { semanticHeader: envelope.header };
  } catch { return unavailable('semantic-header-invalid'); }
}
function describe(row: Row | undefined, identity: MediaIndexIdentity, sourceVersion: string) {
  const evidence = row ? committedHeader(row, identity, sourceVersion) : { semanticHeader: null };
  const overview = describeCachedIndex(row ? { complete: !!row.complete, state: row.state, recordCount: row.frames,
    scannedBytes: row.scanned_bytes, stablePresentationUs: row.stable_presentation_us, metadata: metadata(row), ...evidence } : null, identity);
  if (identity.kind !== 'flv' && identity.kind !== 'js-ts') return overview;
  const storage = row && packetStorage(row.packet_storage, identity, sourceVersion, row.frames, row.last_seq);
  const ready = !!storage && !!evidence.semanticHeader && !!row?.complete && row.state === 'complete';
  const reason = !row ? 'cache-miss' : !storage ? row.storage_length === null ? 'packet-storage-unavailable-explicit-reindex-required' : 'packet-storage-invalid-or-unsupported'
    : !evidence.semanticHeader ? overview.reason : !ready ? 'build-state-inconsistent' : null;
  return { ...overview, recordSemantics: committedRecordSemantics(identity.kind), capabilities: { ...overview.capabilities,
    records: { implemented: true, enabled: true, ready, reason } } };

}

/** Deliberately bypass legacy streamManifest(): that entry may migrate a whole document. */
export class MediaIndexQueryStore {
  private db: IndexDatabase;
  constructor(db: IndexDatabase) { this.db = db; }
  inventory(id: string, version: string, offset: number) {
    const rows = this.db.prepare(`SELECT ${columns} FROM media_index_manifests WHERE media_id=? AND media_version=? ORDER BY kind,stream_key,schema_version,indexer_build LIMIT 17 OFFSET ?`).all(id, version, offset) as unknown as Row[];
    return { ...header, indexes: rows.slice(0, 16).map(row => describe(row, {
      kind: row.kind as MediaIndexIdentity['kind'], streamKey: row.stream_key, schemaVersion: row.schema_version, indexerBuild: row.indexer_build,
    }, `${id}@${version}`)), nextOffset: rows.length > 16 ? offset + 16 : null, inventoryConsistency: 'per-request' };
  }
  query(id: string, version: string, identity: MediaIndexIdentity, query?: SemanticQuery, cursor?: string, cancellation?: SharedArrayBuffer) {
    const check = () => { if (cancellation && Atomics.load(new Int32Array(cancellation), 0)) throw new AdminError(499, 'Cached query cancelled.', 'media-query-cancelled'); };
    check();
    this.db.exec('BEGIN');
    try { return this.read(id, version, identity, query, cursor, check); }
    finally { this.db.exec('ROLLBACK'); }
  }
  private read(id: string, version: string, identity: MediaIndexIdentity, query?: SemanticQuery, cursor?: string, check = () => {}) {
    check();
    const row = this.db.prepare(`SELECT ${columns} FROM media_index_manifests WHERE ${where}`).get(...args(id, version, identity)) as Row | undefined;
    const overview = describe(row, identity, `${id}@${version}`), m = metadata(row);
    const epoch = this.db.prepare('SELECT epoch FROM frame_index_epoch WHERE id=1').get()!.epoch;
    const snapshot = createHash('sha256').update(JSON.stringify([id, version, identity, epoch, row ?? null, query ? [query.axis, query.startTick, query.endTick] : null])).digest('hex');
    const result = this.overviewResult(id, version, snapshot, overview);
    if (!query) return result;
    const committed = identity.kind === 'flv' || identity.kind === 'js-ts';
    let seq = committed ? 1 : 0, offset = 0;
    if (cursor) {
      const match = /^([0-9a-f]{64})\.(\d{1,10})\.(\d{1,10})$/.exec(cursor);
      if (!match) throw new AdminError(400, 'Invalid index cursor.', 'invalid-index-query');
      if (match[1] !== snapshot) throw new AdminError(409, 'Index snapshot changed; restart without cursor.', 'index-snapshot-changed');
      seq = Number(match[2]); offset = Number(match[3]);
    }
    if (row && committed && overview.capabilities.records.ready) return this.readPackets(result, row, id, version, identity, query, seq, offset, check);
    if (!row || committed || !supportedCachedMetadata(identity, m)) return { ...result, query, records: [], summary: null, inspected: 0, inspectedUntimed: 0, exhausted: false, nextCursor: null };
    if (seq > row!.last_seq + 1 || (seq === row!.last_seq + 1 && offset !== 0)) throw new AdminError(400, 'Index cursor exceeds snapshot.', 'invalid-index-query');
    const records: SemanticRecord[] = [];
    let inspected = 0, inspectedUntimed = 0, recordBytes = 0, sumBytes = 0, keyCount = 0;
    const recordBudget = query.byteBudget - Buffer.byteLength(JSON.stringify({ ...result, query })) - 2048;
    if (recordBudget < 1024) throw new AdminError(413, 'Response context exceeds byteBudget.', 'response-budget-too-small');
    const c = cachedIndexClock(m);
    // octet_length(column) reads the on-disk length without loading TEXT. CASE
    // prevents SQLite from materializing an oversized/corrupt batch for substr.
    // https://www.sqlite.org/lang_corefunc.html#octet_length
    // Normal writers store at most 768 records; cap native allocations at 64 KiB.
    // Each JS read selects at most 128*64 base64 characters.
    // 48-byte records occupy exactly 64 base64 characters (no padding).
    while (seq <= row!.last_seq && inspected < QUERY_SCAN_LIMIT && records.length < query.limit) {
      check();
      const take = Math.min(128, QUERY_SCAN_LIMIT - inspected);
      const batch = this.db.prepare(`SELECT frames,octet_length(payload) AS length,CASE WHEN octet_length(payload)<=65536 THEN substr(payload,?,?) END AS slice FROM media_index_batches WHERE ${where} AND seq=?`)
        .get(offset * 64 + 1, take * 64, ...args(id, version, identity), seq) as { frames: number; length: number; slice: string | null } | undefined;
      if (!batch || batch.slice === null || batch.length !== batch.frames * 64 || offset >= batch.frames || batch.frames < 1) throw new AdminError(409, 'Cached index records are unavailable or inconsistent.', 'index-cache-invalid');
      const count = Math.min(take, batch.frames - offset);
      if (!/^[A-Za-z0-9+/]+$/.test(batch.slice) || batch.slice.length !== count * 64) throw new AdminError(409, 'Cached index encoding is invalid.', 'index-cache-invalid');
      const bytes = Buffer.from(batch.slice, 'base64');
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      let stop = false;
      for (let i = 0; i < count; i++) {
        const record = semanticRecord(view, i * FFMPEG_INDEX_RECORD_BYTES, c), matches = recordMatches(record, query);
        if (record.sizeBytes < 0) throw new AdminError(409, 'Cached packet size is invalid.', 'index-cache-invalid');
        if (matches) {
          const length = Buffer.byteLength(JSON.stringify(record)) + 1;
          if (recordBytes + length > recordBudget) { stop = true; break; }
          recordBytes += length; records.push(record); sumBytes += record.sizeBytes; keyCount += Number(record.containerKey);
        } else if (matches === null) inspectedUntimed++;
        inspected++; offset++;
        if (records.length >= query.limit) { stop = true; break; }
      }
      if (offset === batch.frames) { seq++; offset = 0; }
      if (stop) break;
    }
    const exhausted = seq > row!.last_seq;
    return { ...result, query, records, inspected, inspectedUntimed, exhausted,
      nextCursor: exhausted ? null : `${snapshot}.${seq}.${offset}`,
      summary: { scope: 'returned-records-only', count: records.length, sumBytes, containerKeyCount: keyCount } };
  }
  private readPackets(result: ReturnType<MediaIndexQueryStore['overviewResult']>, row: Row, id: string, version: string, identity: MediaIndexIdentity,
    query: SemanticQuery, initialSeq: number, initialOffset: number, check: () => void) {
    const storage = packetStorage(row.packet_storage, identity, `${id}@${version}`, row.frames, row.last_seq)!;
    const context = committedHeader(row, identity, `${id}@${version}`).semanticHeader!;
    let seq = initialSeq, offset = initialOffset;
    if (seq < 1 || seq > storage.chunks + 1 || (seq === storage.chunks + 1 && offset !== 0)
      || seq <= storage.chunks && offset >= Math.min(PACKET_CHUNK_RECORDS, storage.records - (seq - 1) * PACKET_CHUNK_RECORDS))
      throw new AdminError(400, 'Index cursor exceeds snapshot.', 'invalid-index-query');
    const records: ReturnType<typeof committedSemanticRecord>[] = [];
    let inspected = 0, inspectedUntimed = 0, recordBytes = 0, sumBytes = 0, keyCount = 0, readBytes = 0, chunksRead = 0;
    const recordBudget = query.byteBudget - Buffer.byteLength(JSON.stringify({ ...result, query })) - 2048;
    if (recordBudget < 1024) throw new AdminError(413, 'Response context exceeds byteBudget.', 'response-budget-too-small');
    while (seq <= storage.chunks && inspected < QUERY_SCAN_LIMIT && records.length < query.limit) {
      check();
      // Reserve the maximum allocation before selecting a TEXT value. Never
      // substr/CAST the old whole-document column: SQLite materializes it.
      if (readBytes + PACKET_CHUNK_BYTES > PACKET_READ_BYTES) break;
      const batch = this.db.prepare(`SELECT frames,bytes,octet_length(payload) AS length,CASE WHEN octet_length(payload)<=${PACKET_CHUNK_BYTES} THEN payload END AS payload FROM media_index_batches WHERE ${where} AND seq=?`)
        .get(...args(id, version, identity), seq) as { frames: number; bytes: number; length: number; payload: string | null } | undefined;
      if (!batch || typeof batch.payload !== 'string' || batch.length !== batch.bytes) return invalidPackets();
      readBytes += batch.length; chunksRead++;
      const packets = readPacketChunk(batch.payload, seq, batch.frames, storage);
      let stopped = false;
      while (offset < packets.length && inspected < QUERY_SCAN_LIMIT && records.length < query.limit) {
        check();
        let record;
        try { record = committedSemanticRecord(packets[offset], (seq - 1) * PACKET_CHUNK_RECORDS + offset, context); }
        catch { return invalidPackets(); }
        const matches = recordMatches(record, query);
        if (matches) {
          const length = Buffer.byteLength(JSON.stringify(record)) + 1;
          if (recordBytes + length > recordBudget) { stopped = true; break; }
          records.push(record); recordBytes += length; sumBytes += record.sizeBytes; keyCount += Number(record.containerKey);
        } else if (matches === null) inspectedUntimed++;
        inspected++; offset++;
      }
      if (offset === packets.length) { seq++; offset = 0; }
      if (stopped) break;
    }
    check();
    const exhausted = seq > storage.chunks;
    return { ...result, query, records, inspected, inspectedUntimed, exhausted, readBytes, chunksRead,
      workLimits: { inspected: QUERY_SCAN_LIMIT, packetReadBytes: PACKET_READ_BYTES, chunkBytes: PACKET_CHUNK_BYTES },
      nextCursor: exhausted ? null : `${result.snapshot}.${seq}.${offset}`,
      summary: { scope: 'returned-records-only', count: records.length, sumBytes, containerKeyCount: keyCount } };
  }
  private overviewResult(id: string, version: string, snapshot: string, overview: ReturnType<typeof describe>) {
    return { ...header, source: { id, version }, snapshot, overview };
  }

}
