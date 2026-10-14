import { abortableWait } from './media-abort.ts';
import { CustomSource, EncodedPacketSink, Input, MPEG_TS } from 'mediabunny';
import type { EncodedPacket } from 'mediabunny';
import { MediaOpenError } from './media-errors.ts';
import { inspectPacketPicture } from './packet-picture.ts';
import { isAnnexB, nalRanges } from './nal-framing.ts';
import { parseAvcSps } from './avc-geometry.ts';
import {sealJsIndex,isSealedJsIndex} from './js-index-proof.ts';
import {HevcPictureOrder,UnsupportedHevcPictureStructure} from './hevc-timeline.ts';
import {hevcFieldPictures} from './hevc-geometry.ts';

import { TS_PACKET_BUILD, parseTsPacketIndex } from './ts-packet-index.ts';
import type { TsPacketIndex, TsPacketRecord } from './ts-packet-index.ts';
export { TS_PACKET_BUILD, parseTsPacketIndex, tsPictureStream } from './ts-packet-index.ts';
export type { TsPacketIndex, TsPacketRecord } from './ts-packet-index.ts';

export interface TsPacketReader {
  readonly size: number;
  read(offset: number, length: number): Promise<Uint8Array>;
  close(): void;
}
// A document's own flags/checksum cannot prove AU completeness. Only this
// module's complete source enumeration can mint a reusable metadata proof.
// Weak references retain no index storage and the registry is bounded.
const sealedIndexes = new WeakSet<TsPacketIndex>();
const verifiedIndexes: WeakRef<TsPacketIndex>[] = [];
function sealCompleteIndex(index: TsPacketIndex): TsPacketIndex {
  for (const packet of index.packets) { Object.freeze(packet.timing.timebase); Object.freeze(packet.timing); Object.freeze(packet); }
  Object.freeze(index.configuration); Object.freeze(index.packets); Object.freeze(index.completeness); Object.freeze(index);
  sealedIndexes.add(index);
  verifiedIndexes.push(new WeakRef(index));
  if (verifiedIndexes.length > 32) verifiedIndexes.shift();
  return sealJsIndex(index);
}
/** Exact metadata equality to a still-live, immutable complete scan. Serialized
 * documents alone (including self-reported completeness) are untrusted. */
export function isVerifiedCompleteTsIndex(index: TsPacketIndex): boolean {
  if (index.schema !== 2 || index.kind !== 'js-ts-packets' || !['h264','hevc','mpeg2video'].includes(index.codec) || index.streamKey !== 'video:0'
    || index.completeness?.state !== 'complete' || index.completeness.packets !== index.packets.length) return false;
  if (sealedIndexes.has(index)||isSealedJsIndex(index)) return true;
  return verifiedIndexes.some(reference => {
    const known = reference.deref();
    if (known === index) return true;
    if (!known || known.sourceVersion !== index.sourceVersion || known.size !== index.size || known.pid !== index.pid || known.codec !== index.codec || known.exactPictureMapping !== index.exactPictureMapping || known.transportLimit !== index.transportLimit || known.indexIntegrity !== index.indexIntegrity
      || known.build !== index.build || known.schema !== index.schema || known.packets.length !== index.packets.length
      || known.configuration.length !== index.configuration.length || known.configuration.some((v,i)=>v!==index.configuration[i])) return false;
    return known.packets.every((p,i)=>{
      const candidate = index.packets[i];
      return p.au === candidate.au && p.locator === candidate.locator && p.configuration === candidate.configuration
        && p.pesOffset === candidate.pesOffset && p.transportEnd === candidate.transportEnd && p.timestamp === candidate.timestamp && p.ptsUs === candidate.ptsUs
        && p.durationUs === candidate.durationUs && p.size === candidate.size && p.key === candidate.key
        && p.timing.pts === candidate.timing.pts && p.timing.dts === candidate.timing.dts
        && p.timing.origin === candidate.timing.origin && p.timing.timebase[0] === candidate.timing.timebase[0]
        && p.timing.timebase[1] === candidate.timing.timebase[1];
    });
  });
}

