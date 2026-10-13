import { DiagramStore } from "./diagrams.ts";
import { AnalysisPollingBudget } from './task-pool.ts';
import { AnalysisCache } from "./cache.ts";
import {
  BUDGET,
  pictureId,
  validateResult,
  validateTarget,
  validateRange,
  validateStream,
} from "./contract.ts";
import type {
  AnalysisResult,
  AnalysisTarget,
  AnalysisRangeTarget,
  AnalysisStreamTarget,
  PresentedFrameToken,
} from "./contract.ts";
import type { MediaSource } from "../media.ts";
import { referenceVersion } from "../media-reference.ts";
import { AnalysisFailure, failureInfo, restoreFailure } from "./failure.ts";
import type { AnalysisFailureInfo } from "./failure.ts";
import type { StreamProgress } from './stream.ts';
import type { Slot } from '../model.ts';
export type DeepAnalysisState = {
  /** Source coverage survives later picture tasks; current task is state/stream. */
  completedStream?: StreamProgress & { slot: Slot; sourceVersion: string };
  stream?: StreamProgress & { slot: Slot };
  queued?: boolean;
  state:
    | "idle"
    | "pending"
    | "ready"
    | "unsupported"
    | "limited"
    | "error"
    | "cancelled";
  message?: string;
  reason?: AnalysisFailureInfo;
  cacheHit?: boolean;
};
export class BitstreamAnalysisService {
  private cache = new AnalysisCache();
  private diagrams = new DiagramStore();
  queryDiagrams(sourceVersion: string, au: number | null, sourcePtsUs: number, startAu?: number, limit?: number) { return this.diagrams.query(sourceVersion, au, sourcePtsUs, startAu, limit); }
  queryChart(sourceVersion: string, startUs: number, endUs: number, pixelWidth: number, axis: import('../analysis/types.ts').AnalysisAxis = 'pts') { return this.diagrams.queryChart(sourceVersion, startUs, endUs, pixelWidth, axis); }
  chartBounds(sourceVersion: string, axis: import('../analysis/types.ts').AnalysisAxis) { return this.diagrams.chartBounds(sourceVersion, axis); }
  private cancelActive?: () => void;
  private sequence = 0;
  state: DeepAnalysisState = { state: "idle" };
  private changed: () => void;
  constructor(changed: () => void, stores?: { cache: AnalysisCache; diagrams: DiagramStore }) {
    this.changed = changed;
    if (stores) { this.cache = stores.cache; this.diagrams = stores.diagrams; }
  }
  /** Each track owns its task state; all tracks retain one bounded session cache. */
  fork(changed: () => void) {
    return new BitstreamAnalysisService(changed, { cache: this.cache, diagrams: this.diagrams });
  }
  cancel() {
    ++this.sequence;
    this.cancelActive?.();
    this.cancelActive = undefined;
    this.state = { state: "cancelled", ...(this.state.stream ? { stream: this.state.stream } : {}) };
    this.changed();
  }
  dispose() {
    this.cancel();
    this.cache.clear(); this.diagrams.clear();
  }
  fail(error: AnalysisFailure): never {
    this.cancel();
    this.state = {
      state: error.info.kind,
      message: error.message,
      reason: error.info,
    };
    this.changed();
    throw error;
  }
  cached(token: PresentedFrameToken) {
    return token.picture ? this.cache.peek(token.picture) : null;
  }
  async request(
    source: MediaSource,
    token: PresentedFrameToken,
    signal?: AbortSignal,
  ): Promise<AnalysisResult> {
    if (!token.picture)
      throw new AnalysisFailure(
        "unsupported-picture-layout",
        "This playback path has no verified picture identity",
      );
    const target: AnalysisTarget = {
      sourceVersion: token.picture.sourceVersion,
      sourcePtsUs: token.sourcePtsUs,
      normalizedMediaUs: token.normalizedMediaUs,
      picture: token.picture,
    };
    validateTarget(target);
    signal?.throwIfAborted();
    this.cancel();
    const cached = this.cache.get(token.picture);
    if (cached) {
      this.state = {
        state: "ready",
        cacheHit: true,
        reason: cached.reasonCodes?.length
          ? new AnalysisFailure(
              cached.reasonCodes[0],
              cached.reasons.join("; ") ||
                "QP is unavailable for this bit depth",
            ).info
          : undefined,
      };
      this.changed();
      return cached;
    }
    const seq = ++this.sequence,
      controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    this.cancelActive = () => controller.abort();
    this.state = { state: "pending" };
    this.changed();
    try {
      const result = source.info.source
        ? await this.remote(source, target, controller.signal)
        : source.bitstreamFile
          ? await this.local(source.bitstreamFile, target, controller.signal, source.getBitstreamFlvIndex?.bind(source))
          : await Promise.reject(
              new Error("This source has no local File reference"),
            );
      controller.signal.throwIfAborted();
      validateResult(result);
      if (
        pictureId(result.picture) !== pictureId(token.picture) ||
        result.sourcePtsUs !== token.sourcePtsUs
      )
        throw new Error("Analysis result identity mismatch");
      this.cache.put(result); this.diagrams.put(result);
      if (seq === this.sequence) {
        this.state = {
          state: result.confidence === "exact" ? "ready" : "unsupported",
          message: result.reasons.join("; "),
          reason: result.reasonCodes?.length
            ? new AnalysisFailure(
                result.reasonCodes[0],
                result.reasons.join("; ") ||
                  "QP is unavailable for this bit depth",
              ).info
            : undefined,
          cacheHit: false,
        };
        this.changed();
      }
      return result;
    } catch (error) {
      if (seq === this.sequence) {
        const reason = controller.signal.aborted
          ? new AnalysisFailure("cancelled", "Analysis cancelled").info
          : failureInfo(error);
        this.state = {
          state: controller.signal.aborted ? "cancelled" : reason.kind,
          message: reason.message,
          reason,
        };
        this.changed();
      }
      throw error;
    } finally {
      signal?.removeEventListener("abort", abort);
      if (seq === this.sequence) this.cancelActive = undefined;
    }
  }
  async requestRange(
    source: MediaSource,
    target: AnalysisRangeTarget,
    signal?: AbortSignal,
  ): Promise<{ pictures: number }> {
    try {
      validateRange(target);
    } catch (error) {
      return this.fail(restoreFailure(failureInfo(error)));
    }
    this.cancel();
    const controller = new AbortController(),
      abort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    this.cancelActive = () => controller.abort();
    const seq = ++this.sequence;
    this.state = { state: "pending" };
    this.changed();
    let pictures = 0;
    let unsupported: AnalysisFailureInfo | undefined;
    const consume = (result: AnalysisResult) => {
      validateResult(result);
      if (
        result.picture.sourceVersion !== target.sourceVersion ||
        result.sourcePtsUs < target.firstPtsUs + target.startUs ||
        result.sourcePtsUs >= target.firstPtsUs + target.endUs
      )
        throw new Error("Analysis range identity mismatch");
      this.cache.put(result); this.diagrams.put(result);
      pictures++;
      this.changed();
      if (result.confidence !== "exact")
        unsupported = new AnalysisFailure(
          result.reasonCodes?.[0] ?? "incomplete-reference-state",
          result.reasons.join("; "),
        ).info;
    };
    try {
      if (source.info.source)
        await this.remoteRange(source, target, controller.signal, consume);
      else if (source.bitstreamFile)
        await this.localRange(
          source.bitstreamFile,
          target,
          controller.signal,
          consume,
          undefined, undefined, source.getBitstreamFlvIndex?.bind(source),
        );
      else throw new Error("No local analysis source");
      controller.signal.throwIfAborted();
      if (seq === this.sequence) {
        this.state = unsupported
          ? {
              state: "unsupported",
              message: unsupported.message,
              reason: unsupported,
            }
          : { state: "ready" };
        this.changed();
      }
      return { pictures };
    } catch (error) {
      if (seq === this.sequence) {
        const reason = controller.signal.aborted
          ? new AnalysisFailure("cancelled", "Analysis cancelled").info
          : failureInfo(error);
        this.state = {
          state: controller.signal.aborted ? "cancelled" : reason.kind,
          message: reason.message,
          reason,
        };
        this.changed();
      }
      throw error;
    } finally {
      signal?.removeEventListener("abort", abort);
      if (seq === this.sequence) this.cancelActive = undefined;
    }
  }
  async requestStream(source: MediaSource, target: AnalysisStreamTarget, slot: Slot, signal?: AbortSignal) {
    target = { ...target, ...(source.bitstreamIndexIdentity ? { indexIdentity: source.bitstreamIndexIdentity } : {}) };
    try { validateStream(target); } catch (error) { return this.fail(restoreFailure(failureInfo(error))); }
    signal?.throwIfAborted();
    this.cancel();
    const seq = ++this.sequence, controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    this.cancelActive = () => controller.abort();
    let progress: StreamProgress = { checkedUs: 0, totalUs: target.durationUs, pictures: 0, totalPictures: 0 };
    const update = () => {
      controller.signal.throwIfAborted();
      if (seq !== this.sequence) throw new DOMException('Superseded analysis', 'AbortError');
      this.state = { state: 'pending', stream: { slot, ...progress } }; this.changed();
    };
    update();
    let consumed = 0;
    const consume = (result: AnalysisResult) => {
      controller.signal.throwIfAborted(); validateResult(result);
      if (seq !== this.sequence || result.picture.sourceVersion !== target.sourceVersion || !result.gop)
        throw new Error('Stream result identity mismatch');
      if (result.confidence !== 'exact') throw new AnalysisFailure(result.reasonCodes?.[0] ?? 'incomplete-reference-state', result.reasons.join('; '));
      this.cache.put(result); this.diagrams.put(result); consumed++;
      progress = { ...progress, pictures: consumed, gopStartAu: result.gop.startAu }; update();
    };
    const onProgress = (next: StreamProgress) => {
      if (!next || typeof next.indexComplete !== 'boolean' || (next.waitingForIndex !== undefined && typeof next.waitingForIndex !== 'boolean') || ![next.pictures, next.checkedUs, next.totalUs].every(Number.isSafeInteger) || (next.totalPictures !== null && !Number.isSafeInteger(next.totalPictures)) ||
          (next.totalPictures !== null && (next.totalPictures < 0 || next.totalPictures > 250000 || next.pictures > next.totalPictures)) || next.pictures < 0 || next.pictures > 250000 ||
          next.totalUs <= 0 || next.checkedUs < 0 || next.checkedUs > next.totalUs)
        throw new Error('Invalid stream progress');
      // Remote producer may be ahead; displayed coverage counts consumed chunks.
      progress = { ...next, pictures: consumed, checkedUs: next.totalPictures ? Math.min(next.totalUs - 1, Math.floor(next.totalUs * consumed / next.totalPictures)) : 0 }; update();
    };
    try {
      if (source.info.source) await this.remoteRange(source, target, controller.signal, consume, onProgress);
      else if (source.bitstreamFile) await this.localRange(source.bitstreamFile, target, controller.signal, consume, onProgress, source.getBitstreamIndex?.bind(source));
      else throw new AnalysisFailure('invalid-request', 'No stream input');
      controller.signal.throwIfAborted();
      if (!consumed || consumed !== progress.totalPictures || !progress.indexComplete) throw new AnalysisFailure('incomplete-reference-state', 'Incomplete stream coverage');
      progress = { ...progress, checkedUs: progress.totalUs, indexComplete: true, waitingForIndex: false };
      if (seq === this.sequence) { this.state = { state: 'ready', stream: { slot, ...progress } }; this.changed(); }
      return progress;
    } catch (error) {
      if (seq === this.sequence) {
        const reason = failureInfo(controller.signal.aborted ? controller.signal.reason ?? new AnalysisFailure('cancelled', 'Analysis cancelled') : error);
        this.state = { state: reason.kind, reason, message: reason.message, stream: { slot, ...progress } }; this.changed();
      }
      throw error;
    } finally {
      signal?.removeEventListener('abort', abort);
      if (seq === this.sequence) this.cancelActive = undefined;
    }
  }
  private localRange(
    file: Blob,
    target: AnalysisRangeTarget | AnalysisStreamTarget,
    signal: AbortSignal,
    consume: (result: AnalysisResult) => void,
    onProgress?: (progress: StreamProgress) => void,
    frontier?: () => Promise<import('./stream.ts').AnalysisIndexFrontier>,
    snapshot?: () => Promise<import("../flv-index-cache.ts").FlvIndexDocument>,
  ): Promise<void> {
    signal.throwIfAborted();
    const worker = new Worker(new URL("./local-worker.ts", import.meta.url), {
      type: "module",
    });
    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (error?: unknown) => {
        if (settled) return; settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        worker.terminate();
        error ? reject(error) : resolve();
      };
      const abort = () => done(signal.reason);
      let timer = setTimeout(
        () =>
          done(
            new AnalysisFailure(
              "resource-limit",
              "Analysis execution time budget exceeded",
            ),
          ),
        30000,
      );
      signal.addEventListener("abort", abort, { once: true });
      worker.onerror = (e) => done(new Error(e.message));
      worker.onmessage = ({ data }) => {
        if (settled) return;
        // A long stream has a stall budget rather than a 30-second total lifetime.
        if ('mode' in target) {
          clearTimeout(timer);
          timer = setTimeout(() => done(new AnalysisFailure('resource-limit', 'Analysis stream stalled')), 30000);
        }
        if (data.event === 'snapshot') {
          void snapshot!().then(index => { if (!settled) worker.postMessage({ event: 'snapshot', index }); }, done);
        } else if (data.event === 'cache') {
          try {
            worker.postMessage({ event: 'cache', result: data.picture?.sourceVersion === target.sourceVersion ? this.cache.get(data.picture) : null });
          } catch (error) { done(error); }
        } else if (data.event === 'index') {
          void frontier!().then(index => {
            if (!settled) worker.postMessage({ event: 'index', index });
          }, error => done(error));
        } else if (data.event === 'progress') {
          try { onProgress?.(data.progress); } catch (error) { done(error); }
        } else if (data.event === "chunk") {
          try {
            consume(data.result);
            worker.postMessage({ ok: true });
          } catch (error) {
            done(error);
          }
        } else data.ok ? done() : done(restoreFailure(data.reason, data.error));
      };
      worker.postMessage({ file, target, externalIndex: !!frontier, externalSnapshot: !!snapshot, base: location.href });
    });
  }
  private async remoteRange(
    source: MediaSource,
    target: AnalysisRangeTarget | AnalysisStreamTarget,
    signal: AbortSignal,
    consume: (result: AnalysisResult) => void,
    onProgress?: (progress: StreamProgress) => void,
  ) {
    const base = new URL(source.info.source!.url, location.href);
    base.pathname += "/bitstream-analysis/requests";
    const headers = {
      "content-type": "application/json",
      "x-voidplayer-action": "bitstream-analysis",
    };
    const response = await fetch(base, {
      method: "POST",
      headers,
      body: JSON.stringify({
        version: referenceVersion(source.info.source!.url),
        target,
      }),
      signal,
    });
    if (!response.ok)
      throw restoreFailure(
        (await response.json()).reason,
        `Server analysis unavailable (${response.status})`,
      );
    const request = await response.json(),
      status = new URL(
        `/api/bitstream-analysis/requests/${request.requestId}`,
        base,
      ),
      seen = new Set<string>();
    let cursor = 0;
    const stream = 'mode' in target;
    const budget = new AnalysisPollingBudget(stream);
    try {
      for (;;) {
        if (stream) status.searchParams.set('after', String(cursor));
        signal.throwIfAborted();
        const response = await fetch(status, { signal, cache: "no-store" });
        if (!response.ok)
          throw new AnalysisFailure("cancelled", "Analysis lease expired");
        const state = await response.json();
        budget.observe(state);
        if (state.progress) onProgress?.(state.progress);
        if (this.state.queued !== (state.state === 'queued')) {
          this.state = { ...this.state, queued: state.state === 'queued' }; this.changed();
        }
        if (!Array.isArray(state.chunks) || state.chunks.length > 32)
          throw new Error("Invalid analysis chunk manifest");
        for (const chunk of state.chunks) {
          if (stream) {
            if (chunk.cursor !== cursor + 1) throw new Error('Invalid stream cursor');
          } else if (seen.has(chunk.id)) continue;
          const url = new URL(chunk.url, base);
          if (url.origin !== base.origin)
            throw new Error("Invalid analysis chunk origin");
          const response = await fetch(url, { signal });
          const length = Number(response.headers.get("content-length"));
          if (
            !response.ok ||
            !Number.isSafeInteger(length) ||
            length <= 0 ||
            length > BUDGET.resultBytes
          )
            throw new AnalysisFailure(
              "resource-limit",
              "Analysis chunk transport budget exceeded",
            );
          const bytes = await response.arrayBuffer();
          if (bytes.byteLength !== length)
            throw new Error("Incomplete analysis chunk");
          consume(JSON.parse(new TextDecoder().decode(bytes)));
          if (stream) cursor = chunk.cursor; else seen.add(chunk.id);
          budget.progress();
        }
        if (state.state === "complete" && (!stream || cursor === state.published)) return;
        if (state.state === "unsupported" && state.result) {
          consume(state.result);
          return;
        }
        if (
          ["error", "cancelled", "limited", "unsupported"].includes(state.state)
        )
          throw restoreFailure(
            state.reason,
            state.error ?? "Analysis cancelled",
          );
        await new Promise((r) => setTimeout(r, 200));
      }
    } finally {
      void fetch(status, { method: "DELETE", headers, keepalive: true }).catch(
        () => {},
      );
    }
  }
  private local(
    file: Blob,
    target: AnalysisTarget,
    signal: AbortSignal,
    snapshot?: () => Promise<import("../flv-index-cache.ts").FlvIndexDocument>,
  ): Promise<AnalysisResult> {
    signal.throwIfAborted();
    const worker = new Worker(new URL("./local-worker.ts", import.meta.url), {
      type: "module",
    });
    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (error?: unknown, result?: AnalysisResult) => {
        if (settled) return; settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        worker.terminate();
        error ? reject(error) : resolve(result!);
      };
      const abort = () =>
        done(
          signal.reason ?? new DOMException("Analysis cancelled", "AbortError"),
        );
      const timer = setTimeout(
        () =>
          done(
            new AnalysisFailure(
              "resource-limit",
              "Analysis resource time limit exceeded",
            ),
          ),
        30000,
      );
      signal.addEventListener("abort", abort, { once: true });
      worker.onerror = (e) => done(new Error(e.message));
      worker.onmessage = ({ data }) => {
        if (data.event === 'snapshot') {
          void snapshot!().then(index => { if (!settled) worker.postMessage({ event: 'snapshot', index }); }, done); return;
        }
        data.ok
          ? done(undefined, data.result)
          : done(restoreFailure(data.reason, data.error));
      };
      worker.postMessage({ file, target, externalSnapshot: !!snapshot, base: location.href });
    });
  }
  private async remote(
    source: MediaSource,
    target: AnalysisTarget,
    signal: AbortSignal,
  ): Promise<AnalysisResult> {
    const base = new URL(source.info.source!.url, location.href);
    base.pathname += "/bitstream-analysis/requests";
    const headers = {
      "content-type": "application/json",
      "x-voidplayer-action": "bitstream-analysis",
    };
    const response = await fetch(base, {
      method: "POST",
      headers,
      body: JSON.stringify({
        version: referenceVersion(source.info.source!.url),
        target,
      }),
      signal,
    });
    if (!response.ok)
      throw restoreFailure(
        (await response.json()).reason,
        `Server analysis unavailable (${response.status})`,
      );
    const request = await response.json();
    const status = new URL(
      `/api/bitstream-analysis/requests/${request.requestId}`,
      base,
    );
    const budget = new AnalysisPollingBudget(false);
    try {
      for (;;) {
        signal.throwIfAborted();
        const response = await fetch(status, { signal, cache: "no-store" });
        if (!response.ok)
          throw new AnalysisFailure(
            "cancelled",
            `Analysis status failed (${response.status})`,
          );
        const state = await response.json();
        budget.observe(state);
        if (this.state.queued !== (state.state === 'queued')) {
          this.state = { ...this.state, queued: state.state === 'queued' }; this.changed();
        }
        if (state.state === "unsupported" && state.result) return state.result;
        if (
          ["error", "cancelled", "limited", "unsupported"].includes(state.state)
        )
          throw restoreFailure(
            state.reason,
            state.error ?? "Analysis cancelled",
          );
        if (state.state === "complete") {
          const resultURL = new URL(state.resultUrl, base);
          if (resultURL.origin !== base.origin)
            throw new Error("Invalid analysis result origin");
          const response = await fetch(resultURL, { signal });
          if (!response.ok)
            throw new Error(`Analysis result failed (${response.status})`);
          const length = Number(response.headers.get("content-length"));
          if (
            !Number.isSafeInteger(length) ||
            length <= 0 ||
            length > BUDGET.resultBytes
          )
            throw new AnalysisFailure(
              "resource-limit",
              "Analysis result transport budget exceeded",
            );
          const bytes = await response.arrayBuffer();
          if (bytes.byteLength !== length)
            throw new Error("Incomplete analysis result");
          return JSON.parse(new TextDecoder().decode(bytes));
        }
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            signal.removeEventListener("abort", abort);
            resolve();
          }, 200);
          const abort = () => {
            clearTimeout(timer);
            reject(signal.reason);
          };
          signal.addEventListener("abort", abort, { once: true });
        });
      }
    } finally {
      void fetch(status, { method: "DELETE", headers, keepalive: true }).catch(
        () => {},
      );
    }
  }
}
