import { CustomSource, EncodedPacketSink, Input, MPEG_TS } from 'mediabunny';
import type { EncodedPacket } from 'mediabunny';
import { MediaOpenError } from './media-errors.ts';
import { inspectPacketPicture } from './packet-picture.ts';
import { isAnnexB, nalRanges } from './nal-framing.ts';
import { parseAvcSps } from './avc-geometry.ts';

export const TS_PACKET_BUILD = 'mediabunny-1.55.7-ts-packets-v2';
export interface TsPacketReader {
  readonly size: number;
  read(offset: number, length: number): Promise<Uint8Array>;
  close(): void;
}
export interface TsPacketRecord {
  au: number;
  /** Opaque Mediabunny locator. Never used as a payload byte offset. */
  locator: number;
  configuration: 0;
  /** Validated physical PES header position; never a compressed payload range. */
  pesOffset: number | null;
  timestamp: number;
  ptsUs: number;
  durationUs: number;
  size: number;
  key: boolean;
  timing: { pts: number | null; dts: number | null; timebase: [1, 90000]; origin: 'pes' | 'derived' };
}
export interface TsPacketIndex {
  schema: 2;
  completeness: { state: 'complete'; packets: number };
  kind: 'js-ts-packets';
  build: typeof TS_PACKET_BUILD;
  sourceVersion: string;
  size: number;
  streamKey: 'video:0';
  pid: number;
  codec: 'h264';
  configuration: number[];
  packets: TsPacketRecord[];
}
// A document's own flags/checksum cannot prove AU completeness. Only this
// module's complete source enumeration can mint a reusable metadata proof.
// Weak references retain no index storage and the registry is bounded.
const verifiedIndexes: WeakRef<TsPacketIndex>[] = [];
function sealCompleteIndex(index: TsPacketIndex): TsPacketIndex {
  for (const packet of index.packets) { Object.freeze(packet.timing.timebase); Object.freeze(packet.timing); Object.freeze(packet); }
  Object.freeze(index.configuration); Object.freeze(index.packets); Object.freeze(index.completeness); Object.freeze(index);
  verifiedIndexes.push(new WeakRef(index));
  if (verifiedIndexes.length > 32) verifiedIndexes.shift();
  return index;
}
/** Exact metadata equality to a still-live, immutable complete scan. Serialized
 * documents alone (including self-reported completeness) are untrusted. */
export function isVerifiedCompleteTsIndex(index: TsPacketIndex): boolean {
  if (index.schema !== 2 || index.kind !== 'js-ts-packets' || index.codec !== 'h264' || index.streamKey !== 'video:0'
    || index.completeness?.state !== 'complete' || index.completeness.packets !== index.packets.length) return false;
  return verifiedIndexes.some(reference => {
    const known = reference.deref();
    if (known === index) return true;
    if (!known || known.sourceVersion !== index.sourceVersion || known.size !== index.size || known.pid !== index.pid
      || known.build !== index.build || known.schema !== index.schema || known.packets.length !== index.packets.length
      || known.configuration.length !== index.configuration.length || known.configuration.some((v,i)=>v!==index.configuration[i])) return false;
    return known.packets.every((p,i)=>{
      const candidate = index.packets[i];
      return p.au === candidate.au && p.locator === candidate.locator && p.configuration === candidate.configuration
        && p.pesOffset === candidate.pesOffset && p.timestamp === candidate.timestamp && p.ptsUs === candidate.ptsUs
        && p.durationUs === candidate.durationUs && p.size === candidate.size && p.key === candidate.key
        && p.timing.pts === candidate.timing.pts && p.timing.dts === candidate.timing.dts
        && p.timing.origin === candidate.timing.origin && p.timing.timebase[0] === candidate.timing.timebase[0]
        && p.timing.timebase[1] === candidate.timing.timebase[1];
    });
  });
}

function fail(message: string): never { throw new MediaOpenError('container', `JS TS: ${message}`); }
const equal = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((value, i) => value === b[i]);
const ticks = (b: Uint8Array, at: number, prefix: number): number => {
  if (at + 5 > b.length || b[at] >> 4 !== prefix || !(b[at] & 1) || !(b[at + 2] & 1) || !(b[at + 4] & 1)) fail('invalid PES clock markers');
  return ((b[at] >> 1) & 7) * 2 ** 30 + b[at + 1] * 2 ** 22 + (b[at + 2] >> 1) * 2 ** 15 + b[at + 3] * 128 + (b[at + 4] >> 1);
};

