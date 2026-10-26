import type {VmafAssociation} from './vmaf.ts';
import type { FramePairResult, SourceBinding } from './frame-pair.ts';
export type FlvProducerEvidence = {
  producer: 'server-flv-scan-v1'; sourceVersion: string; size: number; epoch: number;
  packetCommitId: string; documentSha256: string;
  sourceStat: {size:string;dev:string;ino:string;mtimeNs:string;ctimeNs:string};
};
export type LibraryPairBinding = { binding: SourceBinding; producer: FlvProducerEvidence };
export type QualityAnnotationContext = {basis:'complete-flv-index-derived-v1';codec:'h264'|'hevc';name:string;lastModified:number;firstPtsUs:number;indexedDurationUs:number;frameDurationUs:number};
export type LibraryPairResult = {
  schema: 'voidplayer-library-frame-pair-psnr'; version: 1;
  sequenceVmaf?:VmafAssociation;
  execution: { host: 'node-worker'; runtime: 'node' | 'bun'; runtimeVersion: string; sourceIdentity: 'stat-version-v1' };
  annotationContext?:{reference:QualityAnnotationContext;distorted:QualityAnnotationContext};
  result: FramePairResult; sources: { reference: LibraryPairBinding; distorted: LibraryPairBinding };
};
export type LibraryPairResponse = LibraryPairResult & { request: {id:string;actorId:string} };
