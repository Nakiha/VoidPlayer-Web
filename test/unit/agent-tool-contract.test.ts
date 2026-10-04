import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewTools } from '../../src/agent.ts';
import { ReviewSession } from '../../src/session.ts';
import { sessionLog } from '../../src/log.ts';
import { rgbaDescription } from '../../src/frame-description.ts';
import type { MediaSource } from '../../src/media.ts';
import type { AnalysisQuery } from '../../src/analysis/types.ts';

function toolsWithSpy() {
  const calls: { method: string; args: unknown[] }[] = [];
  const session = new Proxy({} as ReviewSession, {
    get: (_target, method: string) => (...args: unknown[]) => { calls.push({ method, args }); return args; },
  });
  const tools = reviewTools(session, { exportWorkspace() {}, async importWorkspace() {} });
  return { calls, get: (name: string) => tools.find(tool => tool.name === name)! };
}

test('tool execute validates published types and bounds before entering actions, without a host validator', () => {
  const { get, calls } = toolsWithSpy();
  const cases: [string, unknown[]][] = [
    ['get_review_session', [null, [], 'object', { extra: true }]],
    ['query_analysis', [
      {}, { slot: 'A', startUs: 0 }, { slot: 'Z', startUs: 0, endUs: 1 },
      { slot: 'A', startUs: '0', endUs: 1 }, { slot: 'A', startUs: .5, endUs: 1 },
      { slot: 'A', startUs: 0, endUs: Infinity },
      ...[{ axis: 'other' }, { pixelWidth: 31 }, { pixelWidth: 4097 }, { pixelWidth: 32.5 },
        { bitrateWindowUs: 0 }, { bitrateWindowUs: -1 }, { bitrateWindowUs: 1.5 },
        { bitrateWindowUs: '123' }, { bitrateWindowUs: null }, { extra: true }]
        .map(extra => ({ slot: 'A', startUs: -1, endUs: 1, ...extra })),
    ]],
    ['set_review_color_mode', [{}, { mode: 'auto' }, { mode: 'browser', extra: true }]],
    ['set_reference_decode', [{ decoder: 'hardware' }, { decoder: 'auto', depth: 1 }, { decoder: 'hardware', depth: 3 }, { decoder: 'software', depth: '2' }]],
    ['set_review_track_visibility', [{ slot: 'A', visible: 1 }, { slot: 'A', visible: 'false' }]],
    ['seek_review', [{ ptsUs: -1 }, { ptsUs: .5 }, { ptsUs: NaN }, { ptsUs: '0' }]],
    ['reorder_review_tracks', [{ order: [] }, { order: 'A' }, { order: ['Z'] }, { order: Array(1) }, { order: Array(9).fill('A') }]],
    ['benchmark_review', [{ durationMs: 999 }, { durationMs: 30001 }, { durationMs: 1000.5 }]],
    ['list_library', [{ limit: 0 }, { limit: 201 }, { limit: '100' }, { recursive: 1 }, { search: 42 }, { offset: -1 }]],
    ['load_library_item', [{ id: 42, slot: 'A' }]],
    ['import_workspace', [{ document: null }, { document: [] }]],
    ['update_review_mark', [{ id: 1 }, { id: 'm', reply: '' }, { id: 'm', resolved: 'true' }]],
    ['add_review_mark', [
      { slot: 'A', text: 'x'.repeat(2001) }, { slot: 'A', severity: 0 }, { slot: 'A', severity: 6 },
      { slot: 'A', drawings: [{ tool: 'pen', points: [] }] },
      { slot: 'A', drawings: [{ tool: 'pen', points: [{ x: 0 }] }] },
      { slot: 'A', drawings: [{ tool: 'pen', points: [{ x: 0, y: 0, extra: 1 }] }] },
      { slot: 'A', drawings: [{ tool: 'pen', points: [{ x: 0, y: 0 }], color: 'red' }] },
      ...[0, 64.1].map(strokeWidth => ({ slot: 'A', drawings: [{ tool: 'pen', points: [{ x: 0, y: 0 }], strokeWidth }] })),
    ]],
  ];
  for (const [name, inputs] of cases) for (const input of inputs) {
    assert.throws(() => get(name).execute(input), /工具参数约定/, `${name}: ${JSON.stringify(input)}`);
  }
  assert.equal(calls.length, 0, 'Invalid arguments never reach session or network actions');
});

