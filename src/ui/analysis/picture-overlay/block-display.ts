import type { AnalysisBlock, ReadonlyAnalysisResult } from '../../../../shared/analysis/bitstream/contract.ts';

import type { Slot } from '../../../../shared/review/model.ts';

export const dimensions = ['modes', 'sizes', 'qp', 'depth'] as const;
export type Dimension = typeof dimensions[number];
export type FillMode = 'none' | Dimension;
export type BlockFilter = { slot: Slot; picture: ReadonlyAnalysisResult; dimension: Dimension; key: string };
export type Bin = { key: string; count: number; pixels: number };

export function blockKey(block: AnalysisBlock, dimension: Dimension): string | null {
  switch (dimension) {
    case 'modes': return block.mode;
    case 'sizes': return `${block.width}×${block.height}`;
    case 'qp': return block.qp === null ? null : String(block.qp);
    case 'depth': return block.depth === undefined ? null : String(block.depth);
  }
}

export function blockColor(dimension: Dimension, key: string, codec: ReadonlyAnalysisResult['codec']) {
  if (dimension === 'modes') return key === 'intra' ? 'rgb(64,200,255)' : key === 'skip' ? 'rgb(80,220,110)' : 'rgb(255,160,60)';
  if (dimension === 'qp') return `hsl(${240 - Number(key) * 240 / (codec === 'vvc' ? 63 : 51)},90%,50%)`;
  if (dimension === 'depth') return `hsl(${220 - Number(key) * 40},80%,58%)`;
  const [width, height] = key.split('×').map(Number);
  const scale = Math.log2(width * height) / 2, aspect = Math.log2(width / height);
  return `hsl(${260 - scale * 37 + aspect * 12},75%,${55 + Math.max(-12, Math.min(12, aspect * 3))}%)`;
}

export function summarizeBlocks(frame: ReadonlyAnalysisResult) {
  const maps = { modes: new Map<string, Bin>(), sizes: new Map<string, Bin>(), qp: new Map<string, Bin>(), depth: new Map<string, Bin>() };
  for (const block of frame.blocks) {
    for (const dimension of dimensions) {
      const key = blockKey(block, dimension);
      if (key === null) continue;
      const bins = maps[dimension];
      let bin = bins.get(key);
      if (!bin) { bin = { key, count: 0, pixels: 0 }; bins.set(key, bin); }
      bin.count++;
      bin.pixels += block.width * block.height;
    }
  }
  const numeric = (a: Bin, b: Bin) => Number(a.key) - Number(b.key);
  const qp = [...maps.qp.values()].sort(numeric);
  return {
    blockCount: frame.blocks.length, codedPixels: frame.width * frame.height,
    qp: { min: qp.length ? Number(qp[0].key) : null, mean: frame.qp.mean, max: qp.length ? Number(qp[qp.length - 1].key) : null },
    distributions: { modes: [...maps.modes.values()], sizes: [...maps.sizes.values()].sort((a, b) => b.pixels - a.pixels),
      qp, depth: [...maps.depth.values()].sort(numeric) },
  };
}
