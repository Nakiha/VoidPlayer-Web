import type { AnnotationDocument } from './annotation-record.ts';

/** 本地待保存的单条编辑意图：seq 只增，用于区分“新编辑”与“旧重试”。 */
export type PendingEdit = {
  id: string;
  document: AnnotationDocument | null;
  base: number;
  space: string;
  actorId: string;
  seq: number;
};

export type PendingValue = Omit<PendingEdit, 'seq'>;

/**
 * 标注本地写入的并发守卫（DOM/IndexedDB 无关，可单测）：
 * - 每个 key 单调递增 seq：用户新编辑才 stage，重试不得生成新 seq；
 * - 同 key 写入串行：runIfCurrent 保证旧写先完成、新写后覆盖，
 *   快照重试在启动前与真正写入前两次核对身份，过期直接跳过；
 * - 只比较对象身份 + seq，不依赖深比较，避免旧文档复活。
 */
export class AnnotationPendingQueue {
  private pendings = new Map<string, PendingEdit>();
  private seqs = new Map<string, number>();
  private tails = new Map<string, Promise<void>>();

  stage(key: string, value: PendingValue): PendingEdit {
    const seq = (this.seqs.get(key) ?? 0) + 1;
    this.seqs.set(key, seq);
    const pending: PendingEdit = { ...value, seq };
    this.pendings.set(key, pending);
    return pending;
  }

  get(key: string): PendingEdit | undefined {
    return this.pendings.get(key);
  }

  snapshot(): Array<[string, PendingEdit]> {
    return [...this.pendings.entries()];
  }

  get size(): number {
    return this.pendings.size;
  }

  isCurrent(key: string, pending: PendingEdit): boolean {
    return this.pendings.get(key) === pending;
  }

  removeIfCurrent(key: string, pending: PendingEdit): boolean {
    if (this.pendings.get(key) !== pending) return false;
    this.pendings.delete(key);
    return true;
  }

  /** 同 key 串行执行；不同 key 互不阻塞。 */
  async runSerialized<T>(key: string, task: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const tail = prev.then(() => gate);
    this.tails.set(key, tail);
    await prev;
    try {
      return await task();
    } finally {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }

  /**
   * 仅当 pending 仍为最新意图时执行写入：
   * - 调用前快照已过期直接返回 'stale'，不排队；
   * - 排队等待期间被新编辑取代，轮到时再次核对并跳过；
   * - 新编辑永远排在旧写之后执行，最终落盘为新意图。
   */
  async runIfCurrent<T>(key: string, pending: PendingEdit, task: () => Promise<T>): Promise<T | 'stale'> {
    if (this.pendings.get(key) !== pending) return 'stale';
    return this.runSerialized(key, async () => {
      if (this.pendings.get(key) !== pending) return 'stale' as const;
      return task();
    });
  }
}
