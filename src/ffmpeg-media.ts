import { loadFFmpegCore } from './ffmpeg-core.ts';
import type { FFmpegCore } from './ffmpeg-core.ts';
import type { DecodedFrame, MediaSource } from './media.ts';
import type { MediaInfo } from './model.ts';

// FFmpeg-WASM fallback media source for tracks mediabunny/WebCodecs cannot
// demux or decode (e.g. FFV1, MPEG-2 TS). Frames are indexed by a one-time
// full-decode `showinfo` pass and extracted on demand as RGBA rows through a
// `select=gte(pts,N)` filter, which keeps original timestamps under -copyts and
// avoids every -ss timestamp-domain pitfall. Seeking input is only trusted for
// all-intra tracks (exact landing); inter-frame tracks decode from the start,
// so random access on them is O(position) and slow.

export interface WasmFrameIndex {
  codec: string;
  width: number;
  height: number;
  /** Stream timebase: ticks per second. */
  tbn: number;
  /** Frame start timestamps in timebase ticks, ascending, original domain. */
  ticks: number[];
  /** Per-frame keyframe flags from the index pass. */
  keyframes: boolean[];
}

const SHOWINFO_RE = /\[Parsed_showinfo_\d+ @ [^\]]+\] n:\s*\d+\s+pts:\s*(-?\d+)\s+pts_time:\S+.*\bs:(\d+)x(\d+)\b.*\biskey:(\d)/;
const STREAM_RE = /Stream #\S+?:\s*Video:\s*([a-z0-9_]+)/i;
const TBN_RE = /(\d+)(k?)\s+tbn\b/;

export function parseShowinfoIndex(logs: string[]): WasmFrameIndex | null {
  let codec: string | null = null;
  let tbn: number | null = null;
  let width = 0;
  let height = 0;
  const ticks: number[] = [];
  const keyframes: boolean[] = [];
  for (const line of logs) {
    if (codec == null) {
      const stream = STREAM_RE.exec(line);
      if (stream) {
        codec = stream[1];
        const base = TBN_RE.exec(line);
        tbn = base ? Number(base[1]) * (base[2] === 'k' ? 1000 : 1) : null;
      }
    }
    const frame = SHOWINFO_RE.exec(line);
    if (frame) {
      ticks.push(Number(frame[1]));
      if (!width) { width = Number(frame[2]); height = Number(frame[3]); }
      keyframes.push(frame[4] === '1');
    }
  }
  if (codec == null || tbn == null || !ticks.length || !width) return null;
  return { codec, width, height, tbn, ticks, keyframes };
}

// -copyts keeps original timestamps; select=gte(pts,N) filters by exact
// timebase ticks, so the produced frames must match the index exactly.
export function buildExtractArgs(input: string, output: string, targetTicks: number, count: number, seekSeconds: number | null): string[] {
  const args = ['-hide_banner', '-copyts'];
  if (seekSeconds != null) args.push('-ss', seekSeconds.toFixed(6));
  args.push('-i', input, '-map', '0:v:0', '-vf', `select=gte(pts\\,${targetTicks}),showinfo`, '-frames:v', String(count), '-f', 'rawvideo', '-pix_fmt', 'rgba', output);
  return args;
}

// The produced frames must be exactly index.ticks[from..from+produced-1];
// anything else means the (untrusted) input seek landed mid-stream and the
// caller must retry without seeking.
export function extractionMatchesIndex(producedTicks: number[], indexTicks: number[], from: number, count: number): boolean {
  if (producedTicks.length < count || from + count > indexTicks.length) return false;
  for (let k = 0; k < count; k++) if (producedTicks[k] !== indexTicks[from + k]) return false;
  return true;
}

const MAX_FALLBACK_FILE_BYTES = 512 * 1024 * 1024;
const WINDOW_BYTE_BUDGET = 64 * 1024 * 1024;

interface WasmDecodedFrame extends DecodedFrame {
  pixels: Uint8ClampedArray;
}

