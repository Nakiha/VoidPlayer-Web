import type { AnalysisIndexFrontier } from "./stream.ts";
export interface AnalysisReader {
  readonly size: number;
  readSync?(offset: number, length: number): Uint8Array;
  ffmpegIndex?(): Promise<import('../ffmpeg-index-cache.ts').FfmpegIndexDocument>;
  /** Source-bound immutable metadata; payload IO remains independently owned. */
  flvIndex?(): Promise<import("../flv-index-cache.ts").FlvIndexDocument>;
  readMetadata?(offset: number, length: number): Promise<Uint8Array>;
  read(offset: number, length: number): Promise<Uint8Array>;
  close(): void;
}
export interface AnalysisPacket {
  au: number;
  configuration: number;
  pts: number;
  dts: number;
  offset: number;
  size: number;
  key: boolean;
  discontinuity?: boolean;
  /** Original container ticks; decoder microseconds above remain separate. */
  timing?: { pts: number | null; dts: number | null; timebase: [number, number] };
}
export interface AnalysisInputOptions {
  demuxCore?: any;
  frontier?: () => Promise<AnalysisIndexFrontier>;
  waiting?: (waiting: boolean) => Promise<void>;
}

export interface AnalysisInput {
  analysisCore?: any;
  /** Reset only bounded unconsumed IO after the consumer acknowledges a result. */
  acknowledge?(): void;
  codec: 'h264' | 'hevc' | 'vvc';
  configurations: Uint8Array[];
  packets: AnalysisPacket[];
  ensure?: (cursor: number) => Promise<boolean>;
  sealedEnd: number;
  /** Enumeration is terminal; source integrity is independent of this flag. */
  indexComplete: boolean;
  indexIntegrity?: import('../index-integrity.ts').IndexIntegrity;
  indexTruncatedAt?: number;
  totalPackets: number | null;
  sourceEndUs: number;
  reader: AnalysisReader;
  read(offset: number, length: number): Promise<Uint8Array>;
  readUnit(packet: AnalysisPacket): Promise<Uint8Array>;
  bytesRead: number;
  picture(packet: AnalysisPacket, version: string): import('./contract.ts').SourcePictureKey;
  plan(target: import('./contract.ts').AnalysisTarget): Promise<{ start: number; target: AnalysisPacket; identity: import('./contract.ts').SourcePictureKey }>;
  close(): void;
}

export type AnalysisIndexSnapshot = import('../flv-index-cache.ts').FlvIndexDocument | import('../ffmpeg-index-cache.ts').FfmpegIndexDocument;
