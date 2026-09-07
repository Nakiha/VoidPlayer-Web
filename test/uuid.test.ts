import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from '../src/uuid.ts';
test('UUID generation uses random bytes without needing secure-context randomUUID', () => {
  const original = crypto.randomUUID;
  Object.defineProperty(crypto, 'randomUUID', { configurable: true, value: undefined });
  try {
    const ids = Array.from({ length: 1000 }, () => randomUUID());
    for (const id of ids) assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.equal(new Set(ids).size, ids.length);
  } finally { Object.defineProperty(crypto, 'randomUUID', { configurable: true, value: original }); }
});
