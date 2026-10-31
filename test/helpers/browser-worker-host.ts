import { Worker as NodeWorker } from 'node:worker_threads';

/** Node-only host for the actual browser Worker entrypoints, including WASM.
 * Production modules use the browser surface; tests own Node compatibility. */
export class BrowserWorker extends NodeWorker {
  #listeners = new Map<Function, { type: string; event: (...args: any[]) => void; exit?: (code: number) => void }>();
  #stopping = false;
  constructor(entry: URL, options: import('node:worker_threads').WorkerOptions = {}) {
    super(new URL('./browser-worker-entry.mjs', import.meta.url), {
      ...options,
      workerData: { entry: String(entry), input: options.workerData },
    });
  }
  addEventListener(type: string, listener: (event: any) => void) {
    const event =
      type === 'message' ? (data: unknown) => listener({ data }) : (error: Error) => listener({ message: error.message, error });
    const exit =
      type === 'error'
        ? (code: number) => {
            if (!this.#stopping) listener({ message: `Worker exited unexpectedly: ${code}` });
          }
        : undefined;
    this.#listeners.set(listener, { type, event, exit });
    this.on(type, event);
    if (exit) this.on('exit', exit);
  }
  removeEventListener(type: string, listener: (event: any) => void) {
    const entry = this.#listeners.get(listener);
    if (!entry || entry.type !== type) return;
    this.off(type, entry.event);
    if (entry.exit) this.off('exit', entry.exit);
    this.#listeners.delete(listener);
  }
  override terminate() {
    this.#stopping = true;
    return super.terminate();
  }
}
// The test process can also exercise a client's default browser factory.
if (typeof globalThis.Worker === 'undefined') globalThis.Worker = BrowserWorker as unknown as typeof globalThis.Worker;
