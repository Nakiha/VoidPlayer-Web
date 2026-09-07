import { readWasmFrame, requireFrameAbi } from './wasm-frame.ts';
import { sampleDescription } from './frame-description.ts';
import type { FrameDescription } from './frame-description.ts';
import { VideoSample } from 'mediabunny';
import { hevcGeometry, verifyHevcFrame } from './hevc-geometry.ts';
import { MediaOpenError } from './media-errors.ts';
import { flvDecoderConfig } from './flv-demux.ts';
import type { FlvIndex, FlvPacket } from './flv-demux.ts';
import type { MediaInfo } from './model.ts';
import { ffmpegColorInfo } from './media-metadata.ts';
import { preferredVideoConfig } from './decoder-policy.ts';
import { loadCore } from './wasm-core.ts';

export interface FlvFrame { description: FrameDescription; pts: number; width: number; height: number; frame?: VideoFrame; pixels?: ArrayBuffer; }
export interface PacketDecoder {
  kind: 'webcodecs' | 'ffmpeg-wasm';
  hardwareAcceleration?: MediaInfo['hardwareAcceleration'];
  metadata?(): Pick<MediaInfo, 'color' | 'colorSource' | 'pixelFormat'>;
  reconfigure?(index: Pick<FlvIndex, 'codec' | 'description'>): Promise<void>;
  reset(): void;
  send(bytes: Uint8Array, packet: FlvPacket): Promise<void>;
  receive(minimum: number, recycle?: ArrayBuffer): FlvFrame | null;
  drain(): Promise<void>;
  close(): void;
}

export async function nativeFlvDecoder(index: FlvIndex): Promise<PacketDecoder | null> {
  const parsed = flvDecoderConfig(index);
  if (!parsed || typeof VideoDecoder === 'undefined') return null;
  let config = await preferredVideoConfig({ ...parsed, optimizeForLatency: true });
  if (!config) return null;
  let geometry = index.codec === 'hevc' ? hevcGeometry(index.description) : null;
  let currentIndex: Pick<FlvIndex, 'codec' | 'description'> = index;
  const frames: VideoFrame[] = [];
  let error: Error | null = null, outstanding = 0, minimum = -Infinity;
  let notify: (() => void) | undefined;
  const decoder = new VideoDecoder({
    output(frame) {
      outstanding--;
      try { if (geometry) frame = verifyHevcFrame(frame, geometry); }
      catch (e) { frame.close(); error = packetDecodeError(e, '浏览器输出校验'); notify?.(); return; }
      if (frame.timestamp < minimum) frame.close();
      else frames.push(frame);
      if (frames.length > 32 || frames.reduce((n, f) => n + f.displayWidth * f.displayHeight * 4, 0) > 128 * 1024 * 1024) {
        error = new MediaOpenError('resource', 'FLV 解码输出超过队列内存上限。');
        frames.splice(0).forEach(f => f.close());
      }
      notify?.();
    },
    error(e) { error = e; notify?.(); },
  });
  try { decoder.configure(config); } catch (error) { decoder.close(); throw error; }
  const check = () => { if (error) throw packetDecodeError(error, `浏览器 ${index.codec} 解码器`); };
  return {
    kind: 'webcodecs',
    hardwareAcceleration: config.hardwareAcceleration,
    async reconfigure(next) {
      const parsed = flvDecoderConfig(next);
      const nextConfig = parsed && await preferredVideoConfig({ ...parsed, optimizeForLatency: true });
      if (!nextConfig) throw new MediaOpenError('decode', `浏览器不支持切换后的 ${next.codec} 视频配置。`);
      frames.splice(0).forEach(f => f.close()); decoder.reset(); decoder.configure(nextConfig);
      config = nextConfig; currentIndex = next; geometry = next.codec === 'hevc' ? hevcGeometry(next.description) : null; outstanding = 0; error = null; minimum = -Infinity;
    },
    reset() { frames.splice(0).forEach(f => f.close()); decoder.reset(); decoder.configure(config!); outstanding = 0; error = null; minimum = -Infinity; },
    async send(bytes, packet) {
      check();
      // WebCodecs AV1 has no description field. Include sequence-header OBUs
      // held only in av1C when starting from any keyframe.
      if (currentIndex.codec === 'av1' && packet.key && currentIndex.description.length > 4) {
        const combined = new Uint8Array(currentIndex.description.length - 4 + bytes.length);
        combined.set(currentIndex.description.subarray(4)); combined.set(bytes, currentIndex.description.length - 4);
        bytes = combined;
      }
      decoder.decode(new EncodedVideoChunk({ type: packet.key ? 'key' : 'delta', timestamp: packet.pts, data: bytes as Uint8Array<ArrayBuffer> }));
      outstanding++;
      // Give hardware output a chance to run without accumulating an entire GOP.
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      if (outstanding >= 8) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => { notify = undefined; reject(new MediaOpenError('decode', 'FLV 解码输出超时。')); }, 5000);
          notify = () => { clearTimeout(timer); notify = undefined; resolve(); };
        });
      }
      check();
    },
    receive(target) {
      minimum = target; check();
      frames.sort((a, b) => a.timestamp - b.timestamp);
      while (frames.length && frames[0].timestamp < target) frames.shift()!.close();
      const frame = frames.shift();
      if (!frame) return null;
      const sample=new VideoSample(frame.clone());
      try {return {pts:frame.timestamp,width:frame.displayWidth,height:frame.displayHeight,frame,description:sampleDescription(sample,frame.allocationSize())};}
      finally {sample.close();}
    },
    async drain() { await decoder.flush(); check(); },
    close() { frames.splice(0).forEach(f => f.close()); if (decoder.state !== 'closed') decoder.close(); },
  };
}

