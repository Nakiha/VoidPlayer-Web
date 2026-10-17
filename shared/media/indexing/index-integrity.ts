/** Terminal indexing and source integrity are independent facts. */
export type IndexIntegrity = 'complete' | 'recovered' | 'prefix';
export interface FfmpegIndexRecovery {
  indexIntegrity?: 'complete' | 'prefix';
  /** First discarded GOP's file position, not an invented physical EOF. */
  indexTruncatedAt?: number;
  /** Last retained decode timestamp in the stream's original time base. */
  indexEndDts?: string;
}
export function validFfmpegRecovery(value: FfmpegIndexRecovery, size: number): boolean {
  if (value.indexIntegrity === undefined || value.indexIntegrity === 'complete')
    return value.indexTruncatedAt === undefined && value.indexEndDts === undefined;
  if (value.indexIntegrity !== 'prefix' || !Number.isSafeInteger(value.indexTruncatedAt)
    || value.indexTruncatedAt! < 0 || value.indexTruncatedAt! >= size
    || typeof value.indexEndDts !== 'string' || !/^-?\d{1,19}$/.test(value.indexEndDts)) return false;
  const dts = BigInt(value.indexEndDts);
  return dts > -9223372036854775808n && dts <= 9223372036854775807n;
}
export function indexRecoveryWarning(integrity?: IndexIntegrity): string | undefined {
  return integrity === 'prefix' ? '文件存在损坏，仅播放已保留的有效前段；已舍弃损坏附近可能不完整的视频帧。'
    : integrity === 'recovered' ? '文件存在损坏，已跳过异常数据。' : undefined;
}