/** Raw-clock supplement only. Mediabunny still owns PSI, PES payload reassembly,
 * AU demux and packet seeking. This first admission is finite 188-byte TS. */
async function pesClocks(reader: TsPacketReader, pid: number, signal: AbortSignal) {
  if (reader.size % 188) fail('truncated or non-188-byte transport');
  const clocks = new Map<number, { pts: number | null; dts: number | null }>();
  let previousCounter: number | undefined;
  try {
  for (let start = 0; start < reader.size; start += 188 * 1024) {
    signal.throwIfAborted();
    const block = await reader.read(start, Math.min(188 * 1024, reader.size - start));
    signal.throwIfAborted();
    for (let at = 0; at < block.length; at += 188) {
      if (block[at] !== 0x47) fail('transport sync mismatch');
      if (((block[at + 1] & 31) * 256 + block[at + 2]) !== pid) continue;
      if (block[at + 1] & 0x80 || block[at + 3] & 0xc0) fail('errored or scrambled video transport');
      const control = (block[at + 3] >> 4) & 3;
      if (!control) fail('invalid transport adaptation control');
      let payload = at + 4;
      if (control & 2) {
        const length = block[payload];
        if (payload + 1 + length > at + 188) fail('invalid transport adaptation length');
        if (length && block[payload + 1] & 0x80) fail('transport discontinuity is outside static admission');
        payload += length + 1;
      }
      if (!(control & 1) || payload === at + 188) continue;
      const counter = block[at + 3] & 15;
      if (previousCounter !== undefined && counter !== (previousCounter + 1) % 16) fail('video transport continuity gap');
      previousCounter = counter;
      if (!(block[at + 1] & 0x40)) continue;
      if (payload + 9 > at + 188) fail('split PES clock header is outside initial admission');
      const b = block.subarray(payload, at + 188);
      if (b[0] || b[1] || b[2] !== 1 || b[3] < 0xe0 || b[3] > 0xef || b[6] >> 6 !== 2) fail('invalid video PES header');
      const flags = b[7] >> 6, expected = flags === 3 ? 10 : flags === 2 ? 5 : 0;
      if (flags === 1 || b[8] < expected || 9 + expected > b.length) fail('invalid PES clock header');
      if (clocks.size >= 250000) throw new MediaOpenError('resource', 'JS TS: PES clock budget exceeded');
      clocks.set(start + at, { pts: flags === 2 || flags === 3 ? ticks(b, 9, flags) : null, dts: flags === 3 ? ticks(b, 14, 1) : null });
    }
  }
  return clocks;
  } catch (error) { clocks.clear(); throw error; }
}

/** Thin, independently owned demux/index cursor shared by decoder and analysis
 * consumers. No WASM, decoder, playback seek or persistent cache is owned here. */
