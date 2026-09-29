import { test } from 'node:test';
import assert from 'node:assert/strict';
import { frameIndexBuildPolicy } from '../server/frame-index-jobs.ts';

test('server frame-index policy uses progress-idle timeout and a configurable safety cap', () => {
  assert.deepEqual(frameIndexBuildPolicy({}), { idleTimeoutMs: 120_000, absoluteTimeoutMs: 24 * 60 * 60 * 1000 });
  assert.deepEqual(frameIndexBuildPolicy({
    VOIDPLAYER_INDEX_IDLE_TIMEOUT_MS: '90000',
    VOIDPLAYER_INDEX_ABSOLUTE_TIMEOUT_MS: '172800000',
  }), { idleTimeoutMs: 90_000, absoluteTimeoutMs: 172_800_000 });
  assert.throws(() => frameIndexBuildPolicy({ VOIDPLAYER_INDEX_IDLE_TIMEOUT_MS: '300000.5' }), /VOIDPLAYER_INDEX_IDLE_TIMEOUT_MS/);
  assert.throws(() => frameIndexBuildPolicy({
    VOIDPLAYER_INDEX_IDLE_TIMEOUT_MS: '90000',
    VOIDPLAYER_INDEX_ABSOLUTE_TIMEOUT_MS: '90000',
  }), /must exceed the idle timeout/);
});
