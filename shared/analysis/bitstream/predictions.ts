import { AnalysisFailure } from './failure.ts';

export type PredictionProduct = 'prediction-intra' | 'prediction-inter';
export const isPredictionProduct = (value: unknown): value is PredictionProduct => value === 'prediction-intra' || value === 'prediction-inter';
export const predictionStride = (product: PredictionProduct) => product === 'prediction-intra' ? 16 : 32;
export const PREDICTION_BYTES = 2 * 1024 * 1024;
export const PREDICTION_EXPORTS = ['_vpa_prediction_abi', '_vpa_prediction_select', '_vpa_prediction_count', '_vpa_predictions'] as const;
export function checkPredictionAbi(core: Record<string, any>) {
  if (PREDICTION_EXPORTS.some(key => typeof core[key] !== 'function') || core._vpa_prediction_abi() !== 1)
    throw new AnalysisFailure('unsupported-picture-layout', 'This analysis core does not provide prediction ABI 1');
}

export function copyPredictions(core: Record<string, any>, product: PredictionProduct) {
  const count = core._vpa_prediction_count(), stride = predictionStride(product);
  if (count === -48) throw new AnalysisFailure('resource-limit', 'Prediction record budget exceeded');
  if (count === -52) throw new AnalysisFailure('unsupported-picture-layout', 'Prediction requires a supported progressive 4:2:0 picture');
  if (!Number.isSafeInteger(count) || count < 0 || count * stride > PREDICTION_BYTES) throw Error('Invalid prediction count');
  const ptr = core._vpa_predictions(), bytes = count * stride;
  if (!Number.isSafeInteger(ptr) || ptr < 0 || (!ptr && bytes) || ptr + bytes > core.HEAPU8.byteLength) throw Error('Invalid prediction pointer');
  return new Uint8Array(core.HEAPU8.buffer, ptr, bytes).slice().buffer;
}
const families = ['direction', 'MIP', 'CCLM', 'BDPCM'] as const;
const selections = ['inferred', 'chroma-selector', 'CCLM-index', 'MPM-index', 'remainder'] as const;
const trees = ['single', 'luma', 'chroma'] as const;
const models = ['other', 'translation', 'affine-4', 'affine-6', 'SbTMVP', 'IBC'] as const;

/** Coordinates are in coded luma samples, including records shared by Cb and Cr. */
export function readPrediction(view: DataView, product: PredictionProduct, index: number) {
  const off = index * predictionStride(product);
  const u8 = (i: number) => view.getUint8(off + i);
  const area = {x: view.getUint16(off, true), y: view.getUint16(off + 2, true), width: u8(4), height: u8(5)};
  if (product === 'prediction-intra') {
    return {...area, kind: 'intra' as const, components: u8(6) === 1 ? 'Y' as const : 'CbCr' as const, tree: trees[u8(7)],
      family: families[u8(8)], mode: u8(9), selection: selections[u8(10)], selector: u8(11) === 255 ? null : u8(11),
      isp: u8(12), referenceLine: u8(13), act: !!u8(14)};
  }
  const flags = u8(6), lists = u8(7);
  const reference = (list: number) => lists & (1 << list) ? {
    index: view.getInt8(off + 24 + list), au: view.getInt32(off + 8 + list * 4, true),
    x: view.getInt16(off + 16 + list * 4, true), y: view.getInt16(off + 18 + list * 4, true), denominator: 4 as const,
  } : null;
  return {...area, kind: 'inter' as const, skip: !!(flags & 1), merge: !!(flags & 2), mmvd: !!(flags & 4), ciip: !!(flags & 8),
    subblockMerge: !!(flags & 32), model: models[u8(27)], gpmPartition: u8(28) === 255 ? null : u8(28),
    mergeIndex: u8(26) === 255 ? null : u8(26), l0: reference(0), l1: reference(1)};
}

