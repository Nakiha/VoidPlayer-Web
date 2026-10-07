import { createCooperativeQuerier, driveAnalysis } from './cooperative.ts';
import { locateSampleById } from './adapters.ts';
import type { PacketView } from './adapters.ts';
import type { NativeAnalysisRequest, NativeAnalysisReply } from './native-protocol.ts';

async function start() {
  const parent = typeof process !== 'undefined' && process.versions?.node
    ? (await import('node:worker_threads')).parentPort : null;
  const send = (reply: NativeAnalysisReply) => parent ? parent.postMessage(reply)
    : (globalThis as unknown as { postMessage(reply: NativeAnalysisReply): void }).postMessage(reply);
  const packets: PacketView[] = [], querier = createCooperativeQuerier();
  const queued = new Map<number, NativeAnalysisRequest>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let active: { id: number; cancelled: boolean } | undefined;
  const execute = async (message: NativeAnalysisRequest) => {
    const job = active = { id: message.id, cancelled: false };
    send({ id: message.id, event: 'started' });
    let reportedYield = false;
    const run = <T>(steps: Generator<void, T>) => driveAnalysis(steps, () => job.cancelled, () => {
      if (!reportedYield) { reportedYield = true; send({ id: job.id, event: 'yielded' }); }
      return new Promise<void>(resolve => setTimeout(resolve, 0));
    });
    try {
      if (job.cancelled) throw new DOMException('Analysis query cancelled.', 'AbortError');
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
          data = await run(querier.query(packets, { ...context, sourceVersion: `${context.mediaId}@${packets.length}`, indexRevision: packets.length }, query)); break;
        }
        case 'locate': data = locateSampleById(packets, message.input.mediaId, message.input.firstPtsUs, message.input.sampleId); break;
        case 'rank': data = await run(querier.rank(packets, message.input.firstPtsUs, message.input.axis, message.input.tUs)); break;
        case 'number': data = await run(querier.number(packets, message.input.firstPtsUs, message.input.axis, message.input.number)); break;
      }
      send({ id: message.id, ok: true, data });
    } catch (error) { send({ id: message.id, ok: false, error: error instanceof Error ? error.message : String(error), name: error instanceof Error ? error.name : 'Error' }); }
    finally { active = undefined; }
  };
  const drain = async () => {
    timer = undefined;
    const next = queued.values().next().value;
    if (!next) return;
    queued.delete(next.id); await execute(next);
    if (queued.size) timer = setTimeout(drain, 0);
  };
  const receive = (message: NativeAnalysisRequest | { type: 'cancel'; id: number }) => {
    if (message.type === 'cancel') { if (active?.id === message.id) active.cancelled = true; queued.delete(message.id); return; }
    // Let cancellation messages arrive before starting queued statistics.
    queued.set(message.id, message);
    if (!active && timer === undefined) timer = setTimeout(drain, 0);
  };
  if (parent) parent.on('message', receive);
  else (globalThis as unknown as { onmessage: (event: MessageEvent<NativeAnalysisRequest>) => void }).onmessage = event => receive(event.data);
}
void start();
