import assert from 'node:assert/strict';
import test from 'node:test';
import { createTrackToasts } from '../../src/ui/track-toasts.ts';
import { setLanguage } from '../../src/i18n.ts';
import type { ReviewSession } from '../../src/session.ts';
import type { ToastOptions } from '../../src/ui/toast.ts';

type Track = ReturnType<ReviewSession['getState']>['tracks'][number];
const track = (patch: Partial<Track> = {}): Track => ({ slot: 'A', id: 'video', sourceGen: 1, ...patch } as Track);
function fixture() {
  const shown: { text: () => string; options: ToastOptions; closed: boolean }[] = [];
  const life = new AbortController();
  let logOpens = 0;
  const update = createTrackToasts({ show(message, options = {}) {
    const notice = { text: () => typeof message === 'function' ? message() : message, options, closed: false };
    shown.push(notice);
    return () => { notice.closed = true; };
  } }, () => { logOpens++; }, life.signal);
  return { shown, life, update, logOpens: () => logOpens };
}

test('sync notices update, clear on recovery and do not replay after manual dismissal', () => {
  const { update, shown } = fixture();
  const waiting = track({ syncState: 'index-wait' });
  update([waiting]);
  assert.equal(shown.length, 1);
  assert.equal(shown[0].options.durationMs, 0);
  assert.match(shown[0].text(), /轨道 A.*等待索引数据/);
  shown[0].closed = true; // User closes the toast while the track still waits.
  update([structuredClone(waiting)]);
  assert.equal(shown.length, 1);
  update([track({ syncState: 'catching-up' })]);
  assert.equal(shown.length, 2);
  assert.match(shown[1].text(), /正在追赶播放位置/);
  update([track()]);
  assert.equal(shown[1].closed, true);
  update([waiting]);
  assert.equal(shown.length, 3, 'a later wait is a new incident');
});

test('failure replaces sync notice, opens logs and clears on source replacement/removal', () => {
  const { update, shown, logOpens } = fixture();
  update([track({ syncState: 'index-wait' })]);
  const failed = track({ failure: { message: 'decode failed', positionUs: 1000 } });
  update([failed]);
  assert.equal(shown[0].closed, true);
  assert.equal(shown[1].options.kind, 'warning');
  assert.match(shown[1].text(), /画面已停止更新.*decode failed/);
  shown[1].options.action!.onClick();
  assert.equal(logOpens(), 1);
  update([structuredClone(failed)]);
  assert.equal(shown.length, 2);
  update([track({ sourceGen: 2 })]);
  assert.equal(shown[1].closed, true);
  update([{ ...failed, sourceGen: 2 }]);
  assert.equal(shown.length, 3, 'the same failure on a new source must be reported');
  update([]);
  assert.equal(shown[2].closed, true);
});

test('missing-source notices are owned by relink; peer notices and cleanup remain independent', () => {
  const { update, shown, life } = fixture();
  const failed = track({ failure: { message: 'missing', positionUs: 0 } });
  const peer = track({ slot: 'B', syncState: 'index-wait' });
  update([{ ...failed, pendingRelink: true }, peer]);
  assert.equal(shown.length, 1);
  assert.match(shown[0].text(), /轨道 B/);
  update([failed, peer]);
  assert.equal(shown.length, 2);
  update([{ ...failed, pendingRelink: true }, peer]);
  assert.equal(shown[1].closed, true);
  assert.equal(shown[0].closed, false);
  life.abort();
  assert.equal(shown[0].closed, true);
  update([failed]);
  assert.equal(shown.length, 2);
});

test('an existing notice can change language without replaying the incident', async () => {
  const { update, shown } = fixture();
  const waiting = track({ syncState: 'index-wait' });
  update([waiting]);
  await setLanguage('en', { persist: false });
  try {
    assert.match(shown[0].text(), /Track A/);
    update([waiting]);
    assert.equal(shown.length, 1);
  } finally { await setLanguage('zh-CN', { persist: false }); }
});
