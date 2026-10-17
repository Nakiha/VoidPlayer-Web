import type { MediaSource } from './media.ts';
import type { CachedWindow } from '../shared/media/audio-types.ts';
import type { AudioPeek } from '../shared/media/audio-types.ts';

/** One parser worker only for the explicitly audible track; mute releases it. */
export function attachCachedContainerAudio(source: MediaSource, peek: AudioPeek, observe?: (enabled: boolean) => void, windows: () => Promise<CachedWindow[]> = async () => []) {
  let worker: Worker | undefined;
  let failed = false;
  const stop = () => {
    const current = worker;
    worker = undefined;
    if (current) {
      current.onmessage = null;
      current.onerror = null;
      current.onmessageerror = null;
      current.terminate();
    }
    observe?.(false);
  };
  const fail = (current: Worker) => {
    if (worker !== current) return;
    failed = true;
    stop();
  };
  // A reverse reply happens after the event callback has returned. Keep its
  // postMessage exception in this optional audio client, not a floating Promise.
  const reply = (current: Worker, message: unknown, transfer: Transferable[] = []) => {
    if (worker !== current) return;
    try { current.postMessage(message, transfer); }
    catch { fail(current); }
  };
  const replyWindows = async (current: Worker, id: number) => {
    let ranges: CachedWindow[];
    try { ranges = await windows(); }
    catch { ranges = []; }
    reply(current, { type: 'windows', id, ranges });
  };
  const replyBytes = async (current: Worker, id: number, offset: number, length: number) => {
    let bytes: Uint8Array | undefined;
    try { bytes = await peek(offset, length); }
    catch { /* An optional cache miss does not stop video or audio. */ }
    reply(current, { type: 'bytes', id, bytes }, bytes ? [bytes.buffer as ArrayBuffer] : []);
  };
  source.info.opportunisticAudio = 'cached-container';
  source.setCachedAudioEnabled = enabled => { if (enabled) { failed = false; observe?.(true); } else stop(); };
  source.requestCachedAudio = (ptsUs, generation) => {
    if (failed) return;
    try {
      if (!worker) {
        const current = worker = new Worker(new URL('./cached-audio-worker.ts', import.meta.url), { type: 'module' });
        current.onmessage = event => {
          if (worker !== current) return;
          const message = event.data;
          if (message.type === 'windows') void replyWindows(current, message.id);
          else if (message.type === 'audio') source.onCachedAudio?.(message.generation, message.batch);
          else if (message.type === 'peek') void replyBytes(current, message.id, message.offset, message.length);
        };
        current.onerror = () => fail(current);
        current.onmessageerror = () => fail(current);
        current.postMessage({ type: 'init', size: source.info.size, container: source.info.container });
      }
      worker.postMessage({ type: 'query', ptsUs: ptsUs + source.info.firstPtsUs, generation });
    } catch { if (worker) fail(worker); else { failed = true; stop(); } }
  };
  return stop;
}