export class TsPacketSource {
  private input: Input;
  private sink?: EncodedPacketSink;
  private closed = false;
  private cursor?: { au: number; packet: EncodedPacket };
  private sets = new Map<number, Uint8Array>();
  index?: TsPacketIndex;
  nativeConfig?: VideoDecoderConfig;
  bytesRead = 0;
  packetsRead = 0;
  indexReused = false;
  private reader: TsPacketReader;
  private sourceVersion: string;
  private signal: AbortSignal;
  private abort = () => this.close();
  constructor(reader: TsPacketReader, sourceVersion: string, signal: AbortSignal) {
    this.reader = reader; this.sourceVersion = sourceVersion; this.signal = signal;
    try {
    signal.throwIfAborted();
    if (!sourceVersion || !Number.isSafeInteger(reader.size) || reader.size <= 0) fail('missing source identity/size');
    this.input = new Input({ formats: [MPEG_TS], source: new CustomSource({ getSize: () => reader.size,
      read: async (start, end) => this.read(start, end - start), maxCacheSize: 1024 * 1024 }) });
    signal.addEventListener('abort', this.abort, { once: true });
    } catch (error) { reader.close(); throw error; }
  }
  private check() { this.signal.throwIfAborted(); if (this.closed) throw new MediaOpenError('input', 'JS TS source is closed'); }
  private async read(offset: number, size: number) {
    this.check();
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(size) || offset < 0 || size < 0 || size > 32*1024*1024 || offset+size > this.reader.size) fail('read bounds exceeded');
    const bytes = await this.reader.read(offset, size); this.check();
    if (!(bytes instanceof Uint8Array) || bytes.length !== size) fail('short transport read');
    this.bytesRead += bytes.length; return bytes;
  }
  private validatePicture(bytes: Uint8Array, configuration: Uint8Array) {
    if (!isAnnexB(bytes)) fail('expected Annex-B access unit');
    const evidence = inspectPacketPicture('h264', configuration, bytes);
    if (!evidence.singlePicture) fail(`unverified picture layout: ${evidence.reason}`);
    for (const nal of nalRanges('h264', configuration, bytes)) {
      const data = bytes.subarray(nal.offset, nal.offset + nal.size), type = data[0] & 31;
      if (type !== 7 && type !== 8) continue;
      const stored = this.sets.get(type);
      if (!stored || !equal(stored, data)) fail('parameter-set changes are outside static admission');
    }
    return evidence;
  }
  async open(cached?: unknown): Promise<TsPacketIndex> {
    try {
      this.check(); await this.input.getFormat(); this.check();
      const tracks = await this.input.getVideoTracks();
      if (tracks.length !== 1 || await tracks[0].getCodec() !== 'avc') fail('requires one H.264 video track');
      const track = tracks[0];
      this.nativeConfig = await track.getDecoderConfig() ?? undefined;
      this.sink = new EncodedPacketSink(track);
      const first = await this.sink.getFirstPacket(); this.check();
      if (!first || !isAnnexB(first.data)) fail('missing Annex-B first packet');
      if (first.byteLength > 32*1024*1024) throw new MediaOpenError('resource', 'JS TS: access-unit size budget exceeded');
      for (const nal of nalRanges('h264', new Uint8Array([0, 0, 1]), first.data)) {
        const data = first.data.subarray(nal.offset, nal.offset + nal.size), type = data[0] & 31;
        if (type !== 7 && type !== 8) continue;
        if (this.sets.has(type)) fail('multiple parameter sets are outside initial admission');
        if (type === 7 && parseAvcSps(data).interlaced) fail('interlaced H.264 is outside initial admission');
        this.sets.set(type, data.slice());
      }
      if (this.sets.size !== 2) fail('missing static SPS/PPS');
      const configuration = new Uint8Array([...new Uint8Array([0, 0, 0, 1]), ...this.sets.get(7)!, 0, 0, 0, 1, ...this.sets.get(8)!]);
      if (configuration.length > 4096) fail('configuration budget exceeded');
      if (!this.validatePicture(first.data, configuration).closedRandomAccess) fail('first picture must prove IDR');
      const restored = parseTsPacketIndex(cached, this.sourceVersion, this.reader.size);
      if (restored && isVerifiedCompleteTsIndex(restored) && restored.pid === track.id && equal(Uint8Array.from(restored.configuration), configuration)
        && restored.packets[0].locator === first.sequenceNumber && restored.packets[0].size === first.byteLength
        && restored.packets[0].timestamp === first.timestamp) {
        this.index = sealCompleteIndex(restored); this.indexReused = true; this.cursor = { au: 0, packet: first }; return restored;
      }
      const clocks = await pesClocks({ size: this.reader.size, read: (at, length) => this.read(at, length), close() {} }, track.id, this.signal);
      const packets: TsPacketRecord[] = [];
      for await (const packet of this.sink.packets()) {
        this.check();
        if (packets.length >= 250000 || !Number.isSafeInteger(packet.sequenceNumber) || packet.sequenceNumber < 0
          || (packets.length && packet.sequenceNumber <= packets.at(-1)!.locator)) fail('unstable packet locator or index budget exceeded');
        if (packet.byteLength > 32*1024*1024) throw new MediaOpenError('resource', 'JS TS: access-unit size budget exceeded');
        const evidence = this.validatePicture(packet.data, configuration);
        const previous = packets.at(-1);
        if (previous && Math.abs(packet.timestamp-previous.timestamp)>2**32/90000) fail('clock wrap/jump is outside initial admission');
        const ptsUs = Math.round(packet.timestamp * 1e6), durationUs = Math.round(packet.duration * 1e6);
        if (!Number.isSafeInteger(ptsUs) || !Number.isSafeInteger(durationUs) || durationUs < 0 || !Number.isSafeInteger(packet.byteLength) || packet.byteLength <= 0) fail('invalid packet metadata');
        // PES clocks apply only to the first AU at this locator. Additional AUs
        // have explicitly derived PTS and unknown raw PTS/DTS; never duplicate clocks.
        const raw = clocks.get(packet.sequenceNumber);
        if (raw?.pts != null && raw.dts != null && Math.abs(raw.pts-raw.dts)>2**32) fail('wrapped DTS is outside initial admission');
        if (raw?.pts != null && Math.round(raw.pts * 1e6 / 90000) !== ptsUs) fail('PES/packet timestamp mapping mismatch');
        packets.push({ au: packets.length, locator: packet.sequenceNumber, configuration: 0, pesOffset: raw ? packet.sequenceNumber : null, timestamp: packet.timestamp, ptsUs, durationUs, size: packet.byteLength, key: evidence.closedRandomAccess,
          timing: { pts: raw?.pts ?? null, dts: raw?.dts ?? null, timebase: [1, 90000], origin: raw?.pts != null ? 'pes' : 'derived' } });
        this.packetsRead++;
      }
      clocks.clear();
      if (!packets.length || new Set(packets.map(p => p.ptsUs)).size !== packets.length) fail('missing or ambiguous packet presentation timestamps');
      this.index = { schema: 2, completeness: { state: 'complete', packets: packets.length }, kind: 'js-ts-packets', build: TS_PACKET_BUILD, sourceVersion: this.sourceVersion, size: this.reader.size,
        streamKey: 'video:0', pid: track.id, codec: 'h264', configuration: [...configuration], packets };
      this.index = sealCompleteIndex(this.index);
      this.cursor = { au: 0, packet: first };
      return this.index;
    } catch (error) { this.close(); throw error; }
  }
  async readUnit(au: number): Promise<Uint8Array> {
    this.check();
    const target = this.index?.packets[au];
    if (!target || !Number.isSafeInteger(au) || au < 0) fail('access-unit ordinal out of bounds');
    let packet: EncodedPacket | null;
    if (this.cursor?.au === au) packet = this.cursor.packet;
    else if (this.cursor?.au === au - 1) packet = await this.sink!.getNextPacket(this.cursor.packet);
    else packet = await this.sink!.getPacket(target.timestamp);
    this.check(); this.packetsRead++;
    // Timestamp lookup is only a candidate. Require exact opaque locator,
    // length and timestamp equality, not nearest-PTS association.
    if (!packet || packet.sequenceNumber !== target.locator || packet.byteLength !== target.size || Math.round(packet.timestamp * 1e6) !== target.ptsUs) fail('packet/index identity mismatch');
    if (target.pesOffset !== null) {
      const actual = (await pesClocks({ size: 188, read: () => this.read(target.pesOffset!, 188), close() {} }, this.index!.pid, this.signal)).get(0);
      if (!actual || actual.pts !== target.timing.pts || actual.dts !== target.timing.dts) fail('cached PES clock identity mismatch');
    }
    const evidence = this.validatePicture(packet.data, Uint8Array.from(this.index!.configuration));
    if (target.key && !evidence.closedRandomAccess) fail('container key does not prove a closed IDR anchor');
    this.cursor = { au, packet };
    return packet.data;
  }
  close() { if (this.closed) return; this.closed = true; this.signal.removeEventListener('abort', this.abort); this.cursor = undefined; this.index = undefined; this.nativeConfig = undefined; this.sink = undefined; this.sets.clear(); try { this.input.dispose(); } finally { this.reader.close(); } }
}

