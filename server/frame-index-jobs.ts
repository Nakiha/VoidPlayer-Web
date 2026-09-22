import { Worker } from 'node:worker_threads';
import { AdminError } from './admin-error.ts';

/** One admitted request, including body reception and response backpressure.
 * No unbounded queue and no large object graph crossing the thread boundary. */
export class FrameIndexJobs {
  private worker?: Worker;
  private occupied = false;
  private closed = false;
  private timer?: ReturnType<typeof setTimeout>;
  private pending?: { resolve(value: any): void; reject(error: Error): void };
  constructor(privateDatabase: string) { this.database = privateDatabase; }
  private database: string;
  acquire(): () => void {
    if (this.closed || this.occupied) throw new AdminError(503, '索引任务繁忙，请稍后重试。');
    this.occupied = true;
    let released = false;
    return () => { if (!released) { released = true; this.occupied = false; } };
  }
  async call(op: string, data: Record<string, unknown> = {}, transfer: ArrayBuffer[] = []): Promise<any> {
    if (this.closed) throw new AdminError(503, '索引服务已关闭。');
    if (this.pending) throw new Error('Concurrent index worker call');
    if (!this.worker) {
      const worker = this.worker = new Worker(new URL('./frame-index-worker.ts', import.meta.url), { workerData: { database: this.database } });
      worker.on('message', result => {
        if (this.worker !== worker) return;
        clearTimeout(this.timer);
        const pending = this.pending; this.pending = undefined;
        if (result.error) pending?.reject(new AdminError(result.status, result.error));
        else pending?.resolve(result.value);
      });
      const failed = (error: Error) => {
        if (this.worker !== worker) return;
        this.worker = undefined;
        clearTimeout(this.timer);
        const pending = this.pending; this.pending = undefined; pending?.reject(error);
        void worker.terminate();
      };
      worker.on('error', failed);
      worker.on('exit', code => failed(new Error(`索引 Worker 已退出 (${code})`)));
    }
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject };
      this.timer = setTimeout(() => {
        const worker = this.worker; this.worker = undefined; this.pending = undefined;
        void worker?.terminate(); reject(new AdminError(503, '索引任务超时，请稍后重试。'));
      }, 60000);
      try { this.worker!.postMessage({ op, ...data }, transfer); }
      catch (error) { clearTimeout(this.timer); this.pending = undefined; reject(error); }
    });
  }
  async close() {
    this.closed = true; clearTimeout(this.timer);
    this.pending?.reject(new AdminError(503, '索引服务已关闭。')); this.pending = undefined;
    const worker = this.worker; this.worker = undefined;
    if (worker) await worker.terminate();
  }
}
