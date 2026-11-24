import { predictionStride, readPrediction } from '../../../../shared/analysis/bitstream/predictions.ts';
import type { AnalysisPredictions } from '../../../../shared/analysis/bitstream/products.ts';

const tools = ['Merge', 'MMVD', 'CIIP', 'GPM'] as const;
const labels = Array.from({ length: 1 << tools.length }, (_, mask) => tools.filter((_, i) => mask & (1 << i)));

export function readInterFrame(frame: AnalysisPredictions) {
  const view = new DataView(frame.payload), count = view.byteLength / predictionStride('prediction-inter');
  const columns = frame.width / 4;
  let cells: Uint8Array | undefined;

  function* records() {
    for (let i = 0; i < count; i++) {
      const record = readPrediction(view, 'prediction-inter', i);
      if (record.kind === 'inter') yield record;
    }
  }

  function toolsAt({x, y}: {x: number; y: number}) {
    if (!cells) {
      // A PU may cover only part of the highlighted analysis block. Index the
      // actual coded point on the same 4×4 lattice as the validated records.
      cells = new Uint8Array(columns * frame.height / 4);
      for (const region of records()) {
        const mask = Number(region.merge) | Number(region.mmvd) << 1 | Number(region.ciip) << 2 | Number(region.gpmPartition !== null) << 3;
        if (!mask) continue;
        for (let row = region.y / 4; row < (region.y + region.height) / 4; row++) {
          cells.fill(mask, row * columns + region.x / 4, row * columns + (region.x + region.width) / 4);
        }
      }
    }
    return labels[cells[Math.floor(y / 4) * columns + Math.floor(x / 4)] ?? 0];
  }

  return { records, toolsAt };
}

export type InterFrame = ReturnType<typeof readInterFrame>;
