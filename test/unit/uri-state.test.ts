import test from 'node:test';
import assert from 'node:assert/strict';
import { brotliCompressSync, deflateRawSync } from 'node:zlib';
import { emptyUriState, applyUriParameters, writeUriState, packUriState, unpackUriState, parseUriState } from '../../shared/review/uri-state.ts';
import { encodeUriState, decodeUriState } from '../../server/uri-state.ts';
import { packBinaryUriState, unpackBinaryUriState } from '../../shared/review/uri-binary.ts';
import { annotationTarget } from '../../shared/review/annotation-target.ts';
import type { MediaInfo } from '../../shared/media/types.ts';

const a = '0123456789abcdef01234567', v = '89abcdef0123456789abcdef';
const state = () => applyUriParameters(new URL(`http://localhost/?abi=1&B=${a}@${v}&offset.B=-0.04&A=${v}@${a}&t=12.5&view=split&split=0.37&channel=y&visible.A=0`));
test('ABI state round trips track order, signed offsets, visibility and exact view values through text, tuples and each selected codec', () => {
  const value = state();
  assert.deepEqual(value.tracks.map(t => t.slot), ['B', 'A']); assert.equal(value.tracks[0].offsetUs, -40000);
  assert.equal(value.positionUs, 12500000); assert.equal(value.viewport.splitPos, .37);
  assert.deepEqual(applyUriParameters(writeUriState(value, 'http://localhost')), value);
  assert.deepEqual(unpackUriState(packUriState(value)), value);
  const token = encodeUriState(value); assert.ok(token.length < JSON.stringify(value).length);
  assert.deepEqual(decodeUriState(token), value); assert.equal(encodeUriState(value), token);
  assert.deepEqual(applyUriParameters(new URL('http://localhost/?t=20&channel=rgb'), decodeUriState(token)),
    { ...value, positionUs: 20000000, viewport: { ...value.viewport, channel: 'rgb' } });
});
test('ABI defaults cost no payload fields and minimal single-source links stay bounded', () => {
  assert.deepEqual(packUriState(emptyUriState()), [[]]);
  assert.ok(encodeUriState(emptyUriState()).length <= 12);
  const one = applyUriParameters(new URL(`http://localhost/?abi=1&A=${a}@${v}`));
  assert.ok(encodeUriState(one).length <= 80);
  assert.equal(writeUriState(one, 'http://localhost').searchParams.has('comparison'), false);
  assert.deepEqual(decodeUriState(encodeUriState(one)), one);
});
test('a frozen ABI 1 wire fixture decodes independently of the encoder and application defaults', () => {
  const raw = Buffer.from('W1tbMCwicXFxcXFxcXFxcXFxcXFxcSIsInU3dTd1N3U3dTd1N3U3dTciXV1d', 'base64url');
  const decoded = decodeUriState('1.n.' + raw.toString('base64url'));
  for (const [codec, bytes] of [['d', deflateRawSync(raw)], ['b', brotliCompressSync(raw)]] as const)
    assert.deepEqual(decodeUriState(`1.${codec}.${bytes.toString('base64url')}`), decoded);
  assert.deepEqual(decoded.tracks, [{ slot: 'A', id: 'a'.repeat(24), version: 'b'.repeat(24), offsetUs: 0, visible: true }]);
  assert.equal(decoded.positionUs, 0); assert.equal(decoded.viewport.channel, 'rgb');
  assert.deepEqual(decoded.comparison, { colorMode: 'browser', referenceDecode: { decoder: 'software', depth: 1 }, version: 2,
    presentation: 'voidplayer-color-v2', outputColorSpace: 'srgb', colorOutput: { target: 'sdr', hdrWhiteNits: 203, preview: {
      presentation: 'voidplayer-hdr-sdr-preview-v1', outputColorSpace: 'srgb', toneMap: 'extended-reinhard-luminance',
      gamutMap: 'desaturate-to-luminance', sourcePeakNits: 1000, exposureWhiteNits: 203, hlgDisplayPeakNits: 1000, hlgSystemGamma: 1.2 } } });
});
test('a frozen full binary fixture fixes field order, bit flags, signed integers and comparison defaults', () => {
  const value = emptyUriState();
  value.tracks = [{ slot: 'H', id: 'a'.repeat(24), version: 'b'.repeat(24), offsetUs: -40, visible: false, origin: 'https://x.test' }];
  value.positionUs = 12345;
  value.viewport = { ...value.viewport, mode: 'split', arrangement: 'grid', splitPos: .25, zoom: 2,
    offsetX: 12, offsetY: -8, pixelSize: 'fill', channel: 'u' };
  value.comparison!.referenceDecode = { decoder: 'hardware', depth: 4 };
  value.layout = { panels: { inspector: true, subtracks: false, sources: true, analysis: false }, selected: 'H', dockHeight: 180,
    marksExpanded: true, inspectorTab: 'analysis', filenameWidth: 240, marksWidth: 320, localSourcesHeight: 160,
    sources: { tab: 'available', query: '', root: 'qa', directory: '', search: '', all: false } };
  value.mark = 'mark1'; value.panBasis = { width: 640, height: 360 };
  const fixture = 'PwE_qqqqqqqqqqqqqqqqu7u7u7u7u7u7u7u7UQYOaHR0cHM6Ly94LnRlc3S5YPcDBQAAAAAAANA_IiwECAgBCQQIAgkFCRkJBiTtLwe0AfABwAIIBgJxYaABBgVtYXJrMQOABQPoAg';
  assert.deepEqual(decodeUriState('2.n.' + fixture), value);
  assert.equal(Buffer.from(packBinaryUriState(value)).toString('base64url'), fixture);
});
test('binary share envelopes store 12-byte identities and preserve the ABI 1 state contract', () => {
  // Independent wire fixture: flags, track count, slot/flags, asset bytes, version bytes.
  const bytes = Buffer.from('000100' + 'aa'.repeat(12) + 'bb'.repeat(12), 'hex');
  const expected = { ...emptyUriState(), tracks: [{ slot: 'A' as const, id: 'a'.repeat(24), version: 'b'.repeat(24),
    offsetUs: 0, visible: true }] };
  assert.deepEqual(decodeUriState('2.n.' + bytes.toString('base64url')), expected);
  const token = encodeUriState(applyUriParameters(new URL(`http://localhost/?abi=1&A=${a}@${v}`)));
  assert.match(token, /^2\.[ndb]\./);
  assert.ok(token.length <= 40, `single-source binary token: ${token.length}`);
});
test('coded HDR/panel fields preserve enum meaning and literal multilingual search text', () => {
  const value = state();
  const comparison = value.comparison!;
  assert.equal(comparison.version, 2);
  if (comparison.version === 2) { comparison.colorOutput.target = 'hdr'; comparison.outputColorSpace = 'display-p3'; comparison.colorOutput.hdrWhiteNits = 250; }
  value.layout = { panels: { inspector: true, subtracks: true, sources: true, analysis: true }, selected: 'B', dockHeight: 260,
    marksExpanded: true, sources: { tab: 'available', query: '0 ~query 中文 /?&', root: 'qa', directory: 'a/b', search: '0 ~query 中文 /?&', all: false } };
  assert.deepEqual(decodeUriState(encodeUriState(value)), value);
});
test('binary codecs preserve complete layouts, comparison deltas, pan basis and safe-integer extremes', () => {
  const value = state();
  value.tracks[0].offsetUs = -Number.MAX_SAFE_INTEGER;
  value.tracks[0].origin = 'https://external.test:8443';
  value.tracks[1].offsetUs = Number.MAX_SAFE_INTEGER;
  value.tracks[1].origin = value.tracks[0].origin;
  value.positionUs = Number.MAX_SAFE_INTEGER;
  value.panBasis = { width: 512.25, height: 288.140625 };
  value.viewport.offsetX = -123.125; value.viewport.offsetY = 45.25;
  value.mark = 'mark_123';
  value.layout = { panels: { inspector: false, subtracks: true, sources: true, analysis: false }, selected: 'H', dockHeight: 260,
    marksExpanded: false, inspectorTab: 'analysis', filenameWidth: 240, marksWidth: 0, localSourcesHeight: 192,
    sources: { tab: 'recent', query: '中文 😀 \ud800', root: 'qa', directory: 'a/b', search: '中文 😀 \ud800', all: true },
    analysisView: { view: { start: -Number.MAX_SAFE_INTEGER, end: Number.MAX_SAFE_INTEGER }, axis: 'dts', windowUs: 1000000,
      layoutMode: 'rows', showBitrate: false, showSize: true, follow: false, selected: ['H', 'B'], numAxis: 'dts',
      loadMetrics: ['qp', 'bitrate'], diagrams: ['nalu-types', 'size'], diagram: 'references' } };
  if (value.comparison?.version === 2) {
    value.comparison.colorOutput.target = 'hdr'; value.comparison.outputColorSpace = 'display-p3';
    value.comparison.colorOutput.preview.hlgSystemGamma = 1.35;
    value.comparison.referenceDecode = { decoder: 'hardware', depth: 8 };
  }
  const raw = Buffer.from(packBinaryUriState(value));
  assert.throws(() => packUriState(value), 'legacy tuples must never silently discard the pan basis');
  for (const [codec, bytes] of [['n', raw], ['d', deflateRawSync(raw)], ['b', brotliCompressSync(raw)]] as const)
    assert.deepEqual(decodeUriState(`2.${codec}.${bytes.toString('base64url')}`), value);
  const readable = { ...value, positionUs: 12500000, tracks: value.tracks.map(track => ({ ...track, offsetUs: -40000 })) };
  assert.deepEqual(applyUriParameters(writeUriState(readable, 'http://localhost')), readable);
  const legacyComparison = { ...value, comparison: { version: 1 as const, presentation: 'voidplayer-sdr-v1' as const,
    outputColorSpace: 'srgb' as const, colorMode: 'reference' as const, referenceDecode: { decoder: 'software' as const, depth: 4 as const } } };
  assert.deepEqual(unpackBinaryUriState(packBinaryUriState(legacyComparison)), legacyComparison);
  for (let length = 0; length < raw.length; length++) assert.throws(() => unpackBinaryUriState(raw.subarray(0, length)));
  assert.throws(() => unpackBinaryUriState(Buffer.concat([raw, Buffer.from([0])])));
  assert.throws(() => unpackBinaryUriState(Uint8Array.from([64, 0])));
  assert.throws(() => unpackBinaryUriState(Uint8Array.from([0, 9])));
  assert.throws(() => decodeUriState('2.b.' + brotliCompressSync(Buffer.alloc(65537)).toString('base64url')));
  for (const basis of [{width:0,height:10},{width:100,height:Infinity}]) assert.throws(() => parseUriState({...value,panBasis:basis}));
});
test('URI rejects unknown ABIs, codecs, duplicate/invalid references, noncanonical encodings, bad numbers and decompression bombs', () => {
  for (const query of ['abi=2', 'abi=1&A=unversioned', `abi=1&A=${a}@${v}&A=${a}@${v}`, 'abi=1&t=NaN',
    'abi=1&t=-1', 'abi=1&zoom=Infinity', 'abi=1&split=2', 'abi=1&channel=unknown', 'abi=1&mark=bad!'])
    assert.throws(() => applyUriParameters(new URL('http://localhost/?' + query)), query);
  for (const token of ['2.b.AA', '1.z.AA', '1.n.A', '1.n.!!!!', '1.n.' + 'a'.repeat(16384)]) assert.throws(() => decodeUriState(token));
  assert.throws(() => decodeUriState('1.b.' + brotliCompressSync(Buffer.alloc(65537, 32)).toString('base64url')));
  assert.throws(() => parseUriState({ ...emptyUriState(), tracks: [{ slot: 'A', id: a, version: v, origin: 'https://u:p@host', offsetUs: 0, visible: true }] }));
});
test('versioned media annotation targets ignore slot/ephemeral IDs, isolate content versions and foreign namespaces', async () => {
  const media = { id: 'window-A', source: { kind: 'library', id: a, url: `http://local.test/api/media/${a}/content?v=${v}` } } as MediaInfo;
  const target = await annotationTarget(media, 'http://local.test/');
  assert.match(target, /^media-[0-9a-f]{64}$/);
  assert.equal(await annotationTarget({ ...media, id: 'window-H' }, 'http://local.test/'), target);
  assert.equal(await annotationTarget({ ...media, source: { ...media.source!, url: `https://alias.test/api/media/${a}/content?v=${v}` } }, 'https://alias.test/'), target);
  assert.notEqual(await annotationTarget({ ...media, source: { ...media.source!, url: media.source!.url.replace(v, a) } }, 'http://local.test/'), target);
  assert.notEqual(await annotationTarget(media, 'https://foreign.test/'), target);
  assert.match(await annotationTarget({ ...media, source: undefined }, 'http://local.test/'), /^local-/);
});
