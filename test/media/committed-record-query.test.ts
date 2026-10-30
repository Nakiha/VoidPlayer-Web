import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createMediaServer } from '../../server/app.ts';
import { MediaLibraryIndex } from '../../server/library.ts';
import { FLV_MEDIA_INDEX_IDENTITY as flv, JS_TS_MEDIA_INDEX_IDENTITY as ts } from '../../shared/media/indexing/media-index-identity.ts';
import { committedSemanticRecord } from '../../shared/media/indexing/committed-record-query.ts';
import { recordMatches, parseSemanticQuery } from '../../shared/media/indexing/semantic-query.ts';

// Independent on-wire oracle: ffprobe may synthesize absent PES DTS (notably
// MPEG-2 B pictures), so its populated timestamps alone cannot prove raw clocks.
function pesClocks(bytes: Buffer, offset: number | null) {
  if (offset === null) return { pts: null, dts: null };
  assert.equal(bytes[offset], 0x47);
  const adaptation = (bytes[offset + 3] >> 4) & 3;
  const start = offset + 4 + (adaptation === 3 ? 1 + bytes[offset + 4] : 0);
  assert.equal(bytes.readUIntBE(start, 3), 1);
  const flags = bytes[start + 7] >> 6;
  const clock = (at: number) => String((BigInt(bytes[at] & 14) << 29n) | (BigInt(bytes[at + 1]) << 22n)
    | (BigInt(bytes[at + 2] & 254) << 14n) | (BigInt(bytes[at + 3]) << 7n) | BigInt(bytes[at + 4] >> 1));
  return { pts: flags & 2 ? clock(start + 9) : null, dts: flags === 3 ? clock(start + 14) : null };
}

test('committed FLV/TS records agree with ffprobe and raw PES clocks without filling missing DTS', { timeout: 120000 }, async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'vp-native-records-')), media = path.join(dir, 'media'); await mkdir(media);
  const library = new MediaLibraryIndex([media], { database: path.join(dir, 'index.sqlite'), watch: false });
  const server = createMediaServer({ roots: [media], library, onLog() {} });
  await library.qualityApplication.ready;
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); await library.close(); await rm(dir, { recursive: true, force: true }); });
  for (const [name, codec] of [['reorder.flv', 'libx264'], ['reorder.ts', 'libx264'], ['mpeg2.ts', 'mpeg2video']]) {
    execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=160x96:rate=25', '-frames:v', '75', '-an', '-c:v', codec,
      '-g', '12', '-bf', '2', ...(codec === 'libx264' ? ['-x264-params', 'scenecut=0:repeat-headers=1'] : []), path.join(media, name)], { stdio: 'pipe' });
  }
  await library.refresh();
  for (const entry of library.browse().entries) await t.test(entry.name, async () => {
    const identity = entry.name.endsWith('.flv') ? flv : ts;
    await library.indexJobs.buildIndex({ id: entry.id, version: entry.version!, size: entry.size, filePath: path.join(media, entry.name), epoch: 0, identity });
    const doc = JSON.parse(new TextDecoder().decode(await library.indexJobs.call('get', { id: entry.id, version: entry.version!, identity }))).index;
    const context = { identity, size: entry.size, recordCount: doc.packets.length, originTick: identity.kind === 'flv' ? String(doc.packets[0][2]) : null };
    const records = doc.packets.map((p: unknown, i: number) => committedSemanticRecord(p, i, context));
    const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_packets', '-show_entries', 'packet=pts,dts,size,flags', '-of', 'json', path.join(media, entry.name)], { encoding: 'utf8' }));
    assert.equal(records.length, probe.packets.length);
    const factor = identity.kind === 'flv' ? 1000n : 1n;
    const tick = (value: number | undefined) => value === undefined ? null : String(BigInt(value) * factor);
    const bytes = await readFile(path.join(media, entry.name));
    const clocks: { pts: string | null; dts: string | null }[] = probe.packets.map((p: any, i: number) => identity.kind === 'flv'
      ? { pts: tick(p.pts), dts: tick(p.dts) } : pesClocks(bytes, doc.packets[i].pesOffset));
    for (let i = 0; i < records.length; i++) {
      const r = records[i], p = probe.packets[i];
      assert.equal(r.decodeOrdinal, String(i)); assert.equal(r.ptsTick, clocks[i].pts); assert.equal(r.dtsTick, clocks[i].dts);
      if (clocks[i].pts !== null) assert.equal(r.ptsTick, tick(p.pts));
      if (clocks[i].dts !== null) assert.equal(r.dtsTick, tick(p.dts));
      assert.equal(r.sizeBytes, Number(p.size)); assert.equal(r.containerKey, p.flags.includes('K'));
      assert.equal(r.durationTick, null); assert.equal(r.randomAccessVerified, null); assert.equal(r.pictureType, null); assert.equal(r.qp, null);
    }
    // Both axes filter original ticks; returning source order must preserve B-frame reorder.
    if (entry.name === 'mpeg2.ts') assert.ok(clocks.some((c, i) => c.dts === null && probe.packets[i].dts !== undefined));
    for (const axis of ['pts', 'dts'] as const) {
      const known = clocks.map(c => c[axis]).filter(c => c !== null);
      const start = known[1], end = known.at(-2)!;
      const query = parseSemanticQuery(new URLSearchParams({ axis, startTick: start, endTick: end }));
      const actual = records.filter((r: Parameters<typeof recordMatches>[0]) => recordMatches(r, query));
      const expected = clocks.map((p, i) => ({ value: p[axis], i })).filter(p => p.value !== null && BigInt(p.value) >= BigInt(start) && BigInt(p.value) < BigInt(end));
      const params = new URLSearchParams({ v: entry.version!, kind: identity.kind, stream: identity.streamKey, schema: String(identity.schemaVersion), indexer: identity.indexerBuild, view: 'records', axis, startTick: start, endTick: end, limit: '7', byteBudget: '16384' });
      const endpoint = `${base}/api/media/${entry.id}/index-query?${params}`;
      const received: typeof records = []; let cursor: string | null = null, inspected = 0, untimed = 0, pages = 0;
      do {
        const res: Response = await fetch(endpoint + (cursor ? '&cursor=' + cursor : ''));
        const page: any = await res.json(); assert.equal(res.status, 200, JSON.stringify(page));
        assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 16384);
        assert.ok(page.readBytes <= 262144); assert.ok(page.inspected <= 2048);
        received.push(...page.records); inspected += page.inspected; untimed += page.inspectedUntimed;
        cursor = page.nextCursor; assert.ok(++pages < 30);
      } while (cursor);
      assert.deepEqual(received, actual); assert.equal(inspected, records.length);
      assert.equal(untimed, clocks.filter(c => c[axis] === null).length);
      assert.deepEqual(actual.map((r: { decodeOrdinal: string }) => r.decodeOrdinal), expected.map((p: { i: number }) => String(p.i)));
    }
  });
});
