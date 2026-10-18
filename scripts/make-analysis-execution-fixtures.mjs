import {nalRanges} from '../shared/media/codecs/nal-framing.ts';
import{existsSync}from'node:fs';import{readFile,writeFile,mkdir}from'node:fs/promises';import{execFileSync}from'node:child_process';import path from'node:path';
const root=path.resolve(import.meta.dirname,'..'),out=path.join(root,'fixtures/analysis-execution');await mkdir(out,{recursive:true});
const args=['-v','error','-f','lavfi','-i','testsrc2=size=320x184:rate=24','-frames:v','48','-c:v','libx265','-pix_fmt','yuv420p','-x265-params','pools=none:frame-threads=1:keyint=24:min-keyint=24:scenecut=0:open-gop=0:bframes=3:b-adapt=0:log-level=error','-f','hevc','-y',path.join(out,'base.hevc')];execFileSync('ffmpeg',args);
const raw=await readFile(path.join(out,'base.hevc'));
const packets=JSON.parse(execFileSync('ffprobe',['-v','error','-f','hevc','-show_packets','-show_entries','packet=pos,size','-of','json',path.join(out,'base.hevc')])).packets;
function rbspEscape(bytes){const out=[];let zeros=0;for(const b of bytes){if(zeros>=2&&b<=3){out.push(3);zeros=0;}out.push(b);zeros=b===0?zeros+1:0;}return Buffer.from(out);}
function sei(type,payload,prefix=false){return Buffer.concat([Buffer.from([0,0,0,1,(prefix?39:40)<<1,1]),rbspEscape(Buffer.concat([Buffer.from([type,payload.length]),payload,Buffer.from([128])]))]);}
let bits='0'+'00'+'0'+'00'+'0010'+'000'+'1';bits=bits.padEnd(Math.ceil(bits.length/8)*8,'0');const grain=Buffer.from(bits.match(/.{8}/g).map(x=>parseInt(x,2)));
const range=nalRanges('hevc',Buffer.from([0,0,0,1]),raw).find(n=>(raw[n.offset]>>1&63)===34);if(!range)throw Error('PPS missing');const pps=Buffer.concat([Buffer.from([0,0,0,1]),raw.subarray(range.offset,range.offset+range.size)]);
for(const [name,nal,prefix]of[['late-hash',sei(132,Buffer.from([1,0,0,0,0,0,0])),false],['late-grain',sei(19,grain,true),true],['late-pps',pps,true]]){
 const chunks=[];for(let i=0;i<packets.length;i++){const p=packets[i],unit=raw.subarray(Number(p.pos),Number(p.pos)+Number(p.size));chunks.push(i===10&&prefix?Buffer.concat([nal,unit]):i===10?Buffer.concat([unit,nal]):unit);}
 const file=path.join(out,name+'.hevc');await writeFile(file,Buffer.concat(chunks));execFileSync('ffmpeg',['-v','error','-fflags','+genpts','-r','24','-f','hevc','-i',file,'-map','0:v:0','-c','copy','-tag:v','hev1','-y',path.join(out,name+'.mp4')]);console.log(name,packets.length,nal.length);
}

