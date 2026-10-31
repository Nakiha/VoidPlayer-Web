import {
  clockFraction,
  clockToUs,
} from "../../media/indexing/rational-clock.ts";
import type { RationalClock } from "../../media/indexing/rational-clock.ts";
import type {
  ScoringComponent,
  AnalysisScoringResources,
} from "./scoring-component.ts";
import { validateScoringComponent } from "./scoring-component.ts";
import type { ReexecutionMetadata } from "./reexecution.ts";
import { canonicalJson } from "./correspondence.ts";
import type { FramePairRequest } from "./frame-pair.ts";
import type { QualityVideoIndex } from "./source-index.ts";
import type { LibraryPairResult } from "./library-pair.ts";
import {
  TEMPORAL_RESOURCE_LIMITS, temporalSourceVersion, temporalSequence, temporalSequenceFrame as vmafSequenceFrame, validateTemporalSequenceWitness,
} from './temporal-contract.ts';
import type {
  TemporalPlanSnapshot as VmafPlanSnapshot, TemporalSequence as VmafSequence, TemporalPrepared as VmafPrepared,
  TemporalMetricState as VmafMetricState, TemporalSequenceFrame as VmafSequenceFrame, TemporalAssociation, TemporalPlanPin,
} from './temporal-contract.ts';
export type { VmafPlanSnapshot, VmafSequence, VmafPrepared, VmafMetricState, VmafSequenceFrame };
export { vmafSequenceFrame };
export function vmafSourceVersion(sources: Parameters<typeof temporalSourceVersion>[0]) {
  return temporalSourceVersion(sources, fail);
}
/** VMAF admission retains its own domain and error policy. */
export function vmafSequence(
  snapshot: VmafPlanSnapshot, indexes: [QualityVideoIndex, QualityVideoIndex], cadenceUs: number, cadence?: RationalClock,
): VmafSequence {
  return temporalSequence(snapshot, indexes, cadenceUs, cadence, { frames: VMAF_LIMITS.frames, fail });
}


export const VMAF_SUPERVISOR_SOURCE_SHA256 =
  "df6ab9f43548839f3743d773958468f0e5f6416268006843eb68deab43eff48f";
export const VMAF_SOURCE_REVISION = "17a67b238ce0539bdeafdc95961abac64fa16ea8";
export const VMAF_MODELS = Object.freeze({
  vmaf_v0_6_1: {
    file: "vmaf_v0.6.1.json",
    sha256: "5950d61fa1f861bd45d8149d80539ed9f3376cfc2495b8f0fa8e9f57cb131ee3",
  },
  vmaf_v0_6_1neg: {
    file: "vmaf_v0.6.1neg.json",
    sha256: "1fcda193aaa2a3136471b7516b3c5dc344546c05fcde2d58609f8c60a2387392",
  },
});
export const VMAF_LIMITS = Object.freeze({
  ...TEMPORAL_RESOURCE_LIMITS, frames: 1024, width: 4096, height: 2304, minDimension: 64,
});
export type VmafModel = keyof typeof VMAF_MODELS;
export type VmafComponentConfig = { directory: string; manifestSha256: string };
export type VmafInput = {
  schema: "voidplayer-native-vmaf-job";
  version: 1;
  client: { id: string; kind: "browser" | "agent" | "other" };
  plan: TemporalPlanPin;
  model: VmafModel;
  cadenceUs: number;
  cadence?: RationalClock;
  metrics: { psnr: true; ssim: boolean };
  budget: {
    maxRawBytes: number;
    maxElapsedMs: number;
    nativeCpuSeconds: number;
    nativeMemoryBytes: number;
  };
};
export type VmafPool = {
  min: number;
  max: number;
  mean: number;
  harmonic_mean: number;
};
export type VmafNativeResult = {
  frames: { index: number; score: number }[];
  pooled: VmafPool;
  version: string;
  component: ScoringComponent & { modelSha256: string };
  recipe: {
    roi?: FramePairRequest["roi"];
    model: VmafModel;
    threads: 1;
    cpuMask: 0;
    subsample: 1;
    pooling: "official-mean-min-max-harmonic";
    preprocessing: "none";
    range: "limited";
    color: "bt709-sdr";
    pixelFormat: "yuv420p" | "yuv420p10le";
    width: number;
    height: number;
    bitDepth: 8 | 10;
    boundary: "clip-reset-and-final-flush";
    rawPacking: "visible-y-u-v-tight-little-endian-v1";
  };
  resources: (
    | {
        exitCode: number;
        signal: number;
        cpuMs: number;
        wallMs: number;
        peakRssBytes: number;
        stdoutBytes: number;
        stderrBytes: number;
      }
    | AnalysisScoringResources
  ) & {
    finalVerification?: {
      indexBytes: number;
      indexPackets: number;
      elapsedMs: number;
    };
  };
};
export type VmafResult = {
  schema: "voidplayer-native-vmaf-result";
  version: 1 | 2;
  plan: TemporalPlanPin;
  prepared: VmafPrepared;
  vmaf: VmafNativeResult | null;
  metrics: {
    psnr: VmafMetricState;
    ssim: VmafMetricState;
    vmaf: VmafMetricState;
  };
};
export type VmafJob = ReexecutionMetadata & {
  schema: "voidplayer-native-vmaf-job-state";
  version: 1;
  id: string;
  actor: { id: string; name: string };
  key: string;
  requestId: string;
  input: VmafInput;
  revision: number;
  createdAt: number;
  queueUntil: number;
  startedAt: number | null;
  endedAt: number | null;
  attemptId: string | null;
  state:
    | "queued"
    | "preparing"
    | "running"
    | "cancelling"
    | "completed"
    | "partial"
    | "failed"
    | "cancelled"
    | "interrupted";
  phase: string;
  reason: { code: string; message: string } | null;
  progress: { preparedFrames: number; targetFrames: number };
  metrics: VmafResult["metrics"];
  /** Mutable observation fact; the immutable digest survives explicit release. */
  resultRetained?: boolean;
  resultDigest: string | null;
  process: { pid: number; startTicks: string; bootId: string } | null;
};
export const terminalVmaf = (s: VmafJob["state"]) =>
  !["queued", "preparing", "running", "cancelling"].includes(s);
