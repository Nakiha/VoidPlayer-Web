import test from 'node:test';
import assert from 'node:assert/strict';
import { committedSemanticRecord, committedRecordSemantics } from '../../shared/media/indexing/committed-record-query.ts';
import { FLV_MEDIA_INDEX_IDENTITY as flv, JS_TS_MEDIA_INDEX_IDENTITY as ts } from '../../shared/media/indexing/media-index-identity.ts';
import { recordMatches, parseSemanticQuery } from '../../shared/media/indexing/semantic-query.ts';

test('FLV records retain decode order, preroll, duplicate PTS and recovery boundaries', () => {
  const context = { identity: flv, size: 10000, recordCount: 4, originTick: '40000' };
  const packets = [[40, 10, 40000, 0, 1], [80, 12, 0, 40000, 0], [120, 14, 120000, 80000, 0], [160, 16, 120000, 120000, 1, 1, 1]];
  const records = packets.map((p, i) => committedSemanticRecord(p, i, context));
  assert.deepEqual(records.map(r => r.ptsTick), ['40000', '0', '120000', '120000']);
  assert.deepEqual(records.map(r => r.decodeOrdinal), ['0', '1', '2', '3']);
  assert.equal(records[1].normalizedPtsUs, '-40000');
  assert.equal(records[3].discontinuity, true); assert.equal(records[3].configurationIndex, 1);
  assert.ok(records.every(r => r.durationTick === null && r.effectiveDurationUs === null && r.qp === null && r.pictureType === null && r.randomAccessVerified === null));
  const query = parseSemanticQuery(new URLSearchParams({ startTick: '40000', endTick: '120000' }));
  assert.deepEqual(records.filter(r => recordMatches(r, query)).map(r => r.decodeOrdinal), ['0']);
});

const packet = (au: number, pts: number | null, dts: number | null, effective = pts === null ? 123456 : Math.round(pts * 1e6 / 90000)) => ({
  au, locator: au * 188, pesOffset: pts === null ? null : au * 188, configuration: 0, size: 100, key: !au,
  timestamp: effective / 1e6, ptsUs: effective, durationUs: 40000,
  timing: { pts, dts, timebase: [1, 90000], origin: pts === null ? 'derived' : 'pes' },
});
test('TS raw clocks stay separate from derived presentation and index duration', () => {
  const context = { identity: ts, size: 10000, recordCount: 3, originTick: null };
  const records = [packet(0, 90000, null), packet(1, null, null), packet(2, 99000, 90000)].map((p, i) => committedSemanticRecord(p, i, context));
  assert.equal(records[0].ptsTick, '90000'); assert.equal(records[0].dtsTick, null);
  assert.equal(records[1].effectivePtsUs, '123456'); assert.equal(records[1].ptsTick, null); assert.equal(records[1].timestampSource, 'derived');
  assert.ok(records.every(r => r.normalizedPtsUs === null && r.durationTick === null && r.discontinuity === null));
  assert.equal(records[2].effectiveDurationUs, '40000');
  const query = parseSemanticQuery(new URLSearchParams({ axis: 'dts', startTick: '0', endTick: '90001' }));
  assert.deepEqual(records.map(r => recordMatches(r, query)), [null, null, true]);
});

test('raw timestamp wrap is never silently sorted, unwrapped or marked continuous', () => {
  const context = { identity: ts, size: 10000, recordCount: 2, originTick: null };
  const records = [packet(0, 2 ** 33 - 9000, 2 ** 33 - 9000), packet(1, 9000, 9000)].map((p, i) => committedSemanticRecord(p, i, context));
  assert.deepEqual(records.map(r => r.ptsTick), ['8589925592', '9000']);
  assert.equal(committedRecordSemantics('js-ts').wrap.reconstruction, 'unavailable');
  assert.equal(committedRecordSemantics('flv').continuity, 'unverified');
  assert.equal(committedRecordSemantics('js-ts').order, 'source-packet-order');
  const flvRecord = committedSemanticRecord([40, 10, 1000, 1000, 0], 1, { identity: flv, size: 10000, recordCount: 2, originTick: '4294967000000' });
  assert.equal(flvRecord.normalizedPtsUs, '-4294966999000');
  assert.equal(committedRecordSemantics('flv').normalization, 'raw-offset-not-unwrapped');
});

test('malformed records fail closed without emitting uploaded extra fields', () => {
  const context = { identity: ts, size: 10000, recordCount: 2, originTick: null };
  const good = packet(0, 90000, 90000);
  for (const p of [{ ...good, au: 1 }, { ...good, ptsUs: Infinity }, { ...good, size: -1 }, { ...good, timing: { ...good.timing, pts: 2 ** 33 } }, { ...good, timing: { ...good.timing, pts: null } }]) assert.throws(() => committedSemanticRecord(p, 0, context));
  const result = committedSemanticRecord({ ...good, privatePath: '/not-for-output' }, 0, context);
  assert.equal(JSON.stringify(result).includes('/not-for-output'), false);
  assert.throws(() => committedSemanticRecord([40, 10, 0, 0, 1, 0, 1], 0, { identity: flv, size: 10000, recordCount: 1, originTick: '0' }));
});
