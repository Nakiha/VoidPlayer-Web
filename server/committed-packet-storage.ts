import { createHash, randomUUID } from 'node:crypto';
import type { MediaIndexIdentity } from '../shared/media/indexing/media-index-identity.ts';
import { AdminError } from './admin-error.ts';

export const PACKET_CHUNK_RECORDS = 64;
export const PACKET_CHUNK_BYTES = 65536;
export const PACKET_STORAGE_BYTES = 4096;
export const PACKET_READ_BYTES = 262144;
const schema = 'voidplayer-packet-storage';
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
export type PacketStorage = {
  schema: typeof schema; version: 1; commitId: string; sourceVersion: string; identity: MediaIndexIdentity;
  records: number; chunks: number; chunkRecords: number; chunkBytes: number;
  documentSha256: string; metadataSha256: string;
};
export const invalidPackets = (): never => { throw new AdminError(409, 'Cached packet storage is inconsistent; explicitly rebuild the index.', 'index-cache-invalid'); };
export function preparePacketStorage(text: string, sourceVersion: string, identity: MediaIndexIdentity) {
  const document = JSON.parse(text), packets: unknown[] = document.packets;
  document.packets = null; // Keep the original property position for the JS document seal.
  const metadata = JSON.stringify(document), commitId = randomUUID();
  const chunks: { payload: string; frames: number }[] = [];
  for (let first = 0; first < packets.length; first += PACKET_CHUNK_RECORDS) {
    const part = packets.slice(first, first + PACKET_CHUNK_RECORDS);
    const payload = JSON.stringify({ version: 1, commitId, seq: chunks.length + 1, first, packets: part, sha256: sha(JSON.stringify(part)) });
    if (Buffer.byteLength(payload) > PACKET_CHUNK_BYTES) throw new AdminError(413, 'Packet chunk exceeds storage budget.', 'packet-storage-too-large');
    chunks.push({ payload, frames: part.length });
  }
  const storage: PacketStorage = { schema, version: 1, commitId, sourceVersion, identity, records: packets.length, chunks: chunks.length,
    chunkRecords: PACKET_CHUNK_RECORDS, chunkBytes: PACKET_CHUNK_BYTES, documentSha256: sha(text), metadataSha256: sha(metadata) };
  return { metadata, chunks, storage };
}
export function packetStorage(raw: string | null, identity: MediaIndexIdentity, sourceVersion: string, records: number, lastSeq: number): PacketStorage | null {
  if (!raw || Buffer.byteLength(raw) > PACKET_STORAGE_BYTES) return null;
  try {
    const s = JSON.parse(raw);
    if (s.schema !== schema || s.version !== 1 || typeof s.commitId !== 'string' || !/^[0-9a-f-]{36}$/.test(s.commitId) || s.sourceVersion !== sourceVersion
      || !s.identity || Object.keys(identity).some(k => identity[k as keyof MediaIndexIdentity] !== s.identity[k])
      || !Number.isSafeInteger(records) || records < 1 || s.records !== records
      || s.chunks !== Math.ceil(records / PACKET_CHUNK_RECORDS) || s.chunks !== lastSeq
      || s.chunkRecords !== PACKET_CHUNK_RECORDS || s.chunkBytes !== PACKET_CHUNK_BYTES
      || !/^[a-f0-9]{64}$/.test(s.documentSha256) || !/^[a-f0-9]{64}$/.test(s.metadataSha256)) return null;
    return s;
  } catch { return null; }
}
export function readPacketChunk(payload: string, seq: number, frames: number, storage: PacketStorage): unknown[] {
  if (Buffer.byteLength(payload) > PACKET_CHUNK_BYTES || !Number.isSafeInteger(seq) || seq < 1 || seq > storage.chunks) return invalidPackets();
  try {
    const c = JSON.parse(payload), first = (seq - 1) * PACKET_CHUNK_RECORDS;
    const expected = Math.min(PACKET_CHUNK_RECORDS, storage.records - first);
    if (c.version !== 1 || c.commitId !== storage.commitId || c.seq !== seq || c.first !== first || frames !== expected
      || !Array.isArray(c.packets) || c.packets.length !== expected || c.sha256 !== sha(JSON.stringify(c.packets))) return invalidPackets();
    return c.packets;
  } catch { return invalidPackets(); }
}
export function restorePacketDocument(metadata: string, chunks: { seq: number; payload: string; frames: number }[], storage: PacketStorage) {
  if (sha(metadata) !== storage.metadataSha256 || chunks.length !== storage.chunks) return invalidPackets();
  const document = JSON.parse(metadata);
  if (document.packets !== null) return invalidPackets();
  document.packets = chunks.flatMap((c, i) => {
    if (c.seq !== i + 1) return invalidPackets();
    return readPacketChunk(c.payload, c.seq, c.frames, storage);
  });
  const text = JSON.stringify(document);
  if (sha(text) !== storage.documentSha256) return invalidPackets();
  return text;
}
