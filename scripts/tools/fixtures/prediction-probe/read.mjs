// Read the first 17 video packets of one QA MP4 in decode order. One JSON line per delivered picture.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, openSync, readFileSync, writeSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [moduleFile, codec, filename, mode, output] = process.argv.slice(2);
assert(output && ['avc', 'hevc', 'vvc'].includes(codec) && ['0', '1'].includes(mode),
  'Usage: node read.mjs MODULE avc|hevc|vvc QA.mp4 0|1 OUTPUT.jsonl');
const { default: createCore } = await import(pathToFileURL(resolve(moduleFile)));
const core = await createCore({ wasmBinary: readFileSync(moduleFile.replace(/\.(?:mjs|js)$/, '.wasm')) });
const media = readFileSync(filename);
function probe(...options) {
  return JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', ...options, '-of', 'json', filename]));
}
const [stream] = probe('-show_data', '-show_entries', 'stream=extradata,extradata_size,codec_name').streams;
assert.equal(stream.codec_name, { avc: 'h264', hevc: 'hevc', vvc: 'vvc' }[codec]);
const extra = Buffer.from(stream.extradata.trim().split('\n').map(line => line.slice(10, 49).replaceAll(' ', '')).join(''), 'hex');
assert.equal(extra.length, stream.extradata_size);
const { packets } = probe('-read_intervals', '%+#17', '-show_entries', 'packet=pos,size,pts_time,dts_time');
assert.equal(packets.length, 17);
function sendBytes(bytes, callback) {
  const ptr = core._malloc(bytes.length);
  assert(ptr > 0);
  try {
    core.HEAPU8.set(bytes, ptr);
    return callback(ptr, bytes.length);
  } finally {
    core._free(ptr);
  }
}

const seen = new Set();
const fd = openSync(output, 'w');
function receive() {
  for (;;) {
    const state = core._vpa_step();
    if (state === 0 || state === 2) return state;
    assert.equal(state, 1);
    const au = core._vpa_ordinal();
    assert(au >= 0 && au < packets.length && !seen.has(au));
    seen.add(au);
    const blocks = core._vpa_count(), ptr = core._vpa_blocks();
    const hash = createHash('sha256').update(core.HEAPU8.subarray(ptr, ptr + 12 * blocks)).digest('hex');
    const rows = [];
    if (core._vp_probe_count) {
      const words = new Int32Array(core.HEAPU8.buffer, core._vp_probe_rows(), 16 * core._vp_probe_count());
      for (let i = 0; i < words.length; i += 16) rows.push(Array.from(words.subarray(i, i + 16)));
    }
    const picture = { au, poc: core._vpa_poc(), path: core._vpa_execution_path(), invalid: core._vpa_invalid(), blocks, hash, rows };
    writeSync(fd, JSON.stringify(picture) + '\n');
    assert.equal(core._vpa_take(12 * blocks), blocks);
  }
}
try {
  assert.equal(core._vpa_execution_mode(Number(mode)), 0);
  assert.equal(sendBytes(extra, (ptr, size) => core._vpa_open({ avc: 1, hevc: 2, vvc: 3 }[codec], ptr, size)), 0);
  for (const [au, packet] of packets.entries()) {
    const start = Number(packet.pos), size = Number(packet.size);
    const pts = Math.round(Number(packet.pts_time) * 1e6), dts = Math.round(Number(packet.dts_time) * 1e6);
    assert(Number.isSafeInteger(start) && start >= 0 && start + size <= media.length && size > 0);
    assert(Number.isSafeInteger(pts) && Number.isSafeInteger(dts));
    const result = sendBytes(media.subarray(start, start + size), (ptr, length) => core._vpa_feed(ptr, length, pts, dts, au));
    assert.equal(result, 0);
    assert.equal(receive(), 0);
  }
  assert.equal(core._vpa_drain(), 0);
  assert.equal(receive(), 2);
  assert.equal(seen.size, packets.length);
} finally {
  core._vpa_close();
  closeSync(fd);
}
