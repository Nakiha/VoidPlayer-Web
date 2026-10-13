import { openTsAnalysisInput } from './ts-input.ts';
import { openMp4AnalysisInput } from './mp4-input.ts';
import { openFlvAnalysisInput } from './flv-input.ts';
import type { AnalysisReader, AnalysisInputOptions, AnalysisInput } from './types.ts';
export type { AnalysisReader, AnalysisPacket } from './types.ts';

/** Probe bytes, not file names. Each adapter owns an independent demux cursor. */
export async function openAnalysisInput(reader: AnalysisReader, signal: AbortSignal,
  continuous = false, streamIndex?: AnalysisInputOptions): Promise<AnalysisInput> {
  let header: Uint8Array;
  try {
    signal.throwIfAborted();
    header = await reader.read(0, Math.min(9, reader.size));
    signal.throwIfAborted();
  } catch (error) { reader.close(); throw error; }
  const {demuxCore: _demuxCore, ...containerOptions} = streamIndex ?? {};
  const adapterOptions = Object.keys(containerOptions).length ? containerOptions : undefined;
  if (header[0] === 70 && header[1] === 76 && header[2] === 86)
    return openFlvAnalysisInput(reader, signal, continuous, adapterOptions);
  if (header[0] === 0x47) return openTsAnalysisInput(reader, signal, streamIndex);
  return openMp4AnalysisInput(reader, signal, continuous, adapterOptions);
}
