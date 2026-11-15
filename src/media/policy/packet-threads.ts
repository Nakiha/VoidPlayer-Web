import { configuredPicturePixels, readCodingFeatures } from '../../../shared/media/codecs/coding-features.ts';
import { inspectPacketPicture } from '../../../shared/media/codecs/packet-picture.ts';
import type { PacketDecodeIndex, PacketDecodePacket } from '../../../shared/media/indexing/packet-decode-index.ts';
import { lightPlaybackThreads, type DecodeThreads } from './wasm-threads.ts';

type ReadPacket = (packet: PacketDecodePacket) => Promise<Uint8Array>;

export function hasLightPlaybackCadence(index: PacketDecodeIndex) {
  // Millisecond containers quantize 30 fps to 33 or 34 ms. Check presentation
  // timestamps as well as durations so a nominal default cannot hide a fast stream.
  return (index.configurations?.length ?? 1) === 1 && !index.truncatedAt && index.packets.length >= 2 &&
    index.order.length === index.packets.length && index.durations.length === index.order.length &&
    index.durations.every(duration => duration >= 33000) &&
    index.order.every((id, i, order) => !i || index.packets[id].pts - index.packets[order[i - 1]].pts >= 33000);
}

export async function preparePacketThreads(index: PacketDecodeIndex, complete: boolean, budget: DecodeThreads, read: ReadPacket) {
  const description = index.configurations?.[0] ?? index.description;
  const features = readCodingFeatures(index.codec, description);
  const normal = { budget, features, read, lightweight: false, singleSliceLayout: false };
  if (typeof budget === 'number' || !budget.selectForSource || !features ||
      (index.configurations?.length ?? 1) !== 1 || !index.packets.length) return normal;
  const pixels = configuredPicturePixels(features);
  if (!pixels || pixels > 960 * 576 || features.parameterSets.some(p => p.wavefront || (p.tileColumns ?? 1) * (p.tileRows ?? 1) > 1)) return normal;
  if (complete && !hasLightPlaybackCadence(index)) return normal;
  const first = index.packets[0];
  if (!first.key || (first.configuration ?? 0) !== 0 || first.size > 1024 * 1024) return normal;
  let bytes: Uint8Array | undefined = await read(first);
  let slices = 0;
  const picture = inspectPacketPicture(index.codec, description, bytes, count => { slices = count; });
  // Hand the already-read AU to the timeline, including when the probe rules out a cap.
  const readPrimed: ReadPacket = packet => {
    const cached = bytes;
    bytes = undefined;
    return packet === first && cached ? Promise.resolve(cached) : read(packet);
  };
  const singleSliceLayout = picture.singlePicture && slices === 1;
  const lightweight = complete && singleSliceLayout;
  return { budget: lightweight ? lightPlaybackThreads(budget) : budget, features, read: readPrimed, lightweight, singleSliceLayout };
}