execFileSync('ffmpeg',['-v','error','-fflags','+genpts','-r','24','-f','hevc','-i',path.join(out,'base.hevc'),'-c','copy','-tag:v','hev1','-y',path.join(out,'normal.mp4')]);
execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=size=128x64:rate=24','-frames:v','48','-c:v','libx265','-pix_fmt','yuv420p10le','-x265-params','pools=none:frame-threads=1:keyint=24:min-keyint=24:scenecut=0:open-gop=0:bframes=3:log-level=error','-tag:v','hvc1','-y',path.join(out,'main10.mp4')]);
// Main10 late requirements use the same NAL framing and transaction boundaries.
execFileSync('ffmpeg',['-v','error','-i',path.join(out,'main10.mp4'),'-c','copy','-bsf:v','hevc_mp4toannexb','-f','hevc','-y',path.join(out,'main10.hevc')]);
const raw10=await readFile(path.join(out,'main10.hevc')),packets10=JSON.parse(execFileSync('ffprobe',['-v','error','-f','hevc','-show_packets','-show_entries','packet=pos,size','-of','json',path.join(out,'main10.hevc')])).packets;
const ppsRange10=nalRanges('hevc',Buffer.from([0,0,0,1]),raw10).find(n=>(raw10[n.offset]>>1&63)===34);if(!ppsRange10)throw Error('Main10 PPS missing');
const pps10=Buffer.concat([Buffer.from([0,0,0,1]),raw10.subarray(ppsRange10.offset,ppsRange10.offset+ppsRange10.size)]);
for(const [name,nal,prefix]of[['main10-late-hash',sei(132,Buffer.from([1,0,0,0,0,0,0])),false],['main10-late-grain',sei(19,grain,true),true],['main10-late-pps',pps10,true]]){
 const chunks=packets10.map((p,i)=>{const unit=raw10.subarray(Number(p.pos),Number(p.pos)+Number(p.size));return i===10?Buffer.concat(prefix?[nal,unit]:[unit,nal]):unit;});
 const file=path.join(out,name+'.hevc');await writeFile(file,Buffer.concat(chunks));execFileSync('ffmpeg',['-v','error','-fflags','+genpts','-r','24','-f','hevc','-i',file,'-c','copy','-tag:v','hev1','-y',path.join(out,name+'.mp4')]);
}
execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=size=320x184:rate=24','-frames:v','48','-c:v','libx265','-pix_fmt','yuv420p','-x265-params','pools=none:frame-threads=1:keyint=24:min-keyint=24:scenecut=0:open-gop=1:bframes=3:b-adapt=0:log-level=error','-tag:v','hvc1','-y',path.join(out,'open-gop.mp4')]);
execFileSync('ffmpeg',['-v','error','-i',path.join(out,'open-gop.mp4'),'-c','copy','-bsf:v','hevc_mp4toannexb','-f','hevc','-y',path.join(out,'open.hevc')]);
const openRaw=await readFile(path.join(out,'open.hevc')),openPackets=JSON.parse(execFileSync('ffprobe',['-v','error','-f','hevc','-show_packets','-show_entries','packet=pos,flags','-of','json',path.join(out,'open.hevc')])).packets,second=openPackets.find((p,i)=>i>0&&p.flags.includes('K'));
if(!second)throw Error('CRA fixture needs second key AU');const parameters=new Map();for(const n of nalRanges('hevc',Buffer.from([0,0,0,1]),openRaw)){const t=openRaw[n.offset]>>1&63;if(t>=32&&t<=34&&!parameters.has(t))parameters.set(t,Buffer.concat([Buffer.from([0,0,0,1]),openRaw.subarray(n.offset,n.offset+n.size)]));}
await writeFile(path.join(out,'missing-anchor.hevc'),Buffer.concat([...parameters.values(),openRaw.subarray(Number(second.pos))]));
execFileSync('ffmpeg',['-v','error','-fflags','+genpts','-r','24','-f','hevc','-i',path.join(out,'missing-anchor.hevc'),'-c','copy','-tag:v','hev1','-y',path.join(out,'missing-anchor.mp4')]);

execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=size=320x192:rate=24','-frames:v','48','-c:v','libx264','-pix_fmt','yuv420p','-x264-params','threads=1:keyint=24:min-keyint=24:scenecut=0:open-gop=0:bframes=2:slices=2','-y',path.join(out,'h264.mp4')]);

