import { CachedContainerAudio } from './cached-container-audio.ts';
import type { CachedWindow } from './audio-types.ts';
let parser: CachedContainerAudio | undefined;
let nextId = 0, busy = false;
let latest: { ptsUs: number; generation: number } | undefined;
const pendingWindows = new Map<number, (ranges: CachedWindow[]) => void>();
const pending = new Map<number, (bytes?: Uint8Array) => void>();
const send = (message: unknown, transfer: Transferable[] = []) => (globalThis as unknown as { postMessage(message: unknown, transfer: Transferable[]): void }).postMessage(message, transfer);
async function run() {
  if (busy || !parser) return;
  busy = true;
  try {
    while (latest) {
      const query = latest; latest = undefined;
      const batch = await parser.read(query.ptsUs);
      send({ type: 'audio', generation: query.generation, batch }, batch.packets.map(p => p.data.buffer as ArrayBuffer));
      // Allow cancellation and incoming query coalescing between cache queries.
      await new Promise<void>(resolve => setTimeout(resolve, 0));
    }
  } finally { busy = false; }
}
onmessage = event => {
  const message = event.data;
  if (message.type === 'init') parser = new CachedContainerAudio(message.size, (offset, length) => new Promise(resolve => {
    const id = ++nextId; pending.set(id, resolve); send({ type: 'peek', id, offset, length });
  }), () => new Promise(resolve => { const id = ++nextId; pendingWindows.set(id, resolve); send({ type: 'windows', id }); }), message.container);
  else if (message.type === 'windows') { pendingWindows.get(message.id)?.(message.ranges); pendingWindows.delete(message.id); }
  else if (message.type === 'bytes') { const resolve = pending.get(message.id); pending.delete(message.id); resolve?.(message.bytes); }
  else if (message.type === 'query') { latest = message; void run(); }
};
