import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RangeReader } from '../../src/range-reader.ts';
import { FlvCachedAudio, aacConfig } from '../../src/flv-cached-audio.ts';
import { OpportunisticAudio } from '../../src/opportunistic-audio.ts';
import type { FlvIndex } from '../../src/flv-demux.ts';
import type { MediaSource } from '../../src/media.ts';
import type { CachedAudioBatch } from '../../src/audio-types.ts';

function tag(type: number, time: number, payload: number[]) {
  const bytes = Buffer.alloc(payload.length + 15);
  bytes[0] = type; bytes.writeUIntBE(payload.length, 1, 3);
  bytes.writeUIntBE(time & 0xffffff, 4, 3); bytes[7] = Math.floor(time / 0x1000000);
  bytes.set(payload, 11); bytes.writeUInt32BE(payload.length + 11, bytes.length - 4);
  return bytes;
}
function fixture() {
  const header = Buffer.from([70, 76, 86, 1, 5, 0, 0, 0, 9, 0, 0, 0, 0]);
  const config = tag(8, 0, [0xaf, 0, 0x11, 0x90]);
  const parts = [header, config]; const packets: FlvIndex['packets'] = [];
  let offset = header.length + config.length;
  for (let i = 0; i < 30; i++) {
    const pts = 2000 + i * 40, video = tag(9, pts, [0x17, 1, 0, 0, 0, 1, 2, 3]);
    packets.push({ offset: offset + 16, size: 3, pts: pts * 1000, dts: pts * 1000, key: true });
    const audio = tag(8, pts + 10, [0xaf, 1, 11, 22, 33]);
    parts.push(video, audio); offset += video.length + audio.length;
  }
  const index: FlvIndex = { codec: 'h264', description: new Uint8Array(), packets,
    order: packets.map((_, i) => i), firstPts: 2000000, duration: 1200000, durations: packets.map(() => 40000) };
  return { bytes: Buffer.concat(parts), index };
}

test('cache misses never fetch; cached observations do not issue another Range request', async () => {
  const { bytes, index } = fixture(); const original = globalThis.fetch; let reads = 0;
  globalThis.fetch = async () => { reads++; return new Response(bytes, { status: 206, headers: {
    'content-range': `bytes 0-${bytes.length - 1}/${bytes.length}`, 'content-length': String(bytes.length) } }); };
  const reader = new RangeReader({ url: 'https://example.test/media.flv', size: bytes.length });
  try {
    const audio = new FlvCachedAudio(reader);
    assert.equal(reader.peek(0, 9), undefined); assert.deepEqual(audio.read(index, 2200000).packets, []); assert.equal(reads, 0);
    await reader.read(index.packets[0].offset, 3); audio.prime();
    const baselineReads = reads, result = audio.read(index, 2200000);
    assert.equal(result.config?.sampleRate, 48000); assert.equal(result.config?.numberOfChannels, 2);
    assert.ok(result.packets.length > 0); assert.equal(result.packets[0].ptsUs, 2130000);
    assert.ok(result.packets.every(p => p.ptsUs <= 2600000 && p.durationUs === 21333));
    assert.equal(reads, baselineReads);
    reader.close(); assert.equal(reader.peek(0, 9), undefined);
  } finally { reader.close(); globalThis.fetch = original; }
});

test('configuration survives startup eviction; incomplete tags are silent and traversal is bounded', () => {
  const { bytes, index } = fixture(); let startup = true, cut = bytes.length, peeks = 0;
  const observer = { peek(at: number, length: number) {
    peeks++; if (at < 0 || at + length > cut || (!startup && at < index.packets[0].offset - 16)) return;
    return bytes.subarray(at, at + length);
  } };
  const audio = new FlvCachedAudio(observer); audio.prime(); startup = false;
  assert.ok(audio.read(index, 2300000).packets.length); assert.equal(audio.read(index, 2800000).config?.codec, 'mp4a.40.2');
  cut = index.packets[0].offset + index.packets[0].size + 4;
  assert.deepEqual(audio.read(index, 2000000).packets, []);
  assert.ok(peeks < 300);
  assert.equal(aacConfig(Uint8Array.of(0x29, 0x90)), undefined, 'HE-AAC is not mislabeled as LC');
  assert.equal(aacConfig(Uint8Array.of(0x11, 0x98)), undefined, 'PCE/surround unsupported');
});

test('a changed AAC configuration disables optional audio, including after backward seek', () => {
  const { bytes, index } = fixture();
  const changed = Buffer.concat([bytes, tag(8, 3200, [0xaf, 0, 0x12, 0x10])]);
  const audio = new FlvCachedAudio({ peek(at, length) {
    if (at < 0 || at + length > changed.length) return;
    return changed.subarray(at, at + length);
  } });
  audio.prime(); assert.ok(audio.read(index, 2200000).packets.length);
  assert.deepEqual(audio.read(index, 3000000), { config: undefined, packets: [] });
  assert.deepEqual(audio.read(index, 2200000), { config: undefined, packets: [] });
});

