import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { validateQualityCore } from "../../../shared/analysis/quality/analysis-core.ts";
import { validateXpsnrCore } from "../../../shared/analysis/quality/analysis-xpsnr.ts";
import {
  XPSNR_SOURCE_REVISION,
  XPSNR_FILTER_SHA256,
} from "../../../shared/analysis/quality/xpsnr.ts";
import type { AnalysisScoringComponent } from "../../../shared/analysis/quality/scoring-component.ts";
import {
  VMAF_MODELS,
  VMAF_SOURCE_REVISION,
  VmafError,
} from "../../../shared/analysis/quality/vmaf.ts";

const sha = (value: Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
/** Host-selected analysis artifact only. HTTP never supplies paths or binaries. */
export function analysisComponent(
  directory: string,
  metric: "vmaf" | "xpsnr" = "vmaf",
) {
  try {
    const files = [
      "manifest.json",
      "voidplayer-analysis.js",
      "voidplayer-analysis.wasm",
      "provenance.json",
    ];
    const data = Object.fromEntries(
      files.map((file) => [file, readFileSync(path.join(directory, file))]),
    );
    const manifest = JSON.parse(data["manifest.json"].toString());
    const provenance = JSON.parse(data["provenance.json"].toString());
    if (
      manifest.qualityAbi !== 1 ||
      manifest.quality?.revision !== VMAF_SOURCE_REVISION ||
      manifest.quality.avfilter !== false ||
      manifest.quality.cambiWindowSize !== 63 ||
      manifest.quality.heatmapAbi !== 1 ||
      (metric === "xpsnr" &&
        (manifest.quality.xpsnr?.abi !== 1 ||
          manifest.quality.xpsnr.revision !== XPSNR_SOURCE_REVISION ||
          manifest.quality.xpsnr.filterSha256 !== XPSNR_FILTER_SHA256)) ||
      manifest.threading !== "single" ||
      manifest.libraries.includes("avfilter") ||
      provenance.source.revision !== manifest.revision ||
      Object.entries(VMAF_MODELS).some(
        ([key, value]) => manifest.quality.models[key] !== value.sha256,
      ) ||
      files
        .slice(0, 3)
        .some((file) => provenance.files[file] !== sha(data[file])) ||
      ((manifest.dirty || provenance.dirty) &&
        process.env.ANALYSIS_ALLOW_LOCAL_BUILD !== "1")
    ) {
      throw Error("Analysis scoring provenance mismatch");
    }
    const component: AnalysisScoringComponent = {
      executor: "analysis-wasm",
      abi: 1,
      manifestSha256: sha(data["manifest.json"]),
      binarySha256: sha(data["voidplayer-analysis.wasm"]),
      glueSha256: sha(data["voidplayer-analysis.js"]),
      provenanceSha256: sha(data["provenance.json"]),
      sourceRevision:
        metric === "xpsnr" ? XPSNR_SOURCE_REVISION : VMAF_SOURCE_REVISION,
      coreRevision: manifest.revision,
    };
    return {
      component,
      bytes: data["voidplayer-analysis.wasm"],
      version:
        metric === "xpsnr"
          ? `xpsnr-pixel-${XPSNR_SOURCE_REVISION}`
          : (manifest.quality.version as string),
    };
  } catch (error) {
    throw new VmafError(
      "component-unavailable",
      `Analysis scoring core unavailable: ${(error as Error).message}`,
    );
  }
}
export async function loadAnalysisScoring(
  directory: string,
  expected?: AnalysisScoringComponent,
) {
  const metric =
    expected?.sourceRevision === XPSNR_SOURCE_REVISION ? "xpsnr" : "vmaf";
  const artifact = analysisComponent(directory, metric);
  if (
    expected &&
    JSON.stringify(expected) !== JSON.stringify(artifact.component)
  )
    throw new VmafError(
      "component-unavailable",
      "Frozen analysis scoring component changed",
    );
  const create = (
    await import(
      pathToFileURL(path.join(directory, "voidplayer-analysis.js")).href
    )
  ).default;
  const core = await create({ wasmBinary: artifact.bytes });
  validateQualityCore(core);
  if (metric === "xpsnr") validateXpsnrCore(core);
  return { ...artifact, core };
}
