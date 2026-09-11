import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionLog } from '../src/log.ts';
import { logPreview, LOG_PREVIEW_CHAR_LIMIT } from '../src/log-preview.ts';
test('large reports have bounded paginated previews without losing export data', () => {
  const log = new SessionLog();
  for (let i = 0; i < 2000; i++) log.append('info', 'media', `event ${i}`, { detail: 'x'.repeat(800), details: Array(20).fill('y'.repeat(800)) });
  const report = log.snapshot(), first = logPreview(report, 0), last = logPreview(report, Infinity);
  assert.equal(first.pages, 80); assert.equal(last.page, 79);
  assert.ok(first.text.length <= LOG_PREVIEW_CHAR_LIMIT); assert.ok(last.text.length <= LOG_PREVIEW_CHAR_LIMIT);
  assert.match(first.text, /event 0/); assert.match(last.text, /event 1999/);
  assert.equal(report.events.length, 2000); assert.ok(JSON.stringify(report).length > 1000000);
});
