import { annexBNalType, annexBParameterTypes, annexBPictures, annexBPrefixTypes, type AnnexBPicture } from '../codecs/annex-b-picture.ts';
import { isAnnexB } from '../codecs/nal-framing.ts';
import { MediaOpenError } from '../io/media-errors.ts';
import { isSealedJsIndex, sealJsIndex } from '../indexing/js-index-proof.ts';
import {
  ANNEX_B_DEFAULT_FPS, ANNEX_B_MAX_CONFIGURATION_BYTES, ANNEX_B_MAX_PACKET_BYTES, ANNEX_B_MAX_PACKETS, ANNEX_B_PACKET_BUILD,
  annexBTime, parseAnnexBPacketIndex, type AnnexBPacketIndex, type AnnexBPacketRecord,
} from '../indexing/annex-b-index.ts';
import type { MediaIndexScanProgress } from '../indexing/media-index-types.ts';
import type { TsPacketReader } from './ts-packet-source.ts';
import { probeAnnexBCodec } from './annex-b-header.ts';

function unsupported(message: string): never { throw new MediaOpenError('container', `Annex-B：${message}`); }

async function* nalLocations(reader: TsPacketReader, signal?: AbortSignal, progress?: (bytes: number) => void) {
  const blockSize = 1024 * 1024;
  let prefix = 0, start = 0, zeros = 0;
  for (let offset = 0; offset < reader.size; offset += blockSize) {
    signal?.throwIfAborted();
    const block = await reader.read(offset, Math.min(blockSize, reader.size - offset));
    signal?.throwIfAborted();
    for (let i = 0; i < block.length; i++) {
      const byte = block[i], position = offset + i;
      if (!byte) { zeros++; continue; }
      if (byte === 1 && zeros >= 2) {
        const next = position - Math.min(zeros, 3);
        if (start) yield { prefix, start, end: position - zeros };
        prefix = start ? next : 0;
        start = position + 1;
      } else if (!start) unsupported('缺少起始码。');
      zeros = 0;
    }
    progress?.(offset + block.length);
  }
  if (!start) unsupported('缺少 NAL 单元。');
  yield { prefix, start, end: reader.size - zeros };
}

type PictureRange = AnnexBPicture & { locator: number; size: number };

async function* accessUnits(reader: TsPacketReader, signal?: AbortSignal, progress?: (bytes: number) => void) {
  const codec = await probeAnnexBCodec(reader, signal);
  if (!codec) return unsupported('未找到 AVC、HEVC 或 VVC 参数集。');
  const parser = annexBPictures(codec), sets = new Map<number, Uint8Array>();
  const parameters = annexBParameterTypes[codec], prefixes = annexBPrefixTypes[codec];
  let current: AnnexBPicture | undefined, offset = 0;
  const unit = (end: number) => {
    const size = end - offset;
    if (size > ANNEX_B_MAX_PACKET_BYTES) unsupported('单幅画面的码流超出读取上限。');
    return { ...current!, locator: offset, size };
  };
  const configuration = () => {
    const result: number[] = [];
    for (const nal of sets.values()) {
      if (result.length + nal.length + 4 > ANNEX_B_MAX_CONFIGURATION_BYTES) unsupported('参数集超出读取上限。');
      result.push(0, 0, 0, 1, ...nal);
    }
    return result;
  };
  let first = true;
  for await (const { prefix, start, end } of nalLocations(reader, signal, progress)) {
    const size = end - start;
    if (size <= 0) unsupported('NAL 单元为空。');
    let nal = await reader.read(start, Math.min(size, 256));
    let type: number;
    try { type = annexBNalType(codec, nal); }
    catch (error) { return unsupported((error as Error).message); }
    if (current && prefixes.includes(type)) {
      yield { codec, picture: unit(prefix), config: first ? configuration() : undefined, rate: parser.frameRate };
      first = false;
      current = undefined;
      offset = prefix;
    }
    const parameter = parameters.includes(type);
    if (parameter && size > ANNEX_B_MAX_CONFIGURATION_BYTES - 4) unsupported('参数集超出读取上限。');
    if (parameter && size > nal.length) nal = await reader.read(start, size);
    try {
      if (parameter) {
        const previous = sets.get(type);
        if (previous) {
          if (previous.length !== nal.length || previous.some((byte, i) => byte !== nal[i])) throw Error('in-band configuration change');
        } else {
          if (!first || current) throw Error('parameter set appeared after playback start');
          parser.parameter(type, nal);
          sets.set(type, nal);
        }
      }
      const picture = parser.picture(type, nal, !!current);
      if (!picture) continue;
      if (current) {
        yield { codec, picture: unit(prefix), config: first ? configuration() : undefined, rate: parser.frameRate };
        first = false;
        offset = prefix;
      }
      current = picture;
    } catch (error) { return unsupported((error as Error).message); }
  }
  if (current) yield { codec, picture: unit(reader.size), config: first ? configuration() : undefined, rate: parser.frameRate };
}

