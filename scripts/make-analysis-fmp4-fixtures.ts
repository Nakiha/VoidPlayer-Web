import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { openAnalysisInput } from '../src/bitstream-analysis/input.ts';
const box = (type: string, ...parts: Uint8Array[]) => { const data = Buffer.concat(parts), head = Buffer.alloc(8); head.writeUInt32BE(data.length + 8); head.write(type, 4); return Buffer.concat([head, data]); };
const u32 = (...values: number[]) => { const b = Buffer.alloc(values.length * 4); values.forEach((v, i) => b.writeUInt32BE(v >>> 0, i * 4)); return b; };
function children(bytes: Buffer): { type: string, payload: Buffer }[] {
  const result = [];
  for (let at = 0; at < bytes.length;) { let size = bytes.readUInt32BE(at), header = 8; if (size === 1) { size = Number(bytes.readBigUInt64BE(at + 8)); header = 16; } if (!size) size = bytes.length - at;
    if (size < header || at + size > bytes.length) throw Error('invalid source box');
    result.push({ type: bytes.toString('ascii', at + 4, at + 8), payload: bytes.subarray(at + header, at + size) }); at += size; }
  return result;
}
// Keep codec configuration and every compressed AU byte-identical. The source
// QA clips are 60 fps; use an explicit finite decode clock and signed CTS from
// the existing adapter's presentation order (including HEVC POC recovery).
function initMovie(data: Buffer) {
  let trackId = 0;
  const rewrite = (payload: Buffer): Buffer => Buffer.concat(children(payload).flatMap(({ type, payload: p }) => {
    if (type === 'edts' || type === 'ctts' || type === 'stss' || type === 'mvex') return [];
    if (['moov', 'trak', 'mdia', 'minf', 'stbl'].includes(type)) return [box(type, rewrite(p))];
    if (['stts', 'stsc', 'stco', 'co64'].includes(type)) return [box(type, u32(0, 0))];
    if (type === 'stsz') return [box(type, u32(0, 0, 0))];
    if (type === 'tkhd') { trackId = p.readUInt32BE(p[0] === 1 ? 20 : 12); }
    if (type === 'mdhd') { p = Buffer.from(p); p.writeUInt32BE(60000, p[0] === 1 ? 20 : 12); }
    return [box(type, p)];
  }));
  const moov = children(data).find(b => b.type === 'moov')!;
  const content = rewrite(moov.payload);
  if (!trackId) throw Error('missing track');
  return { trackId, bytes: Buffer.concat([box('ftyp', Buffer.from('isom\0\0\0\0isomiso6mp41')), box('moov', content, box('mvex', box('trex', u32(0, trackId, 1, 1000, 0, 0))))]) };
}
await mkdir('fixtures/fmp4-analysis', { recursive: true });
const matrix = JSON.parse(await readFile('scripts/bitstream-analysis-matrix.json', 'utf8'));
for (const row of matrix.rows.filter((r: any) => r.container === 'mp4')) {
  const bytes = await readFile(`fixtures/video/${row.fixture}`), input = await openAnalysisInput({ size: bytes.length, async read(o, n) { return bytes.subarray(o, o + n); }, close() {} }, new AbortController().signal);
  const init = initMovie(bytes), parts = [init.bytes];
  for (let first = 0; first < input.packets.length; first += 20) {
    const packets = input.packets.slice(first, first + 20), payload = await Promise.all(packets.map(p => input.readUnit(p)));
    const tfdt = Buffer.alloc(12); tfdt.writeUInt32BE(0x01000000); tfdt.writeBigUInt64BE(BigInt(96000 + first * 1000), 4);
    const run = (start: number, end: number, offset?: number) => box('trun', u32(0x01000f00 | (offset === undefined ? 0 : 1), end - start), ...(offset === undefined ? [] : [u32(offset)]),
      ...packets.slice(start, end).map(p => u32(1000, p.size, p.key ? 0x02000000 : 0x01010000, Math.round((p.pts - input.packets[0].pts) * 0.06) - p.au * 1000)));
    const moof = (offset: number) => box('moof', box('mfhd', u32(0, first / 20 + 1)), box('traf', box('tfhd', u32(0x020000, init.trackId)), box('tfdt', tfdt), run(0, 10, offset), run(10, packets.length)));
    const fragment = moof(0); parts.push(moof(fragment.length + 8), box('mdat', ...payload));
  }
  await writeFile(`fixtures/fmp4-analysis/fragmented-${input.codec}.mp4`, Buffer.concat(parts));
  console.log(`fragmented-${input.codec}: ${input.packets.length} byte-identical AUs, 30 non-GOP-aligned fragments, 60 truns`); input.close();
}
// A real interleaved AAC traf exercises a standard muxer's fragment layout.
// Video is copied; it retains the same independent codec answers.
const { execFileSync } = await import('node:child_process');
execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-i', 'fixtures/video/h264_9s_1920x1080.mp4',
  '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=12', '-map', '0:v:0', '-map', '1:a:0',
  '-c:v', 'copy', '-c:a', 'aac', '-shortest', '-movflags', 'empty_moov+default_base_moof+frag_keyframe', 'fixtures/fmp4-analysis/fragmented-h264-audio.mp4']);