class FakeBuffer {
  duration = 1024 / 48000;
  getChannelData() { return new Float32Array(1024); }
}
class FakeNode {
  onended: (() => void) | null = null; buffer?: FakeBuffer; stopped = false; starts: number[][] = [];
  connect() {} disconnect() {} stop() { this.stopped = true; }
  start(...values: number[]) { this.starts.push(values); }
}
class FakeContext {
  static created = 0; static instances: FakeContext[] = [];
  state = 'running'; currentTime = 0; destination = {}; nodes: FakeNode[] = [];
  constructor() { FakeContext.created++; FakeContext.instances.push(this); }
  async resume() { this.state = 'running'; } async suspend() { this.state = 'suspended'; }
  async close() { this.state = 'closed'; }
  createBuffer() { return new FakeBuffer(); }
  createBufferSource() { const node = new FakeNode(); this.nodes.push(node); return node; }
}
class FakeDecoder {
  static instances: FakeDecoder[] = []; static support = async () => ({ supported: true });
  static isConfigSupported() { return FakeDecoder.support(); }
  state = 'configured'; decodeQueueSize = 0;
  init: { output(frame: any): void; error(error: unknown): void };
  constructor(init: FakeDecoder['init']) { this.init = init; FakeDecoder.instances.push(this); }
  configure() {} close() { this.state = 'closed'; }
  decode(chunk: { timestamp: number }) {
    this.init.output({ timestamp: chunk.timestamp, sampleRate: 48000, numberOfChannels: 2, numberOfFrames: 1024,
      copyTo() {}, close() {} });
  }
}
class FakeChunk { timestamp: number; constructor(init: { timestamp: number }) { this.timestamp = init.timestamp; } }
const platform = { AudioContext: FakeContext, AudioDecoder: FakeDecoder, EncodedAudioChunk: FakeChunk } as any;
function source() {
  const requests: [number, number][] = [];
  const media = { info: { firstPtsUs: 2000000, durationUs: 12000000 },
    requestCachedAudio(pts: number, generation: number) { requests.push([pts, generation]); } } as unknown as MediaSource;
  return { media, requests };
}
function batch(time: number): CachedAudioBatch {
  return { config: aacConfig(Uint8Array.of(0x11, 0x90)),
    packets: [{ ptsUs: time, durationUs: 21333, data: Uint8Array.of(1, 2) }] };
}
const settle = async () => { await Promise.resolve(); await Promise.resolve(); };

test('default output is inert; pause, seek generation, stalled video and selection stop old audio', async () => {
  const before = FakeContext.created, output = new OpportunisticAudio(() => {}, platform), a = source(), b = source();
  output.tick(0, 0, true); assert.equal(FakeContext.created, before); assert.equal(output.status, 'muted');
  output.select(a.media); await settle(); output.tick(100000, 20000, true);
  assert.equal(a.requests[0][0], 80000);
  const generation = a.requests[0][1];
  a.media.onCachedAudio!(generation, batch(2100000)); await settle(); output.tick(100000, 20000, true);
  const context = FakeContext.instances.at(-1)!;
  assert.equal(context.nodes.length, 1); assert.equal(output.status, 'playing');
  output.tick(100000, 20000, false); assert.ok(context.nodes[0].stopped, 'video stall stops scheduled audio');
  output.pause(); const count = FakeDecoder.instances.length;
  a.media.onCachedAudio!(generation, batch(2500000)); await settle(); assert.equal(FakeDecoder.instances.length, count);
  output.select(b.media); assert.equal(a.media.onCachedAudio, undefined); await settle();
  output.tick(500000, 0, true); assert.equal(b.requests.length, 1);
  output.select(); assert.equal(b.media.onCachedAudio, undefined); assert.equal(output.status, 'muted');
  assert.equal(context.state, 'suspended'); output.dispose();
});

test('late codec probe cannot resurrect output after mute or seek; missing bytes do not wait', async () => {
  let resolve!: (result: { supported: boolean }) => void;
  FakeDecoder.support = () => new Promise(r => { resolve = r; });
  const output = new OpportunisticAudio(() => {}, platform), a = source();
  output.select(a.media); await settle(); output.tick(100000, 0, true);
  a.media.onCachedAudio!(a.requests[0][1], batch(2100000));
  const count = FakeDecoder.instances.length; output.select(); resolve({ supported: true }); await settle();
  assert.equal(FakeDecoder.instances.length, count); assert.equal(output.status, 'muted');
  output.dispose(); FakeDecoder.support = async () => ({ supported: true });
});
