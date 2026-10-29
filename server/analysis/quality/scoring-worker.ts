import { createHash } from "node:crypto";
import { parentPort, workerData } from "node:worker_threads";
import { AnalysisScorer } from "../../../shared/analysis/quality/analysis-core.ts";
import { VMAF_MODELS } from "../../../shared/analysis/quality/vmaf.ts";
import type {
  VmafNativeResult,
  VmafPrepared,
} from "../../../shared/analysis/quality/vmaf.ts";
import { loadAnalysisScoring } from "./analysis-component.ts";
import { runCambiDecode } from "../cambi/decode-task.ts";
import { CAMBI_RECIPE } from "../../../shared/analysis/quality/cambi.ts";
import type {
  CambiPrepared,
  CambiNative,
} from "../../../shared/analysis/quality/cambi.ts";
import { runVmafDecode } from "../vmaf/decode-task.ts";

let scorer: AnalysisScorer | undefined;
try {
  const started = performance.now();
  const loaded = await loadAnalysisScoring(
    workerData.analysisDir,
    workerData.analysisContract?.component,
  );
  const memory = () => {
    if (
      loaded.core.HEAPU8.byteLength > workerData.input.budget.nativeMemoryBytes
    )
      throw Object.assign(Error("Analysis linear memory budget exceeded"), {
        code: "budget-exceeded",
      });
  };
  memory();
  if (workerData.metric === "cambi") {
    const prepared = (await runCambiDecode(
      workerData,
      (frames, total) =>
        parentPort!.postMessage({ type: "progress", frames, total }),
      (contract) =>
        parentPort!.postMessage({ type: "execution-contract", contract }),
      undefined,
      async (frame, prepared, index, total) => {
        scorer ??= new AnalysisScorer(loaded.core, {
          metrics: ["cambi"],
          frames: total,
        });
        scorer.feed(
          frame,
          frame,
          {
            x: 0,
            y: 0,
            width: frame.description.width,
            height: frame.description.height,
          },
          index,
        );
        memory();
        const maps = scorer
          .heatmaps(index)
          .map((map) => ({
            ...map,
            sha256: createHash("sha256").update(map.bytes).digest("hex"),
          }));
        const { frames: facts, ...header } = prepared;
        // One frame in flight. Persistence acknowledges before the next decode,
        // so neither Worker messages nor heatmap storage grows without backpressure.
        await new Promise<void>((resolve) => {
          const ack = (message: { type: string; index: number }) => {
            if (message.type === "scoring-ack" && message.index === index) {
              parentPort!.off("message", ack);
              resolve();
            }
          };
          parentPort!.on("message", ack);
          parentPort!.postMessage(
            {
              type: "scoring-frame",
              index,
              frame: facts[index],
              header,
              maps,
              score: scorer!.score("cambi", index),
            },
            maps.map((map) => map.bytes.buffer),
          );
        });
      },
    )) as CambiPrepared;
    if (!scorer) throw Error("Empty CAMBI sequence");
    const native: CambiNative = {
      ...scorer.finish().cambi!,
      version: loaded.version,
      recipe: CAMBI_RECIPE,
      component: loaded.component,
      resources: {
        executor: "analysis-wasm",
        wallMs: Math.ceil(performance.now() - started),
        heapBytes: scorer.heapBytes,
      },
      outputBytes: prepared.output.heatBytes,
    };
    parentPort!.postMessage({ ok: true, value: { prepared, native } });
  } else {
    const prepared = (await runVmafDecode(
      workerData,
      (frames, total) =>
        parentPort!.postMessage({ type: "progress", frames, total }),
      (contract) =>
        parentPort!.postMessage({ type: "execution-contract", contract }),
      undefined,
      (reference, distorted, index, total, roi) => {
        scorer ??= new AnalysisScorer(loaded.core, {
          metrics: ["vmaf"],
          frames: total,
          model: workerData.input.model,
        });
        scorer.feed(reference, distorted, roi, index);
        memory();
      },
    )) as VmafPrepared;
    if (!scorer) throw Error("Empty scoring sequence");
    const scores = scorer.finish().vmaf!;
    const result: VmafNativeResult = {
      ...scores,
      version: loaded.version,
      component: {
        ...loaded.component,
        modelSha256:
          VMAF_MODELS[workerData.input.model as keyof typeof VMAF_MODELS]
            .sha256,
      },
      recipe: {
        model: workerData.input.model,
        threads: 1,
        cpuMask: 0,
        subsample: 1,
        pooling: "official-mean-min-max-harmonic",
        preprocessing: "none",
        range: "limited",
        color: "bt709-sdr",
        roi: prepared.sequence.pairs[0].roi,
        pixelFormat:
          prepared.geometry.bitDepth === 8 ? "yuv420p" : "yuv420p10le",
        ...prepared.geometry,
        boundary: "clip-reset-and-final-flush",
        rawPacking: "visible-y-u-v-tight-little-endian-v1",
      },
      resources: {
        executor: "analysis-wasm",
        wallMs: Math.ceil(performance.now() - started),
        heapBytes: scorer.heapBytes,
      },
    };
    parentPort!.postMessage({ ok: true, value: { prepared, native: result } });
  }
} catch (error) {
  parentPort!.postMessage({
    ok: false,
    error: {
      code: (error as { code?: string }).code ?? "execution-failed",
      message: (error as Error).message,
    },
  });
} finally {
  scorer?.close();
}
parentPort!.on("message", () => {});
