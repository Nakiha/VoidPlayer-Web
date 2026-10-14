import { openJsTsAnalysisInput,openJsPacketAnalysisInput } from './js-ts-input.ts';
import { AnalysisFailure } from './failure.ts';
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
  const {sourceVersion: _sourceVersion, indexIdentity: _indexIdentity, ...containerOptions} = streamIndex ?? {};
  const adapterOptions = Object.keys(containerOptions).length ? containerOptions : undefined;
  if (header[0] === 70 && header[1] === 76 && header[2] === 86)
    return openFlvAnalysisInput(reader, signal, continuous, adapterOptions);
  if(header[0]===0x1a&&header[1]===0x45&&header[2]===0xdf&&header[3]===0xa3){
    if(streamIndex?.indexIdentity?.kind!=='js-matroska'||!streamIndex.sourceVersion){reader.close();throw new AnalysisFailure('unsupported-container','Matroska analysis requires the admitted JS source identity');}
    return openJsPacketAnalysisInput('matroska',reader,streamIndex.sourceVersion,signal);
  }
  if (header[0] === 0x47) {
    if(!streamIndex?.sourceVersion){reader.close();throw new AnalysisFailure('invalid-request','JS TS source namespace is missing');}
    return openJsTsAnalysisInput(reader,streamIndex.sourceVersion,signal);
  }
  return openMp4AnalysisInput(reader, signal, continuous, adapterOptions);
}
