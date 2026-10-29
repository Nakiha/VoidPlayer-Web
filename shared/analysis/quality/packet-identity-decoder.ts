import { FramePairError } from "./frame-pair.ts";
import type {
  PairBudget,
  PairPacket,
  DecodedPairFrame,
  PacketOutputIdentity,
} from "./frame-pair.ts";
import { checkedHeap } from "../../wasm/heap.ts";
import { readWasmFrame } from "../../wasm/frame.ts";
const hash = (bytes: Uint8Array) => {
  let n = 14695981039346656037n;
  for (const b of bytes)
    n = BigInt.asUintN(64, (n ^ BigInt(b)) * 1099511628211n);
  return n.toString(16).padStart(16, "0");
};
/** Tokens, never output timestamps, establish AU membership. All outputs,
 * including post-target and drain frames, are observed and charged. */
export function* decodeIdentityGopFrames(
  core: any,
  heap: () => Uint8Array,
  codec: "h264" | "hevc",
  configuration: Uint8Array,
  packets: (PairPacket & { bytes: Uint8Array })[],
  budget: PairBudget,
  captureAu?: number,
): Generator<{ au: number; frame: DecodedPairFrame }, void> {
  function fail(message: string): never {
    throw new FramePairError("identity-mismatch", message);
  }
  const call = (
    name: string,
    types: string[] = [],
    args: unknown[] = [],
    result: string | null = "number",
  ) => core.ccall(name, result, types, args);
  if (
    typeof core._vp_packet_identity_abi !== "function" ||
    call("vp_packet_identity_abi") !== 1 ||
    [
      "_vp_packet_open_identity",
      "_vp_packet_send_identity",
      "_vp_packet_identity_info",
    ].some((name) => typeof core[name] !== "function")
  )
    throw new FramePairError(
      "decoder-error",
      "Required packet-output identity ABI v1 is unavailable",
    );
  if (
    !packets.length ||
    packets.length >
      (typeof core._vp_packet_identity_capacity === "function"
        ? core._vp_packet_identity_capacity()
        : 32) ||
    packets.length > budget.maxPackets ||
    packets.length > budget.maxOutputFrames
  )
    throw new FramePairError(
      "budget-exceeded",
      "GOP packet/output budget exceeded",
    );
  const byToken = new Map(
    packets.map((p) => [
      String(BigInt(p.au) + 1n),
      { packet: p, hash: hash(p.bytes) },
    ]),
  );
  if (byToken.size !== packets.length) fail("Invalid GOP input membership");
  const ctx = call("vp_create");
  if (!ctx)
    throw new FramePairError("decoder-error", "Cannot create identity decoder");
  let extra = 0,
    generation: string | undefined,
    sent = 0,
    previousPts = -Infinity;
  const outputs: PacketOutputIdentity["outputs"] = [],
    seen = new Set<number>();
  const proof: PacketOutputIdentity = { abi: 1, generation: "", outputs };
  const memory = () => {
    if (heap().byteLength > budget.maxHeapBytes)
      throw new FramePairError(
        "budget-exceeded",
        "Identity decoder heap budget exceeded",
      );
  };
  try {
    memory();
    extra = core._malloc(configuration.length);
    checkedHeap(
      heap(),
      extra,
      configuration.length,
      "identity configuration",
    ).set(configuration, extra);
    if (
      call(
        "vp_packet_open_identity",
        ["number", "string", "number", "number"],
        [ctx, codec, extra, configuration.length],
      ) !== 0
    )
      throw new FramePairError("decoder-error", "Cannot open identity decoder");
    core._free(extra);
    extra = 0;
    function* receive(
      phase: "immediate" | "drain",
    ): Generator<{ au: number; frame: DecodedPairFrame }, void> {
      for (;;) {
        const status = call(
          "vp_packet_receive",
          ["number", "i64"],
          [ctx, -9223372036854775808n],
        );
        memory();
        if (status < 0)
          fail(
            "GOP decoder rejected an unknown, duplicate, corrupt or unverified output identity",
          );
        if (status === 0) {
          if (call("vp_packet_identity_info", ["number"], [ctx]) !== 0)
            fail("Stale output identity after decoder exhaustion");
          return;
        }
        if (
          status !== 1 ||
          outputs.length >= packets.length ||
          outputs.length >= budget.maxOutputFrames
        )
          fail("Unexpected or excess GOP output");
        const ptr = call("vp_packet_identity_info", ["number"], [ctx]);
        checkedHeap(heap(), ptr, 64, "packet output identity");
        if (!ptr) fail("Missing packet-output identity");
        const id = new DataView(heap().buffer, ptr, 64);
        const token = String(id.getBigUint64(16, true)),
          member = byToken.get(token),
          epoch = String(id.getBigUint64(8, true));
        if (
          id.getUint32(0, true) !== 1 ||
          id.getUint32(4, true) !== 64 ||
          !member ||
          id.getUint32(60, true) !== 1
        )
          fail("Unknown packet-output ABI or token");
        const p = member.packet;
        if (
          seen.has(p.au) ||
          packets.findIndex((x) => x.au === p.au) >= sent ||
          id.getBigInt64(24, true) !== BigInt(p.pts) ||
          id.getBigInt64(32, true) !== BigInt(p.dts) ||
          id.getInt32(48, true) !== p.size ||
          id.getBigUint64(40, true).toString(16).padStart(16, "0") !==
            member.hash ||
          id.getInt32(52, true) !== 0 ||
          id.getUint32(56, true) & (1 | 8)
        )
          fail("GOP output does not match the exact admitted input packet");
        generation ??= epoch;
        proof.generation = generation;
        if (epoch !== generation) fail("GOP decoder epoch changed");
        const info = call("vp_frame_info", ["number"], [ctx]);
        checkedHeap(heap(), info, 160, "GOP frame descriptor");
        const frame = new DataView(heap().buffer, info, 160);
        const length = frame.getInt32(36, true),
          width = frame.getInt32(24, true),
          height = frame.getInt32(28, true),
          pts = Number(frame.getBigInt64(0, true));
        if (
          frame.getUint32(16, true) !== 2 ||
          frame.getUint32(20, true) !== 160
        )
          fail("GOP frame ABI changed");
        if (
          length < 1 ||
          length > budget.maxFrameBytes ||
          width < 1 ||
          height < 1 ||
          width * height > budget.maxPixels
        )
          throw new FramePairError(
            "budget-exceeded",
            "GOP output frame exceeds memory/pixel budget",
          );
        if (pts !== p.pts || pts <= previousPts)
          fail("GOP output clock differs from its identity or display order");
        previousPts = pts;
        seen.add(p.au);
        outputs.push({
          au: p.au,
          token,
          sourcePtsUs: p.pts,
          sourceDtsUs: p.dts,
          packetBytes: p.size,
          payloadHash: member.hash,
          decodeErrorFlags: 0,
          phase,
        });
        if (captureAu !== undefined && p.au !== captureAu) continue;
        const output = readWasmFrame(core, heap, ctx);
        yield {
          au: p.au,
          frame: {
            pts: output.pts,
            pixels: new Uint8Array(output.pixels),
            description: output.description,
            outputIdentity: proof,
          },
        };
      }
    }
    for (const p of packets) {
      const ptr = call(
        "vp_packet_alloc",
        ["number", "number"],
        [ctx, p.bytes.length],
      );
      checkedHeap(heap(), ptr, p.bytes.length, "identity AU").set(p.bytes, ptr);
      if (
        call(
          "vp_packet_send_identity",
          ["number", "i64", "i64", "number", "number", "i64"],
          [ctx, BigInt(p.pts), BigInt(p.dts), +p.key, 0, BigInt(p.au) + 1n],
        ) !== 0
      )
        throw new FramePairError(
          "decoder-error",
          "Cannot submit exact identity AU",
        );
      sent++;
      yield* receive("immediate");
    }
    if (
      call(
        "vp_packet_send_identity",
        ["number", "i64", "i64", "number", "number", "i64"],
        [ctx, 0n, 0n, 0, 1, 0n],
      ) !== 0
    )
      throw new FramePairError("decoder-error", "Cannot drain identity GOP");
    yield* receive("drain");
    if (seen.size !== packets.length) fail("Missing GOP output");
  } finally {
    if (extra) core._free(extra);
    call("vp_destroy", ["number"], [ctx], null);
  }
}

/** Single-picture API drains the complete window before returning its witness. */
export function decodeIdentityGop(
  core: any,
  heap: () => Uint8Array,
  codec: "h264" | "hevc",
  configuration: Uint8Array,
  packets: (PairPacket & { bytes: Uint8Array })[],
  targetAu: number,
  budget: PairBudget,
): DecodedPairFrame {
  let selected: DecodedPairFrame | undefined;
  for (const output of decodeIdentityGopFrames(
    core,
    heap,
    codec,
    configuration,
    packets,
    budget,
    targetAu,
  ))
    if (output.au === targetAu) selected = output.frame;
  if (!selected)
    throw new FramePairError(
      "identity-mismatch",
      "Missing exact selected target",
    );
  return selected;
}
