import type { AnnexBCodec } from '../codecs/annex-b-picture.ts';

export const ANNEX_B_PROBE_BYTES = 32 * 1024 * 1024;
const PROBE_BLOCK_BYTES = 256 * 1024;

export interface ContainerProbeReader {
  readonly size: number;
  read(offset: number, length: number): Promise<Uint8Array>;
}

/** Retain the start-code and NAL-header state across read boundaries. */
class AnnexBHeaderProbe {
  possible = true;
  private zeros = 0;
  private started = false;
  private nextIsHeader = false;
  private firstByte?: number;

  scan(bytes: Uint8Array): AnnexBCodec | undefined {
    for (const byte of bytes) {
      if (this.nextIsHeader) {
        this.nextIsHeader = false;
        // MPEG-PS and MPEG video also start with 00 00 01, followed by codes like BA or B3.
        if (byte & 0x80) { this.possible = false; return; }
        this.firstByte = byte;
      } else if (this.firstByte !== undefined) {
        const first = this.firstByte;
        this.firstByte = undefined;
        if ((first & 0x9f) === 7 && first & 0x60) return 'h264';
        if ((first === 64 || first === 66) && byte === 1) return 'hevc';
        if (first === 0 && (byte === 113 || byte === 121)) return 'vvc';
      }
      if (!byte) { this.zeros++; continue; }
      if (byte === 1 && this.zeros >= 2) {
        this.started = true;
        this.nextIsHeader = true;
      } else if (!this.started) { this.possible = false; return; }
      this.zeros = 0;
    }
  }
}

/** Identify using parameter-set headers. An AUD, SEI or a slice alone is ambiguous. */
export function annexBCodec(bytes: Uint8Array): AnnexBCodec | undefined {
  return new AnnexBHeaderProbe().scan(bytes);
}

/** Scan at most a maximum-size access unit, stopping at the first codec witness. */
export async function probeAnnexBCodec(reader: ContainerProbeReader, signal?: AbortSignal, header?: Uint8Array) {
  signal?.throwIfAborted();
  const probe = new AnnexBHeaderProbe(), limit = Math.min(reader.size, ANNEX_B_PROBE_BYTES);
  const first = header ?? await reader.read(0, Math.min(limit, 1024));
  signal?.throwIfAborted();
  let codec = probe.scan(first);
  for (let at = first.length; !codec && probe.possible && at < limit;) {
    const length = Math.min(PROBE_BLOCK_BYTES - at % PROBE_BLOCK_BYTES, limit - at);
    const bytes = await reader.read(at, length);
    signal?.throwIfAborted();
    codec = probe.scan(bytes);
    at += length;
  }
  return codec;
}
