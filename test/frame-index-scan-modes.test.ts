import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

test('demux-only MPEG-TS scan matches progressive records and seek pixels', t => {
  const coreDir = process.env.WASM_CORE_DIR || path.resolve('public/vendor/voidplayer-core');
  if (!existsSync(path.join(coreDir, 'voidplayer-core.js')) || !existsSync(path.join(coreDir, 'voidplayer-core.wasm'))) {
    t.skip('WASM core is not synced');
    return;
  }

  const fixture = path.resolve('fixtures/fate/mpegts--h264small.ts');
  const output = execFileSync(process.execPath, [
    path.resolve('scripts/compare-index-scan-modes.mjs'), fixture, '--budget=17',
  ], { encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024 });
  const reportStart = output.lastIndexOf('\n{\n  "progressive"');
  assert.notEqual(reportStart, -1, `benchmark report missing:\n${output}`);
  const report = JSON.parse(output.slice(reportStart + 1));

  assert.equal(report.progressive.progressiveSupported, true, 'fixture exercises decoder-backed progressive indexing');
  assert.notEqual(report.progressive.firstStableBatchMs, null);
  assert.equal(report.demuxOnly.firstStableBatchMs, null, 'demux-only scan publishes no partial stable prefix');
  assert.equal(report.comparison.sameRecordBytes, true);
  assert.equal(report.comparison.sameCount, true);
  assert.equal(report.comparison.sameSeekAnchors, true);
  assert.equal(report.comparison.sameFirstFrame, true);
  assert.equal(report.comparison.sameRandomSeekPixels, true);
  assert.equal(report.comparison.allRandomSeekProbesSucceeded, true);
});
