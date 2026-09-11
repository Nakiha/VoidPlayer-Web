/** Run the application's actual parser locally; never reads the whole video
 * into RAM or uploads media. Requires Node 24+, no WASM/decoder dependency. */
import { openAsBlob } from 'node:fs';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { FlvReader, scanFlv, buildFlvIndex, extendFlvIndex, flvIndexWarning } from '../src/flv-demux.ts';
import type { FlvCheckpoint } from '../src/flv-demux.ts';

const path = process.argv[2];
if (!path) throw new Error('Usage: node scripts/diagnose-flv-index.ts /path/to/file.flv');
const file = await openAsBlob(path), reader = new FlvReader({ file });
const report: Record<string, unknown> = { size: file.size, node: process.version };
try { report.commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: new URL('..', import.meta.url), encoding: 'utf8' }).trim(); }
catch { report.commit = 'unknown'; }
let last: FlvCheckpoint | undefined, publications = 0;
try {
  const startup = await scanFlv(reader, undefined, undefined, true);
  last = startup;
  const complete = await scanFlv(reader, undefined, startup, false, prefix => { last = prefix; publications++; });
  const full = complete.index;
  assert.deepEqual(full, { ...buildFlvIndex(full.codec, full.description, full.packets, full.configurations),
    ...(full.truncatedAt === undefined ? {} : { truncatedAt: full.truncatedAt }) });
  // Force multiple merge schedules even when local disk scans faster than the
  // browser's 500ms publication timer. Keep the real parser's packet objects.
  for (const batch of [127, 1024, 21567]) {
    let index = startup.index;
    for (let end = 1 + batch; end < full.packets.length + batch; end += batch)
      index = extendFlvIndex(index, full.codec, full.description, full.packets.slice(0, end), full.configurations);
    assert.deepEqual(index.order, full.order);
    assert.deepEqual(index.durations, full.durations);
  }
  Object.assign(report, { ok: true, packets: full.packets.length, codec: full.codec, duplicatePts: full.order.length - (full.displayOrder ?? full.order).length, warning: flvIndexWarning(full), durationUs: full.duration, publications, mergeBatches: [127, 1024, 21567] });
} catch (error) {
  Object.assign(report, { ok: false, error: String(error), lastPublished: last && { packets: last.index.packets.length, nextOffset: last.nextOffset }, publications });
  process.exitCode = 1;
} finally { reader.close(); }
console.log(JSON.stringify(report, null, 2));
