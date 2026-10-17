import { MediaOpenError } from '../io/media-errors.ts';
import { TsCombinationNotMigrated } from './ts-packet-source.ts';

/** Product admission supplements the shared demuxer with stable, bounded PSI
 * evidence. No payload, AU or codec parsing is implemented here. */
export function staticTsPsi(prefix: Uint8Array): ((bytes: Uint8Array) => void) & {videoStreams:{pid:number;type:number}[]} {
  const malformed = (reason: string): never => { throw new MediaOpenError('container', `JS TS: ${reason}`); };
  const outside = (reason: string): never => { throw new TsCombinationNotMigrated(reason); };
  if (![0, 188, 376].every(at => prefix[at] === 0x47)) outside('product migration requires 188-byte TS');
  const sections = (bytes: Uint8Array, at: number): Uint8Array[] => {
    const end = at + 188, control = (bytes[at + 3] >> 4) & 3;
    if (end > bytes.length || bytes[at] !== 0x47 || !control || bytes[at + 1] & 128 || bytes[at + 3] & 192)
      malformed('invalid PSI transport');
    let p = at + 4;
    if (control & 2) {
      const length = bytes[p++];
      if (p + length > end || control === 3 && p + length === end || control === 2 && p + length !== end)
        malformed('invalid PSI adaptation length');
      if (length && bytes[p] & 128) outside('PSI discontinuity is outside static product admission');
      p += length;
    }
    if (!(control & 1)) return [];
    if (!(bytes[at + 1] & 64)) {
      if (bytes.subarray(p, end).every(byte => byte === 255)) return [];
      return outside('fragmented PSI is outside product admission');
    }
    const pointer = bytes[p++];
    if (p + pointer > end) malformed('invalid PSI pointer');
    if (!bytes.subarray(p, p + pointer).every(byte => byte === 255))
      outside('continued PSI before the pointer is outside product admission');
    p += pointer;
    const result: Uint8Array[] = [];
    while (p < end) {
      if (bytes[p] === 255) {
        if (!bytes.subarray(p, end).every(byte => byte === 255)) malformed('invalid PSI stuffing');
        break;
      }
      if (p + 3 > end) outside('fragmented PSI is outside product admission');
      const length = (bytes[p + 1] & 15) * 256 + bytes[p + 2];
      if ((bytes[p + 1] & 240) !== 176 || length < 9 || length > 1021) malformed('invalid PSI length or syntax');
      const next = p + 3 + length;
      if (next > end) outside('fragmented PSI is outside product admission');
      const value = bytes.subarray(p, next);
      let crc = 0xffffffff;
      for (const byte of value) { crc ^= byte << 24; for (let bit = 0; bit < 8; bit++) crc = (crc << 1) ^ (crc & 0x80000000 ? 0x04c11db7 : 0); }
      if (crc !== 0) malformed('invalid PSI CRC');
      if ((value[5] & 192) !== 192) malformed('invalid PSI version syntax');
      if (!(value[5] & 1) || value[6] !== 0 || value[7] !== 0)
        outside('non-current or multi-section tables are outside static product admission');
      result.push(value);
      p = next;
    }
    return result;
  };
  const first = (pid: number) => {
    for (let at = 0; at + 188 <= prefix.length; at += 188) {
      if (((prefix[at + 1] & 31) * 256 + prefix[at + 2]) !== pid) continue;
      const value = sections(prefix, at)[0];
      if (value) return value.slice();
    }
    return outside('complete startup PSI is outside product admission');
  };
  const pat = first(0), programs: number[] = [];
  if (pat[0] !== 0 || (pat.length - 12) % 4) malformed('invalid startup PAT');
  for (let at = 8; at + 4 <= pat.length - 4; at += 4)
    if (pat[at] || pat[at + 1]) programs.push((pat[at + 2] & 31) * 256 + pat[at + 3]);
  if (programs.length !== 1) outside('single-program TS is required for product admission');
  const pmtPid = programs[0], pmt = first(pmtPid);
  if (pmt[0] !== 2) malformed('invalid startup PMT');
  const videoStreams:{pid:number;type:number}[]=[];
  let streamAt=12+((pmt[10]&15)*256+pmt[11]);
  while(streamAt<pmt.length-4){
    if(streamAt+5>pmt.length-4)malformed('truncated PMT stream');
    const type=pmt[streamAt],pid=(pmt[streamAt+1]&31)*256+pmt[streamAt+2],end=streamAt+5+((pmt[streamAt+3]&15)*256+pmt[streamAt+4]);
    if(end>pmt.length-4)malformed('invalid PMT descriptor length');
    if([1,2,16,27,36,51].includes(type))videoStreams.push({type,pid});
    streamAt=end;
  }
  const check = (bytes: Uint8Array) => {
    if (bytes.length % 188) malformed('partial PSI transport read');
    for (let at = 0; at < bytes.length; at += 188) {
      const pid = (bytes[at + 1] & 31) * 256 + bytes[at + 2];
      if (pid !== 0 && pid !== pmtPid) continue;
      const expected = pid === 0 ? pat : pmt;
      for (const current of sections(bytes, at)) {
        if (current[0] !== expected[0]) malformed('invalid PSI table for selected PID');
        if (current.length !== expected.length || current.some((byte, i) => byte !== expected[i]))
          outside('program-map changes are outside static product admission');
      }
    }
  };
  check(prefix.subarray(0, Math.floor(prefix.length / 188) * 188));
  return Object.assign(check,{videoStreams});
}
