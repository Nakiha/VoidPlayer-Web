import { RangeReader } from "../range-reader.ts";
import { analyzePicture, analyzeRange } from "./runner.ts";
import { failureInfo } from "./failure.ts";
const scope = globalThis as unknown as {
  onmessage: (event: MessageEvent) => void;
  postMessage: (data: unknown) => void;
};
scope.onmessage = async ({ data }) => {
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
    if ("startUs" in data.target) {
      await analyzeRange(
        new RangeReader({ file: data.file }),
        data.target,
        core,
        manifest.revision,
        new AbortController().signal,
        async (result) => {
          scope.postMessage({ event: "chunk", result });
          await new Promise<void>((resolve) => {
            scope.onmessage = () => resolve();
          });
        },
      );
      scope.postMessage({ ok: true, range: true });
      return;
    }
    const result = await analyzePicture(
      new RangeReader({ file: data.file }),
      data.target,
      core,
      manifest.revision,
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
