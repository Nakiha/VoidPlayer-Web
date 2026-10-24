import { demuxFlv } from '../../shared/media/containers/flv-demux.ts';
import { serializeFlvIndex } from '../../shared/media/indexing/flv-index-cache.ts';
import { FLV_MEDIA_INDEX_IDENTITY } from '../../shared/media/indexing/media-index-identity.ts';
import { blobPairSource } from '../../src/analysis/quality/source.ts';
import type { FramePairRequest, PairTarget } from '../../shared/analysis/quality/frame-pair.ts';
import type { PreparedPairSource } from '../../src/analysis/quality/source.ts';
export function flvTag(payload: Uint8Array, dts: number) {
  const tag = Buffer.alloc(payload.length + 15); tag[0] = 9; tag.writeUIntBE(payload.length, 1, 3);
  tag.writeUIntBE(dts & 0xffffff, 4, 3); tag[7] = dts >>> 24; tag.set(payload, 11); tag.writeUInt32BE(payload.length + 11, tag.length - 4); return tag;
}
export function wrapFlv(codec: 'h264' | 'hevc', configuration: Uint8Array, packets: Uint8Array[], enhanced = false, origin = 2000) {
  const header = (type: number, pts: number, dts: number) => {
    const cts = Buffer.alloc(3); cts.writeUIntBE((pts - dts) & 0xffffff, 0, 3);
    return enhanced ? Buffer.concat([Buffer.from([0x90 | type]), Buffer.from(codec === 'h264' ? 'avc1' : 'hvc1'), ...(type === 1 ? [cts] : [])])
      : Buffer.concat([Buffer.from([codec === 'h264' ? 0x17 : 0x1c, type]), cts]);
  };
  return Buffer.concat([Buffer.from('464c5601010000000900000000', 'hex'), flvTag(Buffer.concat([header(0, 0, 0), configuration]), 0),
    ...packets.map((bytes, i) => flvTag(Buffer.concat([header(1, origin + i * 1000, origin + i * 1000), bytes]), origin + i * 1000))]);
}
export async function preparedPair(bytes: Uint8Array, id = 'a'.repeat(24), au = 0) {
  const index = await demuxFlv({ size: bytes.length, read: async (o, l) => bytes.subarray(o, o + l) });
  const binding = { mediaId: id, mediaVersion: 'b'.repeat(24), size: bytes.length, indexIdentity: { ...FLV_MEDIA_INDEX_IDENTITY }, indexBuildId: 'cache-test-1' };
  const target: PairTarget = { ...binding, picture: { sourceVersion: `${binding.mediaId}@${binding.mediaVersion}`, stream: 'video', configuration: 0,
    au, picture: 0, layer: 0, field: 'frame' }, sourcePtsUs: index.packets[au].pts };
  const source: PreparedPairSource = { binding, file: new Blob([Uint8Array.from(bytes)]), index: serializeFlvIndex(index, bytes.length) };
  return { source, target, open: () => blobPairSource(source) };
}
export function pairRequest(reference: PairTarget, distorted = reference): FramePairRequest {
  return { pairing: 'caller-specified', reference: structuredClone(reference), distorted: structuredClone(distorted), roi: { x: 2, y: 4, width: 24, height: 20 } };
}
// Actual progressive 32x32 AVC SPS/PPS; the unit-test VCL below is admission-only.
export const pairAvcc = Buffer.from('0164100affe100176764100aacb92d80b5020201400000030040000003008101000568ee0f2c8bfdf8f800', 'hex');
export const admissionIdr = Buffer.from([0, 0, 0, 2, 0x65, 0x80]);