/** Feed the existing packet timeline; keep unknown DTS distinct from PTS. */
export function tsDecodeIndex(index: TsPacketIndex): import('./flv-decoder.ts').PacketDecodeIndex {
  if (!isVerifiedCompleteTsIndex(index)) fail('unverified complete index cannot mint decode identities');
  const packets = index.packets.map(packet => ({ sequenceNumber: packet.au, configuration: packet.configuration,
    offset: packet.locator, size: packet.size, pts: packet.ptsUs, identityKnown: packet.timing.pts !== null,
    dts: packet.timing.dts === null ? null : Math.round(packet.timing.dts * 1e6 / 90000), key: packet.key }));
  const order = packets.map((_, au) => au).sort((a, b) => packets[a].pts - packets[b].pts);
  const firstPts = packets[order[0]].pts;
  const durations = order.map((au, i) => i + 1 < order.length ? packets[order[i + 1]].pts - packets[au].pts : index.packets[au].durationUs);
  return { codec: 'h264', description: Uint8Array.from(index.configuration), configurations: [Uint8Array.from(index.configuration)], packets, order, firstPts,
    duration: packets[order.at(-1)!].pts - firstPts + durations.at(-1)!, durations };
}

/** Include the demux build and selected PID in exact picture/cache identity. */
export function tsPictureStream(index: TsPacketIndex) { return `${index.streamKey}:${index.pid}@${index.build}`; }

