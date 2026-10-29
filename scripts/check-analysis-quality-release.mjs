// Scores through the actual packaged service, with an empty PATH and unrelated cwd.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { nativeFixture, until, sha } from '../test/helpers/native-vmaf.mjs';
import { cambiFixture } from '../test/helpers/native-cambi.mjs';
import { trackChildShutdown } from './testing/lifecycle.mjs';

const archive = path.resolve(process.argv[2] ?? JSON.parse(await readFile('artifacts/latest-release.json', 'utf8')).archive);
const temp = await mkdtemp(path.join(tmpdir(), 'vp-analysis-release-'));
const oracle = JSON.parse(await readFile('test/helpers/analysis-quality-oracle.json', 'utf8'));
const samples = JSON.parse(await readFile('test/helpers/native-vmaf-samples.json', 'utf8')).samples;
try {
  const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot, 'System32', 'tar.exe') : 'tar';
  execFileSync(tar, ['-xzf', archive, '-C', temp]);
  const directory = path.join(temp, path.basename(archive, '.tar.gz'));
  const release = JSON.parse(await readFile(path.join(directory, 'release.json'), 'utf8'));
  const empty = path.join(temp, 'empty');
  await mkdir(empty);
  const start = async config => {
    const socket = createServer();
    await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
    const port = socket.address().port;
    await new Promise(resolve => socket.close(resolve));
    await mkdir(config.dataDir, { recursive: true });
    await writeFile(path.join(config.dataDir, 'voidplayer.config.json'), JSON.stringify({
      host: '127.0.0.1', port, mediaRoots: config.mediaRoots, indexWatch: false, logsDir: null,
    }));
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (key.toLowerCase() === 'path' || key.startsWith('VOIDPLAYER_') || ['BUN_OPTIONS', 'BUN_INSPECT', 'NODE_OPTIONS'].includes(key)) delete env[key];
    }
    env.PATH = empty;
    const child = spawn(path.join(directory, release.executable), ['--data-dir', config.dataDir], { cwd: empty, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const stop = trackChildShutdown(child);
    let output = '';
    for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => output = (output + bytes).slice(-65536));
    try {
      await until(() => {
        if (child.exitCode !== null) throw Error(output);
        return fetch(`http://127.0.0.1:${port}/api/ready`).then(r => r.ok).catch(() => false);
      }, Boolean, 'Compiled analysis startup');
      return { server: { address: () => ({ port }) }, close: stop };
    } catch (error) { await stop(); throw error; }
  };
  const results = [];
  const vmafCases = [{depth:8,codec:'h264',containers:['flv','flv']},{depth:10,codec:'hevc',containers:['flv','flv']},...([['h264',8],['hevc',8],['hevc',10]]).flatMap(([codec,depth])=>[['mp4','mp4'],['mp4','flv'],['flv','mp4']].map(containers=>({depth,codec,containers})))];
  for (const {depth, codec, containers} of vmafCases) {
    const f = await nativeFixture({ component: false, depth, codec, distorted: true, containers, ...(containers.every(c=>c==='mp4') ? {frameRate: { ticks: 1001, timescale: 30000 }} : {}), start });
    try {
      const job = (await f.json('/api/quality/vmaf/jobs', f.input, 'compiled-analysis')).job;
      const done = await f.wait(job.id);
      assert.equal(done.state, 'completed', JSON.stringify(done));
      const result = await f.json(`/api/quality/vmaf/jobs/${job.id}/result`);
      const expected = oracle.cases.find(c => c.metric === 'vmaf' && !c.same && !c.roi && c.model === 'vmaf_v0.6.1' && samples[c.sampleIndex].depth === depth && samples[c.sampleIndex].tagged && samples[c.sampleIndex].codec === codec);
      assert.equal(result.vmaf.component.executor, 'analysis-wasm');
      assert.equal(result.vmaf.resources.executor, 'analysis-wasm');
      result.vmaf.frames.forEach((frame, i) => assert.ok(Math.abs(frame.score - expected.frames[i]) <= oracle.vmafTolerance));
      for (const key of Object.keys(expected.pooled)) assert.ok(Math.abs(result.vmaf.pooled[key] - expected.pooled[key]) <= oracle.vmafTolerance);
      assert.equal(result.raw.referenceSha256, expected.referenceSha256);
      assert.equal(result.raw.distortedSha256, expected.distortedSha256);
      const published = await f.json(`/api/quality/vmaf/jobs/${job.id}/candidates`, { space: 'default', side: 'reference', maxScore: 100, limit: 1, minFrameDistance: 1, text: 'Compiled rational-clock VMAF', severity: 2 });
      assert.equal(published.createdIds.length, 1);
      results.push({ metric: 'vmaf', depth, codec, containers, frames: result.vmaf.frames.length, pooled: result.vmaf.pooled });
    } finally { await f.close(); }
  }
  for (const [container,codec,depth,variant] of [['flv','h264',8,'forward'],['flv','hevc',10,'forward'],['mp4','h264',8,'forward'],['mp4','hevc',8,'forward'],['mp4','hevc',10,'reordered']]) {
    const c = await cambiFixture({ component: false, depth, codec, container, variant, start });
    try {
      const job = (await c.json('/api/quality/cambi/jobs', c.input, 'compiled-analysis')).job;
      const done = await c.wait(job.id);
      assert.equal(done.state, 'completed', JSON.stringify(done));
      const result = await c.json(`/api/quality/cambi/jobs/${job.id}/result`);
      const expected = oracle.cases.find(item => item.metric === 'cambi' && item.referenceSha256 === c.sample.rawSha256);
      assert.equal(result.component.executor, 'analysis-wasm');
      for (const key of Object.keys(expected.pooled)) assert.ok(Math.abs(result.pooled[key] - expected.pooled[key]) <= oracle.cambiTolerance);
      const page = await c.json(`/api/quality/cambi/jobs/${job.id}/frames`);
      for (const frame of page.entries) {
        assert.ok(Math.abs(frame.score - expected.frames[frame.index]) <= oracle.cambiTolerance);
        for (const map of frame.heatmaps) {
          const response = await c.request(`/api/quality/cambi/jobs/${job.id}/heatmap?index=${frame.index}&scale=${map.scale}`);
          assert.equal(response.status, 200);
          assert.equal(sha(Buffer.from(await response.arrayBuffer())), expected.heatmaps[map.scale].frames[frame.index]);
        }
      }
      results.push({ metric: 'cambi', depth, codec, container, variant, frames: page.entries.length, pooled: result.pooled });
    } finally { await c.close(); }
  }
  const report = path.resolve(process.env.VOIDPLAYER_TEST_ARTIFACTS ?? '.run/analysis-quality-release');
  await mkdir(report, { recursive: true });
  await writeFile(path.join(report, 'analysis-quality.json'), JSON.stringify({ target: release.target, emptyPath: true, results }, null, 2));
  console.log(`PASS ${release.target}: compiled analysis-WASM VMAF/CAMBI 8/10-bit, exact rational MP4 clocks, official scores and all five heatmap scales, empty PATH`);
} finally { await rm(temp, { recursive: true, force: true }); }
