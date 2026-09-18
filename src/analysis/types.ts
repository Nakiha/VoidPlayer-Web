// 顶部码流分析面板的数据契约（阶段 A）。
// 只读统计来自 demux/sample 元数据；严禁从 DecodedFrame.byteSize、像素或
// 网络下载量推算压缩字节。unknown / pending / unsupported / error 必须区分。

export type AnalysisAxis = 'pts' | 'dts';

export type RandomAccessFlag = 'yes' | 'no' | 'unknown';
/** 阶段 A 只保证关键/非关键/未知；真实 I/P/B 由阶段 B 提供。 */
export type PictureType = 'I' | 'P' | 'B' | 'mixed' | 'other' | null;
export type PictureTypeSource = 'bitstream' | 'decoder' | 'unavailable';
export type KeyFlagSource = 'container' | 'verified' | 'unavailable';

export interface AnalysisSample {
  /** 源版本 + 流身份 + 稳定样本身份，跨 PTS/DTS 视图保持同一身份。 */
  sampleId: string;
  /** adapter 明确分配的解码序号，不是 PTS 排序后的下标。 */
  decodeOrdinal: number;
  /** 原始容器 PTS（微秒）；缺失为 null，不得用平均帧率伪造。 */
  containerPtsUs: number | null;
  /** 时间修复后用于展示的有效 PTS（微秒），图上默认使用它。 */
  effectivePtsUs: number | null;
  /** 真实源 DTS（微秒）；不存在则为 null，不得伪造。 */
  dtsUs: number | null;
  /** 源压缩样本负载字节；未知为 null，不得填 0。 */
  sizeBytes: number | null;
  randomAccess: RandomAccessFlag;
  pictureType: PictureType;
  pictureTypeSource: PictureTypeSource;
  /** 阶段 A 恒为 null，仅保留能力入口。 */
  qp: number | null;
}

export type DataState = 'ready' | 'pending' | 'unsupported' | 'error';

export interface AnalysisCapability {
  hasSize: boolean;
  /** DTS 可用当且仅当后端有真实容器 DTS。 */
  hasDts: boolean;
  keySource: KeyFlagSource;
  pictureType: 'key-only' | 'full' | 'unavailable';
  qp: DataState;
  indexState: 'building' | 'complete' | 'error';
  indexError?: string;
  /** 已确认完整覆盖的会话时间区间；缺失表示暂无可信水位线。 */
  coverageUs?: { start: number; end: number };
  note?: string;
}

export interface AnalysisQuery {
  /** 会话时间区间（已含轨道 offset 投影后的 sessionUs）。 */
  startUs: number;
  endUs: number;
  axis: AnalysisAxis;
  /** 期望的绘制像素宽度，用于 LOD 决策（样本 vs 聚合桶）。 */
  pixelWidth: number;
  /** 码率滑窗（微秒），默认 1_000_000。 */
  bitrateWindowUs: number;
  /** 可选：只取聚合桶而不取逐样本。 */
  bucketsOnly?: boolean;
  /** 单轨查询上限，防止把数十万条记录塞进主线程消息。 */
  maxSamples?: number;
  signal?: AbortSignal;
}

export interface AnalysisBucket {
  startUs: number;
  endUs: number;
  count: number;
  sumBytes: number;
  maxBytes: number;
  maxSampleId: string | null;
  keyCount: number;
  deltaCount: number;
  unknownCount: number;
  /** false 表示桶内混有未覆盖区间，显示为暂定。 */
  complete: boolean;
}

export interface BitratePoint {
  tUs: number;
  /** null 表示窗口不完整或无覆盖，不得画成 0。 */
  mbps: number | null;
  /** 首尾与真实媒体边界求交后的短窗口标记。 */
  shortWindow: boolean;
  provisional: boolean;
}

export interface AnalysisResult {
  requestId: number;
  /** 媒体/流版本 + 索引修订，旧异步结果不得覆盖新图。 */
  sourceVersion: string;
  indexRevision: number;
  axis: AnalysisAxis;
  /** 会话时间原点说明：normalizedMediaUs + offsetUs。 */
  origin: { firstPtsUs: number; offsetUs: number };
  samples: AnalysisSample[];
  /** 样本被截断时为 true，调用方必须用桶视图或缩小范围重查。 */
  truncated: boolean;
  buckets: AnalysisBucket[] | null;
  bitrate: BitratePoint[] | null;
  capability: AnalysisCapability;
  coverageUs: { start: number; end: number } | null;
}

/** getState 只暴露轻量能力/状态，不含样本数组。 */
export interface AnalysisStatus {
  slot: string;
  mediaId: string;
  capability: AnalysisCapability;
}