// VVC custom encoding is not available in a stock ffmpeg; build the 16-frame
// clip from the pinned QA sample with the repository's own MP4 reader and a
// minimal fragmented writer (same approach as the analysis-fmp4 fixtures), so
// no VVC-capable tooling is required. The late-requirement variants inject one
// length-prefixed NAL into AU 10 exactly like the HEVC set: an in-band PPS, a
// suffix decoded-picture-hash SEI and a prefix film-grain SEI.
const vvcSource = path.join(root, 'fixtures/video/h266_10s_1920x1080.mp4');
if (!existsSync(vvcSource)) {
  console.log('skip VVC fixtures: synced h266 sample missing');
} else {
  const { openAnalysisInput } = await import('../shared/analysis/bitstream/input.ts');
  const source = await readFile(vvcSource);
  const vvcInput = await openAnalysisInput({
    size: source.length,
    async read(at, n) { return source.subarray(at, at + n); },
    close() {},
  }, new AbortController().signal);
  if (vvcInput.codec !== 'vvc') throw Error('pinned h266 sample lost its VVC identity');
  const box = (type, ...parts) => {
    const data = Buffer.concat(parts), head = Buffer.alloc(8);
    head.writeUInt32BE(data.length + 8); head.write(type, 4);
    return Buffer.concat([head, data]);
  };
  const u32 = (...values) => { const b = Buffer.alloc(values.length * 4); values.forEach((v, i) => b.writeUInt32BE(v >>> 0, i * 4)); return b; };
  const children = (bytes) => {
    const result = [];
    for (let at = 0; at < bytes.length;) {
      let size = bytes.readUInt32BE(at), header = 8;
      if (size === 1) { size = Number(bytes.readBigUInt64BE(at + 8)); header = 16; }
      if (!size) size = bytes.length - at;
      if (size < header || at + size > bytes.length) throw Error('invalid source box');
      result.push({ type: bytes.toString('ascii', at + 4, at + 8), payload: bytes.subarray(at + header, at + size) });
      at += size;
    }
    return result;
  };
  const initMovie = (data) => {
    let trackId = 0;
    const rewrite = (payload) => Buffer.concat(children(payload).flatMap(({ type, payload: p }) => {
      if (type === 'edts' || type === 'ctts' || type === 'stss' || type === 'mvex') return [];
      if (['moov', 'trak', 'mdia', 'minf', 'stbl'].includes(type)) return [box(type, rewrite(p))];
      if (['stts', 'stsc', 'stco', 'co64'].includes(type)) return [box(type, u32(0, 0))];
      if (type === 'stsz') return [box(type, u32(0, 0, 0))];
      if (type === 'tkhd') trackId = p.readUInt32BE(p[0] === 1 ? 20 : 12);
      if (type === 'mdhd') { p = Buffer.from(p); p.writeUInt32BE(60000, p[0] === 1 ? 20 : 12); }
      return [box(type, p)];
    }));
    const moov = children(data).find(b => b.type === 'moov');
    if (!moov) throw Error('VVC source has no moov');
    const content = rewrite(moov.payload);
    if (!trackId) throw Error('VVC source has no track');
    return { trackId, bytes: Buffer.concat([box('ftyp', Buffer.from('isom\0\0\0\0isomiso6mp41')),
      box('moov', content, box('mvex', box('trex', u32(0, trackId, 1, 1000, 0, 0))))]) };
  };
  const escape = (b) => { const out = []; let z = 0; for (const v of b) { if (z >= 2 && v <= 3) { out.push(3); z = 0; } out.push(v); z = v === 0 ? z + 1 : 0; } return Buffer.from(out); };
  const sei = (type, payload, prefix) => Buffer.concat([Buffer.from([0x00, ((prefix ? 23 : 24) << 3) | 1]),
    escape(Buffer.concat([Buffer.from([type, payload.length]), payload, Buffer.from([128])]))]);
  const layout = initMovie(source);
  const lengthSize = ((vvcInput.configurations[0][0] ?? 0) & 3) + 1;
  const framed = (nal) => { const length = Buffer.alloc(lengthSize); length.writeUIntBE(nal.length, 0, lengthSize); return Buffer.concat([length, nal]); };
  const firstPts = Math.min(...vvcInput.packets.map(p => p.pts));
  const clip = vvcInput.packets.slice(0, 16);
  if (clip.length < 12) throw Error('VVC source clip needs at least 12 access units');
  const units = await Promise.all(clip.map(p => vvcInput.readUnit(p)));
  const pps = (() => {
    // FFmpeg's vvcC record: reserved+lengthSizeMinusOne+ptl_present byte, an
    // optional PTL block, then NAL unit arrays (type 16 = PPS).
    const record = vvcInput.configurations[0];
    let at = 1;
    if (record[0] & 1) {
      const numSublayers = (record.readUInt16BE(at) >> 4) & 7;
      at += 3;
      const constraint = record[at++] & 0x3f;
      at += 2 + constraint;
      if (numSublayers > 1) {
        const flags = record[at++];
        for (let i = numSublayers - 2; i >= 0; i--) if ((flags >> (7 - (numSublayers - 2 - i))) & 1) at++;
      }
      at += record[at] * 4 + 1 + 6;
    }
    const arrays = record[at++];
    for (let i = 0; i < arrays; i++) {
      const type = record[at++] & 0x1f;
      const count = (type === 13 || type === 12) ? 1 : record.readUInt16BE(at);
      if (type !== 13 && type !== 12) at += 2;
      for (let j = 0; j < count; j++) {
        const size = record.readUInt16BE(at); at += 2;
        if (type === 16) return record.subarray(at, at + size);
        at += size;
      }
    }
    return null;
  })();
  if (!pps) throw Error('VVC PPS missing in the first access unit');
  const writeFixture = async (name, patch) => {
    const payloads = clip.map((p, i) => patch?.[i] ?? units[i]);
    const tfdt = Buffer.alloc(12); tfdt.writeUInt32BE(0x01000000); tfdt.writeBigUInt64BE(96000n, 4);
    const run = (a, b, offset) => box('trun', u32(0x01000f00 | (offset === undefined ? 0 : 1), b - a),
      ...(offset === undefined ? [] : [u32(offset)]),
      ...clip.slice(a, b).map((p, k) => u32(1000, payloads[a + k].length, p.key ? 0x02000000 : 0x01010000,
        Math.round((p.pts - firstPts) * 0.06) - p.au * 1000)));
    const moof = (offset) => box('moof', box('mfhd', u32(0, 1)), box('traf', box('tfhd', u32(0x020000, layout.trackId)),
      box('tfdt', tfdt), run(0, clip.length, offset)));
    const fragment = moof(0);
    await writeFile(path.join(out, name + '.mp4'), Buffer.concat([layout.bytes, moof(fragment.length + 8), box('mdat', ...payloads)]));
  };
  const patched = (index, nal, prefix) => units.map((unit, i) => i !== index ? unit : prefix
    ? Buffer.concat([framed(nal), unit]) : Buffer.concat([unit, framed(nal)]));
  await writeFixture('vvc');
  await writeFixture('vvc-late-pps', patched(10, pps, true));
  await writeFixture('vvc-late-hash', patched(10, sei(132, Buffer.from([1, 0, 0, 0, 0, 0, 0, 0]), false), false));
  await writeFixture('vvc-late-grain', patched(10, sei(19, Buffer.from([0, 2]), true), true));
  console.log('VVC execution fixtures written from', path.basename(vvcSource));
  vvcInput.close();
}
