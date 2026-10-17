// 码率滑窗与缩放聚合的纯算法（无 DOM、无 IO，可直接单测）。
// 口径：视频样本负载码率 · 按轴（PTS/DTS）归集 · 真实时间窗（非 N 帧窗）。

export const DEFAULT_BITRATE_WINDOW_US = 1_000_000;
export const BITRATE_WINDOW_OPTIONS_US = [250_000, 500_000, 1_000_000, 2_000_000, 5_000_000];

export const bytesToKiB = (bytes: number): number => bytes / 1024;
export const bpsToMbps = (bps: number): number => bps / 1_000_000;

/**
 * 纵轴上取整：细档位保证最高柱不低于轴高的约 2/3（最差 1→1.2 档约 83%，
 * 2→2.5 档 80%），避免 5× 直跳 10× 把柱子压到一半高度。
 */
const NICE_STEPS = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];
export function niceCeiling(v: number, steps: number[] = NICE_STEPS): number {
  if (!(v > 0)) return 1;
  const mag = 10 ** Math.floor(Math.log10(v));
  for (const m of steps) if (v <= m * mag) return m * mag;
  return 10 * mag;
}

/** 累计字节必须用 Float64（Uint32 在 4GiB 回绕）；时间用 Float64 微秒。 */
export function buildBytePrefixSum(sizes: ArrayLike<number>): Float64Array {
  const prefix = new Float64Array(sizes.length + 1);
  for (let i = 0; i < sizes.length; i++) prefix[i + 1] = prefix[i] + sizes[i];
  return prefix;
}

export function lowerBound(times: ArrayLike<number>, value: number): number {
  let lo = 0, hi = times.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** 半开区间 [start, end) 内的样本字节和（times 必须已按轴升序）。 */
export function rangeSumBytes(
  times: ArrayLike<number>, prefix: ArrayLike<number>, start: number, end: number,
): number {
  const lo = lowerBound(times, start);
  const hi = lowerBound(times, end);
  return prefix[hi] - prefix[lo];
}

export interface CoverageRange { start: number; end: number }

function coveredLength(ranges: CoverageRange[] | null, start: number, end: number): number {
  if (!ranges) return end - start;
  let covered = 0;
  for (const r of ranges) {
    const s = Math.max(start, r.start), e = Math.min(end, r.end);
    if (e > s) covered += e - s;
  }
  return covered;
}

/**
 * 单点滑窗码率。窗口 I(t) = [t - w/2, t + w/2)，与已确认媒体边界求交后按
 * 实际覆盖时长归一化并标记 shortWindow；窗口跨未覆盖区间时返回 null（不断
 * 言偏低的码率）。评价中心 t 落在媒体边界之外时直接返回 null：此时求交只剩
 * 小残片，按残长归一化会把尾部大帧放大成尖峰并画到片尾之外。
 * 缩放显示抽样不得改变 w 的定义。
 */
export function bitrateAt(
  tUs: number,
  times: ArrayLike<number>,
  prefix: ArrayLike<number>,
  windowUs: number,
  mediaBounds: { start: number; end: number } | null,
  coverage: CoverageRange[] | null,
): { mbps: number | null; shortWindow: boolean; provisional: boolean } {
  if (!Number.isFinite(tUs) || !(windowUs > 0)) return { mbps: null, shortWindow: false, provisional: true };
  const half = windowUs / 2;
  if (mediaBounds && (tUs < mediaBounds.start || tUs >= mediaBounds.end)) {
    return { mbps: null, shortWindow: true, provisional: false };
  }
  let a = tUs - half, b = tUs + half;
  let shortWindow = false;
  if (mediaBounds) {
    const s = Math.max(a, mediaBounds.start), e = Math.min(b, mediaBounds.end);
    if (e <= s) return { mbps: null, shortWindow: true, provisional: false };
    if (s !== a || e !== b) shortWindow = true;
    a = s; b = e;
  }
  if (b <= a) return { mbps: null, shortWindow, provisional: false };
  // 未覆盖区间占比超过一半即视为不可信；完全覆盖才给出确定值。
  const covered = coveredLength(coverage, a, b);
  if (covered < b - a) return { mbps: null, shortWindow, provisional: true };
  const bytes = rangeSumBytes(times, prefix, a, b);
  const mbps = (8 * bytes * 1_000_000) / ((b - a) * 1_000_000);
  return { mbps, shortWindow, provisional: false };
}

export interface BucketInput {
  axisUs: number;
  sizeBytes: number;
  key: boolean | null;
  sampleId: string;
}

export interface BucketResult {
  startUs: number;
  endUs: number;
  count: number;
  sumBytes: number;
  maxBytes: number;
  maxSampleId: string | null;
  keyCount: number;
  deltaCount: number;
  unknownCount: number;
}

/**
 * 固定原点锚定的时间分桶（减少平移跳变）。概览默认显示区间峰值
 * （maxBytes），tooltip 同时列 count/sum；不得把 sum 标成单帧大小，
 * 不得用抽 N 帧丢掉 I 帧尖峰。
 */
export function bucketize(
  samples: BucketInput[],
  rangeStart: number,
  rangeEnd: number,
  bucketWidthUs: number,
  originUs = 0,
): BucketResult[] {
  if (!(bucketWidthUs > 0) || !(rangeEnd > rangeStart)) return [];
  const firstIndex = Math.floor((rangeStart - originUs) / bucketWidthUs);
  const lastIndex = Math.ceil((rangeEnd - originUs) / bucketWidthUs);
  const buckets: BucketResult[] = [];
  for (let i = firstIndex; i < lastIndex; i++) {
    buckets.push({
      startUs: originUs + i * bucketWidthUs,
      endUs: originUs + (i + 1) * bucketWidthUs,
      count: 0, sumBytes: 0, maxBytes: 0, maxSampleId: null,
      keyCount: 0, deltaCount: 0, unknownCount: 0,
    });
  }
  for (const s of samples) {
    if (!(s.axisUs >= rangeStart && s.axisUs < rangeEnd)) continue;
    const idx = Math.floor((s.axisUs - originUs) / bucketWidthUs) - firstIndex;
    const bucket = buckets[idx];
    if (!bucket) continue;
    bucket.count++;
    bucket.sumBytes += s.sizeBytes;
    if (s.sizeBytes > bucket.maxBytes) { bucket.maxBytes = s.sizeBytes; bucket.maxSampleId = s.sampleId; }
    if (s.key === true) bucket.keyCount++;
    else if (s.key === false) bucket.deltaCount++;
    else bucket.unknownCount++;
  }
  return buckets;
}

/** LOD 决策：每样本像素不足时只画聚合桶。 */
export function shouldBucketize(sampleCount: number, pixelWidth: number, minPxPerSample = 2.5): boolean {
  if (!(pixelWidth > 0)) return true;
  return sampleCount / pixelWidth > 1 / minPxPerSample;
}
