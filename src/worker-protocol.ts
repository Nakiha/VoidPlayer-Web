import type { FfmpegAnalysisSummary } from './analysis/ffmpeg-adapter.ts';
import type { WasmFrameOutput } from './wasm-frame.ts';
import type { MediaIndexIdentity } from '../shared/media/indexing/media-index-identity.ts';
import type { FfmpegIndexRecovery } from '../shared/media/indexing/index-integrity.ts';
import type { MediaIndexClientTrace, MediaIndexRecordBatch, MediaIndexRecordManifest } from '../shared/media/indexing/media-index-types.ts';
import type { MediaLoadStage } from './media-progress.ts';
import type { OpenStage } from '../shared/media/io/media-errors.ts';
import type { PacketInput } from '../shared/media/containers/flv-demux.ts';
import type { FlvEngine, PreparedFlv } from './flv-engine.ts';
import type { TsEngine } from './ts-engine.ts';
import type { Mp4Engine } from './mp4-engine.ts';
import type { PacketFrame } from './flv-decoder.ts';
import type { CachedWindow, CachedAudioBatch } from '../shared/media/audio-types.ts';
import type { MediaInfo } from '../shared/review/model.ts';
import type { AnalysisQuery, AnalysisRank, AnalysisResult, AnalysisSample } from '../shared/analysis/metadata/types.ts';

// Command maps are the single wire contract for callers and Worker responders.
// No result type is selected by the caller. Engine imports above are type-only.
type Command<Request extends object, Response> = { request: Request; response: Response };
export interface FfmpegInitResult extends FfmpegIndexRecovery {
  analysis?: FfmpegAnalysisSummary;
  ctx: number;
  firstPts?: number;
  firstFrame?: WasmFrameOutput;
  path: string;
  ticks: number[];
  durations: number[];
  tbNum: number;
  tbDen: number;
  width: number;
  height: number;
  codec: string;
  indexMs?: number;
  indexSource?: 'server' | 'client';
  localIndexBuildCalls?: number;
  seekAnchorCount?: number;
  ioMode?: 'blob' | 'memfs' | 'http-range';
  colorPrimaries?: number;
  colorTransfer?: number;
  colorSpace?: number;
  colorRange?: number;
  pixelFormat?: string | null;
  indexIdentity?: MediaIndexIdentity;
  indexTrace?: MediaIndexClientTrace;
  indexPending?: boolean;
}

