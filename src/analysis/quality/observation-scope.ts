export type ObservationLevel = "actor" | "selection";
/** Read lifetime only: no job submission, cancellation or DOM ownership. */
export class QualityObservationScope {
  private generation = 0;
  private view = 0;
  private actor = new AbortController();
  private selection = new AbortController();
  private slots = new Map<
    string,
    {
      level: ObservationLevel;
      request: string;
      promise: Promise<unknown>;
      controller: AbortController;
    }
  >();
  private versions = new Map<string, number>();
  invalidate() {
    this.generation++;
    this.actor.abort();
    this.actor = new AbortController();
    this.select();
    this.slots.clear();
  }
  select() {
    this.view++;
    this.selection.abort();
    this.selection = new AbortController();
    for (const [key, entry] of this.slots)
      if (entry.level === "selection") this.cancel(key);
  }
  cancel(key: string) {
    this.versions.set(key, (this.versions.get(key) ?? 0) + 1);
    this.slots.get(key)?.controller.abort();
    this.slots.delete(key);
  }
  busy(key: string) {
    return this.slots.has(key);
  }
  capture(level: ObservationLevel = "selection", key?: string) {
    const generation = this.generation,
      view = this.view,
      actor = this.actor.signal,
      selection = this.selection.signal;
    const version = key ? (this.versions.get(key) ?? 0) : 0,
      slot = key ? this.slots.get(key)?.controller.signal : undefined;
    const signal = AbortSignal.any([
      actor,
      ...(level === "selection" ? [selection] : []),
      ...(slot ? [slot] : []),
    ]);
    return {
      signal,
      current: () =>
        !signal.aborted &&
        generation === this.generation &&
        (level === "actor" || view === this.view) &&
        (!key || (this.versions.get(key) ?? 0) === version),
    };
  }
  run<T>(
    key: string,
    level: ObservationLevel,
    work: () => Promise<T>,
    request = key,
  ): Promise<T> {
    const existing = this.slots.get(key);
    if (existing?.request === request && existing.level === level) return existing.promise as Promise<T>;
    if(existing)this.cancel(key);
    let resolve!: (value: T | PromiseLike<T>) => void,
      reject!: (error: unknown) => void;
    const promise = new Promise<T>((a, b) => {
      resolve = a;
      reject = b;
    });
    const entry = { level, request, promise, controller: new AbortController() };
    this.slots.set(key, entry);
    // Capture caller identity/selection synchronously, after the slot exists.
    try {
      resolve(work());
    } catch (error) {
      reject(error);
    }
    void entry.promise
      .finally(() => {
        if (this.slots.get(key) === entry) this.slots.delete(key);
      })
      .catch(() => {});
    return entry.promise;
  }
  close() {
    this.invalidate();
    this.actor.abort();
    this.selection.abort();
  }
}
