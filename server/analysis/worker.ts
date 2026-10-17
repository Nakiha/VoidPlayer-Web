import { emptyCounters, countCore, countProduct } from '../../shared/analysis/bitstream/counters.ts';
import { isProduct } from '../../shared/analysis/bitstream/products.ts';
import type { AnalysisOutput } from '../../shared/analysis/bitstream/products.ts';
import {sealJsIndex} from '../../shared/media/indexing/js-index-proof.ts';
import { validateAnalysisCore } from '../../shared/analysis/bitstream/core-abi.ts';
import { parentPort, workerData } from "node:worker_threads";
import { open, readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import path from "node:path";
import {
  AnalysisFailure,
  failureInfo,
  restoreFailure,
} from "../../shared/analysis/bitstream/failure.ts";
import {
  analyzePicture,
  analyzeRange,
  analyzeStream,
} from "../../shared/analysis/bitstream/runner.ts";
try {
  const file = await open(workerData.filePath, "r");
  const stat = await file.stat();
  let closed = false;
  const reader = {
    size: stat.size,
    ...(workerData.jsSnapshot?{jsIndex:async()=>sealJsIndex(workerData.jsSnapshot)}:{}),
    ...(workerData.flvSnapshot ? { flvIndex: async () => workerData.flvSnapshot } : {}),
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
    const counters=emptyCounters();const delivered=new Set<number>();
    const manifest = JSON.parse(
      await readFile(path.join(workerData.coreDir, "manifest.json"), "utf8"),
    );
    const loadCore = async () => {
      const initStarted=performance.now();
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
      validateAnalysisCore(core);
      counters.init++;counters.initMs+=performance.now()-initStarted;return countCore(core,counters);
    };
    const cachedResults=new Set<string>();
    let pendingCacheKey="";
    let cacheReply: ((value: AnalysisOutput | null) => void) | undefined;
    let acknowledgement: { resolve(): void; reject(error: unknown): void } | undefined;
    let indexReply: { resolve(value: import('../../shared/analysis/bitstream/stream.ts').AnalysisIndexFrontier): void; reject(error: unknown): void } | undefined;
    parentPort!.on('message', message => {
      if (message.type === 'cache') {
        const reply = cacheReply; cacheReply = undefined; if(message.result)cachedResults.add(JSON.stringify([message.result.picture,message.result.buildId]));else cachedResults.delete(pendingCacheKey); reply?.(message.result ?? null);
      } else if (message.type === 'index') {
        const reply = indexReply; indexReply = undefined;
        if (message.error) reply?.reject(restoreFailure(message.reason, message.error)); else reply?.resolve(message.index);
      } else {
        const ack = acknowledgement; acknowledgement = undefined;
        if (message.ok) ack?.resolve(); else ack?.reject(restoreFailure(message.reason, message.error ?? 'Analysis consumer stopped'));
      }
    });
    const publish = async (result: AnalysisOutput) => {
      const hit=cachedResults.has(JSON.stringify([result.picture,result.buildId]));countProduct(result,hit,counters);delivered.add(result.picture.au);counters.uniqueDelivered=delivered.size;
      parentPort!.postMessage({ type: "chunk", result, counters:{...counters}, cacheHit:cachedResults.has(JSON.stringify([result.picture,result.buildId])) }, isProduct(result) && result.product === "blocks" ? [result.payload] : []);
      await new Promise<void>((resolve, reject) => {
        acknowledgement = { resolve, reject };
      });
    };
    if (workerData.target.mode === 'stream')
      await analyzeStream(reader, workerData.target, loadCore, (manifest.buildId ?? manifest.revision),
        new AbortController().signal, publish,
        async progress => parentPort!.postMessage({ type: 'progress', progress }),
        workerData.externalIndex ? () => new Promise((resolve, reject) => {
          indexReply = { resolve, reject }; parentPort!.postMessage({ type: 'index' });
        }) : undefined, picture => new Promise<AnalysisOutput | null>(resolve => {
          pendingCacheKey=JSON.stringify([picture,manifest.buildId ?? manifest.revision]);cacheReply = resolve; parentPort!.postMessage({ type: 'cache', picture });
        }), plan=>parentPort!.postMessage({type:'plan',plan}));
    else if ("startUs" in workerData.target)
      await analyzeRange(
        reader,
        workerData.target,
        loadCore,
        (manifest.buildId ?? manifest.revision),
        new AbortController().signal,
        publish,
        picture => new Promise<AnalysisOutput | null>(resolve => {
          pendingCacheKey=JSON.stringify([picture,manifest.buildId ?? manifest.revision]);cacheReply = resolve; parentPort!.postMessage({ type: 'cache', picture });
        }),
      );
    else
      await publish(
        await analyzePicture(
          reader,
          workerData.target,
          await loadCore(),
          (manifest.buildId ?? manifest.revision),
          new AbortController().signal,
        ),
      );
    parentPort!.postMessage({type:"counters",counters});parentPort!.postMessage({ ok: true, type: "complete" });
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