export interface FfmpegCommands {
  'analysis-ffmpeg-index': Command<{ctx: number; size: number}, import('../shared/media/indexing/ffmpeg-index-cache.ts').FfmpegIndexDocument>;
  'peek-audio': Command<{ offset: number; length: number; ctx?: number; windows?: boolean }, null>;
  'observe-audio': Command<{ ctx: number; enabled: boolean }, null>;
  analysis: Command<{ ctx: number } & AnalysisOrigin & Omit<AnalysisQuery, 'signal'> & { durationUs: number; coverageUs: { start: number; end: number } | null }, AnalysisResult>;
  'analysis-locate': Command<{ ctx: number } & AnalysisOrigin & { sampleId: string }, AnalysisSample | null>;
  'analysis-rank': Command<{ ctx: number } & AnalysisOrigin & { axis: 'pts' | 'dts'; tUs: number }, Omit<AnalysisRank, 'complete'>>;
  'analysis-number': Command<{ ctx: number } & AnalysisOrigin & { axis: 'pts' | 'dts'; number: number }, number | null>;
  init: Command<{ glueURL: string; wasmBinary?: ArrayBuffer | Uint8Array; name: string; file?: ArrayBuffer; blob?: Blob; range?: { shared: SharedArrayBuffer; size: number }; threads?: number; externalIndexSession?: boolean; mediaSize?: number }, FfmpegInitResult>;
  extract: Command<{ ctx: number; index: number; recycle?: ArrayBuffer }, WasmFrameOutput & { seek?: { decodedFrames: number; restarts: number } }>;
  dispose: Command<{ ctx: number; path: string }, null>;
}
export type PacketInitResult = (NonNullable<Awaited<ReturnType<FlvEngine['open']>>> | Awaited<ReturnType<Mp4Engine['open']>> | Awaited<ReturnType<TsEngine['open']>>) & Pick<MediaInfo, 'timelineSource' | 'seekAnchorCount' | 'jsIndexReused' | 'jsIndexPacketsScanned'>;
type Empty = Record<string, never>;
type SoftwareOptions = { glueURL: string; wasmBinary?: Uint8Array; threads?: number };
type AnalysisOrigin = { mediaId?: string; firstPtsUs?: number };
export interface PacketCommands {
  'prepare-js':Command<{input:PacketInput;sourceVersion:string;format:'ts'|'matroska';persistent?:boolean},{admitted:true;session:string;index:import('../shared/media/containers/matroska-packet-index.ts').JsPacketIndex}|{admitted:false;reason:string}>;
  'analysis-js-index':Command<Empty,import('../shared/media/containers/matroska-packet-index.ts').JsPacketIndex>;
  'prepare-ts': Command<{input: PacketInput; sourceVersion: string},
    {admitted: true; session: string; index: import('../shared/media/indexing/ts-packet-index.ts').TsPacketIndex} | {admitted: false; reason: string}>;
  'peek-audio': Command<{ offset: number; length: number; ctx?: number; windows?: boolean }, null>;
  'cached-audio': Command<{ pts: number; generation: number }, null>;
  prepare: Command<{ input: PacketInput }, PreparedFlv>;
  native: Command<Empty, PacketInitResult | null>;
  init: Command<SoftwareOptions & { input: PacketInput; forceWasm?: boolean } & ({container: 'ts'|'matroska'; sourceVersion: string; preparedTsSession?: string;persistent?:boolean} | {container?: 'flv' | 'mp4'; prepared?: PreparedFlv}), PacketInitResult>;
  'analysis-ts-index': Command<Empty, import('../shared/media/indexing/ts-packet-index.ts').TsPacketIndex>;
  'analysis-flv-index': Command<Empty, import('../shared/media/indexing/flv-index-cache.ts').FlvIndexDocument>;
  'analysis-index': Command<Empty, import('../shared/analysis/bitstream/stream.ts').AnalysisIndexFrontier>;
  'complete-index': Command<Empty, Awaited<ReturnType<FlvEngine['completeIndex']>>>;
  'reference-witness': Command<SoftwareOptions, PacketFrame>;
  'switch-software': Command<SoftwareOptions, Awaited<ReturnType<FlvEngine['switchToSoftware']>> | Awaited<ReturnType<Mp4Engine['switchToSoftware']>> | Awaited<ReturnType<TsEngine['switchToSoftware']>>>;
  'switch-native': Command<Empty, Awaited<ReturnType<FlvEngine['switchToNative']>> | Awaited<ReturnType<Mp4Engine['switchToNative']>> | Awaited<ReturnType<TsEngine['switchToNative']>>>;
  dispose: Command<Empty, null>;
  extract: Command<{ position: number; recycle?: ArrayBuffer }, PacketFrame | null>;
  at: Command<{ pts: number; recycle?: ArrayBuffer }, PacketFrame | null>;
  next: Command<{ pts: number; recycle?: ArrayBuffer }, PacketFrame | null>;
  analysis: Command<AnalysisOrigin & Omit<AnalysisQuery, 'signal'> & { durationUs?: number; coverageUs?: { start: number; end: number } | null }, AnalysisResult>;
  'analysis-locate': Command<AnalysisOrigin & { sampleId: string }, AnalysisSample | null>;
  'analysis-rank': Command<AnalysisOrigin & { axis: 'pts' | 'dts'; tUs: number }, Omit<AnalysisRank, 'complete'>>;
  'analysis-number': Command<AnalysisOrigin & { axis: 'pts' | 'dts'; number: number }, number | null>;
}
export type CommandsShape<C> = { [K in keyof C]: { request: object; response: unknown } };
export type WorkerRequest<C extends CommandsShape<C>, K extends keyof C = keyof C> = {
  [P in K]: { id: number; type: P } & (C[P]['request'] extends Record<string, never> ? object : C[P]['request']);
}[K];
export type WorkerSuccess<C extends CommandsShape<C>, K extends keyof C = keyof C> = {
  [P in K]: { id: number; ok: true; data: C[P]['response']; diagnostics?: Record<string, unknown>[] };
}[K];
export type WorkerFailure = { id: number; ok: false; error: string; stack?: string; stage?: OpenStage; code?: import('../shared/media/io/media-errors.ts').MediaErrorCode };
export type IndexBatch = { analysis?: FfmpegAnalysisSummary; ctx: number; ticks: number[]; durations: number[]; stableCoverageUs: number; seekAnchorCount: number; buildId: string; indexIdentity?: MediaIndexIdentity; indexTrace?: MediaIndexClientTrace };
export type IndexError = { ctx?: number; error: string; stage?: OpenStage };
export type IndexProgress = { scannedBytes: number; totalBytes: number; packets: number; bytesRead?:number; durationUs?: number };
export type IndexEvent = { type: 'index-batch'; data: IndexBatch } | { type: 'index-complete'; data: FfmpegInitResult } | { type: 'index-error'; data: IndexError };
export type WorkerEvent = ({ id: number } & IndexEvent)
  | { id: number; type: 'cached-audio'; generation: number; data: CachedAudioBatch }
  | { id: number; type: 'cached-bytes'; data?: Uint8Array; windows?: CachedWindow[] }
  | { id: number; type: 'ready'; data: FfmpegInitResult }
  | { id: number; type: 'index-waiting'; data: boolean }
  | { id: number; type: 'index-progress'; data: IndexProgress }
  | { id: number; type: 'progress'; progress: MediaLoadStage };
export type RangeReadRequest = { type: 'read-range'; offset: number; length: number };
export type WorkerMessage<C extends CommandsShape<C>> = WorkerSuccess<C> | WorkerFailure | WorkerEvent | RangeReadRequest;
export type IndexInput = { id: number; type: 'index-input'; ctx: number } & (
  | { action: 'manifest'; manifest: MediaIndexRecordManifest; trace: MediaIndexClientTrace }
  | { action: 'batch'; batch: MediaIndexRecordBatch; trace: MediaIndexClientTrace }
  | { action: 'complete'; manifest: MediaIndexRecordManifest; frames: number; trace: MediaIndexClientTrace }
  | { action: 'legacy'; index: unknown; trace: MediaIndexClientTrace }
  | { action: 'fallback' }
);

type WithoutRouting<T> = T extends unknown ? Omit<T, 'id' | 'type'> : never;
export type IndexInputPayload = WithoutRouting<IndexInput>;

/** Enforce command/result correlation at the responder, without changing wire format. */
export function workerReply<C extends CommandsShape<C>>() {
  return <K extends keyof C>(request: WorkerRequest<C, K>, data: NoInfer<C[K]['response']>, diagnostics?: Record<string, unknown>[]): WorkerSuccess<C, K> =>
    ({ id: request.id, ok: true, data, ...(diagnostics ? { diagnostics } : {}) }) as WorkerSuccess<C, K>;
}