// Emscripten's generated module has a dynamically named C API.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function wasmFlvDecoder(index: Pick<FlvIndex, 'codec' | 'description'>, glueURL: string, wasmBinary?: Uint8Array, threads = 1): Promise<PacketDecoder> {
  const { core, heap } = await loadCore(glueURL, wasmBinary);
  requireFrameAbi(core);
  if (typeof core._vp_packet_open !== 'function') throw new MediaOpenError('decode', 'WASM core 版本过旧，请同步带 FLV 压缩包接口的产物。');
  const call = (name: string, types: string[], args: unknown[], result: string | null = 'number') => core.ccall(name, result, types, args);
  call('vp_set_threads', ['number'], [threads], null);
  const ctx = call('vp_create', [], []);
  if (!ctx) throw new MediaOpenError('resource', '无法创建 FLV 解码上下文。');
  const configure = (next: Pick<FlvIndex, 'codec' | 'description'>) => {
    const description = next.codec === 'av1' ? next.description.subarray(4) : next.description;
    const extra = core._malloc(Math.max(1, description.length));
    try {
      if (!extra) throw new MediaOpenError('resource', '无法分配 FLV 配置头内存。');
      checkedHeap(heap(), extra, description.length, '写入配置头').set(description, extra);
      if (call('vp_packet_open', ['number', 'string', 'number', 'number'], [ctx, next.codec, extra, description.length]) !== 0) throw new MediaOpenError('decode', `WASM 无法初始化 ${next.codec} 解码器。`);
    } finally { core._free(extra); }
  };
  try { configure(index); } catch (error) { call('vp_destroy', ['number'], [ctx], null); throw error; }
  return {
    kind: 'ffmpeg-wasm',
    async reconfigure(next) { configure(next); },
    metadata() {
      return { colorSource: 'decoder', pixelFormat: typeof core._vp_pixel_format === 'function' ? call('vp_pixel_format', ['number'], [ctx], 'string') || null : null,
        color: ffmpegColorInfo({ colorPrimaries: call('vp_color_primaries', ['number'], [ctx]), colorTransfer: call('vp_color_transfer', ['number'], [ctx]),
          colorSpace: call('vp_color_space', ['number'], [ctx]), colorRange: call('vp_color_range', ['number'], [ctx]) }) };
    },
    reset() { call('vp_packet_reset', ['number'], [ctx], null); },
    async send(bytes, packet) {
      const ptr = call('vp_packet_alloc', ['number', 'number'], [ctx, bytes.length]);
      if (!ptr) throw new MediaOpenError('resource', '无法分配 FLV 压缩包内存。');
      checkedHeap(heap(), ptr, bytes.length, '写入压缩视频包').set(bytes, ptr);
      if (call('vp_packet_send', ['number', 'i64', 'i64', 'number', 'number'], [ctx, BigInt(packet.pts), BigInt(packet.dts), +packet.key, 0]) !== 0) throw new MediaOpenError('decode', 'WASM 拒绝 FLV 视频包。');
    },
    receive(minimum, recycle) {
      const status = call('vp_packet_receive', ['number', 'i64'], [ctx, BigInt(minimum)]);
      if (status < 0) throw new MediaOpenError('decode', 'WASM 无法解码 FLV 视频包。');
      if (!status) return null;
      const output=readWasmFrame(core,heap,ctx,recycle);
      return {...output,width:output.description.width,height:output.description.height};
    },
    async drain() {
      if (call('vp_packet_send', ['number', 'i64', 'i64', 'number', 'number'], [ctx, 0n, 0n, 0, 1]) !== 0) throw new MediaOpenError('decode', 'FLV 解码器无法完成尾帧输出。');
    },
    close() { call('vp_destroy', ['number'], [ctx], null); },
  };
}

/** Validate external core pointers before TypedArray silently clips or throws. */
export function checkedHeap(heap: Uint8Array, ptr: number, size: number, operation: string): Uint8Array {
  if (!Number.isSafeInteger(ptr) || ptr <= 0 || !Number.isSafeInteger(size) || size < 0 || ptr + size > heap.byteLength) {
    throw new MediaOpenError('decode', `WASM ${operation}时内存范围无效（offset=${ptr}, bytes=${size}, heap=${heap.byteLength}），请重新载入片源。`);
  }
  return heap;
}

export function packetDecodeError(error: unknown, context: string): MediaOpenError {
  const result = new MediaOpenError(error instanceof MediaOpenError ? error.stage : 'decode', `${context}失败：${error instanceof Error ? error.message : String(error)}`);
  result.cause = error;
  return result;
}
