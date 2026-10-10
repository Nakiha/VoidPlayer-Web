import { AnalysisCache } from "./cache.ts";
import {
  BUDGET,
  pictureId,
  validateResult,
  validateTarget,
  validateRange,
} from "./contract.ts";
import type {
  AnalysisResult,
  AnalysisTarget,
  AnalysisRangeTarget,
  PresentedFrameToken,
} from "./contract.ts";
import type { MediaSource } from "../media.ts";
import { referenceVersion } from "../media-reference.ts";
export type DeepAnalysisState = {
  state: "idle" | "pending" | "ready" | "unsupported" | "error" | "cancelled";
  message?: string;
  cacheHit?: boolean;
};
export class BitstreamAnalysisService {
  private cache = new AnalysisCache();
  private cancelActive?: () => void;
  private sequence = 0;
  state: DeepAnalysisState = { state: "idle" };
  private changed: () => void;
  constructor(changed: () => void) {
    this.changed = changed;
  }
  cancel() {
    ++this.sequence;
    this.cancelActive?.();
    this.cancelActive = undefined;
    this.state = { state: "cancelled" };
    this.changed();
  }
  cached(token: PresentedFrameToken) {
    return token.picture ? this.cache.get(token.picture) : null;
  }
  async request(
    source: MediaSource,
    token: PresentedFrameToken,
    signal?: AbortSignal,
  ): Promise<AnalysisResult> {
    if (!token.picture)
      throw new Error("This playback path has no verified picture identity");
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
      this.state = { state: "ready", cacheHit: true };
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
          ? await this.local(source.bitstreamFile, target, controller.signal)
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
      this.cache.put(result);
      if (seq === this.sequence) {
        this.state = {
          state: result.confidence === "exact" ? "ready" : "unsupported",
          message: result.reasons.join("; "),
          cacheHit: false,
        };
        this.changed();
      }
      return result;
    } catch (error) {
      if (seq === this.sequence) {
        this.state = {
          state: controller.signal.aborted ? "cancelled" : "error",
          message: error instanceof Error ? error.message : String(error),
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
    validateRange(target);
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
    const consume = (result: AnalysisResult) => {
      validateResult(result);
      if (
        result.picture.sourceVersion !== target.sourceVersion ||
        result.sourcePtsUs < target.firstPtsUs + target.startUs ||
        result.sourcePtsUs >= target.firstPtsUs + target.endUs
      )
        throw new Error("Analysis range identity mismatch");
      this.cache.put(result);
      pictures++;
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
        );
      else throw new Error("No local analysis source");
      controller.signal.throwIfAborted();
      if (seq === this.sequence) {
        this.state = { state: "ready" };
        this.changed();
      }
      return { pictures };
    } catch (error) {
      if (seq === this.sequence) {
        this.state = {
          state: controller.signal.aborted ? "cancelled" : "error",
          message: String(error),
        };
        this.changed();
      }
      throw error;
    } finally {
      signal?.removeEventListener("abort", abort);
      if (seq === this.sequence) this.cancelActive = undefined;
    }
  }
  private localRange(
    file: Blob,
    target: AnalysisRangeTarget,
    signal: AbortSignal,
    consume: (result: AnalysisResult) => void,
  ): Promise<void> {
    signal.throwIfAborted();
    const worker = new Worker(new URL("./local-worker.ts", import.meta.url), {
      type: "module",
    });
    return new Promise((resolve, reject) => {
      const done = (error?: unknown) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        worker.terminate();
        error ? reject(error) : resolve();
      };
      const abort = () => done(signal.reason);
      const timer = setTimeout(
        () => done(new Error("Analysis execution time budget exceeded")),
        30000,
      );
      signal.addEventListener("abort", abort, { once: true });
      worker.onerror = (e) => done(new Error(e.message));
      worker.onmessage = ({ data }) => {
        if (data.event === "chunk") {
          try {
            consume(data.result);
            worker.postMessage({ ok: true });
          } catch (error) {
            done(error);
          }
        } else data.ok ? done() : done(new Error(data.error));
      };
      worker.postMessage({ file, target, base: location.href });
    });
  }
  private async remoteRange(
    source: MediaSource,
    target: AnalysisRangeTarget,
    signal: AbortSignal,
    consume: (result: AnalysisResult) => void,
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
      throw new Error(`Server analysis unavailable (${response.status})`);
    const request = await response.json(),
      status = new URL(
        `/api/bitstream-analysis/requests/${request.requestId}`,
        base,
      ),
      seen = new Set<string>();
    try {
      for (let poll = 0; poll < 150; poll++) {
        signal.throwIfAborted();
        const response = await fetch(status, { signal, cache: "no-store" });
        if (!response.ok) throw new Error("Analysis lease expired");
        const state = await response.json();
        if (!Array.isArray(state.chunks) || state.chunks.length > 32)
          throw new Error("Invalid analysis chunk manifest");
        for (const chunk of state.chunks) {
          if (seen.has(chunk.id)) continue;
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
            throw new Error("Analysis chunk transport budget exceeded");
          const bytes = await response.arrayBuffer();
          if (bytes.byteLength !== length)
            throw new Error("Incomplete analysis chunk");
          consume(JSON.parse(new TextDecoder().decode(bytes)));
          seen.add(chunk.id);
        }
        if (state.state === "complete") return;
        if (state.state === "error" || state.state === "cancelled")
          throw new Error(state.error ?? "Analysis cancelled");
        await new Promise((r) => setTimeout(r, 200));
      }
      throw new Error("Analysis timed out");
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
  ): Promise<AnalysisResult> {
    signal.throwIfAborted();
    const worker = new Worker(new URL("./local-worker.ts", import.meta.url), {
      type: "module",
    });
    return new Promise((resolve, reject) => {
      const done = (error?: unknown, result?: AnalysisResult) => {
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
        () => done(new Error("Analysis resource time limit exceeded")),
        30000,
      );
      signal.addEventListener("abort", abort, { once: true });
      worker.onerror = (e) => done(new Error(e.message));
      worker.onmessage = ({ data }) =>
        data.ok ? done(undefined, data.result) : done(new Error(data.error));
      worker.postMessage({ file, target, base: location.href });
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
      throw new Error(`Server analysis unavailable (${response.status})`);
    const request = await response.json();
    const status = new URL(
      `/api/bitstream-analysis/requests/${request.requestId}`,
      base,
    );
    try {
      for (let poll = 0; poll < 150; poll++) {
        signal.throwIfAborted();
        const response = await fetch(status, { signal, cache: "no-store" });
        if (!response.ok)
          throw new Error(`Analysis status failed (${response.status})`);
        const state = await response.json();
        if (state.state === "error" || state.state === "cancelled")
          throw new Error(state.error ?? "Analysis cancelled");
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
            throw new Error("Analysis result transport budget exceeded");
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
      throw new Error("Analysis request timed out");
    } finally {
      void fetch(status, { method: "DELETE", headers, keepalive: true }).catch(
        () => {},
      );
    }
  }
}
