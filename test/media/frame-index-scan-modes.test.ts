import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

function makeOpenGopHevcFixture(directory: string): string | null {
  const encoders = spawnSync('ffmpeg', ['-hide_banner', '-encoders'], { encoding: 'utf8' });
  if (encoders.error || encoders.status !== 0 || !`${encoders.stdout}\n${encoders.stderr}`.includes('libx265')) return null;

  const fixture = path.join(directory, 'hevc-open-gop-bframes.ts');
  execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=24',
    '-t', '4', '-an', '-c:v', 'libx265', '-preset', 'ultrafast', '-threads', '1',
    '-x265-params', 'open-gop=1:bframes=3:keyint=24:min-keyint=24:scenecut=0:pools=1:frame-threads=1:wpp=0',
    '-f', 'mpegts', fixture,
  ], { timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });

  const frameReport = JSON.parse(execFileSync('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0', '-show_frames', '-show_entries', 'frame=pict_type', '-of', 'json', fixture,
  ], { encoding: 'utf8', timeout: 30_000 }));
  assert.ok(frameReport.frames.some((frame: { pict_type?: string }) => frame.pict_type === 'B'), 'HEVC fixture contains B-frames');

  const traced = spawnSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'debug', '-i', fixture, '-map', '0:v:0', '-c', 'copy', '-bsf:v', 'trace_headers', '-f', 'null', '-',
  ], { encoding: 'utf8', timeout: 30_000, maxBuffer: 8 * 1024 * 1024 });
  assert.equal(traced.status, 0, traced.stderr);
  assert.match(traced.stderr, /nal_unit_type: 21\(CRA_NUT\)/, 'HEVC fixture contains CRA pictures from open GOPs');
  return fixture;
}

test('demux-only MPEG-TS scan matches decoder-backed records and seek pixels across codecs', async t => {
  const coreDir = process.env.WASM_CORE_DIR || path.resolve('public/vendor/voidplayer-core');
  if (!existsSync(path.join(coreDir, 'voidplayer-core.js')) || !existsSync(path.join(coreDir, 'voidplayer-core.wasm'))) {
    t.skip('WASM core is not synced');
    return;
  }

  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'voidplayer-index-modes-'));
  try {
    const hevcFixture = makeOpenGopHevcFixture(tempDir);
    const cases = [
      { name: 'H.264', fixture: path.resolve('fixtures/fate/mpegts--h264small.ts') },
      { name: 'HEVC open-GOP with B-frames', fixture: hevcFixture },
      { name: 'MPEG-2', fixture: path.resolve('fixtures/video/mpeg2_10s_1280x720.ts') },
    ];

    for (const fixtureCase of cases) {
      if (!fixtureCase.fixture) {
        await t.test(fixtureCase.name, { skip: 'ffmpeg with libx265 is required to generate the HEVC open-GOP fixture' }, () => {});
        continue;
      }
      await t.test(fixtureCase.name, () => {
        const output = execFileSync(process.execPath, [
          path.resolve('scripts/compare-index-scan-modes.mjs'), fixtureCase.fixture!, '--budget=1024',
        ], { encoding: 'utf8', timeout: 60_000, maxBuffer: 1024 * 1024 });
        const reportStart = output.lastIndexOf('\n{\n  "progressive"');
        assert.notEqual(reportStart, -1, `benchmark report missing:\n${output}`);
        const report = JSON.parse(output.slice(reportStart + 1));

        assert.equal(report.comparison.sameRecordBytes, true, 'all PTS/DTS/duration/position/size/flag records match byte-for-byte');
        assert.equal(report.comparison.sameCount, true);
        assert.equal(report.comparison.sameSeekAnchors, true);
        assert.equal(report.comparison.sameFirstPts, true);
        assert.equal(report.comparison.sameDuration, true);
        assert.equal(report.comparison.sameFirstFrame, true);
        assert.equal(report.comparison.sameRandomSeekPixels, true);
        assert.equal(report.comparison.allRandomSeekProbesSucceeded, true);
        assert.equal(report.progressive.recordHash, report.demuxOnly.recordHash);
        assert.equal(report.progressive.seekHashes.length, 5);
      });
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