/** Old FFmpeg indexes and mismatched JS builds rebuild with JS; never load an old demuxer. */
export function parseTsPacketIndex(value: unknown, sourceVersion: string, size: number): TsPacketIndex | undefined {
  if (!value || typeof value !== 'object') return;
  const doc = value as Partial<TsPacketIndex>;
  if (doc.schema !== 2 || doc.kind !== 'js-ts-packets' || doc.build !== TS_PACKET_BUILD || doc.sourceVersion !== sourceVersion || doc.size !== size
    || doc.streamKey !== 'video:0' || doc.codec !== 'h264' || !Number.isSafeInteger(doc.pid) || doc.pid! < 1 || doc.pid! > 8190
    || !Array.isArray(doc.configuration) || !doc.configuration.length || doc.configuration.length > 4096 || !doc.configuration.every(n=>Number.isInteger(n)&&n>=0&&n<=255)
    || !Array.isArray(doc.packets) || !doc.packets.length || doc.packets.length > 250000) return;
  if (doc.completeness?.state !== 'complete' || doc.completeness.packets !== doc.packets.length) return;
  const times = new Set<number>();
  for (let au = 0; au < doc.packets.length; au++) {
    const p = doc.packets[au];
    if (!p || p.au !== au || p.configuration !== 0 || !Number.isSafeInteger(p.locator) || p.locator < 0 || p.locator >= size
      || au > 0 && p.locator <= doc.packets[au - 1].locator || !Number.isFinite(p.timestamp) || !Number.isSafeInteger(p.ptsUs) || Math.round(p.timestamp*1e6)!==p.ptsUs
      || !Number.isSafeInteger(p.durationUs) || p.durationUs < 0 || !Number.isSafeInteger(p.size) || p.size <= 0 || p.size > 32*1024*1024 || typeof p.key !== 'boolean'
      || times.has(p.ptsUs) || !p.timing || p.timing.timebase?.[0] !== 1 || p.timing.timebase?.[1] !== 90000) return;
    times.add(p.ptsUs);
    for (const clock of [p.timing.pts,p.timing.dts]) if(clock!==null&&(!Number.isSafeInteger(clock)||clock<0||clock>=2**33))return;
    if(p.pesOffset!==null&&(!Number.isSafeInteger(p.pesOffset)||p.pesOffset<0||p.pesOffset%188||p.pesOffset+188>size))return;
    if(p.timing.pts!==null&&p.timing.dts!==null&&Math.abs(p.timing.pts-p.timing.dts)>2**32)return;
    if(p.timing.origin==='pes') {if(p.timing.pts===null||p.pesOffset===null||Math.round(p.timing.pts*1e6/90000)!==p.ptsUs)return;}
    else if(p.timing.origin!=='derived'||p.timing.pts!==null||p.timing.dts!==null)return;
  }
  return doc as TsPacketIndex;
}