/** For thumbnails, stop once the first independently decodable access unit is delimited. */
export async function firstAnnexBPicture(reader: TsPacketReader) {
  for await (const { codec, picture, config } of accessUnits(reader)) {
    if (!picture.key || !config) unsupported('需要从随机访问画面开始。');
    return { codec, config: Uint8Array.from(config!), bytes: await reader.read(picture.locator, picture.size) };
  }
  return unsupported('未找到可播放画面。');
}

export class AnnexBPacketSource {
  private index?: AnnexBPacketIndex;
  private closed = false;
  readonly nativeConfig = undefined;
  indexReused = false;
  packetsRead = 0;

  private reader: TsPacketReader;
  private sourceVersion: string;
  private signal: AbortSignal;
  constructor(reader: TsPacketReader, sourceVersion: string, signal: AbortSignal) {
    this.reader = reader;
    this.sourceVersion = sourceVersion;
    this.signal = signal;
  }

  async open(restored?: unknown, onProgress?: (progress: MediaIndexScanProgress) => void, required = false) {
    this.signal.throwIfAborted();
    if (this.closed) throw new MediaOpenError('input', '裸码流已释放。');
    if (this.index) return this.index;
    if (restored && typeof restored === 'object' && isSealedJsIndex(restored)) {
      const index = parseAnnexBPacketIndex(restored, this.sourceVersion, this.reader.size);
      if (index) {
        this.indexReused = true;
        return this.index = index;
      }
    }
    if (required) throw new MediaOpenError('input', '服务端裸码流播放索引不可用。');
    const { size } = this.reader, packets: AnnexBPacketRecord[] = [], group: PictureRange[] = [];
    let frameRate = ANNEX_B_DEFAULT_FPS, rank = 0, codec: AnnexBPacketIndex['codec'] | undefined;
    let config: number[] | undefined, rateSource: AnnexBPacketIndex['rateSource'] = 'default';
    const finish = () => {
      const sorted = group.slice().sort((a, b) => a.poc - b.poc);
      const ranks = new Map<PictureRange, number>();
      for (const [i, picture] of sorted.entries()) {
        if (i && picture.poc === sorted[i - 1].poc) unsupported('画面顺序计数冲突。');
        ranks.set(picture, rank++);
      }
      for (const picture of group) {
        const ordinal = ranks.get(picture)!;
        const ptsUs = annexBTime(ordinal, frameRate);
        packets.push({ au: packets.length, locator: picture.locator, size: picture.size, key: picture.key,
          configuration: 0, ptsUs, durationUs: annexBTime(ordinal + 1, frameRate) - ptsUs,
          timing: { pts: null, dts: null, timebase: [1, 1000000], origin: 'derived' } });
      }
      group.length = 0;
    };
    for await (const entry of accessUnits(this.reader, this.signal, scannedBytes => {
      onProgress?.({ scannedBytes, totalBytes: size, packets: this.packetsRead });
    })) {
      const { picture } = entry;
      if (!this.packetsRead) {
        if (!picture.key || !entry.config) unsupported('需要从随机访问画面开始。');
        codec = entry.codec;
        config = entry.config;
        if (entry.rate !== undefined && entry.rate >= 1 && entry.rate <= 1000) {
          frameRate = entry.rate;
          rateSource = 'bitstream';
        }
      }
      if (++this.packetsRead > ANNEX_B_MAX_PACKETS) throw new MediaOpenError('resource', '裸码流画面数量超出索引上限。');
      if (!rank && group.length && picture.leading && picture.poc < group[0].poc) continue;
      if (picture.reset) finish();
      group.push(picture);
    }
    finish();
    const document = parseAnnexBPacketIndex({ schema: 1, kind: 'js-annexb-packets', build: ANNEX_B_PACKET_BUILD,
      streamKey: 'video:0', sourceVersion: this.sourceVersion, size, codec, configuration: config, packets, frameRate, rateSource,
      completeness: { state: 'complete', packets: packets.length } }, this.sourceVersion, size);
    if (!document) return unsupported('找不到可用的画面索引。');
    return this.index = sealJsIndex(document);
  }

  async readUnit(au: number, includeConfiguration = true) {
    this.signal.throwIfAborted();
    const packet = this.index?.packets[au];
    if (this.closed || !packet) throw new MediaOpenError('input', '裸码流画面索引无效或已释放。');
    const bytes = await this.reader.read(packet.locator, packet.size);
    this.signal.throwIfAborted();
    if (!isAnnexB(bytes)) throw new MediaOpenError('input', '裸码流画面起始码与索引不一致。');
    if (!packet.key || !includeConfiguration) return bytes;
    // A later RAP can omit the original parameter sets. Supply them in-band
    // on every restart so native and software decoding receive the same bytes.
    const configuration = this.index!.configuration;
    const data = new Uint8Array(configuration.length + bytes.length);
    data.set(configuration);
    data.set(bytes, configuration.length);
    return data;
  }

  close() { this.closed = true; this.index = undefined; this.reader.close(); }
}
