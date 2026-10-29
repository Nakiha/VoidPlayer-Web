import test from "node:test";
import assert from "node:assert/strict";
import {
  cambiInput,
  cambiIntervalClocks,
  cambiScales,
  cambiOutputBudget,
  CAMBI_LIMITS,
  CAMBI_RECIPE,
} from "../../shared/analysis/quality/cambi.ts";
import {
  FLV_MEDIA_INDEX_IDENTITY,
  MP4_QUALITY_MEDIA_INDEX_IDENTITY,
} from "../../shared/media/indexing/media-index-identity.ts";
import {
  requirePacketOutputWitness,
  type PairProvenance,
} from "../../shared/analysis/quality/frame-pair.ts";
const body = () => ({
  schema: "voidplayer-cambi-job",
  version: 1,
  client: { id: "unit", kind: "agent" },
  source: {
    mediaId: "a".repeat(24),
    mediaVersion: "b".repeat(24),
    size: 100,
    indexIdentity: FLV_MEDIA_INDEX_IDENTITY,
    indexBuildId: "build",
  },
  interval: { startPtsUs: 0, endPtsUs: 1000000 },
  sampling: { stride: 1 },
  budget: Object.fromEntries(
    [
      "maxRawBytes",
      "maxHeatBytes",
      "maxTemporaryBytes",
      "maxElapsedMs",
      "nativeCpuSeconds",
      "nativeMemoryBytes",
    ].map((k) => [k, CAMBI_LIMITS[k as keyof typeof CAMBI_LIMITS]]),
  ),
});
test("CAMBI input is genuinely single-source, normalized and bounded", () => {
  const b = body();
  assert.deepEqual(cambiInput(b), b);
  assert.equal(
    cambiInput({
      ...b,
      source: { ...b.source, indexIdentity: MP4_QUALITY_MEDIA_INDEX_IDENTITY },
    }).source.indexIdentity.kind,
    "mp4",
  );
  for (const v of [
    { ...b, reference: b.source },
    { ...b, plan: {} },
    { ...b, model: "arbitrary" },
    { ...b, source: { ...b.source, indexBuildId: "" } },
    { ...b, client: { ...b.client, id: 123 } },
    { ...b, interval: { startPtsUs: -1, endPtsUs: 20 } },
    { ...b, sampling: { stride: 0 } },
    {
      ...b,
      budget: { ...b.budget, maxHeatBytes: CAMBI_LIMITS.maxHeatBytes + 1 },
    },
  ])
    assert.throws(() => cambiInput(v));
  assert.equal(CAMBI_RECIPE.prediction, false);
  assert.equal(CAMBI_RECIPE.fullRef, false);
  assert.equal(CAMBI_RECIPE.internalBitDepth, 10);
  assert.equal(CAMBI_RECIPE.scoreDirection, "higher-is-more-banding");
});
test("streamed CAMBI reserves actual heatmaps and bounded result, without raw files or FSIZE multiplication", () => {
  const input = cambiInput(body()),
    s = cambiScales(642, 354);
  assert.deepEqual(
    s.map((m) => [m.width, m.height]),
    [
      [642, 354],
      [321, 177],
      [161, 89],
      [81, 45],
      [41, 23],
    ],
  );
  for (const [i, m] of s.entries()) {
    assert.equal(m.bytes, m.width * m.height * 2);
    assert.equal(m.mapping.factor, 2 ** i);
  }
  const b = cambiOutputBudget(640, 352, 4, input),
    expected = 2400640 + CAMBI_LIMITS.resultBytes;
  assert.equal(b.heatBytes, 2400640);
  assert.equal(b.reservedOutputBytes, expected);
  assert.equal(b.temporaryReservedBytes, expected);
  assert.equal(b.accounting, "streamed-heatmap-and-result-v1");
  assert.equal("fileCap" in b, false);
  assert.doesNotThrow(() =>
    cambiOutputBudget(640, 352, 4, {
      ...input,
      budget: { ...input.budget, maxTemporaryBytes: expected },
    }),
  );
  assert.throws(() =>
    cambiOutputBudget(640, 352, 4, {
      ...input,
      budget: { ...input.budget, maxTemporaryBytes: expected - 1 },
    }),
  );
  assert.throws(() =>
    cambiOutputBudget(640, 352, 4, {
      ...input,
      budget: { ...input.budget, maxHeatBytes: 2400639 },
    }),
  );
  assert.throws(() =>
    cambiOutputBudget(640, 352, 4, {
      ...input,
      budget: { ...input.budget, maxRawBytes: 640 * 352 * 3 * 4 - 1 },
    }),
  );
  assert.throws(() => cambiScales(256, 144));
  assert.throws(() => cambiScales(641, 352));
  assert.throws(() => cambiOutputBudget(1920, 1080, 1024, input));
});

