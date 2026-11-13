import test from 'node:test';
import assert from 'node:assert/strict';
import { brotliCompressSync } from 'node:zlib';
import { emptyUriState, applyUriParameters, writeUriState, packUriState, unpackUriState, parseUriState } from '../../shared/review/uri-state.ts';
import { encodeUriState, decodeUriState } from '../../server/uri-state.ts';
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
  const decoded = decodeUriState('1.n.W1tbMCwicXFxcXFxcXFxcXFxcXFxcSIsInU3dTd1N3U3dTd1N3U3dTciXV1d');
  assert.deepEqual(decoded.tracks, [{ slot: 'A', id: 'a'.repeat(24), version: 'b'.repeat(24), offsetUs: 0, visible: true }]);
  assert.equal(decoded.positionUs, 0); assert.equal(decoded.viewport.channel, 'rgb');
  assert.deepEqual(decoded.comparison, { colorMode: 'browser', referenceDecode: { decoder: 'software', depth: 1 }, version: 2,
    presentation: 'voidplayer-color-v2', outputColorSpace: 'srgb', colorOutput: { target: 'sdr', hdrWhiteNits: 203, preview: {
      presentation: 'voidplayer-hdr-sdr-preview-v1', outputColorSpace: 'srgb', toneMap: 'extended-reinhard-luminance',
      gamutMap: 'desaturate-to-luminance', sourcePeakNits: 1000, exposureWhiteNits: 203, hlgDisplayPeakNits: 1000, hlgSystemGamma: 1.2 } } });
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
