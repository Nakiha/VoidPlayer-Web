import { WasmMemoryBudgetError } from '../../wasm/core.ts';
import { readWasmFrame, requireFrameAbi } from '../../wasm/frame.ts';
import { checkedHeap } from '../../wasm/heap.ts';
import { FramePairError, PAIR_LIMITS } from './frame-pair.ts';
import type { PairDecoder, PairBudget, DecodedPairFrame } from './frame-pair.ts';

/** One single-thread core, one isolated packet context at a time. No playback engine. */
export async function createPairDecoder(load: () => Promise<{ core: any; heap: () => Uint8Array }>): Promise<PairDecoder> {
  let loaded;
  try { loaded = await load(); }
  catch (error) { if (error instanceof WasmMemoryBudgetError) throw new FramePairError('budget-exceeded', error.message); throw error; }
  const { core, heap } = loaded;
  requireFrameAbi(core);
  const call = (name: string, types: string[], args: unknown[], result: string | null = 'number') => core.ccall(name, result, types, args);
  if (typeof core._vp_core_build_id !== 'function' || typeof core._vp_packet_open !== 'function') throw new FramePairError('decoder-error', 'Packet/build ABI unavailable');
  const buildId = call('vp_core_build_id', [], [], 'string');
  if (!/^[a-f0-9]{40}$/.test(buildId)) throw new FramePairError('decoder-error', 'Invalid decoder build ID');
  let closed = false;
  const memory = (budget: PairBudget) => {
    if (heap().byteLength > budget.maxHeapBytes) throw new FramePairError('budget-exceeded', 'WASM heap budget exceeded');
  };
  memory(PAIR_LIMITS);
  call('vp_set_threads', ['number'], [1], null);
  return {
    version: { backend: 'ffmpeg-wasm', buildId, frameAbi: 2, packetIdentity: 'isolated-closed-au-v1' },
    async decode(codec, configuration, bytes, pts, dts, budget) {
      try {
        if (closed) throw new FramePairError('decoder-error', 'Pair decoder closed');
        memory(budget);
        const ctx = call('vp_create', [], []);
        if (!ctx) throw new FramePairError('decoder-error', 'Cannot create packet context');
        let extra = 0;
        try {
          extra = core._malloc(configuration.length);
          checkedHeap(heap(), extra, configuration.length, 'quality configuration').set(configuration, extra);
          if (call('vp_packet_open', ['number', 'string', 'number', 'number'], [ctx, codec, extra, configuration.length]) !== 0)
            throw new FramePairError('decoder-error', 'Cannot open packet decoder');
          core._free(extra); extra = 0; memory(budget);
          const ptr = call('vp_packet_alloc', ['number', 'number'], [ctx, bytes.length]);
          checkedHeap(heap(), ptr, bytes.length, 'quality packet').set(bytes, ptr);
          if (call('vp_packet_send', ['number', 'i64', 'i64', 'number', 'number'], [ctx, BigInt(pts), BigInt(dts), 1, 0]) !== 0)
            throw new FramePairError('decoder-error', 'Cannot send closed AU');
          memory(budget);
          let frame: DecodedPairFrame | undefined;
          const receive = () => {
            for (;;) {
              const status = call('vp_packet_receive', ['number', 'i64'], [ctx, -9223372036854775808n]);
              memory(budget);
              if (status < 0) throw new FramePairError('decoder-error', 'Packet decoding failed');
              if (!status) return;
              if (frame) throw new FramePairError('identity-mismatch', 'One AU emitted multiple pictures');
              // Check descriptor/storage before readWasmFrame allocates its pixel copy.
              const info = call('vp_frame_info', ['number'], [ctx]);
              checkedHeap(heap(), info, 160, 'quality frame descriptor');
              const view = new DataView(heap().buffer, info, 160), length = view.getInt32(36, true);
              const width = view.getInt32(24, true), height = view.getInt32(28, true);
              if (length < 1 || length > budget.maxFrameBytes || width < 1 || height < 1 || width * height > budget.maxPixels)
                throw new FramePairError('budget-exceeded', 'Output frame allocation exceeds budget');
              const output = readWasmFrame(core, heap, ctx);
              frame = { pts: output.pts, pixels: new Uint8Array(output.pixels), description: output.description };
            }
          };
          receive();
          if (call('vp_packet_send', ['number', 'i64', 'i64', 'number', 'number'], [ctx, 0n, 0n, 0, 1]) !== 0)
            throw new FramePairError('decoder-error', 'Cannot drain isolated AU');
          receive();
          if (!frame) throw new FramePairError('identity-mismatch', 'Closed AU emitted no picture');
          return frame;
        } finally { if (extra) core._free(extra); call('vp_destroy', ['number'], [ctx], null); }
      } catch(error) {
        if(error instanceof WasmMemoryBudgetError)throw new FramePairError('budget-exceeded',error.message);
        throw error;
      }
    },
    close() { closed = true; },
  };
}
