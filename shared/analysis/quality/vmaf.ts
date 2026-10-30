import {
  clockFraction,
  clockKey,
  clockToUs,
  clockDeltaEquals,
} from "../../media/indexing/rational-clock.ts";
import type { RationalClock } from "../../media/indexing/rational-clock.ts";
import { qualitySourceClock } from "./source-index.ts";
import type {
  ScoringComponent,
  AnalysisScoringResources,
} from "./scoring-component.ts";
import { validateScoringComponent } from "./scoring-component.ts";
import type { ReexecutionMetadata } from "./reexecution.ts";
import type { CorrespondenceResult } from "./correspondence.ts";
import { canonicalJson } from "./correspondence.ts";
import { FORWARD_PAIR_LIMITS } from "./frame-pair.ts";
import type { FramePairRequest, PairProvenance } from "./frame-pair.ts";
import type { QualityVideoIndex } from "./source-index.ts";
import type { LibraryPairBinding, LibraryPairResult } from "./library-pair.ts";
import {
  mp4TicksToUs,
  parseMp4QualityDocument,
} from "../../media/indexing/mp4-quality-index.ts";

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
  frames: 1024,
  width: 4096,
  height: 2304,
  minDimension: 64,
  maxRawBytes: 64 * 1024 * 1024 * 1024,
  maxIndexBytes: 64 * 1024 * 1024,
  maxIndexPackets: 1000000,
  maxElapsedMs: 600000,
  nativeCpuSeconds: 60,
  nativeMemoryBytes: 512 * 1024 * 1024,
  stdoutBytes: 64 * 1024,
  resultBytes: 32 * 1024 * 1024,
  queued: 4,
  actorOutstanding: 2,
  queueWaitMs: 60000,
  historyRows: 16,
  reservedBytes: 256 * 1024 * 1024,
  page: 4,
});
export type VmafModel = keyof typeof VMAF_MODELS;
export type VmafComponentConfig = { directory: string; manifestSha256: string };
export type VmafInput = {
  schema: "voidplayer-native-vmaf-job";
  version: 1;
  client: { id: string; kind: "browser" | "agent" | "other" };
  plan: { id: string; attemptId: string; digest: string };
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
export type VmafPlanSnapshot = {
  id: string;
  attemptId: string;
  digest: string;
  value: CorrespondenceResult;
};
export type VmafSequence = {
  pairs: FramePairRequest[];
  cadenceUs: number;
  cadence?: RationalClock;
  presentationOrder: "strict-source-pts";
  boundary: "clip-reset-and-final-flush";
  mapping: "frozen-caller-declared-clock-plan";
  referenceIntegrity: "not-certified";
  concealmentDetection: "unavailable";
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
export type VmafPrepared = {
  sequence: VmafSequence;
  geometry: { width: number; height: number; bitDepth: 8 | 10 };
  pairs: LibraryPairResult[];
  raw: { referenceSha256: string; distortedSha256: string; bytes: number };
  work: {
    readBytes: number;
    packets: number;
    outputFrames: number;
    indexBytes: number;
    indexPackets: number;
    inputBytes: number;
    heapBytes: number;
    elapsedMs: number;
  };
};
export type VmafMetricState = {
  state:
    | "waiting"
    | "running"
    | "completed"
    | "failed"
    | "cancelled"
    | "interrupted"
    | "not-requested";
  reason: { code: string; message: string } | null;
};
export type VmafResult = {
  schema: "voidplayer-native-vmaf-result";
  version: 1 | 2;
  plan: { id: string; attemptId: string; digest: string };
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
export function vmafSourceVersion(sources: {
  reference: LibraryPairBinding;
  distorted: LibraryPairBinding;
}): 1 | 2 {
  let version: 1 | 2 = 1;
  for (const source of [sources?.reference, sources?.distorted]) {
    const kind = source?.binding?.indexIdentity?.kind,
      producer = source?.producer?.producer;
    if (kind === "flv" && producer === "server-flv-scan-v1") continue;
    if (kind === "mp4" && producer === "server-mp4-scan-v1") {
      version = 2;
      continue;
    }
    fail(
      "VMAF requires an existing trusted FLV or strict MP4 source and matching server producer",
    );
  }
  return version;
}
/** C supplies correspondence. This adds sequence eligibility, never alignment. */
export function vmafSequence(
  snapshot: VmafPlanSnapshot,
  indexes: [QualityVideoIndex, QualityVideoIndex],
  expectedCadenceUs: number,
  exactCadence?: RationalClock,
): VmafSequence {
  const r = snapshot.value,
    plan = r.rangePlan;
  vmafSourceVersion(r.sources!);
  if (
    !plan ||
    r.executionBlock ||
    r.request.sampling.mode !== "all" ||
    r.rows.length < 2 ||
    r.rows.length > VMAF_LIMITS.frames ||
    r.rows.some((row) => !row.selected || row.status !== "mapped") ||
    r.sourceIssues.reference ||
    r.sourceIssues.distorted
  )
    fail(
      "VMAF needs 2..1024 fully mapped all-sample frames without stride or holes",
    );
  const pairs = structuredClone(plan!.input.pairs).sort(
    (a, b) => a.reference.sourcePtsUs - b.reference.sourcePtsUs,
  );
  if (pairs.length !== r.rows.length)
    fail("Frozen pairs do not cover every selected AU");
  const expected = exactCadence ?? {
    ticks: expectedCadenceUs,
    timescale: 1000000,
  };
  clockFraction(expected);
  let cadence = 0;
  for (const side of ["reference", "distorted"] as const) {
    const i = side === "reference" ? 0 : 1,
      ordered = pairs.map((p) => p[side].sourcePtsUs),
      selected = new Set(pairs.map((p) => p[side].picture.au));
    const source = r.sources![side],
      index = indexes[i],
      mp4 = index.mp4;
    if (
      pairs.some((p) =>
        (
          [
            "mediaId",
            "mediaVersion",
            "size",
            "indexBuildId",
            "indexIdentity",
          ] as const
        ).some(
          (k) => canonicalJson(p[side][k]) !== canonicalJson(source.binding[k]),
        ),
      )
    )
      fail("Frozen sequence source/cache binding changed");
    if (source.binding.indexIdentity.kind === "mp4") {
      const producer = source.producer;
      if (
        !mp4 ||
        index.container !== "mp4" ||
        producer.producer !== "server-mp4-scan-v1" ||
        producer.trackId !== mp4.trackId ||
        producer.timescale !== mp4.timescale ||
        producer.tableSha256 !== mp4.moov.sha256
      )
        fail("MP4 track, timebase or table differs from the frozen producer");
      parseMp4QualityDocument(mp4, source.binding.size);
      for (const pair of pairs) {
        const p = pair[side],
          sample = mp4!.samples[p.picture.au];
        if (
          p.decode?.mode !== "packet-identity-gop-v1" ||
          !sample ||
          sample.ordinal !== p.picture.au ||
          sample.ptsUs !== p.sourcePtsUs ||
          clockKey({
            ticks: sample.durationTicks,
            timescale: mp4!.timescale,
          }) !== clockKey(expected)
        )
          fail(
            "MP4 sequence needs exact closed-window sample clocks and constant durations",
          );
      }
    } else if (index.container === "mp4" || mp4)
      fail("Container differs from the frozen source");
    if (
      ordered.some(
        (pts, n) =>
          !Number.isSafeInteger(pts) ||
          pts < 0 ||
          (n > 0 && pts <= ordered[n - 1]),
      )
    )
      fail(
        "Known unique nonnegative presentation clocks required; VFR/negative PTS not admitted",
      );
    if (
      pairs.some(
        (pair, n) =>
          n > 0 &&
          !clockDeltaEquals(
            qualitySourceClock(index, pair[side].picture.au),
            qualitySourceClock(index, pairs[n - 1][side].picture.au),
            expected,
          ),
      )
    )
      fail("One exact rational presentation cadence on both sides required");
    cadence = expectedCadenceUs;
    const inSpan = indexes[i].packets.flatMap((p, au) =>
      p.pts >= ordered[0] && p.pts <= ordered.at(-1)! ? [{ p, au }] : [],
    );
    if (
      inSpan.length !== pairs.length ||
      inSpan.some(
        ({ p, au }) =>
          !selected.has(au) ||
          !Number.isSafeInteger(p.pts) ||
          indexes[i].packets.filter((q) => q.pts === p.pts).length !== 1,
      )
    )
      fail(
        "Presentation interval has an unselected, duplicate or missing picture",
      );
    for (const p of pairs) {
      const raw = indexes[i].packets[p[side].picture.au];
      if (!raw || raw.pts !== p[side].sourcePtsUs)
        fail("Frozen AU/PTS changed");
    }
  }
  for (let n = 1; n < pairs.length; n++)
    if (pairs[n].distorted.sourcePtsUs <= pairs[n - 1].distorted.sourcePtsUs)
      fail("Mapping changes presentation order");
  return {
    pairs,
    cadenceUs: cadence,
    ...(exactCadence ? { cadence: exactCadence } : {}),
    presentationOrder: "strict-source-pts",
    boundary: "clip-reset-and-final-flush",
    mapping: "frozen-caller-declared-clock-plan",
    referenceIntegrity: "not-certified",
    concealmentDetection: "unavailable",
  };
}
export type VmafSequenceFrame = {
  au: number;
  sourcePtsUs: number;
  decode?: FramePairRequest["reference"]["decode"];
  container?: PairProvenance["container"];
};
export function vmafSequenceFrame(p: PairProvenance): VmafSequenceFrame {
  return {
    au: p.picture.au,
    sourcePtsUs: p.sourcePtsUs,
    decode: p.decode,
    ...(p.container ? { container: structuredClone(p.container) } : {}),
  };
}
export type VmafAssociation = {
  schema: "voidplayer-vmaf-sequence-association";
  version: 1 | 2;
  jobId: string;
  attemptId: string;
  resultDigest: string;
  plan: { id: string; attemptId: string; digest: string };
  sequence: {
    indices?: number[];
    pairsSha256?: string;
    cadenceUs: number;
    cadence?: RationalClock;
    referenceIntegrity: "not-certified";
    concealmentDetection: "unavailable";
    pairs: { reference: VmafSequenceFrame; distorted: VmafSequenceFrame }[];
  };
  index: number;
  frames: number;
  score: number;
  pooled: VmafPool;
  component: VmafNativeResult["component"];
  recipe: VmafNativeResult["recipe"];
  raw: VmafPrepared["raw"];
  spatial:
    | "full-frame-temporal-score-not-localized"
    | "cropped-region-temporal-score-not-localized";
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
  validateTemporalSequenceWitness(v, pair);
  return structuredClone(v);
}
/** Shared frame identity, exact clock and crop evidence for temporal scorers. */
export function validateTemporalSequenceWitness(
  v: Pick<VmafAssociation, 'sequence'|'index'|'frames'|'raw'|'spatial'> & {
    component: ScoringComponent;
    recipe: Pick<VmafNativeResult['recipe'], 'width'|'height'|'bitDepth'|'roi'>;
  }, pair: LibraryPairResult,
) {
  const c=v.component, recipe=v.recipe;
  object(v.sequence, [
    "indices",
    "pairsSha256",
    "cadenceUs",
    "cadence",
    "referenceIntegrity",
    "concealmentDetection",
    "pairs",
  ]);
  if (
    !Number.isSafeInteger(v.sequence.cadenceUs) ||
    v.sequence.cadenceUs < 1 ||
    v.sequence.referenceIntegrity !== "not-certified" ||
    v.sequence.concealmentDetection !== "unavailable" ||
    !Array.isArray(v.sequence.pairs) ||
    (v.sequence.indices
      ? v.sequence.pairs.length !== v.sequence.indices.length
      : v.sequence.pairs.length !== v.frames)
  )
    fail("Invalid temporal sequence witness");
  const indices = v.sequence.indices ?? v.sequence.pairs.map((_, i) => i);
  if (v.sequence.indices) {
    if (
      !("executor" in c) ||
      c.executor !== "analysis-wasm" ||
      !/^[a-f0-9]{64}$/.test(v.sequence.pairsSha256 ?? "") ||
      indices.length < 2 ||
      indices.length > 3 ||
      indices[0] !== 0 ||
      indices.at(-1) !== v.frames - 1 ||
      !indices.includes(v.index) ||
      indices.some(
        (n, i) =>
          !Number.isSafeInteger(n) ||
          n < 0 ||
          n >= v.frames ||
          (i > 0 && n <= indices[i - 1]),
      )
    )
      fail("Invalid digest-bound first/selected/last sequence witness");
  } else if (v.sequence.pairsSha256 !== undefined)
    fail("Unexpected compact sequence digest");
  const exact = v.sequence.cadence ?? {
    ticks: v.sequence.cadenceUs,
    timescale: 1000000,
  };
  clockFraction(exact);
  if (exact.ticks < 1 || clockToUs(exact) !== v.sequence.cadenceUs)
    fail("Invalid rational cadence");
  for (const side of ["reference", "distorted"] as const) {
    const seen = new Set<number>(),
      source = pair.sources[side],
      mp4 = source.binding.indexIdentity.kind === "mp4";
    for (const [i, item] of v.sequence.pairs.entries()) {
      object(item, ["reference", "distorted"]);
      object(
        item[side],
        mp4
          ? ["au", "sourcePtsUs", "decode", "container"]
          : ["au", "sourcePtsUs", "decode"],
      );
      const p = item[side];
      if (
        !Number.isSafeInteger(p.au) ||
        p.au < 0 ||
        seen.has(p.au) ||
        !Number.isSafeInteger(p.sourcePtsUs) ||
        p.sourcePtsUs < 0
      )
        fail("Invalid continuous temporal picture identities");
      seen.add(p.au);
      const sourceClock = (f: VmafSequenceFrame) =>
        f.container
          ? {
              ticks: f.container.sample.dtsTicks + f.container.sample.ctsTicks,
              timescale: f.container.timescale,
            }
          : { ticks: f.sourcePtsUs, timescale: 1000000 };
      if (
        i > 0 &&
        !clockDeltaEquals(
          sourceClock(p),
          sourceClock(v.sequence.pairs[i - 1][side]),
          {
            ticks: exact.ticks * (indices[i] - indices[i - 1]),
            timescale: exact.timescale,
          },
        )
      )
        fail("Temporal source ticks are not continuous");
      if (mp4) {
        const c = p.container,
          s = c?.sample,
          producer = source.producer;
        object(c, ["kind", "trackId", "timescale", "tableSha256", "sample"]);
        object(s, [
          "ordinal",
          "description",
          "offset",
          "size",
          "dtsTicks",
          "ctsTicks",
          "durationTicks",
          "dtsUs",
          "ptsUs",
          "durationUs",
          "key",
        ]);
        if (
          !c ||
          !s ||
          producer.producer !== "server-mp4-scan-v1" ||
          c.kind !== "mp4" ||
          c.trackId !== producer.trackId ||
          c.timescale !== producer.timescale ||
          c.tableSha256 !== producer.tableSha256 ||
          p.decode?.mode !== "packet-identity-gop-v1" ||
          !Number.isSafeInteger(p.decode.startAu) ||
          !Number.isSafeInteger(p.decode.endAu) ||
          p.decode.startAu < 0 ||
          p.decode.startAu > p.au ||
          p.decode.endAu < p.au ||
          p.decode.endAu - p.decode.startAu >=
            FORWARD_PAIR_LIMITS.packetsPerSide ||
          s.ordinal !== p.au ||
          s.description !== 1 ||
          s.ptsUs !== p.sourcePtsUs ||
          clockKey({ ticks: s.durationTicks, timescale: c.timescale }) !==
            clockKey(exact) ||
          ![
            s.offset,
            s.size,
            s.dtsTicks,
            s.ctsTicks,
            s.durationTicks,
            s.dtsUs,
            s.ptsUs,
            s.durationUs,
          ].every(Number.isSafeInteger) ||
          s.offset < 0 ||
          s.size < 1 ||
          s.offset + s.size > source.binding.size ||
          s.dtsTicks < 0 ||
          s.durationTicks < 1 ||
          typeof s.key !== "boolean" ||
          mp4TicksToUs(s.dtsTicks, c.timescale) !== s.dtsUs ||
          mp4TicksToUs(s.dtsTicks + s.ctsTicks, c.timescale) !== s.ptsUs ||
          mp4TicksToUs(s.durationTicks, c.timescale) !== s.durationUs
        )
          fail("Invalid MP4 temporal sample/table witness");
      }
    }
    const p = v.sequence.pairs[indices.indexOf(v.index)][side],
      actual = pair.result.provenance[side];
    if (
      p.au !== actual.picture.au ||
      p.sourcePtsUs !== actual.sourcePtsUs ||
      canonicalJson(p.decode) !== canonicalJson(actual.decode) ||
      canonicalJson(p.container) !== canonicalJson(actual.container)
    )
      fail("Selected frame differs from the temporal sequence");
  }
  const metric = pair.result.metric;
  if (
    ![8, 10].includes(recipe.bitDepth) ||
    ![recipe.width, recipe.height].every(
      (n) =>
        Number.isSafeInteger(n) && n >= VMAF_LIMITS.minDimension && n % 2 === 0,
    ) ||
    recipe.width > VMAF_LIMITS.width ||
    recipe.height > VMAF_LIMITS.height ||
    metric.color.primaries !== "bt709" ||
    metric.color.transfer !== "bt709" ||
    metric.color.matrix !== "bt709" ||
    metric.color.fullRange ||
    metric.color.chromaLocation !== 1 ||
    metric.roi.width !== recipe.width ||
    metric.roi.height !== recipe.height ||
    metric.bitDepth !== recipe.bitDepth
  )
    fail("Temporal evidence pixel domain differs");
  if (recipe.roi) {
    object(recipe.roi, ["x", "y", "width", "height"]);
    if (
      canonicalJson(recipe.roi) !== canonicalJson(metric.roi) ||
      !("executor" in c) ||
      c.executor !== "analysis-wasm"
    )
      fail(
        "Crop recipe must match the pixel-domain measurement and analysis executor",
      );
  }
  const cropped = Object.values(pair.result.provenance).some(
    (p) =>
      metric.roi.x !== 0 ||
      metric.roi.y !== 0 ||
      metric.roi.width !== p.decoded.description.width ||
      metric.roi.height !== p.decoded.description.height,
  );
  if (
    (cropped && !recipe.roi) ||
    v.spatial !==
      (cropped
        ? "cropped-region-temporal-score-not-localized"
        : "full-frame-temporal-score-not-localized")
  )
    fail("Temporal spatial claim differs from the evaluated region");
  for (const p of Object.values(pair.result.provenance)) {
    const d = p.decoded.description;
    if (
      metric.roi.x + recipe.width > d.width ||
      metric.roi.y + recipe.height > d.height ||
      d.visibleRect.x ||
      d.visibleRect.y ||
      d.codedWidth !== d.width ||
      d.codedHeight !== d.height ||
      d.yuv?.bitDepth !== recipe.bitDepth
    )
      fail("Temporal evidence geometry differs");
  }
  if (
    !v.raw ||
    [v.raw.referenceSha256, v.raw.distortedSha256].some(
      (h) => !/^[a-f0-9]{64}$/.test(h),
    ) ||
    !Number.isSafeInteger(v.raw.bytes) ||
    v.raw.bytes !==
      ((recipe.width * recipe.height * 3) / 2) *
        (recipe.bitDepth === 8 ? 1 : 2) *
        v.frames *
        2 ||
    v.raw.bytes > VMAF_LIMITS.maxRawBytes
  )
    fail("Invalid raw sequence witness");
}
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
