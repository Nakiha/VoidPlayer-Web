import assert from 'node:assert/strict';
import { openAnalysisInput } from '../../shared/analysis/bitstream/input.ts';

export async function checkAcknowledgedInputBudget(bytes: Uint8Array) {
  const makeReader = () => ({ size: bytes.length, async read(at: number, length: number) { return bytes.subarray(at, at + length); }, close() {} });
  const signal = new AbortController().signal, length = Math.min(bytes.length, 8 * 1024 * 1024);
  const reads = Math.ceil(64 * 1024 * 1024 / length) + 2;
  for (const perOutputBudget of [false, true]) {
    const input = await openAnalysisInput(makeReader(), signal, false, perOutputBudget ? { perOutputBudget } : undefined);
    try {
      assert.equal(input.indexComplete, true);
      assert.equal(input.packets.length, input.totalPackets, 'budget mode must not change index enumeration into a partial prefix');
      await assert.rejects(async () => { for (let n = 0; n < reads; n++) await input.read(0, length); }, /input budget exceeded/);
      await assert.rejects(input.read(0, 32 * 1024 * 1024 + 1), /input budget exceeded/, 'a single read remains bounded');
    } finally { input.close(); }
  }
  const input = await openAnalysisInput(makeReader(), signal, false, { perOutputBudget: true });
  try {
    assert.equal(typeof input.acknowledge, 'function');
    for (let n = 0; n < reads; n++) { await input.read(0, length); input.acknowledge!(); }
    assert.ok(input.bytesRead > 64 * 1024 * 1024, 'diagnostic IO remains cumulative after output acknowledgement');
  } finally { input.close(); }
}