/** Retain a previously proven clone independently of its original owner. */
export function retainVerifiedTsIndex(index: TsPacketIndex): TsPacketIndex | undefined {
  return isVerifiedCompleteTsIndex(index) ? sealCompleteIndex(index) : undefined;
}
export class TsSourceChangedError extends MediaOpenError {
  constructor() { super('input', 'JS TS: source changed after complete index verification'); }
}
/** A declared combination outside this migration stage. Corruption, IO,
 * clocks, cancellation and resource failures never use this classification. */
export class TsCombinationNotMigrated extends MediaOpenError {
  constructor(reason: string) { super('container', `JS TS: ${reason}`); }
}

function fail(message: string): never { throw new MediaOpenError('container', `JS TS: ${message}`); }
const equal = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((value, i) => value === b[i]);
const ticks = (b: Uint8Array, at: number, prefix: number): number => {
  if (at + 5 > b.length || b[at] >> 4 !== prefix || !(b[at] & 1) || !(b[at + 2] & 1) || !(b[at + 4] & 1)) fail('invalid PES clock markers');
  return ((b[at] >> 1) & 7) * 2 ** 30 + b[at + 1] * 2 ** 22 + (b[at + 2] >> 1) * 2 ** 15 + b[at + 3] * 128 + (b[at + 4] >> 1);
};

/** Raw-clock supplement only. Mediabunny still owns PSI, PES payload reassembly,
 * AU demux and packet seeking. This first admission is finite 188-byte TS. */
