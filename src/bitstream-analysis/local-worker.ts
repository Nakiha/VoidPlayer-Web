import { validateAnalysisCore } from './core-abi.ts';
import { RangeReader } from "../range-reader.ts";
import { analyzePicture, analyzeRange, analyzeStream } from "./runner.ts";
import { failureInfo } from "./failure.ts";
let acknowledgement: (() => void) | undefined;
let indexReply: ((index: import('./stream.ts').AnalysisIndexFrontier) => void) | undefined;
const scope = globalThis as unknown as {
  onmessage: (event: MessageEvent) => void;
  postMessage: (data: unknown) => void;
};
scope.onmessage = async ({ data }) => {
  if (data.event === 'index') { const reply = indexReply; indexReply = undefined; reply?.(data.index); return; }
  if (data.ok) { const ack = acknowledgement; acknowledgement = undefined; ack?.(); return; }
  try {
    const response = await fetch(
      new URL("/vendor/voidplayer-analysis/manifest.json", data.base),
    );
    if (!response.ok) throw new Error("Analysis core unavailable");
    const manifest = await response.json();
    const module = await import(
      /* @vite-ignore */ new URL(
        "/vendor/voidplayer-analysis/voidplayer-analysis.js",
        data.base,
      ).href
    );
    const core = await module.default();
    validateAnalysisCore(core);
    if (data.target.mode === 'stream' || 'startUs' in data.target) {
      await (data.target.mode === "stream" ? analyzeStream : analyzeRange)(
        new RangeReader({ file: data.file }),
        data.target,
        core,
        (manifest.buildId ?? manifest.revision),
        new AbortController().signal,
        async (result) => {
          scope.postMessage({ event: "chunk", result });
          await new Promise<void>((resolve) => {
            acknowledgement = resolve;
          });
        },
        async (progress: unknown) => scope.postMessage({ event: 'progress', progress }),
        data.externalIndex ? () => new Promise(resolve => {
          indexReply = resolve; scope.postMessage({ event: 'index' });
        }) : undefined,
      );
      scope.postMessage({ ok: true, range: true });
      return;
    }
    const result = await analyzePicture(
      new RangeReader({ file: data.file }),
      data.target,
      core,
      (manifest.buildId ?? manifest.revision),
      new AbortController().signal,
    );
    scope.postMessage({ ok: true, result });
  } catch (error) {
    scope.postMessage({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      reason: failureInfo(error),
    });
  }
};