export async function openFFmpegMedia(file: File, loadCore: () => Promise<FFmpegCore> = () => loadFFmpegCore()): Promise<MediaSource> {
  if (file.size > MAX_FALLBACK_FILE_BYTES) {
    throw new Error(`文件超过 WASM 回退解码的 ${MAX_FALLBACK_FILE_BYTES / 1024 / 1024} MiB 内存上限。`);
  }
  const core = await loadCore();
  const inputPath = `/vp-in-${crypto.randomUUID()}`;
  const outputPath = `/vp-out-${crypto.randomUUID()}.raw`;

  const execCapture = (args: string[]): string[] => {
    const logs: string[] = [];
    core.setLogger(({ message }) => logs.push(message));
    core.exec(...args);
    if (core.ret !== 0) {
      const tail = logs.slice(-3).join(' ').trim();
      throw new Error(`FFmpeg 执行失败（${core.ret}）${tail ? `：${tail}` : '。'}`);
    }
    return logs;
  };

  let disposed = false;
  let index: WasmFrameIndex;
  try {
    core.FS.writeFile(inputPath, new Uint8Array(await file.arrayBuffer()));
    const logs = execCapture(['-hide_banner', '-copyts', '-i', inputPath, '-map', '0:v:0', '-vf', 'showinfo', '-f', 'null', '-']);
    const parsed = parseShowinfoIndex(logs);
    if (!parsed) throw new Error('FFmpeg WASM 也无法读取该文件的视频轨道。');
    index = parsed;
  } catch (error) {
    try { core.FS.unlink(inputPath); } catch { /* best effort */ }
    throw error;
  }

  const total = index.ticks.length;
  const frameBytes = index.width * index.height * 4;
  const ticksToUs = (ticks: number) => Math.round(ticks * 1e6 / index.tbn);
  const firstUs = ticksToUs(index.ticks[0]);
  const relUs = index.ticks.map(t => ticksToUs(t) - firstUs);
  const durationOf = (k: number) => k + 1 < total ? relUs[k + 1] - relUs[k] : (k > 0 ? relUs[k] - relUs[k - 1] : 0);
  const durationUs = relUs[total - 1] + durationOf(total - 1);
  const allIntra = index.keyframes.every(Boolean);
  const windowSize = Math.max(2, Math.min(32, Math.floor(WINDOW_BYTE_BUDGET / frameBytes)));
  let window: { start: number; frames: WasmDecodedFrame[] } | null = null;

  const extract = (from: number, count: number): WasmDecodedFrame[] => {
    const wanted = Math.min(count, total - from);
    const run = (seekSeconds: number | null) => {
      const logs = execCapture(buildExtractArgs(inputPath, outputPath, index.ticks[from], wanted, seekSeconds));
      const producedTicks = logs.map(l => SHOWINFO_RE.exec(l)).filter(m => m != null).map(m => Number(m[1]));
      const raw = core.FS.readFile(outputPath);
      core.FS.unlink(outputPath);
      const written = Math.floor(raw.length / frameBytes);
      if (!extractionMatchesIndex(producedTicks, index.ticks, from, written)) return null;
      return { raw, written };
    };
    // Fast path: input seeking is frame-exact only for all-intra tracks. Any
    // mismatch (imprecise demuxer seek, mid-GOP landing) retries from the start.
    let result = null;
    if (allIntra && from > 0) {
      try { result = run((index.ticks[from - 1] + index.ticks[from]) / 2 / index.tbn); }
      catch { result = null; }
    }
    result ??= run(null);
    if (!result) throw new Error('WASM 解码结果与帧索引不一致。');
    const frames: WasmDecodedFrame[] = [];
    for (let k = 0; k < result.written; k++) {
      const pixels = new Uint8ClampedArray(result.raw.buffer as ArrayBuffer, result.raw.byteOffset + k * frameBytes, frameBytes);
      const frameIndex = from + k;
      frames.push({
        pixels,
        ptsUs: relUs[frameIndex],
        sourcePtsUs: ticksToUs(index.ticks[frameIndex]),
        durationUs: durationOf(frameIndex),
        draw(canvas) {
          if (canvas.width !== index.width) canvas.width = index.width;
          if (canvas.height !== index.height) canvas.height = index.height;
          const ctx = canvas.getContext('2d');
          if (!ctx) throw new Error('浏览器无法创建画布。');
          ctx.putImageData(new ImageData(pixels, index.width, index.height), 0, 0);
        },
        // Pixels are plain JS memory shared with the lookahead window; the
        // session's per-draw close() must not invalidate cached frames.
        close() {},
      });
    }
    return frames;
  };

  const framesAt = (from: number, count: number): DecodedFrame[] => {
    if (disposed) throw new Error('媒体已释放。');
    if (window && from >= window.start && from + count <= window.start + window.frames.length) {
      return window.frames.slice(from - window.start, from - window.start + count);
    }
    const frames = extract(from, Math.max(count, windowSize));
    window = { start: from, frames };
    return frames.slice(0, count);
  };

  const info: MediaInfo = {
    id: crypto.randomUUID(), name: file.name, size: file.size, lastModified: file.lastModified,
    codec: index.codec, decoder: 'ffmpeg-wasm', width: index.width, height: index.height,
    firstPtsUs: firstUs, durationUs,
  };
  return {
    info,
    async frameAt(ptsUs) {
      // Floor semantics, matching the WebCodecs path.
      let idx = 0;
      for (let k = 0; k < total; k++) { if (relUs[k] <= ptsUs) idx = k; else break; }
      const frame = framesAt(idx, 1)[0];
      if (!frame) throw new Error(`时间 ${ptsUs} µs 没有可解码的画面。`);
      return frame;
    },
    async framesAfter(ptsUs, count) {
      let idx = -1;
      for (let k = 0; k < total; k++) if (relUs[k] > ptsUs) { idx = k; break; }
      if (idx < 0) return [];
      return framesAt(idx, Math.min(count, total - idx));
    },
    dispose() {
      disposed = true;
      window = null;
      try { core.FS.unlink(inputPath); } catch { /* already gone */ }
    },
  };
}
