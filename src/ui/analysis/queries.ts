import type { Slot } from '../../model.ts';
import type { AnalysisAxis, AnalysisCapability, AnalysisQuery, AnalysisResult } from '../../analysis/types.ts';
import { shouldBucketize } from '../../analysis/statistics.ts';
import { bucketWidthFor, canSatisfy, clampPixelWidth } from '../../analysis/view-cache.ts';
import type { ViewCacheEntry } from '../../analysis/view-cache.ts';
import { LOCAL_RATE_WINDOW_US } from '../../analysis/inspection.ts';

export interface AnalysisQueryTrack {
  slot: Slot; mediaId: string; offsetUs: number; durationUs: number; sourceGen: number;
}
export interface AnalysisQuerySnapshot {
  open: boolean;
  tracks: readonly AnalysisQueryTrack[];
  selected: readonly AnalysisQueryTrack[];
  capabilities: ReadonlyMap<Slot, AnalysisCapability>;
  axis: AnalysisAxis;
  windowUs: number;
  range: { start: number; end: number };
  domain: { start: number; end: number };
  pixelWidth: number;
}

/** Owns query scheduling, coverage and cancellation; no DOM or decoding access.
 * Requests still use the session facade, shared with Agent tools. */
export function createAnalysisQueries(hooks: {
  signal: AbortSignal;
  snapshot(): AnalysisQuerySnapshot;
  query(slot: Slot, query: AnalysisQuery): Promise<AnalysisResult>;
  onChange(): void;
  onResult?(): void;
  onQueryStart?(): void;
  onQueryComplete?(elapsedMs: number): void;
}) {
  const { signal, snapshot } = hooks;
  const results = new Map<Slot, AnalysisResult>();
  const errors = new Map<Slot, string>();
  const coverage = new Map<Slot, ViewCacheEntry>();
  const seqBySlot = new Map<Slot, number>();
  const abortBySlot = new Map<Slot, AbortController>();
  let sequence = 0;
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastQueryMs = 0;
  const now = () => performance.now();
  const active = () => !disposed && !signal.aborted && snapshot().open;
  const MAX_SAMPLES = 5000;
  const QUERY_THROTTLE_MS = 100;
  const CURVE_MARGIN_RATIO = 0.25;

  // Discrete actions query immediately; gestures query at most every 100ms,
  // with a trailing request using the latest snapshot.
  function schedule(immediate = false) {
    if (!active()) return;
    clearTimeout(timer);
    const elapsed = now() - lastQueryMs;
    if (immediate || elapsed >= QUERY_THROTTLE_MS) {
      lastQueryMs = now();
      refresh();
    } else {
      timer = setTimeout(() => { lastQueryMs = now(); refresh(); }, QUERY_THROTTLE_MS - elapsed);
    }
  }

  function suspend() {
    clearTimeout(timer);
    timer = undefined;
    for (const [slot, controller] of abortBySlot) {
      controller.abort();
      seqBySlot.set(slot, ++sequence);
    }
    abortBySlot.clear();
  }

  /** Preserve provisional data on geometry changes; discard another source's data. */
  function reconcile(previous: readonly AnalysisQueryTrack[], current: readonly AnalysisQueryTrack[]): Slot[] {
    suspend();
    const changed = (slot: Slot) => {
      const before = previous.find(t => t.slot === slot), after = current.find(t => t.slot === slot);
      return !after || after.mediaId !== before?.mediaId || after.sourceGen !== before?.sourceGen;
    };
    for (const slot of errors.keys()) if (changed(slot)) errors.delete(slot);
    const removed: Slot[] = [];
    for (const [slot, result] of results) {
      const track = current.find(t => t.slot === slot);
      const generation = Number(result.sourceVersion.split('#')[0]);
      if (changed(slot) || !track || !Number.isInteger(generation) || generation !== track.sourceGen) {
        results.delete(slot);
        coverage.delete(slot);
        removed.push(slot);
      }
    }
    return removed;
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    suspend();
    signal.removeEventListener('abort', dispose);
    results.clear(); errors.clear(); coverage.clear(); seqBySlot.clear();
  }
  signal.addEventListener('abort', dispose, { once: true });
  if (signal.aborted) dispose();

  /** 估计新区间内的样本数（用已缓存的 raw 精确计数或桶 count 求和）。 */
  function estimateSamplesIn(slot: Slot, startUs: number, endUs: number, axis: AnalysisAxis): number | null {
    const r = results.get(slot);
    if (!r) return null;
    if (!r.truncated && r.samples.length) {
      let n = 0;
      for (const s of r.samples) {
        const t = axis === 'pts' ? s.effectivePtsUs : s.dtsUs;
        if (t != null && t >= startUs && t < endUs) n++;
      }
      return n;
    }
    if (r.buckets) {
      let n = 0;
      for (const b of r.buckets) {
        if (b.endUs <= startUs || b.startUs >= endUs || !b.count) continue;
        n += b.count;
      }
      return n;
    }
    return null;
  }

  function refresh() {
    if (!active()) return;
    const state = snapshot();
    const { range, domain: db, axis, windowUs } = state;
    const pixelWidth = clampPixelWidth(state.pixelWidth);
    const span = Math.max(1, range.end - range.start);
    // 预取 margin：连续滚动落入缓存只重绘，不发查询；可见区密度与预取数量不混淆。
    // margin 至少覆盖局部帧率的半个统计窗口：深度放大后视口不足 1s，
    // 否则检查器拿到的样本覆盖不了自己的 1s 邻域（口径随缩放漂移）。
    // 样本/桶走 halo 区间（qStart/qEnd/qPix），码率曲线走小 margin 预载区间
    // （cStart/cEnd/cPix，可视 ±0.25span，按比例放大像素数保证 usPerPixel 不变）；
    // 绘制层统一按可视裁剪，缓存层分别比较覆盖与密度。
    const full = span >= db.end - db.start;
    const margin = Math.max(span * 0.5, LOCAL_RATE_WINDOW_US / 2);
    const qStart = full ? range.start : Math.max(db.start, Math.floor(range.start - margin));
    const qEnd = full ? range.end : Math.min(db.end, Math.ceil(range.end + margin));
    // 大 CSS 宽度 + 预取 margin 不得产生 pixelWidth>4096 的查询异常。
    const qPix = clampPixelWidth(full ? pixelWidth : Math.round(pixelWidth * (qEnd - qStart) / span));
    const curveMargin = full ? 0 : span * CURVE_MARGIN_RATIO;
    const cStart = full ? Math.floor(range.start) : Math.max(db.start, Math.floor(range.start - curveMargin));
    const cEnd = full ? Math.ceil(range.end) : Math.min(db.end, Math.ceil(range.end + curveMargin));
    const cPix = clampPixelWidth(full ? pixelWidth : Math.round(pixelWidth * (cEnd - cStart) / span));
    const visibleBucketW = bucketWidthFor(range.start, range.end, pixelWidth);
    for (const track of state.selected) {
      const cap = state.capabilities.get(track.slot);
      // Unsupported paths and failed indexes are terminal states, not pending queries.
      if (cap?.hasSize === false || cap?.indexState === 'error') continue;
      const cover = coverage.get(track.slot);
      const cached = results.get(track.slot);
      if (!errors.has(track.slot) && cap?.indexState === 'complete' && cover && cached
        && cached.indexRevision === cover.indexRevision
        && cached.sourceVersion === cover.sourceVersion) {
        // 可见区是否需要逐样本：用缓存估计密度，不只看点数。
        const estimated = estimateSamplesIn(track.slot, range.start, range.end, axis);
        const needRaw = estimated == null ? false : !shouldBucketize(estimated, pixelWidth, 2);
        const ok = canSatisfy(cover, {
          startUs: Math.floor(qStart), endUs: Math.ceil(qEnd),
          axis, windowUs, offsetUs: track.offsetUs,
          pixelWidth: qPix, needRaw, bucketWidthUs: bucketWidthFor(Math.floor(qStart), Math.ceil(qEnd), qPix),
          curveStartUs: cStart, curveEndUs: cEnd, curvePixelWidth: cPix,
        });
        // 可见区 LOD 也要满足：粗桶覆盖预取区不代表可见区够细。
        const visibleOk = !needRaw || cover.detailMode === 'raw';
        const densityOk = cover.detailMode === 'raw' || cover.bucketWidthUs <= visibleBucketW + 1;
        if (ok && visibleOk && densityOk) continue; // 已覆盖：只重绘，不发查询
      }
      abortBySlot.get(track.slot)?.abort();
      const controller = new AbortController();
      abortBySlot.set(track.slot, controller);
      const mySeq = ++sequence;
      seqBySlot.set(track.slot, mySeq);
      const mediaId = track.mediaId;
      const queryStart = now();
      hooks.onQueryStart?.();
      hooks.query(track.slot, {
        startUs: Math.floor(qStart), endUs: Math.ceil(qEnd),
        axis, pixelWidth: qPix, bitrateWindowUs: windowUs, maxSamples: MAX_SAMPLES,
        bucketOriginUs: 0,
        curveStartUs: cStart, curveEndUs: cEnd, curvePixelWidth: cPix,
        signal: controller.signal,
      }).then(result => {
        if (abortBySlot.get(track.slot) === controller) abortBySlot.delete(track.slot);
        if (!active() || controller.signal.aborted || seqBySlot.get(track.slot) !== mySeq) return; // 旧结果不覆盖新图
        const current = snapshot().tracks.find(e => e.slot === track.slot);
        if (!current || current.mediaId !== mediaId || current.sourceGen !== track.sourceGen) return; // 换片后旧结果丢弃
        // 实例隔离：source 重建（色彩模式切换等）后 mediaId 不变，必须按
        // session 盖章的 generation 校验；内层 mediaId 由 adapter 在打开时
        // 铸造，可能早于身份钉定（updateMediaInfo），不得参与比较。
        if (!result.sourceVersion.startsWith(`${current.sourceGen}#`)) return;
        errors.delete(track.slot);
        results.set(track.slot, result);
        // 索引进展可能使暂定排名转正，按当前帧重估状态区。
        hooks.onResult?.();
        // 只有完整索引的结果才建立覆盖：构建中的空/稀疏结果不得缓存覆盖，
        // 否则索引完成后 revision 对比的是快照自身，永远跳过重查。
        if (result.capability?.indexState === 'complete') {
          const detailMode = !result.truncated && result.samples.length > 0 ? 'raw' : 'buckets';
          coverage.set(track.slot, {
            slot: track.slot, sourceVersion: result.sourceVersion, indexRevision: result.indexRevision,
            axis: result.axis, windowUs,
            startUs: Math.floor(qStart), endUs: Math.ceil(qEnd),
            pixelWidth: qPix, offsetUs: track.offsetUs,
            detailMode, bucketWidthUs: bucketWidthFor(Math.floor(qStart), Math.ceil(qEnd), qPix),
            truncated: result.truncated, sampleCount: result.samples.length,
            curveStartUs: cStart, curveEndUs: cEnd, curvePixelWidth: cPix,
          });
          // 派生索引按快照身份由 WeakMap 持有，新对象自动隔离，无需手动失效。
        } else {
          coverage.delete(track.slot);
        }
        hooks.onQueryComplete?.(now() - queryStart);
        hooks.onChange();
      }).catch(error => {
        if (abortBySlot.get(track.slot) === controller) abortBySlot.delete(track.slot);
        if (!active() || controller.signal.aborted || seqBySlot.get(track.slot) !== mySeq) return;
        if (error instanceof Error && error.name === 'AbortError') return;
        errors.set(track.slot, error instanceof Error ? error.message : String(error));
        hooks.onChange();
      });
    }
    hooks.onChange();
  }

  return { results, errors, schedule, refresh, reconcile, suspend, dispose };
}
