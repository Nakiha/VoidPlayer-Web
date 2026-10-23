import { createHash } from 'node:crypto';
import type { IndexDatabase } from './sqlite.ts';
import { AdminError } from './admin-error.ts';
import type { MediaIndexIdentity } from '../shared/media/indexing/media-index-identity.ts';
import { cachedField, FFMPEG_INDEX_RECORD_BYTES, MEDIA_QUERY_SCHEMA, MEDIA_QUERY_VERSION, MEDIA_QUERY_DICTIONARY,
  QUERY_SCAN_LIMIT, recordMatches, semanticRecord } from '../shared/media/indexing/semantic-query.ts';
import type { SemanticQuery, SemanticRecord } from '../shared/media/indexing/semantic-query.ts';

const where = 'media_id=? AND media_version=? AND kind=? AND stream_key=? AND schema_version=? AND indexer_build=?';
const args = (id: string, version: string, identity: MediaIndexIdentity) => [id, version, identity.kind, identity.streamKey, identity.schemaVersion, identity.indexerBuild];
const columns = 'kind,stream_key,schema_version,indexer_build,build_id,state,complete,last_seq,frames,packets,scanned_bytes,stable_presentation_us,CASE WHEN octet_length(metadata_json)<=32768 THEN metadata_json END AS metadata_json,octet_length(metadata_json) AS metadata_length';
type Row = { kind: string; stream_key: string; schema_version: number; indexer_build: string; build_id: string | null; state: string; complete: number; last_seq: number; frames: number; packets: number; scanned_bytes: number; stable_presentation_us: number; metadata_json: string | null; metadata_length: number | null };
const header = { schema: MEDIA_QUERY_SCHEMA, version: MEDIA_QUERY_VERSION, describedBy: MEDIA_QUERY_DICTIONARY };
function metadata(row: Row | undefined): Record<string, unknown> | null {
  if (!row?.metadata_json || Number(row.metadata_length) > 32768) return null;
  try { return JSON.parse(row.metadata_json); } catch { return null; }
}
function supported(row: Row | undefined, m: Record<string, unknown> | null): boolean {
  return !!row && row.kind === 'ffmpeg' && row.schema_version === 3 && !!m
    && m.recordBytes === 48 && m.schema === 3 && m.kind === 'ffmpeg-container'
    && typeof m.codec === 'string' && /^[a-z0-9_+-]{1,64}$/i.test(m.codec)
    && m.indexerBuild === row.indexer_build && `video:${m.streamIndex}` === row.stream_key
    && Number.isSafeInteger(m.timeBaseNum) && Number(m.timeBaseNum) > 0 && Number(m.timeBaseNum) <= 1e9
    && Number.isSafeInteger(m.timeBaseDen) && Number(m.timeBaseDen) > 0 && Number(m.timeBaseDen) <= 1e9;
}
function clock(m: Record<string, unknown> | null) {
  const firstPts = typeof m?.firstPts === 'string' && /^-?\d{1,19}$/.test(m.firstPts) && BigInt(m.firstPts) > -9223372036854775808n && BigInt(m.firstPts) <= 9223372036854775807n ? m.firstPts : null;
  return { num: Number(m?.timeBaseNum), den: Number(m?.timeBaseDen), firstPts, originVerified: m?.originVerified === true && firstPts !== null };
}
function describe(row: Row | undefined, identity: MediaIndexIdentity) {
  const m = metadata(row), ready = supported(row, m), c = clock(ready ? m : null);
  const state = !row ? 'not-indexed' : !ready ? 'unknown' : row.complete && m!.indexIntegrity === 'complete' ? 'complete' : 'partial';
  const reason = !row ? 'cache-miss' : !ready ? 'semantic-adapter-unavailable' : m!.indexIntegrity === 'prefix' ? 'retained-prefix'
    : row.state === 'failed' ? 'build-failed' : !row.complete ? 'build-in-progress' : m!.indexIntegrity !== 'complete' ? 'integrity-unknown' : null;
  const technical: Record<string, ReturnType<typeof cachedField>> = {};
  for (const key of ['codec', 'width', 'height', 'timeBaseNum', 'timeBaseDen', 'streamIndex']) {
    const value = ready ? m![key] : undefined;
    technical[key] = cachedField((typeof value === 'number' && Number.isSafeInteger(value) && (key === 'streamIndex' ? value >= 0 : value > 0)) || typeof value === 'string' ? value : null, reason ?? 'not-stored-in-index');
  }
  for (const key of ['container', 'profile', 'codedWidth', 'codedHeight', 'visibleWidth', 'visibleHeight', 'sar', 'rotation', 'bitDepth', 'pixelFormat', 'sourceColorPrimaries', 'sourceColorTransfer', 'sourceColorMatrix', 'sourceColorRange', 'durationUs', 'frameRateMode', 'frameRate', 'bitrate', 'decodedFrameCount']) {
    technical[key] = !row ? { value: null, status: 'not-probed', source: 'unavailable', reason: 'cache-miss' } : cachedField(null);
  }
  return {
    identity, state, reason, terminal: !!row?.complete, buildState: row?.state ?? null,
    recordCount: row?.frames ?? null, scannedBytes: row?.scanned_bytes ?? null,
    // Uploads/legacy caches set 0 without deriving a watermark; do not claim coverage.
    stablePresentationUs: ready && c.originVerified && Number(row?.stable_presentation_us) > 0 ? String(row!.stable_presentation_us) : null,
    integrity: ready && (m!.indexIntegrity === 'complete' || m!.indexIntegrity === 'prefix') ? m!.indexIntegrity : 'unknown',
    clock: { timeBase: ready ? { numerator: c.num, denominator: c.den, unit: 'seconds-per-tick' } : null,
      firstPts: c.firstPts, originVerified: c.originVerified, rangeDomain: 'original-stream-ticks' },
    technical,
    capabilities: { overview: { implemented: true, enabled: true, ready: true },
      records: { implemented: identity.kind === 'ffmpeg' && identity.schemaVersion === 3, enabled: identity.kind === 'ffmpeg' && identity.schemaVersion === 3, ready, reason: ready ? null : reason } },
  };
}

