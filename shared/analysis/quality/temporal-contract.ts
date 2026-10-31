import { BYTE_HISTORY_RETENTION } from '../../service/history-retention.ts';
import { clockFraction, clockKey, clockToUs, clockDeltaEquals } from '../../media/indexing/rational-clock.ts';
import type { RationalClock } from '../../media/indexing/rational-clock.ts';
import { mp4TicksToUs, parseMp4QualityDocument } from '../../media/indexing/mp4-quality-index.ts';
import { canonicalJson } from './correspondence.ts';
import type { CorrespondenceResult } from './correspondence.ts';
import { FORWARD_PAIR_LIMITS } from './frame-pair.ts';
import type { FramePairRequest, PairProvenance } from './frame-pair.ts';
import type { LibraryPairBinding, LibraryPairResult } from './library-pair.ts';
import { qualitySourceClock } from './source-index.ts';
import type { QualityVideoIndex } from './source-index.ts';
import type { ScoringComponent } from './scoring-component.ts';

/** Shared resource/retention defaults, independently adopted by each metric. Geometry stays in metric admission. */
export const TEMPORAL_RESOURCE_LIMITS = Object.freeze({
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
  /** @deprecated Compatibility metadata only; not a storage row cap. */
  historyRows: 16, historyRetention: BYTE_HISTORY_RETENTION,
  reservedBytes: 256 * 1024 * 1024,
  page: 4,
});
/** Shared frozen facts and sequence witnesses. Metrics supply their own admission limits and errors. */
export type TemporalPlanPin = { id: string; attemptId: string; digest: string };
export type TemporalPlanSnapshot = TemporalPlanPin & { value: CorrespondenceResult };
export type TemporalSequence = {
  pairs: FramePairRequest[];
  cadenceUs: number;
  cadence?: RationalClock;
  presentationOrder: "strict-source-pts";
  boundary: "clip-reset-and-final-flush";
  mapping: "frozen-caller-declared-clock-plan";
  referenceIntegrity: "not-certified";
  concealmentDetection: "unavailable";
};
export type TemporalPrepared = {
  sequence: TemporalSequence;
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
export type TemporalMetricState = {
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
export function temporalSourceVersion(sources: {
  reference: LibraryPairBinding;
  distorted: LibraryPairBinding;
}, fail: (message: string) => never): 1 | 2 {
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
      "An existing trusted FLV or strict MP4 source and matching server producer is required",
    );
  }
  return version;
}
/** C supplies correspondence. This adds sequence eligibility, never alignment. */
export function temporalSequence(
  snapshot: TemporalPlanSnapshot,
  indexes: [QualityVideoIndex, QualityVideoIndex],
  expectedCadenceUs: number,
  exactCadence: RationalClock | undefined,
  domain: { frames: number; fail: (message: string) => never },
): TemporalSequence {
  const { fail } = domain;
  const r = snapshot.value,
    plan = r.rangePlan;
  temporalSourceVersion(r.sources!, fail);
  if (
    !plan ||
    r.executionBlock ||
    r.request.sampling.mode !== "all" ||
    r.rows.length < 2 ||
    r.rows.length > domain.frames ||
    r.rows.some((row) => !row.selected || row.status !== "mapped") ||
    r.sourceIssues.reference ||
    r.sourceIssues.distorted
  )
    fail(
      `Sequence needs 2..${domain.frames} fully mapped all-sample frames without stride or holes`,
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
export type TemporalSequenceFrame = {
  au: number;
  sourcePtsUs: number;
  decode?: FramePairRequest["reference"]["decode"];
  container?: PairProvenance["container"];
};
export function temporalSequenceFrame(p: PairProvenance): TemporalSequenceFrame {
  return {
    au: p.picture.au,
    sourcePtsUs: p.sourcePtsUs,
    decode: p.decode,
    ...(p.container ? { container: structuredClone(p.container) } : {}),
  };
}
export type TemporalSequenceWitness = {
  sequence: {
    indices?: number[]; pairsSha256?: string; cadenceUs: number; cadence?: RationalClock;
    referenceIntegrity: 'not-certified'; concealmentDetection: 'unavailable';
    pairs: { reference: TemporalSequenceFrame; distorted: TemporalSequenceFrame }[];
  };
  index: number; frames: number; raw: TemporalPrepared['raw'];
  spatial: 'full-frame-temporal-score-not-localized' | 'cropped-region-temporal-score-not-localized';
};
export type TemporalAssociation = TemporalSequenceWitness & {
  version: 1 | 2; jobId: string; attemptId: string; resultDigest: string; plan: TemporalPlanPin;
};
/** Exact first/selected/last witness above 32 frames; the host supplies its existing digest. */
export function temporalWitness(
  prepared: TemporalPrepared, index: number, digest: (value: unknown) => string,
): TemporalSequenceWitness {
  const pairs = prepared.pairs.map(p => ({
    reference: temporalSequenceFrame(p.result.provenance.reference),
    distorted: temporalSequenceFrame(p.result.provenance.distorted),
  }));
  const indices = pairs.length > 32 ? [...new Set([0, index, pairs.length - 1])].sort((a, b) => a - b) : null;
  const roi = prepared.sequence.pairs[index].roi, d = prepared.pairs[index].result.provenance.reference.decoded.description;
  return {
    index, frames: pairs.length, raw: prepared.raw,
    sequence: {
      cadenceUs: prepared.sequence.cadenceUs, ...(prepared.sequence.cadence ? { cadence: prepared.sequence.cadence } : {}),
      referenceIntegrity: 'not-certified', concealmentDetection: 'unavailable',
      ...(indices ? { indices, pairsSha256: digest(pairs), pairs: indices.map(i => pairs[i]) } : { pairs }),
    },
    spatial: roi.x !== 0 || roi.y !== 0 || roi.width !== d.width || roi.height !== d.height
      ? 'cropped-region-temporal-score-not-localized' : 'full-frame-temporal-score-not-localized',
  };
}
export function validateTemporalSequenceWitness(
  v: TemporalSequenceWitness & {
    component: ScoringComponent;
    recipe: { width: number; height: number; bitDepth: number; roi?: FramePairRequest['roi'] };
  }, pair: LibraryPairResult,
  limits: { minDimension: number; width: number; height: number; maxRawBytes: number },
  fail: (message: string) => never, object: (value: unknown, keys: string[]) => void,
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
      const sourceClock = (f: TemporalSequenceFrame) =>
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
        Number.isSafeInteger(n) && n >= limits.minDimension && n % 2 === 0,
    ) ||
    recipe.width > limits.width ||
    recipe.height > limits.height ||
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
    v.raw.bytes > limits.maxRawBytes
  )
    fail("Invalid raw sequence witness");
}
