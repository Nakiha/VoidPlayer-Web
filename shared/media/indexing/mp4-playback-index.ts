import type { Mp4Playback } from '../containers/mp4-playback.ts';
import { MediaOpenError } from '../io/media-errors.ts';

export const MP4_PLAYBACK_INDEX_BYTES = 64 * 1024 * 1024;

export function serializeMp4Playback(playback: Mp4Playback, size: number, sourceVersion: string) {
  const { nativeConfig, index } = playback;
  const description = nativeConfig?.description;
  const bytes = description && (ArrayBuffer.isView(description)
    ? new Uint8Array(description.buffer, description.byteOffset, description.byteLength) : new Uint8Array(description));
  return { ...playback, size, sourceVersion,
    nativeConfig: nativeConfig && { ...nativeConfig, description: bytes && [...bytes] },
    index: { ...index, description: [...index.description], configurations: index.configurations?.map(config => [...config]) } };
}

export function parseMp4Playback(value: unknown, size: number, sourceVersion: string): Mp4Playback {
  const doc = value as ReturnType<typeof serializeMp4Playback> | null;
  const bad = (): never => { throw new MediaOpenError('input', '服务端 MP4 播放索引无效或与媒体版本不一致。'); };
  const byteArray = (value: unknown): value is number[] => Array.isArray(value) && value.length <= 1024 * 1024
    && value.every(b => Number.isInteger(b) && b >= 0 && b <= 255);
  if (!doc || doc.size !== size || doc.sourceVersion !== sourceVersion || ![0, 90, 180, 270].includes(doc.rotation)) return bad();
  const { index, nativeConfig } = doc;
  if (!index || !['h264','hevc','av1','vvc','mpeg4','mjpeg','prores'].includes(index.codec) || !byteArray(index.description)
    || !Array.isArray(index.configurations) || !index.configurations.length || index.configurations.length > 256
    || !index.configurations.every(byteArray) || !Array.isArray(index.packets) || !index.packets.length
    || index.packets.length > 2_000_000 || !Array.isArray(index.order) || !Array.isArray(index.durations)
    || index.order.length !== index.packets.length || index.durations.length !== index.packets.length
    || !Array.isArray(doc.displayBounds) || doc.displayBounds.some(b => !b || !Number.isSafeInteger(b.width) || b.width <= 0
      || !Number.isSafeInteger(b.height) || b.height <= 0)
    || !Number.isSafeInteger(index.firstPts) || !Number.isSafeInteger(index.duration) || index.duration <= 0
    || (nativeConfig && (typeof nativeConfig.codec !== 'string' || (nativeConfig.description !== undefined && !byteArray(nativeConfig.description)))))
    return bad();
  let previous = -Infinity;
  for (let i = 0; i < index.packets.length; i++) {
    const p = index.packets[i];
    const sorted = index.packets[index.order[i]];
    if (!p || !Number.isSafeInteger(p.offset) || p.offset < 0 || !Number.isSafeInteger(p.size) || p.size <= 0 || p.size > size - p.offset
      || !Number.isSafeInteger(p.pts) || !Number.isSafeInteger(p.dts) || typeof p.key !== 'boolean' || (!i && !p.key)
      || p.sequenceNumber !== i || !Number.isSafeInteger(p.configuration) || p.configuration! < 0 || p.configuration! >= index.configurations.length
      || !Number.isSafeInteger(index.order[i]) || !sorted || sorted.pts <= previous
      || !Number.isSafeInteger(index.durations[i]) || index.durations[i] <= 0) return bad();
    previous = sorted.pts;
  }
  if (index.packets[index.order[0]].pts !== index.firstPts || previous - index.firstPts + index.durations.at(-1)! !== index.duration) return bad();
  return { ...doc, nativeConfig: nativeConfig && { ...nativeConfig, description: nativeConfig.description && new Uint8Array(nativeConfig.description) },
    index: { ...index, description: new Uint8Array(index.description), configurations: index.configurations.map(config => new Uint8Array(config)) } };
}
