/**
 * REVIEW-02：GPU 初始化/刷新的跨异步失效守卫（DOM/WebGPU 无关，可单测）。
 * - 每次 initialize/refresh/dispose 进入即递增 epoch，使旧任务失效；
 * - 候选资源先放局部集合，整批校验 epoch 后才提交；
 * - 旧任务迟到成功/失败只清理自己那批，不碰全局 entries；
 * - 完整 source 列表独立保存，不从“已提交 entries”反推。
 */
export class GpuPresentationGuard<S = unknown> {
  private epoch = 0;
  private knownSources: S[] = [];

  /** 首次/全量初始化：固定完整 source 列表并使旧任务失效。 */
  beginInitialize(sources: S[]): number {
    this.knownSources = [...sources];
    this.epoch += 1;
    return this.epoch;
  }

  /** 色彩切换刷新：使旧初始化失效，返回新 epoch 与完整 source 列表。 */
  beginRefresh(): { token: number; sources: S[] } {
    this.epoch += 1;
    return { token: this.epoch, sources: [...this.knownSources] };
  }

  /** 释放：使所有在途初始化失效。 */
  invalidate(): number {
    this.epoch += 1;
    return this.epoch;
  }

  isCurrent(token: number): boolean {
    return token === this.epoch;
  }

  get current(): number {
    return this.epoch;
  }

  sources(): S[] {
    return [...this.knownSources];
  }
}
