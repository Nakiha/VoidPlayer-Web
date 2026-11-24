import assert from 'node:assert/strict';
import type { AnalysisBlock } from '../../shared/analysis/bitstream/contract.ts';

// The independent geometry and QP references were captured without CABAC positions.
export function withoutBitCount({ bits: _bits, ...block }: AnalysisBlock) { return block; }

export function assertReferenceBlock(blocks: AnalysisBlock[], expected: AnalysisBlock) {
  const actual = blocks.find(block => block.x === expected.x && block.y === expected.y);
  assert.ok(actual, `reference block at ${expected.x}, ${expected.y}`);
  assert.deepEqual(withoutBitCount(actual), expected);
}