export class VmafError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}
const fail = (message: string): never => {
  throw new VmafError("unsupported-vmaf-sequence", message);
};
const object = (v: unknown, keys: string[]) => {
  if (
    !v ||
    typeof v !== "object" ||
    Array.isArray(v) ||
    Object.keys(v).some((k) => !keys.includes(k))
  )
    throw new VmafError("invalid-vmaf-request", "Unknown VMAF fields");
};
export function vmafInput(value: unknown): VmafInput {
  object(value, [
    "schema",
    "version",
    "client",
    "plan",
    "model",
    "cadenceUs",
    "cadence",
    "metrics",
    "budget",
  ]);
  const v = structuredClone(value) as VmafInput;
  object(v.client, ["id", "kind"]);
  object(v.plan, ["id", "attemptId", "digest"]);
  object(v.metrics, ["psnr", "ssim"]);
  object(v.budget, [
    "maxRawBytes",
    "maxElapsedMs",
    "nativeCpuSeconds",
    "nativeMemoryBytes",
  ]);
  if (!Number.isSafeInteger(v.cadenceUs) || v.cadenceUs < 1)
    throw new VmafError(
      "invalid-vmaf-request",
      "Declare the exact constant presentation cadence in integer microseconds",
    );
  if (v.cadence) {
    clockFraction(v.cadence);
    if (v.cadence.ticks < 1 || clockToUs(v.cadence) !== v.cadenceUs)
      throw new VmafError(
        "invalid-vmaf-request",
        "Cadence microseconds must be the declared rational clock projection",
      );
  }
  if (
    v.schema !== "voidplayer-native-vmaf-job" ||
    v.version !== 1 ||
    typeof v.client.id !== "string" ||
    !/^[A-Za-z0-9._:-]{1,80}$/.test(v.client.id) ||
    !["agent", "browser", "other"].includes(v.client.kind) ||
    !Object.hasOwn(VMAF_MODELS, v.model) ||
    v.metrics.psnr !== true ||
    typeof v.metrics.ssim !== "boolean"
  )
    throw new VmafError(
      "invalid-vmaf-request",
      "Explicit model and PSNR/VMAF joint recipe required",
    );
  if (
    !/^[a-f0-9-]{36}$/.test(v.plan.id) ||
    !/^[a-f0-9-]{36}$/.test(v.plan.attemptId) ||
    !/^[a-f0-9]{64}$/.test(v.plan.digest)
  )
    throw new VmafError(
      "invalid-vmaf-request",
      "Pin the committed correspondence plan attempt and digest",
    );
  const maxima = {
    maxRawBytes: VMAF_LIMITS.maxRawBytes,
    maxElapsedMs: VMAF_LIMITS.maxElapsedMs,
    nativeCpuSeconds: VMAF_LIMITS.nativeCpuSeconds,
    nativeMemoryBytes: VMAF_LIMITS.nativeMemoryBytes,
  };
  for (const key of Object.keys(maxima) as (keyof typeof maxima)[])
    if (
      !Number.isSafeInteger(v.budget[key]) ||
      v.budget[key] < 1 ||
      v.budget[key] > maxima[key]
    )
      throw new VmafError("invalid-vmaf-request", `Invalid ${key} budget`);
  return v;
}
/** FLV v1 remains byte-compatible; MP4 on either side requires v2 evidence. */
export type VmafAssociation = TemporalAssociation & {
  schema: "voidplayer-vmaf-sequence-association";
  score: number;
  pooled: VmafPool;
  component: VmafNativeResult["component"];
  recipe: VmafNativeResult["recipe"];

};
export function validateVmafAssociation(
  value: unknown,
  pair: LibraryPairResult,
): VmafAssociation {
  const version = vmafSourceVersion(pair.sources);
  const v = value as VmafAssociation;
  object(v, [
    "schema",
    "version",
    "jobId",
    "attemptId",
    "resultDigest",
    "plan",
    "sequence",
    "index",
    "frames",
    "score",
    "pooled",
    "component",
    "recipe",
    "raw",
    "spatial",
  ]);
  if (
    v.schema !== "voidplayer-vmaf-sequence-association" ||
    v.version !== version ||
    pair.version !== version ||
    !/^vmaf-[a-f0-9-]{36}$/.test(v.jobId) ||
    !/^[a-f0-9-]{36}$/.test(v.attemptId) ||
    !/^[a-f0-9]{64}$/.test(v.resultDigest) ||
    ![
      "full-frame-temporal-score-not-localized",
      "cropped-region-temporal-score-not-localized",
    ].includes(v.spatial) ||
    !Number.isInteger(v.frames) ||
    v.frames < 2 ||
    v.frames > VMAF_LIMITS.frames ||
    !Number.isInteger(v.index) ||
    v.index < 0 ||
    v.index >= v.frames ||
    !Number.isFinite(v.score) ||
    v.score < 0 ||
    v.score > 100
  )
    fail("Invalid sequence association identity");
  if (
    !v.plan ||
    !/^[a-f0-9-]{36}$/.test(v.plan.id) ||
    !/^[a-f0-9-]{36}$/.test(v.plan.attemptId) ||
    !/^[a-f0-9]{64}$/.test(v.plan.digest)
  )
    fail("Invalid correspondence reference");
  object(v.plan, ["id", "attemptId", "digest"]);
  validateScoringComponent(v.component);
  object(v.recipe, [
    "roi",
    "model",
    "threads",
    "cpuMask",
    "subsample",
    "pooling",
    "preprocessing",
    "range",
    "color",
    "pixelFormat",
    "width",
    "height",
    "bitDepth",
    "boundary",
    "rawPacking",
  ]);
  object(v.raw, ["referenceSha256", "distortedSha256", "bytes"]);
  const c = v.component,
    recipe = v.recipe,
    m =
      recipe && Object.hasOwn(VMAF_MODELS, recipe.model)
        ? VMAF_MODELS[recipe.model]
        : undefined;
  if (
    !c ||
    !m ||
    c.sourceRevision !== VMAF_SOURCE_REVISION ||
    c.modelSha256 !== m.sha256 ||
    recipe.threads !== 1 ||
    recipe.cpuMask !== 0 ||
    recipe.subsample !== 1 ||
    recipe.pooling !== "official-mean-min-max-harmonic" ||
    recipe.preprocessing !== "none" ||
    recipe.boundary !== "clip-reset-and-final-flush" ||
    recipe.rawPacking !== "visible-y-u-v-tight-little-endian-v1" ||
    recipe.range !== "limited" ||
    recipe.color !== "bt709-sdr" ||
    recipe.pixelFormat !== (recipe.bitDepth === 8 ? "yuv420p" : "yuv420p10le")
  )
    fail("Invalid fixed native recipe");
  if (
    Object.keys(v.pooled).sort().join(",") !== "harmonic_mean,max,mean,min" ||
    Object.values(v.pooled).some(
      (n) => !Number.isFinite(n) || n < 0 || n > 100,
    ) ||
    v.pooled.min > v.pooled.max ||
    v.score < v.pooled.min - 0.000002 ||
    v.score > v.pooled.max + 0.000002 ||
    v.pooled.mean < v.pooled.min - 0.000002 ||
    v.pooled.mean > v.pooled.max + 0.000002
  )
    fail("Invalid native pool");
  validateTemporalSequenceWitness(v, pair, VMAF_LIMITS, fail, object);
  return structuredClone(v);
}
/** Shared frame identity, exact clock and crop evidence for temporal scorers. */
export const VMAF_CAPABILITY = {
  schema: "voidplayer-native-vmaf-capability",
  version: 1,
  platforms: ["wasm32"],
  sourceMatrix: [
    { codec: "h264", bitDepths: [8, 10] },
    { codec: "hevc", bitDepths: [8, 10] },
  ],
  models: VMAF_MODELS,
  scoreDirection: "higher-is-better",
  scoreRange: { min: 0, max: 100, basis: "fixed-model-default-clip" },
  sourceRevision: VMAF_SOURCE_REVISION,
  limits: VMAF_LIMITS,
  containers: {
    flv: { codecs: ["h264", "hevc"], bitDepths: [8, 10] },
    mp4: {
      sampleEntries: ["avc1", "hvc1"],
      matrix: ["h264-8", "hevc-8", "hevc-10"],
      fragmented: false,
    },
  },
  resultVersions: [1, 2],
  associationVersions: [1, 2],
  requires:
    "committed-C-plan; all samples; no holes; exact continuous presentation cadence; complete trusted FLV or strict non-fragmented MP4",
  input: "full-frame limited BT.709 SDR planar YUV420 8/10bit; no conversion",
  metrics: { required: ["psnr", "vmaf"], optional: ["ssim"] },
  temporalBoundary: "clip-reset-and-final-flush",
  spatial: "no-VMAF-heatmap-or-localized-defect",
  contentCertification: false,
  negativePts: false,
  vfr: false,
} as const;
export { canonicalJson };