test("CAMBI MP4 interval clock gate rejects variable/ambiguous/nonintegral clocks without claiming VFR support", () => {
  assert.equal(
    cambiIntervalClocks([750000, 500000, 1000000], [250000, 250000, 250000]),
    250000,
  );
  for (const [pts, durations] of [
    [
      [0, 250000, 750000],
      [250000, 500000, 250000],
    ],
    [
      [0, 250000],
      [250000, 500000],
    ],
    [
      [0, 0],
      [250000, 250000],
    ],
    [
      [-1, 249999],
      [250000, 250000],
    ],
    [
      [0, 250000.5],
      [250000, 250000],
    ],
    [[0], [0]],
  ])
    assert.throws(() => cambiIntervalClocks(pts, durations));
});

test("streamed GOP witness cannot commit before drain or accept changed output identity", () => {
  // Only the fields consumed at this boundary are needed: source geometry is
  // independently validated by the source/provenance parser.
  const witness = {
    decode: { mode: "packet-identity-gop-v1", startAu: 10, endAu: 11 },
    picture: { au: 10 },
    dependency: {
      packets: [10, 11].map((au, i) => ({
        au,
        pts: i * 40000,
        dts: (i - 1) * 40000,
        size: 100 + i,
        offset: i * 100,
        key: i === 0,
      })),
      outputFrames: 2,
      outputIdentity: {
        abi: 1,
        generation: "decode-epoch",
        outputs: [
          {
            au: 10,
            token: "11",
            sourcePtsUs: 0,
            sourceDtsUs: -40000,
            packetBytes: 100,
            payloadHash: "0123456789abcdef",
            decodeErrorFlags: 0,
            phase: "immediate",
          },
        ],
      },
    },
  } as PairProvenance;
  assert.doesNotThrow(() => requirePacketOutputWitness(witness, false));
  assert.throws(() => requirePacketOutputWitness(witness));
  witness.dependency!.outputIdentity!.outputs.push({
    au: 11,
    token: "12",
    sourcePtsUs: 40000,
    sourceDtsUs: 0,
    packetBytes: 101,
    payloadHash: "abcdef0123456789",
    decodeErrorFlags: 0,
    phase: "drain",
  });
  assert.doesNotThrow(() => requirePacketOutputWitness(witness));
  for (const change of [
    { au: 10 },
    { token: "11" },
    { sourcePtsUs: 40001 },
    { sourceDtsUs: 1 },
    { packetBytes: 100 },
    { payloadHash: "unverified" },
    { decodeErrorFlags: 1 },
    { phase: "unknown" },
  ]) {
    const broken = structuredClone(witness);
    Object.assign(broken.dependency!.outputIdentity!.outputs[1], change);
    assert.throws(
      () => requirePacketOutputWitness(broken),
      JSON.stringify(change),
    );
  }
  const missingTarget = structuredClone(witness);
  missingTarget.picture.au = 12;
  assert.throws(() => requirePacketOutputWitness(missingTarget, false));
});
