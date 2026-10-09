import type { MediaSource } from './media.ts';
import type { CachedWindow } from './audio-types.ts';
import type { AudioPeek } from './cached-container-audio.ts';

/** One parser worker only for the explicitly audible track; mute releases it. */
export function attachCachedContainerAudio(source: MediaSource, peek: AudioPeek, observe?: (enabled: boolean) => void, windows: () => Promise<CachedWindow[]> = async () => []) {
  let worker: Worker | undefined;
  let failed = false;
  const stop = () => { worker?.terminate(); worker = undefined; observe?.(false); };
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
          if (message.type === 'windows') void windows().then(ranges => { if (worker === current) current.postMessage({ type: 'windows', id: message.id, ranges }); }, () => { if (worker === current) current.postMessage({ type: 'windows', id: message.id, ranges: [] }); });
          else if (message.type === 'audio') source.onCachedAudio?.(message.generation, message.batch);
          else if (message.type === 'peek') void peek(message.offset, message.length).then(bytes => {
            if (worker === current) current.postMessage({ type: 'bytes', id: message.id, bytes }, bytes ? [bytes.buffer as ArrayBuffer] : []);
          }, () => { if (worker === current) current.postMessage({ type: 'bytes', id: message.id }); });
        };
        current.onerror = () => { failed = true; stop(); };
        current.postMessage({ type: 'init', size: source.info.size, container: source.info.container });
      }
      worker.postMessage({ type: 'query', ptsUs: ptsUs + source.info.firstPtsUs, generation });
    } catch { failed = true; stop(); }
  };
  return stop;
}
