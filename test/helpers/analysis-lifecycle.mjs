/** Hold actual Worker messages at a witnessed boundary. No scores or worker
 * outcomes are fabricated; cancellation still uses the production owner. */
export function holdScoringWorker(runner, boundary = 'execution-contract') {
  const create = runner.createWorker.bind(runner);
  const workers = [];
  let held = false, released = false;
  const pending = [];
  runner.createWorker = (url, data) => {
    const worker = create(url, data);
    workers.push(worker);
    if (!url.pathname.endsWith('/scoring-worker.ts')) return worker;
    const emit = worker.emit.bind(worker);
    worker.emit = (event, ...args) => {
      const message = args[0];
      if (event === 'message' && !released &&
          (held || (boundary === 'result' ? message?.ok === true : message?.type === boundary))) {
        held = true;
        pending.push(() => emit(event, ...args));
        return true;
      }
      return emit(event, ...args);
    };
    return worker;
  };
  return {
    workers,
    get held() { return held; },
    release() { released = true; for (const emit of pending.splice(0)) emit(); },
    async crash() { await Promise.all(workers.map(worker => worker.terminate())); },
  };
}
/** Advance only the real, synchronously armed execution deadline. */
export function controlledExecutionDeadline(milliseconds, run) {
  const schedule = globalThis.setTimeout;
  let expire, armed = 0;
  try {
    globalThis.setTimeout = (fn, ms, ...args) => {
      const timer = schedule(fn, ms, ...args);
      if (ms === milliseconds) { armed++; clearTimeout(timer); expire = () => fn(...args); }
      return timer;
    };
    const work = run();
    if (armed !== 1) throw Error('Expected one real whole-execution deadline');
    return { work, expire() { if (!expire) throw Error('Deadline absent'); const fn = expire; expire = null; fn(); } };
  } finally { globalThis.setTimeout = schedule; }
}
