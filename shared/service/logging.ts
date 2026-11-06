export type RuntimeLogPolicy = { segmentBytes: number; maxBytes: number; days: number };
export type ReportLogPolicy = { maxBytes: number; maxFiles: number; days: number };
export type LogPolicy = { runtime: RuntimeLogPolicy; reports: ReportLogPolicy };
export const DEFAULT_LOG_POLICY: LogPolicy = {
  runtime: { segmentBytes: 10 * 1024 ** 2, maxBytes: 256 * 1024 ** 2, days: 60 },
  reports: { maxBytes: 512 * 1024 ** 2, maxFiles: 1000, days: 0 },
};
export const REPORT_BODY_BYTES = 10 * 1024 ** 2;
export type LogStorageStatus = {
  directory: string | null; bytes: number; files: number; maxBytes: number; days: number;
  error: string | null; dropped?: number; pendingBytes?: number; maxFiles?: number; segmentBytes?: number;
};
export type LogStorageOverview = { runtime: LogStorageStatus | null; reports: LogStorageStatus };

/** Zero report days means explicit deletion only. Runtime history always expires. */
export function logPolicy(input: unknown = {}): LogPolicy {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error('logging 必须是对象。');
  const source = input as Record<string, unknown>;
  if (Object.keys(source).some(key => !['runtime', 'reports'].includes(key))) throw Error('未知 logging 配置项。');
  const result = structuredClone(DEFAULT_LOG_POLICY);
  for (const kind of ['runtime', 'reports'] as const) {
    if (source[kind] === undefined) continue;
    const value = source[kind];
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error(`logging.${kind} 必须是对象。`);
    for (const [key, number] of Object.entries(value)) {
      if (!Object.hasOwn(result[kind], key) || !Number.isSafeInteger(number)) throw Error(`logging.${kind}.${key} 无效。`);
    }
    Object.assign(result[kind], value);
  }
  const { runtime, reports } = result;
  if (runtime.segmentBytes < 65536 || runtime.segmentBytes > 128 * 1024 ** 2 || runtime.maxBytes < runtime.segmentBytes * 3
    || runtime.maxBytes > 16 * 1024 ** 3 || runtime.days < 1 || runtime.days > 365) throw Error('运行日志配置超出范围。');
  if (reports.maxBytes < 1024 || reports.maxBytes > 64 * 1024 ** 3 || reports.maxFiles < 1 || reports.maxFiles > 100000
    || reports.days < 0 || reports.days > 3650) throw Error('上传日志配置超出范围。');
  return result;
}
