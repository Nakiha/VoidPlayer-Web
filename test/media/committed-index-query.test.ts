import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MediaLibraryIndex } from '../../server/library.ts';
import { createMediaServer } from '../../server/app.ts';
import { FLV_MEDIA_INDEX_IDENTITY as flv, JS_TS_MEDIA_INDEX_IDENTITY as ts } from '../../shared/media/indexing/media-index-identity.ts';
import { parseFlvIndex } from '../../shared/media/indexing/flv-index-cache.ts';
import { flvMediaTiming, flvIndexIntegrity } from '../../shared/media/containers/flv-demux.ts';
import { runSourceQuery } from '../../shared/analysis/metadata/adapters.ts';

test('real FLV and JS-TS commit headers agree with ffprobe and shared statistics, including damaged coverage', { timeout: 120000 }, async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'vp-committed-real-')), media = path.join(dir, 'media'); await mkdir(media);
  const library = new MediaLibraryIndex([media], { database: path.join(dir, 'index.sqlite'), watch: false });
  const server = createMediaServer({ roots: [media], library, onLog() {} }); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); await library.close(); await rm(dir, { recursive: true, force: true }); });
  for (const [name, codec] of [['h264.flv', 'libx264'], ['h264.ts', 'libx264'], ['mpeg2.ts', 'mpeg2video']]) {
    execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=160x96:rate=25', '-frames:v', '60', '-an', '-c:v', codec,
      '-g', '12', '-bf', '2', ...(codec === 'libx264' ? ['-x264-params', 'scenecut=0:repeat-headers=1'] : []), path.join(media, name)], { stdio: 'pipe' });
  }
  const flvBytes = await readFile(path.join(media, 'h264.flv')), tsBytes = await readFile(path.join(media, 'h264.ts'));
  await writeFile(path.join(media, 'tail.flv'), Buffer.concat([flvBytes, Buffer.alloc(1024, 0xa5)]));
  await writeFile(path.join(media, 'tail.ts'), Buffer.concat([tsBytes, Buffer.alloc(188 * 20, 0xa5)]));
  let gapAt = 0;
  for (let at = 13; at + 15 < flvBytes.length; at += 15 + flvBytes.readUIntBE(at + 1, 3)) {
    if (at > flvBytes.length / 3 && flvBytes[at] === 9 && flvBytes[at + 11] === 0x17 && flvBytes[at + 12] === 1) { gapAt = at; break; }
  }
  assert.ok(gapAt); await writeFile(path.join(media, 'gap.flv'), Buffer.concat([flvBytes.subarray(0, gapAt), Buffer.alloc(149, 0xa5), flvBytes.subarray(gapAt)]));
  await library.refresh();
  for (const entry of library.browse().entries) await t.test(entry.name, async () => {
    const identity = entry.name.endsWith('.flv') ? flv : ts;
    const endpoint = `${base}/api/media/${entry.id}/index-query?${new URLSearchParams({ v: entry.version!, kind: identity.kind, stream: identity.streamKey, schema: String(identity.schemaVersion), indexer: identity.indexerBuild })}`;
    assert.equal((await (await fetch(endpoint)).json()).overview.state, 'not-indexed');
    // The explicit existing builder does the only media reads in this flow.
    await library.indexJobs.buildIndex({ id: entry.id, version: entry.version!, size: entry.size, filePath: path.join(media, entry.name), epoch: 0, identity });
    const doc = JSON.parse(new TextDecoder().decode(await library.indexJobs.call('get', { id: entry.id, version: entry.version!, identity }))).index;
    const original = library.indexJobs.startBuild; library.indexJobs.startBuild = () => { throw Error('semantic GET started a build'); };
    try {
      const response = await fetch(endpoint), page = await response.json(); assert.equal(response.status, 200, JSON.stringify(page));
      const o = page.overview;
      assert.equal(o.technical.codec.value, doc.codec); assert.equal(o.evidence.provenance, 'server-scan');
      assert.equal(o.recordCount, doc.packets.length); assert.equal(o.capabilities.records.ready, false);
      assert.equal(o.technical.durationUs.value, null); assert.equal(o.technical.decodedFrameCount.value, null);
      assert.equal(o.technical.frameRateMode.value, null); assert.equal(o.stablePresentationUs, null);
      let packets: { pts: number | null; dts: number | null; size: number; key: boolean }[];
      if (identity.kind === 'flv') {
        const index = parseFlvIndex(doc, entry.size); packets = index.packets;
        assert.equal(o.integrity, flvIndexIntegrity(index));
        assert.equal(o.technical.indexedDurationUs.value, String(flvMediaTiming(index).durationUs));
        assert.equal(o.clock.firstPts, String(index.packets[0].pts));
        assert.equal(o.clock.timeBase.denominator, 1000000); assert.equal(o.clock.nativeTimeBase.denominator, 1000);
      } else {
        packets = doc.packets.map((p: any) => ({ pts: p.timing.pts === null ? null : p.ptsUs, dts: p.timing.dts === null ? null : Math.round(p.timing.dts * 1e6 / 90000), size: p.size, key: p.key }));
        assert.equal(o.integrity, doc.indexIntegrity ?? 'complete');
        assert.equal(o.clock.timeBase.denominator, 90000); assert.equal(o.clock.firstPts, null);
        for (const axis of ['pts', 'dts']) {
          const values = doc.packets.map((p: any) => p.timing[axis]).filter((v: any) => v !== null);
          assert.equal(o.coverage[axis].count, values.length); assert.equal(o.coverage[axis].missing, packets.length - values.length);
          assert.equal(o.coverage[axis].minTick, values.length ? String(Math.min(...values)) : null);
          assert.equal(o.coverage[axis].maxTick, values.length ? String(Math.max(...values)) : null);
        }
      }
      const shared = runSourceQuery(packets, { mediaId: 'test', firstPtsUs: 0, durationUs: 10000000, sourceVersion: 'test', indexRevision: 1,
        capability: { hasSize: true, hasDts: true, keySource: 'container', pictureType: 'key-only', qp: 'unsupported', indexState: 'complete' }, coverageUs: null },
      { requestId: 1, axis: 'pts', startUs: -10000000, endUs: 10000000, pixelWidth: 10, bitrateWindowUs: 1000000 });
      assert.equal(o.coverage.pts.count, shared.samples.length);
      assert.equal(o.statistics.payloadBytes, packets.reduce((n, p) => n + p.size, 0));
      assert.equal(o.statistics.indexKeyCount, packets.filter(p => p.key).length);
      assert.equal(o.coverage.continuousPresentation, null);
      if (/^(tail|gap)/.test(entry.name)) {
        assert.equal(o.state, 'partial'); assert.equal(o.reason, entry.name.startsWith('tail') ? 'retained-prefix' : 'recovered-gaps');
        if (entry.name.startsWith('tail')) assert.equal(o.coverage.truncatedAt, identity.kind === 'flv' ? doc.truncatedAt : doc.indexTruncatedAt);
        else assert.equal(o.coverage.recoveredGapCount, doc.recoveredGaps.length);
      } else {
        assert.equal(o.state, 'complete');
        const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_streams', '-show_packets', '-show_entries', 'stream=codec_name,width,height:packet=pts,dts,size', '-of', 'json', path.join(media, entry.name)], { encoding: 'utf8' }));
        assert.equal(o.technical.codec.value, probe.streams[0].codec_name); assert.equal(o.recordCount, probe.packets.length);
        if (doc.codec === 'h264') { assert.equal(o.technical.visibleWidth.value, probe.streams[0].width); assert.equal(o.technical.visibleHeight.value, probe.streams[0].height); }
        const factor = identity.kind === 'flv' ? 1000 : 1;
        const pts = probe.packets.filter((p: any) => p.pts !== undefined).map((p: any) => p.pts * factor);
        assert.equal(o.coverage.pts.minTick, String(Math.min(...pts))); assert.equal(o.coverage.pts.maxTick, String(Math.max(...pts)));
      }
      const info = await (await fetch(`${base}/api/media/${entry.id}/info?v=${entry.version}`)).json(); assert.deepEqual(info.indexes[0], o);
      const head = await fetch(endpoint, { method: 'HEAD' }); assert.equal(await head.text(), ''); assert.equal(Number(head.headers.get('content-length')), Buffer.byteLength(JSON.stringify(page)));
      const compact = await (await fetch(`${base}/api/media/${entry.id}/frame-index?${new URLSearchParams({ v: entry.version!, kind: identity.kind, stream: identity.streamKey, schema: String(identity.schemaVersion), indexer: identity.indexerBuild })}`)).json();
      assert.deepEqual(compact.index, doc, 'GUI compact index remains identical');
    } finally { library.indexJobs.startBuild = original; }
  });
});