test('valid boundary values preserve forwarding, defaults and mutation tracing', () => {
  const { get, calls } = toolsWithSpy();
  const before = sessionLog.read().lastSeq;
  get('get_review_session').execute({}); get('get_review_session').execute({});
  assert.equal(sessionLog.read().lastSeq, before, 'Read-only polling remains quiet');
  for (const pixelWidth of [32, 4096]) for (const bitrateWindowUs of [1, 123, 250000, 5000000]) {
    get('query_analysis').execute({ slot: 'H', axis: 'dts', startUs: -10, endUs: 0, pixelWidth, bitrateWindowUs });
    assert.deepEqual(calls.at(-1), { method: 'queryAnalysis', args: ['H', { axis: 'dts', startUs: -10, endUs: 0, pixelWidth, bitrateWindowUs }] });
  }
  get('query_analysis').execute({ slot: 'A', startUs: 0, endUs: 1 });
  assert.deepEqual(calls.at(-1)?.args, ['A', { axis: 'pts', startUs: 0, endUs: 1, pixelWidth: 320, bitrateWindowUs: 1000000 }]);
  assert.equal(sessionLog.read().lastSeq, before, 'Analysis queries remain quiet');
  get('set_review_track_visibility').execute({ slot: 'A', visible: false });
  assert.deepEqual(calls.at(-1), { method: 'setTrackVisibility', args: ['A', false] });
  get('set_review_track_offset').execute({ slot: 'A', offsetUs: -1 });
  get('add_review_mark').execute({ slot: 'A', severity: 5, text: 'x'.repeat(2000), drawings: [{ tool: 'line', points: [{ x: -1, y: 1 }], color: '#aB1234', strokeWidth: 64 }] });
  const outcomes = sessionLog.read({ sinceSeq: before }).events.filter(event => event.msg === '操作结束');
  assert.equal(outcomes.length, 3);
  assert.ok(outcomes.every(event => (event.data as { status: string }).status === 'completed'));
});

test('analysis window contract keeps non-preset positive integers compatible with the real session facade', async () => {
  const queries: AnalysisQuery[] = [];
  const source: MediaSource = {
    info: { id: 'contract', name: 'contract', size: 1, lastModified: 0, codec: 'test', decoder: 'webcodecs', width: 1, height: 1, firstPtsUs: 0, durationUs: 1000 },
    async frameAt() { return { ptsUs: 0, sourcePtsUs: 0, durationUs: 1000, description: rgbaDescription(1, 1), kind: 'video-sample', width: 1, height: 1, byteSize: 4, close() {} }; },
    async framesAfter() { return []; }, async *framesFrom() {}, dispose() {},
    async queryAnalysis(query) {
      queries.push(query);
      return { requestId: 0, sourceVersion: 'v1', indexRevision: 1, axis: query.axis, origin: { firstPtsUs: 0, offsetUs: 0 },
        samples: [], truncated: false, buckets: null, bitrate: null, coverageUs: null,
        capability: { hasSize: true, hasDts: true, keySource: 'container', pictureType: 'key-only', qp: 'unsupported', indexState: 'complete' } };
    },
  };
  const session = new ReviewSession(() => {});
  try {
    await session.load('A', async () => source);
    const tool = reviewTools(session).find(tool => tool.name === 'query_analysis')!;
    const properties = (tool.inputSchema as { properties: Record<string, object> }).properties;
    assert.deepEqual(properties.bitrateWindowUs, { type: 'integer', minimum: 1 });
    for (const bitrateWindowUs of [1, 123, 250000, 500000, 1000000, 2000000, 5000000]) {
      const query: AnalysisQuery = { axis: 'dts', startUs: -1, endUs: 1, pixelWidth: 32, bitrateWindowUs };
      await tool.execute({ slot: 'A', ...query });
      await session.queryAnalysis('A', query);
      assert.equal(queries.at(-2)?.bitrateWindowUs, bitrateWindowUs);
      assert.equal(queries.at(-1)?.bitrateWindowUs, bitrateWindowUs);
    }
    for (const bitrateWindowUs of [0, -1, .5, NaN, Infinity]) {
      assert.throws(() => tool.execute({ slot: 'A', startUs: 0, endUs: 1, bitrateWindowUs }));
      await assert.rejects(session.queryAnalysis('A', { axis: 'pts', startUs: 0, endUs: 1, pixelWidth: 32, bitrateWindowUs }));
    }
  } finally { await session.dispose(); }
});
