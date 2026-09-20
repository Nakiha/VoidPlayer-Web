// Separate client/server processes so client scheduling cannot hide server stalls.
import { fork } from 'node:child_process';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { mkdtemp, mkdir, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MediaLibraryIndex } from '../server/library.ts';
import { createMediaServer } from '../server/app.ts';

if (process.argv.includes('--server')) {
  const root = await mkdtemp(path.join(tmpdir(), 'vp-index-bench-'));
  await mkdir(path.join(root, 'media'));
  const file = await open(path.join(root, 'media', 'long.flv'), 'w');
  await file.truncate(100 * 1024 * 1024); await file.close();
  const library = new MediaLibraryIndex([path.join(root, 'media')], { watch: false });
  await library.refresh();
  const server = createMediaServer({ library, roots: library.roots, onLog() {} });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const delay = monitorEventLoopDelay({ resolution: 10 }); delay.enable();
  process.send({ base: 'http://127.0.0.1:' + server.address().port, entry: library.browse().entries[0] });
  process.on('message', async message => {
    if (message === 'stats') process.send({ delayMaxMs: delay.max / 1e6, peakRssMiB: process.resourceUsage().maxRSS / 1024 });
    if (message === 'close') {
      delay.disable(); await new Promise(r => server.close(r)); await library.close();
      await rm(root, { recursive: true, force: true }); process.exit(0);
    }
  });
} else {
  const child = fork(import.meta.filename, ['--server'], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  const next = () => new Promise((resolve, reject) => { child.once('message', resolve); child.once('error', reject); });
  try {
    const { base, entry } = await next();
    const count = Number(process.env.INDEX_PACKETS || 500000);
    const index = { schema: 2, size: entry.size, codec: 'h264', description: [1, 100, 0, 31, 255, 224, 0],
      packets: Array.from({ length: count }, (_, i) => [13 + i * 16, 10, i * 40000, i * 40000, +(i % 25 === 0)]) };
    const body = JSON.stringify({ epoch: 0, index });
    const url = base + '/api/media/' + entry.id + '?v=' + entry.version;
    async function probe(n) {
      const durations = [];
      for (let i = 0; i < n; i++) {
        const start = performance.now();
        const response = await fetch(url, { headers: { range: 'bytes=0-65535' } });
        if (response.status !== 206) throw Error('Range status ' + response.status);
        await response.arrayBuffer(); durations.push(performance.now() - start);
        await new Promise(r => setTimeout(r, 5));
      }
      durations.sort((a, b) => a - b);
      return { p95Ms: durations[Math.floor(n * .95)], maxMs: durations.at(-1) };
    }
    const baseline = await probe(40);
    const concurrent = probe(100);
    const start = performance.now();
    const response = await fetch(base + '/api/media/' + entry.id + '/frame-index?v=' + entry.version, {
      method: 'POST', headers: { origin: base, 'x-voidplayer-action': 'frame-index', 'content-type': 'application/json' }, body });
    const responseText = await response.text();
    if (response.status !== 201) throw Error(response.status + ' ' + responseText);
    const uploadMs = performance.now() - start, ranges = await concurrent;
    const pendingStats = next(); child.send('stats'); const stats = await pendingStats;
    console.log(JSON.stringify({ packets: count, bodyMiB: Buffer.byteLength(body) / 1024 ** 2, baseline, concurrent: ranges, uploadMs, ...stats }, null, 2));
  } finally { child.send('close'); }
}
