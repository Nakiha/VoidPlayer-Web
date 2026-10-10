import { parentPort, workerData } from "node:worker_threads";
import { open, readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import path from "node:path";
import {
  AnalysisFailure,
  failureInfo,
  restoreFailure,
} from "../../src/bitstream-analysis/failure.ts";
import {
  analyzePicture,
  analyzeRange,
} from "../../src/bitstream-analysis/runner.ts";
try {
  const file = await open(workerData.filePath, "r");
  const stat = await file.stat();
  let closed = false;
  const reader = {
    size: stat.size,
    async read(offset: number, length: number) {
      if (
        !Number.isSafeInteger(offset) ||
        length < 0 ||
        length > 32 * 1024 * 1024 ||
        offset + length > stat.size
      )
        throw new AnalysisFailure(
          "resource-limit",
          "Analysis read budget exceeded",
        );
      const bytes = new Uint8Array(length);
      let count = 0;
      while (count < length) {
        const r = await file.read(bytes, count, length - count, offset + count);
        if (!r.bytesRead)
          throw new AnalysisFailure(
            "source-changed",
            "Analysis source changed",
          );
        count += r.bytesRead;
      }
      return bytes;
    },
    close() {
      if (!closed) {
        closed = true;
        void file.close().catch(() => {});
      }
    },
  };
  try {
    const manifest = JSON.parse(
      await readFile(path.join(workerData.coreDir, "manifest.json"), "utf8"),
    );
    const module = await import(
      pathToFileURL(path.join(workerData.coreDir, "voidplayer-analysis.js"))
        .href
    );
    const core = await module.default({
      wasmBinary: new Uint8Array(
        await readFile(
          path.join(workerData.coreDir, "voidplayer-analysis.wasm"),
        ),
      ),
    });
    const publish = async (result: unknown) => {
      parentPort!.postMessage({ type: "chunk", result });
      await new Promise<void>((resolve, reject) => {
        parentPort!.once("message", (message) =>
          message.ok
            ? resolve()
            : reject(
                restoreFailure(
                  message.reason,
                  message.error ?? "Analysis consumer stopped",
                ),
              ),
        );
      });
    };
    if ("startUs" in workerData.target)
      await analyzeRange(
        reader,
        workerData.target,
        core,
        manifest.revision,
        new AbortController().signal,
        publish,
      );
    else
      await publish(
        await analyzePicture(
          reader,
          workerData.target,
          core,
          manifest.revision,
          new AbortController().signal,
        ),
      );
    parentPort!.postMessage({ ok: true, type: "complete" });
  } finally {
    reader.close();
  }
} catch (error) {
  parentPort!.postMessage({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
    reason: failureInfo(error),
  });
}
