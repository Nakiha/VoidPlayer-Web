import { loadFFmpegCore } from './ffmpeg-core.ts';
import type { FFmpegCore } from './ffmpeg-core.ts';
import type { DecodedFrame, MediaSource } from './media.ts';
import type { MediaInfo } from './model.ts';

// FFmpeg-WASM fallback media source for tracks mediabunny/WebCodecs cannot
// demux or decode (FFV1, MPEG-2 TS, H.266/VVC, ...). Uses the self-built
// trimmed core's vp_* API: a demux-only frame index, then exact-PTS frame
// extraction with decoder-state continuation, so sequential stepping decodes
// each frame once and backward/random steps pay at most a GOP re-decode.

const MAX_FALLBACK_FILE_BYTES = 512 * 1024 * 1024;

export interface WasmDecodedFrame extends DecodedFrame {
  pixels: Uint8ClampedArray;
}

// Greatest index whose time is at most ptsUs (0 when none), and the first
// index strictly after ptsUs (-1 when none). Pure binary-search helpers for
// the session's frameAt/framesAfter contract.
export function floorIndex(timesUs: number[], ptsUs: number): number {
  let lo = 0, hi = timesUs.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (timesUs[mid] <= ptsUs) lo = mid + 1; else hi = mid;
  }
  return Math.max(0, lo - 1);
}
export function nextIndex(timesUs: number[], ptsUs: number): number {
  let lo = 0, hi = timesUs.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (timesUs[mid] > ptsUs) hi = mid; else lo = mid + 1;
  }
  return lo < timesUs.length ? lo : -1;
}

export async function openFFmpegMedia(file: File, loadCore: () => Promise<FFmpegCore> = () => loadFFmpegCore()): Promise<MediaSource> {
  if (file.size > MAX_FALLBACK_FILE_BYTES) {
    throw new Error(`文件超过 WASM 回退解码的 ${MAX_FALLBACK_FILE_BYTES / 1024 / 1024} MiB 内存上限。`);
  }
  const core = await loadCore();
  const ctx = core.ccall('vp_create', 'number', [], []) as number;
  if (!ctx) throw new Error('无法创建 WASM 解码上下文。');
  const inputPath = `/vp-in-${crypto.randomUUID()}`;

  const call = (name: string, returnType: string | null, argTypes: string[], args: unknown[]) =>
    core.ccall(name, returnType, ['number', ...argTypes], [ctx, ...args]);

  let disposed = false;
  const cleanup = () => {
    try { core.FS.unlink(inputPath); } catch { /* already gone */ }
    core.ccall('vp_destroy', null, ['number'], [ctx]);
  };

  let ticks: number[];
  let info: MediaInfo;
  let frameBytes: number;
  let relUs: number[];
  let durations: number[];
  let ticksToUs: (t: number) => number;
  try {
    core.FS.writeFile(inputPath, new Uint8Array(await file.arrayBuffer()));
    if (call('vp_open', 'number', ['string'], [inputPath]) !== 0) {
      throw new Error('FFmpeg WASM 也无法读取该文件的视频轨道。');
    }
    const count = call('vp_index_build', 'number', [], []) as number;
    if (count <= 0) throw new Error('FFmpeg WASM 无法建立该文件的帧索引。');
    ticks = new Array<number>(count);
    durations = new Array<number>(count);
    for (let i = 0; i < count; i++) ticks[i] = Number(call('vp_index_ticks', 'i64', ['number'], [i]));
    const tbNum = call('vp_tb_num', 'number', [], []) as number;
    const tbDen = call('vp_tb_den', 'number', [], []) as number;
    if (!tbNum || !tbDen) throw new Error('WASM 解码器未提供有效的时间基准。');
    ticksToUs = t => Math.round(t * 1e6 * tbNum / tbDen);
    const firstUs = ticksToUs(ticks[0]);
    relUs = ticks.map(t => ticksToUs(t) - firstUs);
    for (let i = 0; i < count; i++) {
      const declared = ticksToUs(Number(call('vp_index_duration', 'i64', ['number'], [i])));
      durations[i] = declared > 0 ? declared : (i + 1 < count ? relUs[i + 1] - relUs[i] : (i > 0 ? relUs[i] - relUs[i - 1] : 0));
    }
    const width = call('vp_width', 'number', [], []) as number;
    const height = call('vp_height', 'number', [], []) as number;
    frameBytes = width * height * 4;
    info = {
      id: crypto.randomUUID(), name: file.name, size: file.size, lastModified: file.lastModified,
      codec: call('vp_codec_name', 'string', [], []) as string, decoder: 'ffmpeg-wasm',
      width, height, firstPtsUs: firstUs, durationUs: relUs[count - 1] + durations[count - 1],
    };
  } catch (error) {
    cleanup();
    throw error;
  }

  const extract = (index: number): WasmDecodedFrame => {
    if (disposed) throw new Error('媒体已释放。');
    const target = BigInt(ticks[index]);
    const result = call('vp_extract', 'number', ['i64'], [target]) as number;
    // vp_extract must land exactly on the indexed pts; anything else means the
    // container lied about its timestamps, which we refuse to guess around.
    if (result !== 1 || Number(call('vp_last_ticks', 'i64', [], [])) !== ticks[index]) {
      throw new Error(`WASM 解码未能命中索引帧 ${index}（结果 ${result}）。`);
    }
    const pixelsPtr = call('vp_pixels', 'number', [], []) as number;
    // Copy out of the WASM heap: ALLOW_MEMORY_GROWTH can reallocate it.
    const pixels = new Uint8ClampedArray(frameBytes);
    pixels.set(core.HEAPU8.subarray(pixelsPtr, pixelsPtr + frameBytes));
    return {
      pixels,
      ptsUs: relUs[index],
      sourcePtsUs: ticksToUs(ticks[index]),
      durationUs: durations[index],
      draw(canvas) {
        if (canvas.width !== info.width) canvas.width = info.width;
        if (canvas.height !== info.height) canvas.height = info.height;
        const ctx2d = canvas.getContext('2d');
        if (!ctx2d) throw new Error('浏览器无法创建画布。');
        ctx2d.putImageData(new ImageData(pixels, info.width, info.height), 0, 0);
      },
      // The pixel copy is plain JS memory; nothing to release.
      close() {},
    };
  };

  return {
    info,
    async frameAt(ptsUs) {
      return extract(floorIndex(relUs, ptsUs));
    },
    async framesAfter(ptsUs, count) {
      const start = nextIndex(relUs, ptsUs);
      if (start < 0) return [];
      const frames: WasmDecodedFrame[] = [];
      for (let i = start; i < Math.min(start + count, ticks.length); i++) frames.push(extract(i));
      return frames;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      cleanup();
    },
  };
}
