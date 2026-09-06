import { MediaOpenError } from './media-errors.ts';
import { flvDecoderConfig } from './flv-demux.ts';
import type { FlvIndex, FlvPacket } from './flv-demux.ts';
import type { MediaInfo } from './model.ts';
import { ffmpegColorInfo } from './media-metadata.ts';

export interface FlvFrame { pts: number; width: number; height: number; frame?: VideoFrame; pixels?: ArrayBuffer; }
export interface PacketDecoder {
  kind: 'webcodecs' | 'ffmpeg-wasm';
  metadata?(): Pick<MediaInfo, 'color' | 'colorSource' | 'pixelFormat'>;
  reset(): void;
  send(bytes: Uint8Array, packet: FlvPacket): Promise<void>;
  receive(minimum: number, recycle?: ArrayBuffer): FlvFrame | null;
  drain(): Promise<void>;
  close(): void;
}

export async function nativeFlvDecoder(index: FlvIndex): Promise<PacketDecoder | null> {
  const parsed = flvDecoderConfig(index);
  const config = parsed ? { ...parsed, optimizeForLatency: true } : null;
  if (!config || typeof VideoDecoder === 'undefined') return null;
  if (!(await VideoDecoder.isConfigSupported(config)).supported) return null;
  const frames: VideoFrame[] = [];
  let error: Error | null = null, outstanding = 0, minimum = -Infinity;
  let notify: (() => void) | undefined;
  const decoder = new VideoDecoder({
    output(frame) {
      outstanding--;
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
  const check = () => { if (error) throw new MediaOpenError(error instanceof MediaOpenError ? error.stage : 'decode', error.message); };
  return {
    kind: 'webcodecs',
    reset() { frames.splice(0).forEach(f => f.close()); decoder.reset(); decoder.configure(config); outstanding = 0; error = null; minimum = -Infinity; },
    async send(bytes, packet) {
      check();
      // WebCodecs AV1 has no description field. Include sequence-header OBUs
      // held only in av1C when starting from any keyframe.
      if (index.codec === 'av1' && packet.key && index.description.length > 4) {
        const combined = new Uint8Array(index.description.length - 4 + bytes.length);
        combined.set(index.description.subarray(4)); combined.set(bytes, index.description.length - 4);
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
      return frame ? { pts: frame.timestamp, width: frame.displayWidth, height: frame.displayHeight, frame } : null;
    },
    async drain() { await decoder.flush(); check(); },
    close() { frames.splice(0).forEach(f => f.close()); if (decoder.state !== 'closed') decoder.close(); },
  };
}

// Emscripten's generated module has a dynamically named C API.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function wasmFlvDecoder(index: FlvIndex, glueURL: string, wasmBinary?: Uint8Array, threads = 1): Promise<PacketDecoder> {
  const mod = await import(/* @vite-ignore */ glueURL);
  const core = await mod.default(wasmBinary ? { wasmBinary } : {});
  if (typeof core._vp_packet_open !== 'function') throw new MediaOpenError('decode', 'WASM core 版本过旧，请同步带 FLV 压缩包接口的产物。');
  const call = (name: string, types: string[], args: unknown[], result: string | null = 'number') => core.ccall(name, result, types, args);
  call('vp_set_threads', ['number'], [threads], null);
  const ctx = call('vp_create', [], []);
  if (!ctx) throw new MediaOpenError('resource', '无法创建 FLV 解码上下文。');
  // dav1d consumes config OBUs, not the four-byte AV1CodecConfigurationRecord.
  const description = index.codec === 'av1' ? index.description.subarray(4) : index.description;
  const extra = core._malloc(Math.max(1, description.length));
  try {
    if (!extra) throw new MediaOpenError('resource', '无法分配 FLV 配置头内存。');
    core.HEAPU8.set(description, extra);
    if (call('vp_packet_open', ['number', 'string', 'number', 'number'], [ctx, index.codec, extra, description.length]) !== 0) throw new MediaOpenError('decode', `WASM 无法初始化 ${index.codec} 解码器。`);
  } catch (error) { call('vp_destroy', ['number'], [ctx], null); throw error; }
  finally { core._free(extra); }
  return {
    kind: 'ffmpeg-wasm',
    metadata() {
      return { colorSource: 'decoder', pixelFormat: typeof core._vp_pixel_format === 'function' ? call('vp_pixel_format', ['number'], [ctx], 'string') || null : null,
        color: ffmpegColorInfo({ colorPrimaries: call('vp_color_primaries', ['number'], [ctx]), colorTransfer: call('vp_color_transfer', ['number'], [ctx]),
          colorSpace: call('vp_color_space', ['number'], [ctx]), colorRange: call('vp_color_range', ['number'], [ctx]) }) };
    },
    reset() { call('vp_packet_reset', ['number'], [ctx], null); },
    async send(bytes, packet) {
      const ptr = call('vp_packet_alloc', ['number', 'number'], [ctx, bytes.length]);
      if (!ptr) throw new MediaOpenError('resource', '无法分配 FLV 压缩包内存。');
      core.HEAPU8.set(bytes, ptr);
      if (call('vp_packet_send', ['number', 'i64', 'i64', 'number', 'number'], [ctx, BigInt(packet.pts), BigInt(packet.dts), +packet.key, 0]) !== 0) throw new MediaOpenError('decode', 'WASM 拒绝 FLV 视频包。');
    },
    receive(minimum, recycle) {
      const status = call('vp_packet_receive', ['number', 'i64'], [ctx, BigInt(minimum)]);
      if (status < 0) throw new MediaOpenError('decode', 'WASM 无法解码 FLV 视频包。');
      if (!status) return null;
      const width = call('vp_width', ['number'], [ctx]), height = call('vp_height', ['number'], [ctx]);
      const ptr = call('vp_pixels', ['number'], [ctx]), size = width * height * 4;
      const out = recycle?.byteLength === size ? new Uint8Array(recycle) : new Uint8Array(size);
      out.set(core.HEAPU8.subarray(ptr, ptr + size));
      return { pts: Number(call('vp_last_ticks', ['number'], [ctx], 'i64')), width, height, pixels: out.buffer };
    },
    async drain() {
      if (call('vp_packet_send', ['number', 'i64', 'i64', 'number', 'number'], [ctx, 0n, 0n, 0, 1]) !== 0) throw new MediaOpenError('decode', 'FLV 解码器无法完成尾帧输出。');
    },
    close() { call('vp_destroy', ['number'], [ctx], null); },
  };
}
