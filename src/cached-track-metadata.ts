import type { AudioPeek } from './cached-container-audio.ts';

export interface AudioTrackMetadata { codec?: string; sampleRate?: number; channels?: number; }
export interface CachedTrackMetadata {
  container?: string;
  audio: { presence: 'present' | 'absent' | 'unknown'; tracks: AudioTrackMetadata[]; complete: boolean };
}
const unknown = (): CachedTrackMetadata => ({ audio: { presence: 'unknown', tracks: [], complete: false } });
const ascii = (b: Uint8Array, at = 0, end = b.length) => String.fromCharCode(...b.subarray(at, end));
const view = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);
const u32 = (b: Uint8Array, at = 0) => view(b).getUint32(at);
const rates = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
/** Metadata decoding is deliberately independent of the playable AAC-LC/stereo filter. */
export function aacMetadata(bytes: Uint8Array): AudioTrackMetadata {
  let bit = 0;
  const read = (count: number) => { if (bit + count > bytes.length * 8) throw new Error('incomplete ASC'); let value = 0; for (let n = 0; n < count; n++, bit++) value = value * 2 + ((bytes[bit >> 3] >> (7 - (bit & 7))) & 1); return value; };
  const object = () => { const value = read(5); return value === 31 ? 32 + read(6) : value; };
  const frequency = () => { const value = read(4); return value === 15 ? read(24) : rates[value]; };
  try {
    const type = object(); let sampleRate = frequency(); const layout = read(4);
    let channels = [1, 2, 3, 4, 5, 6, 8][layout - 1];
    if (type === 5 || type === 29) { sampleRate = frequency(); object(); if (type === 29 && channels === 1) channels = 2; }
    return { codec: type === 2 ? 'AAC-LC' : type === 5 ? 'HE-AAC' : type === 29 ? 'HE-AAC v2' : `AAC (${type})`,
      ...(sampleRate && sampleRate <= 768000 ? { sampleRate } : {}), ...(channels ? { channels } : {}) };
  } catch { return { codec: 'AAC' }; }
}
class Missing extends Error {}
class Budget {
  bytes = 4 * 1024 * 1024; calls = 256; private deadline = performance.now() + 2000;
  private peek: AudioPeek;
  readonly size: number;
  constructor(peek: AudioPeek, size: number) { this.peek = peek; this.size = size; }
  async read(offset: number, length: number) {
    if (performance.now() > this.deadline || !Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > this.size || length > this.bytes) throw new Missing();
    this.bytes -= length;
    const result = new Uint8Array(length);
    for (let at = 0; at < length; at += 65536) {
      if (--this.calls < 0) throw new Missing();
      const count = Math.min(65536, length - at), part = await this.peek(offset + at, count);
      if (!part || part.length !== count) throw new Missing();
      result.set(part, at);
    }
    return result;
  }
}
function audio(result: CachedTrackMetadata, tracks: AudioTrackMetadata[], complete: boolean) {
  result.audio = { tracks, complete, presence: tracks.length ? 'present' : complete ? 'absent' : 'unknown' };
}
function boxes(bytes: Uint8Array, start = 0, end = bytes.length) {
  const result: { type: string; start: number; end: number }[] = [];
  for (let at = start; at < end;) {
    if (result.length >= 2048 || at + 8 > end) throw new Missing();
    let size = u32(bytes, at), header = 8;
    if (size === 1) { if (at + 16 > end) throw new Missing(); size = Number(view(bytes).getBigUint64(at + 8)); header = 16; }
    if (!size) size = end - at;
    if (!Number.isSafeInteger(size) || size < header || at + size > end) throw new Missing();
    result.push({ type: ascii(bytes, at + 4, at + 8), start: at + header, end: at + size }); at += size;
  }
  return result;
}
const codecs: Record<string, string> = { mp4a: 'mp4a', 'ac-3': 'AC-3', 'ec-3': 'E-AC-3', Opus: 'Opus', fLaC: 'FLAC', alac: 'ALAC', '.mp3': 'MP3', lpcm: 'PCM', sowt: 'PCM', twos: 'PCM' };
function esds(bytes: Uint8Array): AudioTrackMetadata {
  let at = 4;
  const descriptor = (tag: number) => {
    if (bytes[at++] !== tag) throw new Missing();
    let length = 0;
    for (let i = 0; i < 4; i++) {
      const byte = bytes[at++]; if (byte === undefined) throw new Missing();
      length = length * 128 + (byte & 127);
      if (!(byte & 128)) { if (at + length > bytes.length) throw new Missing(); return length; }
    }
    throw new Missing();
  };
  descriptor(3); at += 2; const flags = bytes[at++];
  if (flags & 128) at += 2;
  if (flags & 64) { const length = bytes[at++]; at += length; }
  if (flags & 32) at += 2;
  descriptor(4); const object = bytes[at]; at += 13;
  if ([0x69, 0x6b].includes(object)) return { codec: 'MP3' };
  if (![0x40, 0x66, 0x67, 0x68].includes(object)) return { codec: `mp4a (0x${object.toString(16)})` };
  const length = descriptor(5); return aacMetadata(bytes.subarray(at, at + length));
}
async function mp4(reader: Budget, result: CachedTrackMetadata) {
  result.container = 'ISO BMFF';
  for (let at = 0, n = 0; at + 8 <= reader.size && n < 128; n++) {
    const header = await reader.read(at, 8); let size = u32(header), count = 8;
    if (size === 1) { size = Number(view(await reader.read(at + 8, 8)).getBigUint64(0)); count = 16; }
    if (!size) size = reader.size - at;
    if (!Number.isSafeInteger(size) || size < count || at + size > reader.size) throw new Missing();
    const type = ascii(header, 4, 8);
    if (type === 'ftyp' && size >= count + 8) {
      const brand = ascii(await reader.read(at + count, 4));
      result.container = brand === 'qt  ' ? 'QuickTime' : /^(isom|iso[2-9]|mp4[12]|avc1|dash|M4[AV] )$/.test(brand) ? 'MP4' : `ISO BMFF (${brand})`;
    }
    if (type === 'moov') {
      const bytes = await reader.read(at + count, size - count), tracks: AudioTrackMetadata[] = [];
      const children = boxes(bytes); let complete = true;
      for (const trak of children.filter(b => b.type === 'trak')) {
        const mdia = boxes(bytes, trak.start, trak.end).find(b => b.type === 'mdia');
        if (!mdia) { complete = false; continue; }
        const media = boxes(bytes, mdia.start, mdia.end), hdlr = media.find(b => b.type === 'hdlr');
        if (!hdlr || hdlr.end - hdlr.start < 12) { complete = false; continue; }
        const handler = ascii(bytes, hdlr.start + 8, hdlr.start + 12);
        if (handler !== 'soun') { if (!['vide','text','sbtl','subt','clcp','hint','meta','tmcd','mdir','mdta','auxv'].includes(handler)) complete = false; continue; }
        if (tracks.length >= 32) { complete = false; break; }
        const track: AudioTrackMetadata = {}; tracks.push(track); audio(result, tracks, false);
        const minf = media.find(b => b.type === 'minf');
        const stbl = minf && boxes(bytes, minf.start, minf.end).find(b => b.type === 'stbl');
        const stsd = stbl && boxes(bytes, stbl.start, stbl.end).find(b => b.type === 'stsd');
        if (!stsd || stsd.end - stsd.start < 8) continue;
        const entry = boxes(bytes, stsd.start + 8, stsd.end)[0];
        if (!entry) continue;
        track.codec = codecs[entry.type] ?? entry.type;
        if (entry.end - entry.start >= 28) {
          const version = view(bytes).getUint16(entry.start + 8);
          if (version <= 1) {
            const channels = view(bytes).getUint16(entry.start + 16), rate = u32(bytes, entry.start + 24) / 65536;
            if (channels > 0 && channels <= 64) track.channels = channels;
            if (rate > 0 && rate <= 768000) track.sampleRate = rate;
          }
          const extension = version === 0 ? 28 : version === 1 ? 44 : 64;
          if (entry.start + extension <= entry.end) {
            const extra = boxes(bytes, entry.start + extension, entry.end);
            const config = extra.find(b => b.type === 'esds');
            if (config) Object.assign(track, esds(bytes.subarray(config.start, config.end)));
            const opus = extra.find(b => b.type === 'dOps');
            if (opus && opus.end - opus.start >= 11) { track.codec = 'Opus'; track.channels = bytes[opus.start + 1]; track.sampleRate = 48000; }
          }
        }
      }
      // A complete moov with no tracks is not a trustworthy video inventory.
      audio(result, tracks, complete && children.some(b => b.type === 'trak')); return;
    }
    at += size;
  }
}
function vint(bytes: Uint8Array, at: number, id = false) {
  const first = bytes[at]; if (!first) throw new Missing();
  let length = 1; while (length <= 8 && !(first & (128 >> (length - 1)))) length++;
  if (length > (id ? 4 : 8) || at + length > bytes.length) throw new Missing();
  let value = id ? first : first & (255 >> length);
  for (let i = 1; i < length; i++) value = value * 256 + bytes[at + i];
  return { value, length, unknown: !id && value === 2 ** (7 * length) - 1 };
}
function elements(bytes: Uint8Array) {
  const result: { id: number; data: Uint8Array }[] = [];
  for (let at = 0; at < bytes.length;) {
    if (result.length >= 1024) throw new Missing();
    const id = vint(bytes, at, true), size = vint(bytes, at + id.length), start = at + id.length + size.length;
    if (size.unknown || !Number.isSafeInteger(size.value) || start + size.value > bytes.length) throw new Missing();
    result.push({ id: id.value, data: bytes.subarray(start, start + size.value) }); at = start + size.value;
  }
  return result;
}
const uint = (b: Uint8Array) => b.length <= 6 ? b.reduce((n, byte) => n * 256 + byte, 0) : NaN;
async function ebml(reader: Budget, result: CachedTrackMetadata) {
  let at = 0, limit = reader.size;
  for (let n = 0; n < 128 && at < limit && at < 1024 * 1024; n++) {
    const head = await reader.read(at, Math.min(12, limit - at)), id = vint(head, 0, true), size = vint(head, id.length), start = at + id.length + size.length;
    if (id.value === 0x18538067) { if (!size.unknown) limit = Math.min(limit, start + size.value); at = start; continue; }
    if (size.unknown || !Number.isSafeInteger(size.value) || start + size.value > limit) throw new Missing();
    if (id.value === 0x1a45dfa3) {
      const doc = elements(await reader.read(start, size.value)).find(e => e.id === 0x4282);
      if (doc) { const name = ascii(doc.data); if (name === 'webm' || name === 'matroska') result.container = name === 'webm' ? 'WebM' : 'Matroska'; }
    } else if (id.value === 0x1654ae6b) {
      const entries = elements(await reader.read(start, size.value)).filter(e => e.id === 0xae), tracks: AudioTrackMetadata[] = [];
      let complete = entries.length > 0;
      for (const entry of entries) {
        const fields = elements(entry.data), type = fields.find(e => e.id === 0x83);
        if (!type) { complete = false; continue; }
        const kind = uint(type.data);
        if (kind !== 2) { if (![1,3,16,17,18,32,33].includes(kind)) complete = false; continue; }
        if (tracks.length >= 32) { complete = false; break; }
        const track: AudioTrackMetadata = {}, codec = fields.find(e => e.id === 0x86);
        tracks.push(track); audio(result, tracks, false);
        if (codec && codec.data.length <= 128) { const name = ascii(codec.data); track.codec = ({ A_OPUS: 'Opus', A_AAC: 'AAC', A_FLAC: 'FLAC', A_AC3: 'AC-3', A_EAC3: 'E-AC-3', 'A_MPEG/L3': 'MP3' } as Record<string,string>)[name] ?? name.replace(/^A_/, ''); }
        const settings = fields.find(e => e.id === 0xe1);
        if (settings) for (const f of elements(settings.data)) {
          if (f.id === 0x9f) { const channels = uint(f.data); if (channels > 0 && channels <= 64) track.channels = channels; }
          if (f.id === 0xb5 && [4, 8].includes(f.data.length)) { const rate = f.data.length === 4 ? view(f.data).getFloat32(0) : view(f.data).getFloat64(0); if (rate > 0 && rate <= 768000) track.sampleRate = rate; }
        }
      }
      audio(result, tracks, complete); return;
    } else if (id.value === 0x1f43b675) return; // Never scan clusters or follow packet payloads.
    at = start + size.value;
  }
}
async function flv(reader: Budget, result: CachedTrackMetadata) {
  const header = await reader.read(0, 9); result.container = 'FLV';
  if (header[3] !== 1 || header[4] & ~5) return;
  if (!(header[4] & 4)) { audio(result, [], true); return; }
  const track: AudioTrackMetadata = {}; audio(result, [track], false);
  for (let at = u32(header, 5) + 4, n = 0; n < 128 && at < 65536 && at + 11 <= reader.size; n++) {
    const h = await reader.read(at, 11), length = h[1] * 65536 + h[2] * 256 + h[3];
    if (![8, 9, 18].includes(h[0]) || at + 15 + length > reader.size) return;
    if (h[0] === 8 && length) {
      const data = await reader.read(at + 11, Math.min(length, 66)), format = data[0] >> 4;
      track.codec = ({ 0:'PCM', 1:'ADPCM', 2:'MP3', 3:'PCM', 4:'Nellymoser', 5:'Nellymoser', 6:'Nellymoser', 7:'G.711 A-law', 8:'G.711 μ-law', 10:'AAC', 11:'Speex', 14:'MP3' } as Record<number,string>)[format] ?? `FLV audio (${format})`;
      if (format === 10) { if (data[1] === 0) Object.assign(track, aacMetadata(data.subarray(2))); else { at += length + 15; continue; } }
      else if ([0, 1, 2, 3, 14].includes(format)) { track.channels = (data[0] & 1) + 1; track.sampleRate = format === 14 ? 8000 : [5500, 11025, 22050, 44100][(data[0] >> 2) & 3]; }
      result.audio.complete = true; return;
    }
    at += length + 15;
  }
}
function crc(bytes: Uint8Array) {
  let value = 0xffffffff;
  for (const b of bytes) { value ^= b << 24; for (let i = 0; i < 8; i++) value = value & 0x80000000 ? (value << 1) ^ 0x04c11db7 : value << 1; }
  return value >>> 0;
}
async function ts(reader: Budget, result: CachedTrackMetadata) {
  const bytes = await reader.read(0, Math.min(65536, reader.size)), sections = new Map<number, Uint8Array>(), partial = new Map<number, { data: number[]; count: number }>();
  const stride = [188,192,204].find(s => [0,1,2].every(n => bytes[(s === 192 ? 4 : 0) + n * s] === 0x47));
  if (!stride) return;
  result.container = 'MPEG-TS';
  for (let at = stride === 192 ? 4 : 0; at + 188 <= bytes.length; at += stride) {
    if (bytes[at] !== 0x47 || bytes[at + 1] & 0x80 || bytes[at + 3] & 0xc0) continue;
    const pid = ((bytes[at + 1] & 31) << 8) | bytes[at + 2], mode = (bytes[at + 3] >> 4) & 3, count = bytes[at + 3] & 15;
    if (!(mode & 1)) continue;
    let p = at + 4; if (mode & 2) p += 1 + bytes[p]; if (p >= at + 188) continue;
    if (bytes[at + 1] & 64) { p += 1 + bytes[p]; partial.set(pid, { data: [], count }); }
    const part = partial.get(pid); if (!part || (part.data.length && count !== (part.count + 1) % 16)) { partial.delete(pid); continue; }
    part.count = count;
    for (; p < at + 188 && part.data.length < 4096; p++) part.data.push(bytes[p]);
    if (part.data.length < 3) continue;
    const length = 3 + (((part.data[1] & 15) << 8) | part.data[2]);
    if (length > 4096 || length < 12) { partial.delete(pid); continue; }
    if (part.data.length >= length) { const section = Uint8Array.from(part.data.slice(0,length)); if (crc(section) === 0 && section[5] & 1 && section[6] === 0 && section[7] === 0) sections.set(pid, section); partial.delete(pid); }
  }
  const pat = sections.get(0); if (!pat || pat[0] !== 0) return;
  const tracks: AudioTrackMetadata[] = [], aacPids = new Map<number, AudioTrackMetadata>(); let complete = true, programs = 0;
  for (let p = 8; p + 4 <= pat.length - 4; p += 4) {
    if (!pat[p] && !pat[p + 1]) continue;
    programs++; const pmt = sections.get(((pat[p + 2] & 31) << 8) | pat[p + 3]);
    if (!pmt || pmt[0] !== 2 || pmt[3] !== pat[p] || pmt[4] !== pat[p + 1]) { complete = false; continue; }
    for (let q = 12 + (((pmt[10] & 15) << 8) | pmt[11]); q + 5 <= pmt.length - 4;) {
      const type = pmt[q], length = ((pmt[q + 3] & 15) << 8) | pmt[q + 4];
      if (q + 5 + length > pmt.length - 4) { complete = false; break; }
      let codec = ({ 3:'MPEG audio', 4:'MPEG audio', 15:'AAC', 17:'AAC LATM', 0x81:'AC-3', 0x87:'E-AC-3', 0x83:'TrueHD', 0x84:'E-AC-3', 0x8a:'DTS' } as Record<number,string>)[type];
      if (type === 6) for (let d = q + 5; d + 2 <= q + 5 + length;) {
        const tag = pmt[d], len = pmt[d + 1]; if (d + 2 + len > q + 5 + length) break;
        codec ??= ({ 0x6a:'AC-3', 0x7a:'E-AC-3', 0x7b:'DTS', 0x7c:'AAC' } as Record<number,string>)[tag];
        if (tag === 5 && len >= 4) codec ??= ({ 'AC-3':'AC-3', EAC3:'E-AC-3', Opus:'Opus', DTS1:'DTS', DTS2:'DTS', DTS3:'DTS' } as Record<string,string>)[ascii(pmt,d+2,d+6)];
        d += len + 2;
      }
      if (codec && tracks.length >= 32) { complete = false; break; }
      if (codec) { const track = { codec }; tracks.push(track); if (type === 15) aacPids.set(((pmt[q + 1] & 31) << 8) | pmt[q + 2], track); }
      else if (![1,2,0x10,0x1b,0x24,0x33,0x86].includes(type)) complete = false;
      q += 5 + length;
    }
  }
  // Read only an ADTS header at the start of an already cached audio PES.
  // PMT existence remains independent of this optional AAC configuration.
  for (let at = stride === 192 ? 4 : 0; at + 188 <= bytes.length; at += stride) {
    const track = aacPids.get(((bytes[at + 1] & 31) << 8) | bytes[at + 2]);
    if (!track || bytes[at] !== 0x47 || !(bytes[at + 1] & 64) || bytes[at + 1] & 128 || bytes[at + 3] & 0xc0) continue;
    const mode = (bytes[at + 3] >> 4) & 3; if (!(mode & 1)) continue;
    let p = at + 4; if (mode & 2) p += 1 + bytes[p];
    if (p + 9 > at + 188 || bytes[p] || bytes[p + 1] || bytes[p + 2] !== 1) continue;
    p += 9 + bytes[p + 8];
    if (p + 7 > at + 188 || bytes[p] !== 255 || (bytes[p + 1] & 0xf6) !== 0xf0) continue;
    const frequency = (bytes[p + 2] >> 2) & 15, object = (bytes[p + 2] >> 6) + 1, channels = ((bytes[p + 2] & 1) << 2) | (bytes[p + 3] >> 6);
    Object.assign(track, aacMetadata(Uint8Array.of((object << 3) | (frequency >> 1), ((frequency & 1) << 7) | (channels << 3))));
  }
  audio(result, tracks, complete && programs > 0);
}
/** The only byte capability is a non-promoting cache peek. No URL, Blob,
 * Input, AudioContext or decoder can be constructed here. Missing/oversized
 * metadata preserves uncertainty; sample tables and media packets are skipped. */
export async function inspectCachedTracks(size: number, peek: AudioPeek): Promise<CachedTrackMetadata> {
  const result = unknown(), reader = new Budget(peek, size);
  try {
    const head = await reader.read(0, Math.min(16, size));
    if (ascii(head,0,3) === 'FLV') await flv(reader,result);
    else if (head.length >= 4 && u32(head) === 0x1a45dfa3) await ebml(reader,result);
    else if (head.length >= 8 && ['ftyp','styp','moov','mdat','free','wide','skip'].includes(ascii(head,4,8))) await mp4(reader,result);
    else if (head[0] === 0x47 || head[4] === 0x47) await ts(reader,result);
  } catch { /* Cache misses, budgets and malformed metadata are not absence. */ }
  return result;
}
