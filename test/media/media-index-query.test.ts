import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { MediaLibraryIndex } from '../../server/library.ts';
import { createMediaServer } from '../../server/app.ts';
import { instantiateCore } from '../../shared/wasm/core.ts';
import type { SemanticRecord } from '../../shared/media/indexing/semantic-query.ts';
import { FfmpegPacketIndex } from '../../shared/analysis/metadata/ffmpeg-adapter.ts';

test('real cached AVI/PS packets match ffprobe and shared statistics; MP4/FLV/TS misses stay explicit', { timeout: 120000 }, async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'vp-semantic-media-')), media = path.join(dir, 'media'); await mkdir(media);
  const coreDir = process.env.WASM_CORE_DIR || path.resolve('public/vendor/voidplayer-core');
  const glue = await import(pathToFileURL(path.join(coreDir, 'voidplayer-core.js')).href);
  const { core } = await instantiateCore(glue.default, new Uint8Array(await readFile(path.join(coreDir, 'voidplayer-core.wasm'))));
  const indexerBuild = core.ccall('vp_core_build_id', 'string', [], []) as string;
  const identity = { kind: 'ffmpeg' as const, streamKey: 'video:0', schemaVersion: 3, indexerBuild };
  const library = new MediaLibraryIndex([media], { database: path.join(dir, 'index.sqlite'), watch: false });
  const server = createMediaServer({ roots: [media], library, onLog() {} }); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await library.close(); await rm(dir, { recursive: true, force: true }); });
  for (const [name, codec] of [['lossless.avi', 'ffv1'], ['reordered.mpg', 'mpeg2video'], ['candidate.mp4', 'libx264'], ['candidate.flv', 'libx264'], ['candidate.ts', 'mpeg2video']]) {
    const file = path.join(media, name);
    execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=160x96:rate=25', '-frames:v', '24', '-an', '-c:v', codec,
      ...(codec === 'mpeg2video' ? ['-bf', '2'] : []), file], { stdio: 'pipe' });
  }
  await library.refresh();
  for (const entry of library.browse().entries) {
    await t.test(entry.name, async () => {
      const before = await (await fetch(`${base}/api/media/${entry.id}/info?v=${entry.version}`)).json(); assert.equal(before.technicalState, 'not-probed');
      if (!/\.(avi|mpg)$/.test(entry.name)) { assert.deepEqual(before.indexes, []); return; }
      // Explicit test preparation builds the cache. No semantic GET invokes this.
      await library.indexJobs.buildIndex({ id: entry.id, version: entry.version!, size: entry.size, filePath: path.join(media, entry.name), epoch: 0, identity });
      const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_packets', '-show_entries', 'packet=pts,dts,size,flags', '-of', 'json', path.join(media, entry.name)], { encoding: 'utf8' }));
      const endpoint = `${base}/api/media/${entry.id}/index-query?${new URLSearchParams({ v: entry.version!, kind: 'ffmpeg', stream: 'video:0', schema: '3', indexer: indexerBuild })}`;
      const snapshot = await library.indexJobs.call('stream-manifest', { id: entry.id, version: entry.version!, identity });
      const batches = await library.indexJobs.call('stream-batches', { id: entry.id, version: entry.version!, identity, after: -1, limit: 16 });
      const shared = new FfmpegPacketIndex(), meta = snapshot.manifest!.metadata!;
      for (const batch of batches) shared.append(Buffer.from(batch.payload, 'base64'), Number(meta.timeBaseNum), Number(meta.timeBaseDen));
      const original = library.indexJobs.startBuild; library.indexJobs.startBuild = () => { throw Error('query attempted a build'); };
      try {
        let cursor: string | null = null, total = 0, bytes = 0;
        do {
          const res: Response = await fetch(endpoint + '&view=records&startTick=-9223372036854775807&endTick=9223372036854775807&limit=7' + (cursor ? '&cursor=' + cursor : ''));
          const page: { overview: { state: string }; records: SemanticRecord[]; summary: { count: number; sumBytes: number }; nextCursor: string | null } = await res.json(); assert.equal(res.status, 200, JSON.stringify(page));
          assert.equal(page.overview.state, 'complete');
          for (const record of page.records) {
            const reference = probe.packets[Number(record.decodeOrdinal)], sample = shared.locate('source', 0, 'source:v:' + record.decodeOrdinal)!;
            assert.equal(record.ptsTick, reference.pts === undefined ? null : String(reference.pts));
            assert.equal(record.dtsTick, reference.dts === undefined ? null : String(reference.dts));
            assert.equal(record.sizeBytes, Number(reference.size)); assert.equal(record.sizeBytes, sample.sizeBytes);
            assert.equal(record.containerKey, reference.flags.includes('K')); assert.equal(record.pictureType, null); assert.equal(record.qp, null);
          }
          total += page.summary.count; bytes += page.summary.sumBytes; cursor = page.nextCursor;
        } while (cursor);
        const timed = probe.packets.filter((packet: { pts?: number }) => packet.pts !== undefined);
        assert.equal(total, timed.length); assert.equal(shared.summary.packetCount, probe.packets.length);
        assert.equal(bytes, timed.reduce((sum: number, packet: { size: string }) => sum + Number(packet.size), 0));
      } finally { library.indexJobs.startBuild = original; }
    });
  }
});