/** Deliberately bypass legacy streamManifest(): that entry may migrate a whole document. */
export class MediaIndexQueryStore {
  private db: IndexDatabase;
  constructor(db: IndexDatabase) { this.db = db; }
  inventory(id: string, version: string, offset: number) {
    const rows = this.db.prepare(`SELECT ${columns} FROM media_index_manifests WHERE media_id=? AND media_version=? ORDER BY kind,stream_key,schema_version,indexer_build LIMIT 17 OFFSET ?`).all(id, version, offset) as unknown as Row[];
    return { ...header, indexes: rows.slice(0, 16).map(row => describe(row, {
      kind: row.kind as MediaIndexIdentity['kind'], streamKey: row.stream_key, schemaVersion: row.schema_version, indexerBuild: row.indexer_build,
    })), nextOffset: rows.length > 16 ? offset + 16 : null, inventoryConsistency: 'per-request' };
  }
  query(id: string, version: string, identity: MediaIndexIdentity, query?: SemanticQuery, cursor?: string) {
    this.db.exec('BEGIN');
    try { return this.read(id, version, identity, query, cursor); }
    finally { this.db.exec('ROLLBACK'); }
  }
  private read(id: string, version: string, identity: MediaIndexIdentity, query?: SemanticQuery, cursor?: string) {
    const row = this.db.prepare(`SELECT ${columns} FROM media_index_manifests WHERE ${where}`).get(...args(id, version, identity)) as Row | undefined;
    const overview = describe(row, identity), m = metadata(row);
    const epoch = this.db.prepare('SELECT epoch FROM frame_index_epoch WHERE id=1').get()!.epoch;
    const snapshot = createHash('sha256').update(JSON.stringify([id, version, identity, epoch, row ?? null, query ? [query.axis, query.startTick, query.endTick] : null])).digest('hex');
    const result = { ...header, source: { id, version }, snapshot, overview };
    if (!query) return result;
    let seq = 0, offset = 0;
    if (cursor) {
      const match = /^([0-9a-f]{64})\.(\d{1,10})\.(\d{1,10})$/.exec(cursor);
      if (!match) throw new AdminError(400, 'Invalid index cursor.', 'invalid-index-query');
      if (match[1] !== snapshot) throw new AdminError(409, 'Index snapshot changed; restart without cursor.', 'index-snapshot-changed');
      seq = Number(match[2]); offset = Number(match[3]);
    }
    if (!supported(row, m)) return { ...result, query, records: [], summary: null, inspected: 0, inspectedUntimed: 0, exhausted: false, nextCursor: null };
    if (seq > row!.last_seq + 1 || (seq === row!.last_seq + 1 && offset !== 0)) throw new AdminError(400, 'Index cursor exceeds snapshot.', 'invalid-index-query');
    const records: SemanticRecord[] = [];
    let inspected = 0, inspectedUntimed = 0, recordBytes = 0, sumBytes = 0, keyCount = 0;
    const recordBudget = query.byteBudget - Buffer.byteLength(JSON.stringify({ ...result, query })) - 2048;
    if (recordBudget < 1024) throw new AdminError(413, 'Response context exceeds byteBudget.', 'response-budget-too-small');
    const c = clock(m);
    // octet_length(column) reads the on-disk length without loading TEXT. CASE
    // prevents SQLite from materializing an oversized/corrupt batch for substr.
    // https://www.sqlite.org/lang_corefunc.html#octet_length
    // Normal writers store at most 768 records; cap native allocations at 64 KiB.
    // Each JS read selects at most 128*64 base64 characters.
    // 48-byte records occupy exactly 64 base64 characters (no padding).
    while (seq <= row!.last_seq && inspected < QUERY_SCAN_LIMIT && records.length < query.limit) {
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
}
