import { coreAssetUrl } from '../core-url.ts';
import { validateAnalysisCore } from './core-abi.ts';
import { RangeReader } from "../range-reader.ts";
import { analyzePicture, analyzeRange, analyzeStream } from "./runner.ts";
import { failureInfo } from "./failure.ts";
let cacheReply: ((value: import('./contract.ts').AnalysisResult | null) => void) | undefined;
let acknowledgement: (() => void) | undefined;
let indexReply: ((index: import('./stream.ts').AnalysisIndexFrontier) => void) | undefined;
const scope = globalThis as unknown as {
  onmessage: (event: MessageEvent) => void;
  postMessage: (data: unknown) => void;
};
scope.onmessage = async ({ data }) => {
  if (data.event === 'cache') { const reply = cacheReply; cacheReply = undefined; reply?.(data.result ?? null); return; }
  if (data.event === 'index') { const reply = indexReply; indexReply = undefined; reply?.(data.index); return; }
  if (data.ok) { const ack = acknowledgement; acknowledgement = undefined; ack?.(); return; }
  try {
    const response = await fetch(
      coreAssetUrl("/vendor/voidplayer-analysis/manifest.json", data.base),
    );
    if (!response.ok) throw new Error("Analysis core unavailable");
    const manifest = await response.json();
    const loadCore = async () => {
      const module = await import(
        /* @vite-ignore */ coreAssetUrl(
          "/vendor/voidplayer-analysis/voidplayer-analysis.js",
          data.base,
        )
      );
      const core = await module.default({ locateFile: (name: string) => coreAssetUrl(`/vendor/voidplayer-analysis/${name}`, data.base) });
      validateAnalysisCore(core);
      return core;
    };
    if (data.target.mode === 'stream' || 'startUs' in data.target) {
      const publish = async (result: import('./contract.ts').AnalysisResult) => {
        scope.postMessage({ event: 'chunk', result });
        await new Promise<void>(resolve => { acknowledgement = resolve; });
      };
      const reader = new RangeReader({ file: data.file });
      const signal = new AbortController().signal;
      const buildId = manifest.buildId ?? manifest.revision;
      if (data.target.mode === 'stream')
        await analyzeStream(reader, data.target, loadCore, buildId, signal, publish,
          async progress => scope.postMessage({ event: 'progress', progress }),
          data.externalIndex ? () => new Promise(resolve => {
            indexReply = resolve; scope.postMessage({ event: 'index' });
          }) : undefined, picture => new Promise(resolve => {
            cacheReply = resolve; scope.postMessage({ event: 'cache', picture });
          }));
      else
        await analyzeRange(reader, data.target, loadCore, buildId, signal, publish,
          picture => new Promise(resolve => {
            cacheReply = resolve; scope.postMessage({ event: 'cache', picture });
          }));
      scope.postMessage({ ok: true, range: true });
      return;
    }
    const result = await analyzePicture(
      new RangeReader({ file: data.file }),
      data.target,
      await loadCore(),
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
