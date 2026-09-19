// 分析查询缓存：区间覆盖只是必要条件，还必须比较时间分辨率与细节级别。
// 粗桶不可满足更细请求，bucket 结果不能满足 raw 请求；点数相同不代表可复用。

export type DetailMode = 'raw' | 'buckets';

export interface ViewCacheEntry {
  slot: string;
  sourceVersion: string;
  indexRevision: number;
  axis: string;
  windowUs: number;
  offsetUs: number;
  startUs: number;
  endUs: number;
  pixelWidth: number;
  detailMode: DetailMode;
  bucketWidthUs: number;
  truncated: boolean;
  sampleCount: number;
}

export interface ViewCacheRequest {
  startUs: number;
  endUs: number;
  axis: string;
  windowUs: number;
  offsetUs: number;
  pixelWidth: number;
  /** 本次视图是否需要逐样本（raw）。 */
  needRaw: boolean;
  bucketWidthUs: number;
}

export const MAX_QUERY_PIXELS = 4096;

export function clampPixelWidth(px: number): number {
  if (!Number.isFinite(px)) return 32;
  return Math.min(MAX_QUERY_PIXELS, Math.max(32, Math.floor(px)));
}

export function bucketWidthFor(startUs: number, endUs: number, pixelWidth: number): number {
  return Math.max(1, Math.floor((endUs - startUs) / Math.max(1, Math.floor(pixelWidth))) || 1);
}

export function usPerPixel(startUs: number, endUs: number, pixelWidth: number): number {
  return (endUs - startUs) / Math.max(1, pixelWidth);
}

export function detailModeFor(truncated: boolean, sampleCount: number): DetailMode {
  return !truncated && sampleCount > 0 ? 'raw' : 'buckets';
}

/**
 * 缓存是否满足新请求。
 * 1. 身份/修订/轴/窗口兼容；
 * 2. 请求区间被完整覆盖（含分组所需的边界样本由调用方的预取 margin 保证）；
 * 3. raw 请求只能由完整 raw 满足；
 * 4. 聚合请求可由 raw 或足够细且可正确合并的桶满足，但缓存方不会按新口径
 *    重算派生数据：桶网格与码率采样步长必须和桶缓存一样分别比较；
 * 5. 只比较点数不够，必须比较时间分辨率/桶宽；
 * 6. 未知/暂定区间不可因命中变成完整（调用方不得缓存 building 结果）。
 */
export function canSatisfy(cached: ViewCacheEntry, requested: ViewCacheRequest): boolean {
  if (cached.axis !== requested.axis) return false;
  if (cached.windowUs !== requested.windowUs) return false;
  if (cached.offsetUs !== requested.offsetUs) return false;
  if (cached.startUs > requested.startUs || cached.endUs < requested.endUs) return false;
  if (requested.needRaw) {
    // 逐样本请求：必须有完整 raw，桶再细也不行。
    if (cached.detailMode !== 'raw' || cached.truncated) return false;
    // raw 样本虽精确，但码率序列按查询密度采样：全览粗查询的码率步长
    // 满足不了放大视图（游标步长小一个量级时最近邻限位会将其剔除，
    // 读数在值/—间闪烁）。时间分辨率必须一起比较。
    const cachedUspp = usPerPixel(cached.startUs, cached.endUs, cached.pixelWidth);
    const requestedUspp = usPerPixel(requested.startUs, requested.endUs, requested.pixelWidth);
    if (cachedUspp > requestedUspp * 1.25 + 1) return false;
    return true;
  }
  // 聚合请求：raw 样本精确不代表其桶网格与码率曲线满足新口径；调用方沿用
  // 缓存结果的派生数据而不重算，因此 raw 缓存与桶缓存走同一套网格/分辨率比较。
  // 桶宽越小越细。允许 1us 的整除误差。
  if (cached.bucketWidthUs > requested.bucketWidthUs + 1) return false;
  // 时间分辨率兜底：缓存每像素跨度不得明显大于请求。
  const cachedUspp = usPerPixel(cached.startUs, cached.endUs, cached.pixelWidth);
  const requestedUspp = usPerPixel(requested.startUs, requested.endUs, requested.pixelWidth);
  if (cachedUspp > requestedUspp * 1.25 + 1) return false;
  return true;
}
