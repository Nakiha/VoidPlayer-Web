import { createSourceQuerier, locateSampleById } from './adapters.ts';
import type { PacketView } from './adapters.ts';
import type { NativeAnalysisRequest, NativeAnalysisReply } from './native-protocol.ts';

async function start() {
  const parent = typeof process !== 'undefined' && process.versions?.node
    ? (await import('node:worker_threads')).parentPort : null;
  const send = (reply: NativeAnalysisReply) => parent ? parent.postMessage(reply)
    : (globalThis as unknown as { postMessage(reply: NativeAnalysisReply): void }).postMessage(reply);
  const packets: PacketView[] = [], querier = createSourceQuerier();
  const queued = new Map<number, NativeAnalysisRequest>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const execute = (message: NativeAnalysisRequest) => {
    try {
      let data: Extract<NativeAnalysisReply, { ok: true }>['data'];
      switch (message.type) {
        case 'append': {
          const records = message.input.records;
          if (records.length % 3 || packets.length + records.length / 3 > 2_000_000) throw new Error('Invalid native analysis packet batch.');
          for (let i = 0; i < records.length; i += 3) packets.push({ pts: records[i], dts: null, size: records[i + 1], key: records[i + 2] === 1 });
          data = packets.length; break;
        }
        case 'query': {
          const { context, query } = message.input;
          data = querier(packets, { ...context, sourceVersion: `${context.mediaId}@${packets.length}`, indexRevision: packets.length }, query); break;
        }
        case 'locate': data = locateSampleById(packets, message.input.mediaId, message.input.firstPtsUs, message.input.sampleId); break;
        case 'rank': data = querier.rank(packets, message.input.firstPtsUs, message.input.axis, message.input.tUs); break;
        case 'number': data = querier.sampleAtNumber(packets, message.input.firstPtsUs, message.input.axis, message.input.number); break;
      }
      send({ id: message.id, ok: true, data });
    } catch (error) { send({ id: message.id, ok: false, error: error instanceof Error ? error.message : String(error) }); }
  };
  const drain = () => {
    timer = undefined;
    const next = queued.values().next().value;
    if (!next) return;
    queued.delete(next.id); execute(next);
    if (queued.size) timer = setTimeout(drain, 0);
  };
  const receive = (message: NativeAnalysisRequest | { type: 'cancel'; id: number }) => {
    if (message.type === 'cancel') { queued.delete(message.id); return; }
    // Let cancellation messages arrive before starting queued statistics.
    queued.set(message.id, message);
    if (timer === undefined) timer = setTimeout(drain, 0);
  };
  if (parent) parent.on('message', receive);
  else (globalThis as unknown as { onmessage: (event: MessageEvent<NativeAnalysisRequest>) => void }).onmessage = event => receive(event.data);
}
void start();
