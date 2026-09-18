import { Mp4Engine } from './mp4-engine.ts';
import { FlvEngine } from './flv-engine.ts';
import type { PreparedFlv } from './flv-engine.ts';
import { MediaOpenError } from './media-errors.ts';
import type { FlvInput } from './flv-demux.ts';
import { createSourceQuerier } from './analysis/adapters.ts';

async function start() {
  // The production path uses the browser Worker; Node exercises this same
  // demux/decoder implementation with the real WASM binary.
  const parent = typeof process !== 'undefined' && process.versions?.node
    ? (await import('node:worker_threads')).parentPort : null;
  const send = (value: unknown, transfer: Transferable[] = []) => parent ? parent.postMessage(value, { transfer: transfer as ArrayBuffer[] }) : (globalThis as unknown as { postMessage(v: unknown, t: Transferable[]): void }).postMessage(value, transfer);
  let engine: FlvEngine | Mp4Engine | undefined;
  let chain = Promise.resolve();
  // 轴排序缓存：同一包表只付一次排序成本，hover/缩放只做区间二分与有界物化。
  // 首个大索引的同步排序仍会短暂占用本 worker 线程（与解码同线程），因此
  // 主线程只在视口需要时查询，且结果按像素宽度聚合，不逐帧全量索取。
  const querier = createSourceQuerier();
  const receive = (message: { id: number; type: string; input: FlvInput; prepared?: PreparedFlv; glueURL: string; wasmBinary?: Uint8Array; forceWasm?: boolean; container?: 'flv' | 'mp4'; threads?: number; position: number; pts:number; recycle?: ArrayBuffer;
    axis?: 'pts' | 'dts'; startUs?: number; endUs?: number; pixelWidth?: number; bitrateWindowUs?: number; maxSamples?: number; firstPtsUs?: number; durationUs?: number; coverageUs?: { start: number; end: number } | null; mediaId?: string }) => {
    if (message.type === 'complete-index' && engine instanceof FlvEngine) {
      const current = engine, id = message.id;
      // Incremental commits never await the extraction chain: an extract may
      // itself be waiting for the next index publication.
      chain = chain.then(() => {
      current.onIndexWaiting = waiting => send({ id, type: 'index-waiting', data: waiting });
      void current.completeIndex(progress => send({ id, type: 'progress', progress }), undefined, data => send({ id, type: 'index-progress', data }))
        .then(data => send({ id, ok: true, data }), error => send({ id, ok: false, error: error instanceof Error ? error.message : String(error), stack: workerStack(error), stage: error instanceof MediaOpenError ? error.stage : 'container' }));
      });
      return;
    }
    chain = chain.then(async () => {
      const { id, type } = message;
      try {
        if (type === 'prepare') {
          engine?.close(); engine = new FlvEngine(message.input);
          send({ id, ok: true, data: await engine.prepare(progress => send({ id, type: 'progress', progress })) });
        } else if (type === 'native' && engine instanceof FlvEngine) {
          const data = await engine.open('', undefined, false, 1, progress => send({ id, type: 'progress', progress }), true);
          send({ id, ok: true, data, diagnostics: engine.nativeDiagnostics });
        } else if (type === 'init') {
          if (!(engine instanceof FlvEngine && message.container === 'flv')) {
            engine?.close(); engine = message.container === 'mp4' ? new Mp4Engine(message.input) : new FlvEngine(message.input, message.prepared);
          }
          send({ id, ok: true, data: await engine.open(message.glueURL, message.wasmBinary, message.forceWasm, message.threads, progress => send({ id, type: 'progress', progress })) });
        } else if (type === 'dispose') {
          engine?.close(); engine = undefined; send({ id, ok: true, data: null });
        } else if (['extract','at','next'].includes(type) && engine) {          const result = type==='at'?await engine.at(message.pts,message.recycle):type==='next'?await engine.next(message.pts,message.recycle):await engine.extract(message.position, message.recycle);
          if(!result){send({id,ok:true,data:null});return;}
          if (engine instanceof FlvEngine) {
          const { index } = engine;
          let lo = 0, hi = index.order.length;
          while (lo < hi) { const mid = (lo + hi) >> 1; if (index.packets[index.order[mid]].pts <= result.pts) lo = mid + 1; else hi = mid; }
          result.durationUs = index.durations[Math.max(0, lo - 1)];
          }
          try { send({ id, ok: true, data: result }, result.frame ? [result.frame] : [result.pixels!]); }
          finally { result.frame?.close(); }
        } else if (type === 'analysis' && engine) {
          // 只读统计：复用当前 demux 包表，不启动第二套扫描、不转移底层缓冲。
          // 查询走同一串行 chain 保序，但只做区间二分与有界物化，不重算全片。
          const packets = engine instanceof FlvEngine ? engine.index?.packets : engine.analysisIndex?.packets;
          if (!packets?.length) throw new MediaOpenError('container', '索引尚未建立，暂无分析数据。');
          const complete = engine instanceof FlvEngine ? engine.indexComplete : true;
          const mediaId = message.mediaId ?? '';
          const data = querier(packets, {
            mediaId, sourceVersion: `${mediaId}@${packets.length}${complete ? '' : '+'}`, indexRevision: packets.length,
            firstPtsUs: message.firstPtsUs ?? 0, durationUs: message.durationUs ?? 0,
            capability: {
              hasSize: true, hasDts: true, keySource: 'container',
              pictureType: 'key-only', qp: 'unsupported',
              indexState: complete ? 'complete' : 'building',
            },
            coverageUs: message.coverageUs ?? null,
          }, {
            requestId: id, axis: message.axis ?? 'pts',
            startUs: message.startUs ?? 0, endUs: message.endUs ?? 0,
            pixelWidth: message.pixelWidth ?? 320, bitrateWindowUs: message.bitrateWindowUs ?? 1_000_000,
            maxSamples: message.maxSamples ?? 5000,
          });
          send({ id, ok: true, data });
        } else throw new MediaOpenError('input', '压缩包 worker 未初始化。');
      } catch (error) {
        send({ id, ok: false, error: error instanceof Error ? error.message : String(error), stack: workerStack(error), stage: error instanceof MediaOpenError ? error.stage : 'decode' });
      }
    });
  };
  if (parent) parent.on('message', receive);
  else globalThis.onmessage = e => receive(e.data);
}
void start();

function workerStack(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  return [error.stack, error.cause instanceof Error ? error.cause.stack : undefined].filter(Boolean).join('\nCaused by: ').slice(0, 16000);
}
