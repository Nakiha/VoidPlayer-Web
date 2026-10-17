/** Milestones reported by the code doing the work; these are not percentages. */
export const loadStages = {
  queued: '正在准备载入',
  download: '正在读取视频数据',
  decode: '正在选择解码方式',
  inspect: '正在读取视频信息',
  index: '正在建立帧索引',
  decoder: '正在启动软件解码器',
  'first-frame': '正在解码首帧',
  synchronize: '正在定位到当前播放位置',
} as const;
export type MediaLoadStage = keyof typeof loadStages;
export type MediaOpenProgress = (stage: MediaLoadStage) => void;
export interface MediaLoadStatus {
  name: string;
  slot: string;
  stage: MediaLoadStage;
  state: 'loading' | 'complete' | 'cancelled' | 'error';
  startedAt: number;
  finishedAt?: number;
  error?: string;
  targetPtsUs?: number;
  indexedDurationUs?: number;
  indexProgress?: { scannedBytes: number; totalBytes: number; packets: number };
}
