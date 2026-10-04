import type { WasmFrameOutput } from './wasm-frame.ts';
import type { MediaIndexIdentity } from './media-index-identity.ts';
import type { MediaIndexClientTrace, MediaIndexRecordBatch, MediaIndexRecordManifest } from './media-index-types.ts';
import type { MediaLoadStage } from './media-progress.ts';
import type { OpenStage } from './media-errors.ts';
import type { FlvInput } from './flv-demux.ts';
import type { FlvEngine, PreparedFlv } from './flv-engine.ts';
import type { Mp4Engine } from './mp4-engine.ts';
import type { FlvFrame } from './flv-decoder.ts';
import type { MediaInfo } from './model.ts';
import type { AnalysisQuery, AnalysisRank, AnalysisResult, AnalysisSample } from './analysis/types.ts';

// Command maps are the single wire contract for callers and Worker responders.
// No result type is selected by the caller. Engine imports above are type-only.
type Command<Request extends object, Response> = { request: Request; response: Response };
export interface FfmpegInitResult {
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
  init: Command<{ glueURL: string; wasmBinary?: ArrayBuffer | Uint8Array; name: string; file?: ArrayBuffer; blob?: Blob; range?: { shared: SharedArrayBuffer; size: number }; threads?: number; externalIndexSession?: boolean; mediaSize?: number }, FfmpegInitResult>;
  extract: Command<{ ctx: number; index: number; recycle?: ArrayBuffer }, WasmFrameOutput & { seek?: { decodedFrames: number; restarts: number } }>;
  dispose: Command<{ ctx: number; path: string }, null>;
}
export type PacketInitResult = (NonNullable<Awaited<ReturnType<FlvEngine['open']>>> | Awaited<ReturnType<Mp4Engine['open']>>) & Pick<MediaInfo, 'timelineSource'>;
type Empty = Record<string, never>;
type SoftwareOptions = { glueURL: string; wasmBinary?: Uint8Array; threads?: number };
type AnalysisOrigin = { mediaId?: string; firstPtsUs?: number };
export interface PacketCommands {
  prepare: Command<{ input: FlvInput }, PreparedFlv>;
  native: Command<Empty, PacketInitResult | null>;
  init: Command<SoftwareOptions & { input: FlvInput; prepared?: PreparedFlv; forceWasm?: boolean; container?: 'flv' | 'mp4' }, PacketInitResult>;
  'complete-index': Command<Empty, Awaited<ReturnType<FlvEngine['completeIndex']>>>;
  'reference-witness': Command<SoftwareOptions, FlvFrame>;
  'switch-software': Command<SoftwareOptions, Awaited<ReturnType<FlvEngine['switchToSoftware']>> | Awaited<ReturnType<Mp4Engine['switchToSoftware']>>>;
  'switch-native': Command<Empty, Awaited<ReturnType<FlvEngine['switchToNative']>> | Awaited<ReturnType<Mp4Engine['switchToNative']>>>;
  dispose: Command<Empty, null>;
  extract: Command<{ position: number; recycle?: ArrayBuffer }, FlvFrame | null>;
  at: Command<{ pts: number; recycle?: ArrayBuffer }, FlvFrame | null>;
  next: Command<{ pts: number; recycle?: ArrayBuffer }, FlvFrame | null>;
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
export type WorkerFailure = { id: number; ok: false; error: string; stack?: string; stage?: OpenStage };
export type IndexBatch = { ctx: number; ticks: number[]; durations: number[]; stableCoverageUs: number; seekAnchorCount: number; buildId: string; indexIdentity?: MediaIndexIdentity; indexTrace?: MediaIndexClientTrace };
export type IndexError = { ctx?: number; error: string; stage?: OpenStage };
export type IndexProgress = { scannedBytes: number; totalBytes: number; packets: number; durationUs?: number };
export type IndexEvent = { type: 'index-batch'; data: IndexBatch } | { type: 'index-complete'; data: FfmpegInitResult } | { type: 'index-error'; data: IndexError };
export type WorkerEvent = ({ id: number } & IndexEvent)
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
