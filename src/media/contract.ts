import type { VideoSample } from 'mediabunny';
import type { ColorMode, ReferenceDecode } from '../../shared/color/decode-policy-types.ts';
import type { FrameInfo, MediaInfo } from '../../shared/media/types.ts';
import type { FrameDescription } from '../../shared/media/frame-description.ts';
import type { CachedAudioBatch } from '../../shared/media/audio-types.ts';
import type { PresentationInfo } from '../../shared/presentation/presentation-info.ts';
import type { AnalysisAxis, AnalysisCapability, AnalysisQuery, AnalysisRank, AnalysisResult, AnalysisSample } from '../../shared/analysis/metadata/types.ts';

/** Browser resource contracts only. Consumers close frames and dispose sources;
 * implementations choose decoding, while the presenter owns painting and captures. */
export type MediaInfoChange={revision:number;reason:'index'|'presented-frame'|'identity'|'cached-metadata';changed:string[];before:MediaInfo;after:MediaInfo};
export interface DecodedFrame extends FrameInfo {
  readonly nativePresentedInput?: {instance:string;sourceVersion:string;input:import('../../shared/media/codecs/native-picture-identity.ts').NativePictureIdentity};
  presentedCommit?: number;
  readonly sourcePicture?: import('../../shared/analysis/bitstream/contract.ts').SourcePictureKey;
  /** Filled only by the presenter after a successful paint; never decoder tags. */
  presentation?: PresentationInfo;
  readonly description: FrameDescription;
  readonly copyMs?: number;
  readonly rotation?: number;
  /** Resource form: a WebCodecs sample, YUV planes, or RGBA8 pixels. The presenter decides
   *  how a kind reaches the canvas; backends never paint. */
  readonly kind: 'video-sample' | 'rgba8' | 'yuv';
  readonly width: number;
  readonly height: number;
  /** Approximate bytes held by this frame, for queue memory budgets. */
  readonly byteSize: number;
  readonly sample?: VideoSample;
  readonly pixels?: Uint8ClampedArray;
  close(): void;
}
export interface MediaSource {
  readonly nativePresentedInstance?:string;
  readonly nativePresentedTransport?:Readonly<{source:{kind:'library';id:string;url:string};sourceVersion:string}>;
  /** Retained reference only; no analysis instance or IO until explicit request. */
  bitstreamFile?: Blob;
  /** Read-only confirmed packet frontier; starts metadata indexing, never seeks. */
  getBitstreamIndex?(): Promise<import('../../shared/analysis/bitstream/stream.ts').AnalysisIndexFrontier>;
  getBitstreamFfmpegIndex?(): Promise<import('../../shared/media/indexing/ffmpeg-index-cache.ts').FfmpegIndexDocument>;
  getBitstreamFlvIndex?(): Promise<import("../../shared/media/indexing/flv-index-cache.ts").FlvIndexDocument>;
  bitstreamIndexIdentity?: import('../../shared/media/indexing/media-index-identity.ts').MediaIndexIdentity;
  info: MediaInfo;
  /** Cache-only, bounded metadata inspection; never enables audio output. */
  requestCachedMetadata?(): void;
  setMetadataInspectionEnabled?(enabled: boolean): void;
  /** Fire-and-forget cache observation; implementations must never read missing bytes. */
  requestCachedAudio?(ptsUs: number, generation: number): void;
  setCachedAudioEnabled?(enabled: boolean): void;
  onCachedAudio?: (generation: number, batch: CachedAudioBatch) => void;
  /** Background container indexing can extend duration after the first frame. */
  onInfoChange?: (change?:MediaInfoChange) => void;
  ensureIndexed?(ptsUs?: number): Promise<void>;
  /** Container adapters may verify or replace only the decoder while retaining
   * their existing demux/index session. This is used by reference-color admission. */
  admitReference?(depth: number): Promise<MediaSource>;
  /** Change presentation/decoder policy over the existing container session. */
  reconfigureColorMode?(mode: ColorMode, decode: ReferenceDecode, signal?: AbortSignal): Promise<void>;
  frameAt(ptsUs: number): Promise<DecodedFrame>;
  framesAfter(ptsUs: number, count: number): Promise<DecodedFrame[]>;
  /** Sequential presentation-order frames starting at ptsUs, for playback. */
  framesFrom(ptsUs: number): AsyncGenerator<DecodedFrame>;
  /** Continue after an already displayed frame without re-decoding its GOP. */
  framesFollowing?(ptsUs: number): AsyncGenerator<DecodedFrame>;
  /**
   * 可选的只读码流分析查询（顶部分析面板与 Agent 共用）。返回压缩样本
   * 负载统计，不解码、不 seek；缺失能力时方法不存在，调用方显示
   * pending/unsupported，不伪造数据。
   */
  getAnalysisCapability?(): AnalysisCapability;
  queryAnalysis?(query: AnalysisQuery & { requestId: number }): Promise<AnalysisResult>;
  /**
   * 展示序排名（只读，不解码）：归一化媒体时间 tUs 在 axis 下的排名，
   * 即 axis 时间严格小于 tUs 的样本数。复用分析查询的有序轴缓存，
   * O(log N) 且不物化样本数组；索引构建中返回暂定值。
   */
  rankAnalysisTime?(tUs: number, axis: AnalysisAxis): Promise<AnalysisRank>;
  analysisSampleAtNumber?(number: number, axis: AnalysisAxis): Promise<{ ptsUs: number | null; complete: boolean }>;
  /**
   * 按样本身份（桶峰值等）有界定位单个样本，不依赖某次查询是否返回了 raw 列表。
   * 身份格式由 adapter 层解析；未索引/不属于本媒体返回 null。
   */
  locateAnalysisSample?(sampleId: string): Promise<AnalysisSample | null>;
  dispose(): void;
}
export interface MediaMeta { name: string; size: number; lastModified: number; }