export async function readTsPesClocks(reader: TsPacketReader, pid: number, signal: AbortSignal, scanned?: (bytes: number) => void) {
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
    scanned?.(start + block.length);
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
  private codec: 'h264' | 'hevc' = 'h264';
  private exactPictureMapping=true;
  index?: TsPacketIndex;
  nativeConfig?: VideoDecoderConfig;
  bytesRead = 0;
  packetsRead = 0;
  indexReused = false;
  private progress?: (value: {packets:number;scannedBytes:number;totalBytes:number;bytesRead:number})=>void;
  private scannedBytes=0;
  private indexedPackets=0;
  private indexBytesRead:number|undefined;
  private readonly indexByteBudget:number;
  private lastProgressMs=-Infinity;
  private publishProgress(force=false) {
    if (!this.progress) return;
    const now=performance.now();
    if (!force && now-this.lastProgressMs<25) return;
    this.lastProgressMs=now;
    this.progress({packets:this.indexedPackets,scannedBytes:this.scannedBytes,totalBytes:this.reader.size,bytesRead:this.bytesRead});
  }
  private reader: TsPacketReader;
  private sourceVersion: string;
  private signal: AbortSignal;
  private abort = () => this.close();
  constructor(reader: TsPacketReader, sourceVersion: string, signal: AbortSignal) {
    this.reader = reader; this.sourceVersion = sourceVersion; this.signal = signal;
    this.indexByteBudget=Math.min(Number.MAX_SAFE_INTEGER,reader.size*4+32*1024*1024);
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
    const bytes = await abortableWait(this.reader.read(offset, size), this.signal); this.check();
    if (!(bytes instanceof Uint8Array) || bytes.length !== size) fail('short transport read');
    this.bytesRead += bytes.length;
    // The scan budget belongs to indexing, independently of observation.
    // Playback/analysis readUnit IO has separate per-read/AU bounds and must
    // not exhaust a lifetime scan counter after repeated legitimate seeks.
    if (this.indexBytesRead !== undefined) {
      this.indexBytesRead += bytes.length;
      if (!Number.isSafeInteger(this.indexBytesRead) || this.indexBytesRead > this.indexByteBudget)
        throw new MediaOpenError('resource','JS TS: index IO budget exceeded');
    }
    this.publishProgress(); return bytes;
  }
  private validatePicture(bytes: Uint8Array, configuration: Uint8Array) {
    if (!isAnnexB(bytes)) fail('expected Annex-B access unit');
    let evidence = inspectPacketPicture(this.codec, configuration, bytes);
    if (!evidence.singlePicture) {
      const slices=this.codec==='h264'?nalRanges(this.codec,configuration,bytes).filter(n=>[1,5].includes(bytes[n.offset]&31)):[];
      // Preserve the former TS playback capability. Multiple slices in one
      // demuxed packet are decoder input, not proof of one exact picture.
      // Require one first slice and homogeneous IDR/non-IDR coding before
      // using an IDR packet as a closed seek anchor.
      if(evidence.reason==='unsupported-ts-multiple-slices'&&slices.length>1
        &&slices.every(n=>n.size>=2)&&slices.filter(n=>bytes[n.offset+1]&128).length===1
        &&slices.every(n=>(bytes[n.offset]&31)===(bytes[slices[0].offset]&31))){
        this.exactPictureMapping=false;
        evidence={singlePicture:false,closedRandomAccess:(bytes[slices[0].offset]&31)===5};
      }else fail(`unverified picture layout: ${evidence.reason}`);
    }
    for (const nal of nalRanges(this.codec, configuration, bytes)) {
      const data = bytes.subarray(nal.offset, nal.offset + nal.size), type = this.codec==='h264' ? data[0] & 31 : (data[0] >> 1) & 63;
      if (!(this.codec==='h264'?[7,8]:[32,33,34]).includes(type)) continue;
      const stored = this.sets.get(type);
      if (!stored || !equal(stored, data)) throw new TsCombinationNotMigrated('parameter-set changes are outside static admission');
    }
    return evidence;
  }
  async open(cached?: unknown, progress?: typeof this.progress): Promise<TsPacketIndex> {
    try {
      this.indexBytesRead=0;this.progress=progress; this.publishProgress(true);
      this.check(); await this.input.getFormat(); this.check();
      const tracks = await this.input.getVideoTracks();
      if (tracks.length !== 1) throw new TsCombinationNotMigrated('requires one H.264/HEVC video track');
      const codec = await tracks[0].getCodec();
      if(codec!=='avc'&&codec!=='hevc')throw new TsCombinationNotMigrated('requires H.264/HEVC video');
      this.codec=codec==='avc'?'h264':'hevc';
      const track = tracks[0];
      this.nativeConfig = await track.getDecoderConfig() ?? undefined;
      this.sink = new EncodedPacketSink(track);
      const first = await this.sink.getFirstPacket(); this.check();
      if (!first || !isAnnexB(first.data)) fail('missing Annex-B first packet');
      if (first.byteLength > 32*1024*1024) throw new MediaOpenError('resource', 'JS TS: access-unit size budget exceeded');
      for (const nal of nalRanges(this.codec, new Uint8Array([0, 0, 1]), first.data)) {
        const data = first.data.subarray(nal.offset, nal.offset + nal.size), type = this.codec==='h264' ? data[0] & 31 : (data[0] >> 1) & 63;
        if (!(this.codec==='h264'?[7,8]:[32,33,34]).includes(type)) continue;
        if (this.sets.has(type)) throw new TsCombinationNotMigrated('multiple parameter sets are outside initial admission');
        if (this.codec==='h264' && type === 7 && parseAvcSps(data).interlaced) this.exactPictureMapping=false;
        this.sets.set(type, data.slice());
      }
      const setTypes=this.codec==='h264'?[7,8]:[32,33,34];
      if (this.sets.size !== setTypes.length) fail('missing static parameter sets');
      const configuration = Uint8Array.from(setTypes.flatMap(type=>[0,0,0,1,...this.sets.get(type)!]));
      if (configuration.length > 4096) fail('configuration budget exceeded');
      if(this.codec==='hevc')try{new HevcPictureOrder(configuration);if(hevcFieldPictures(configuration))throw new UnsupportedHevcPictureStructure('HEVC field pictures require separate admission');}catch(error){if(error instanceof UnsupportedHevcPictureStructure)throw new TsCombinationNotMigrated(error.message);fail('invalid progressive HEVC configuration');}
      if (!this.validatePicture(first.data, configuration).closedRandomAccess) fail('first picture must prove IDR');
      const restored = parseTsPacketIndex(cached, this.sourceVersion, this.reader.size);
      if (restored && isVerifiedCompleteTsIndex(restored)) {
        if (!this.exactPictureMapping && restored.exactPictureMapping!==false || restored.codec !== this.codec || restored.pid !== track.id || !equal(Uint8Array.from(restored.configuration), configuration)
          || restored.packets[0].locator !== first.sequenceNumber || restored.packets[0].size !== first.byteLength
          || restored.packets[0].timestamp !== first.timestamp) throw new TsSourceChangedError();
        this.index = sealCompleteIndex(restored); this.indexReused = true; this.cursor = { au: 0, packet: first }; return restored;
      }
      const clocks = await readTsPesClocks({ size: this.reader.size, read: (at, length) => this.read(at, length), close() {} }, track.id, this.signal, bytes=>{this.scannedBytes=bytes;this.publishProgress();});
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
        this.packetsRead++;this.indexedPackets=packets.length;this.publishProgress();
      }
      clocks.clear();
      if (!packets.length || new Set(packets.map(p => p.ptsUs)).size !== packets.length) fail('missing or ambiguous packet presentation timestamps');
      this.index = { schema: 2, ...(!this.exactPictureMapping?{exactPictureMapping:false as const}:{}), completeness: { state: 'complete', packets: packets.length }, kind: 'js-ts-packets', build: TS_PACKET_BUILD, sourceVersion: this.sourceVersion, size: this.reader.size,
        streamKey: 'video:0', pid: track.id, codec: this.codec, configuration: [...configuration], packets };
      this.index = sealCompleteIndex(this.index);this.publishProgress(true);
      this.cursor = { au: 0, packet: first };
      return this.index;
    } catch (error) { this.close(); this.signal.throwIfAborted(); throw error; }
    finally {this.progress=undefined;this.indexBytesRead=undefined;}
  }
  async readUnit(au: number): Promise<Uint8Array> {
    try {
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
      const actual = (await readTsPesClocks({ size: 188, read: () => this.read(target.pesOffset!, 188), close() {} }, this.index!.pid, this.signal)).get(0);
      if (!actual || actual.pts !== target.timing.pts || actual.dts !== target.timing.dts) fail('cached PES clock identity mismatch');
    }
    const evidence = this.validatePicture(packet.data, Uint8Array.from(this.index!.configuration));
    if (target.key && !evidence.closedRandomAccess) fail('container key does not prove a closed IDR anchor');
    this.cursor = { au, packet };
    return packet.data;
    } catch(error) {this.signal.throwIfAborted();throw error;}
  }
  close() { if (this.closed) return; this.closed = true; this.signal.removeEventListener('abort', this.abort); this.cursor = undefined; this.index = undefined; this.nativeConfig = undefined; this.sink = undefined; this.sets.clear(); try { this.input.dispose(); } finally { this.reader.close(); } }
}

/** Feed the existing packet timeline; keep unknown DTS distinct from PTS. */
export function tsDecodeIndex(index: TsPacketIndex): import('./flv-decoder.ts').PacketDecodeIndex {
  if (!isVerifiedCompleteTsIndex(index)) fail('unverified complete index cannot mint decode identities');
  const packets = index.packets.map(packet => ({ sequenceNumber: packet.au, configuration: packet.configuration,
    offset: packet.locator, size: packet.size, pts: packet.ptsUs, identityKnown: index.exactPictureMapping!==false && packet.timing.pts !== null,
    dts: packet.timing.dts === null ? null : Math.round(packet.timing.dts * 1e6 / 90000), key: packet.key }));
  const order = packets.map((_, au) => au).sort((a, b) => packets[a].pts - packets[b].pts);
  const firstPts = packets[order[0]].pts;
  const durations = order.map((au, i) => i + 1 < order.length ? packets[order[i + 1]].pts - packets[au].pts : index.packets[au].durationUs);
  return { codec: index.codec, description: Uint8Array.from(index.configuration), configurations: [Uint8Array.from(index.configuration)], packets, order, firstPts,
    duration: packets[order.at(-1)!].pts - firstPts + durations.at(-1)!, durations };
}