type Frame = { codec: 'h264' | 'hevc' | 'vvc'; width: number; height: number; picture: {au: number} };
export function validatePredictions(product: PredictionProduct, payload: ArrayBuffer, frame: Frame) {
  const stride = predictionStride(product);
  if (!(payload instanceof ArrayBuffer) || payload.byteLength > PREDICTION_BYTES || payload.byteLength % stride)
    throw Error('Invalid prediction payload length');
  if (product === 'prediction-inter' && frame.codec === 'h264') throw Error('Unsupported AVC inter prediction product');
  if (![frame.width, frame.height].every(n => Number.isInteger(n) && n > 0 && n % 4 === 0) || frame.width > 4096 || frame.height > 2304)
    throw Error('Invalid prediction picture geometry');
  const view = new DataView(payload), cols = frame.width / 4;
  const cells = new Uint8Array(cols * Math.ceil(frame.height / 4));
  for (let off = 0; off < payload.byteLength; off += stride) {
    const x = view.getUint16(off, true), y = view.getUint16(off + 2, true), w = view.getUint8(off + 4), h = view.getUint8(off + 5);
    if (!w || !h || w > 128 || h > 128 || (x | y | w | h) % 4 || x + w > frame.width || y + h > frame.height)
      throw Error('Invalid prediction region');
    const u8 = (i: number) => view.getUint8(off + i);
    const mask = product === 'prediction-intra' ? u8(6) : 1;
    if (mask !== 1 && mask !== 6) throw Error('Invalid prediction components');
    for (let row = y / 4; row < (y + h) / 4; row++) {
      for (let col = x / 4; col < (x + w) / 4; col++) {
        const pos = row * cols + col;
        if (cells[pos] & mask) throw Error('Overlapping prediction regions');
        cells[pos] |= mask;
      }
    }
    if (product === 'prediction-intra') {
      const tree = u8(7), family = u8(8), mode = u8(9), selection = u8(10), raw = u8(11);
      const vvc = frame.codec === 'vvc', hevc = frame.codec === 'hevc';
      const maxMode = vvc ? family === 2 ? 69 : family === 1 ? 31 : 66 : hevc ? 34 : mask === 6 || w === 16 ? 3 : 8;
      if (frame.codec === 'h264' && (w !== h || (mask === 1 ? ![4, 8, 16].includes(w) || selection !== 0 :
          w !== 16 || selection !== 1 || raw !== mode))) throw Error('Invalid AVC intra predictor');
      if (hevc && (mask === 1 ? selection !== 3 && selection !== 4 : selection !== 1)) throw Error('Invalid HEVC intra selector');
      if (vvc && (mask === 1 ? selection !== 0 || u8(14) !== 0 : u8(12) !== 0 || u8(13) !== 0))
        throw Error('Invalid component-specific VVC prediction tools');
      if (tree > 2 || (tree === 1 && mask !== 1) || (tree === 2 && mask !== 6) ||
          (!vvc && (tree || family || u8(12) || u8(13) || u8(14))) || family > 3 || mode > maxMode ||
          selection > 4 || (selection === 0 ? raw !== 255 : raw > [0, 4, 2, 2, 31][selection]) ||
          ((selection === 1 || selection === 2) && mask !== 6) || (selection >= 3 && (!hevc || mask !== 1)) ||
          (family === 2 && (mask !== 6 || mode !== 67 + raw || selection !== 2)) || (selection === 2 && family !== 2) ||
          u8(12) > 2 || u8(13) > 3 || u8(14) > 1 || u8(15)) throw Error('Invalid intra prediction modes');
    } else {
      const flags = u8(6), lists = u8(7), merge = !!(flags & 2), gpm = !!(flags & 16);
      if (flags > 63 || ((flags & 1) && !merge) || u8(27) >= models.length || (gpm ? u8(28) >= 64 : u8(28) !== 255) ||
          u8(29) || u8(30) || u8(31)) throw Error('Invalid inter prediction tools');
      if (frame.codec === 'hevc' ? (flags > 3 || lists < 1 || lists > 3 || u8(27) !== 1 || (merge ? u8(26) > 4 : u8(26) !== 255)) :
          (lists !== 0 || u8(26) !== 255 || (gpm !== (u8(27) === 0)))) throw Error('Invalid codec prediction model');
      for (let i = 0; i < 2; i++) {
        const idx = view.getInt8(off + 24 + i), au = view.getInt32(off + 8 + i * 4, true);
        if (lists & (1 << i) ? idx < 0 || idx >= 16 || au < 0 || au >= frame.picture.au :
            idx !== -1 || au !== -1 || view.getInt32(off + 16 + i * 4, true)) throw Error('Invalid prediction reference');
      }
    }
  }
}
