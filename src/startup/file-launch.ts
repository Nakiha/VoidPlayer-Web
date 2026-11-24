import { captureDecodeConfiguration, type DecodeConfiguration } from '../media/policy/color-mode.ts';
import { localOnly } from '../services/build-profile.ts';
import type { FsFileHandle } from '../services/file-handles.ts';
import type { FileLaunchOpener, prepareFirstFile } from './prepare-file.ts';

interface FileLaunchQueue { setConsumer(consume: (launch: { files: readonly FsFileHandle[] }) => void): void }
type LoadFiles = (files: File[], handles: (FsFileHandle | undefined)[], openFirst?: FileLaunchOpener) => Promise<unknown>;

async function inspectFiles(files: readonly FsFileHandle[], early?: { signal: AbortSignal; configuration: DecodeConfiguration }) {
  const items = Promise.all(files.map(async handle => {
    if (handle.kind === 'directory') return { directory: handle.name };
    try { return { file: await handle.getFile(), handle }; }
    catch { return { unreadable: handle.name }; }
  }));
  // Load the opening code alongside file IO and validation. Reference mode's
  // native-plane admission depends on the active GPU profile.
  const preparing = early?.configuration.colorMode === 'browser' ? import('./prepare-file.ts') : undefined;
  void preparing?.catch(() => {});
  const { inspectVideoInputs } = await import('../ui/video-input.ts');
  const inspected = await inspectVideoInputs<{ file: File; handle: FsFileHandle }>(await items);
  const first = inspected.accepted[0];
  if (!first || !early || !preparing || early.signal.aborted) return { ...inspected, prepared: undefined };
  const { prepareFirstFile } = await preparing;
  const prepared = early.signal.aborted ? undefined : prepareFirstFile(first.file, early.signal, early.configuration);
  return { ...inspected, prepared };
}

type Request = { files: readonly FsFileHandle[]; inspected?: ReturnType<typeof inspectFiles> };
export let startupFileLaunch: ReturnType<typeof createFileLaunch> | undefined;

export function initializeFileLaunch() {
  if (localOnly || !import.meta.env.PROD || window.top !== window || location.pathname !== '/' || location.search !== '?open=files'
      || document.querySelector('meta[name="voidplayer-page-bridge"]')) return;
  const queue = (window as Window & { launchQueue?: FileLaunchQueue }).launchQueue;
  if (queue) startupFileLaunch = createFileLaunch(queue);
}

function createFileLaunch(queue: FileLaunchQueue) {
  const lifecycle = new AbortController();
  const { signal } = lifecycle;
  const buffered: Request[] = [];
  const initial = captureDecodeConfiguration();
  let receivedFiles = false;
  let receive: ((request: Request) => void) | undefined;
  queue.setConsumer(({ files }) => {
    if (signal.aborted) return;
    const request: Request = { files };
    if (!receivedFiles && files.length) {
      receivedFiles = true;
      request.inspected = inspectFiles(files, { signal, configuration: initial });
      void request.inspected.catch(() => {});
    }
    if (receive) receive(request);
    else buffered.push(request);
  });
  function dispose() { lifecycle.abort(); buffered.length = 0; }
  window.addEventListener('pagehide', event => { if (!event.persisted) dispose(); }, { signal });
  return {
    dispose,
    bind(load: LoadFiles, report: (error: unknown) => void, openingChanged: (opening: boolean) => void, uiSignal: AbortSignal) {
      if (signal.aborted || uiSignal.aborted) return false;
      uiSignal.addEventListener('abort', dispose, { once: true, signal });
      let waiting = true, queued = 0;
      let pending = Promise.resolve();
      const update = (opening: boolean) => { if (!signal.aborted) openingChanged(opening); };
      // A direct navigation (or denied launch) may never deliver a file.
      const timeout = window.setTimeout(() => { waiting = false; update(false); }, 3000);
      signal.addEventListener('abort', () => window.clearTimeout(timeout), { once: true });
      receive = request => {
        const wasWaiting = waiting;
        waiting = false;
        if (wasWaiting) window.clearTimeout(timeout);
        if (!request.files.length) {
          if (wasWaiting) queueMicrotask(() => { if (!queued) update(false); });
          return;
        }
        if (++queued === 1 && !wasWaiting) queueMicrotask(() => update(true));
        let prepared: ReturnType<typeof prepareFirstFile> | undefined;
        pending = pending.then(async () => {
          if (signal.aborted) return;
          const inspected = await (request.inspected ?? inspectFiles(request.files));
          prepared = inspected.prepared;
          if (signal.aborted) return;
          const { accepted, reportRejections } = inspected;
          reportRejections(report);
          if (accepted.length) await load(accepted.map(item => item.file), accepted.map(item => item.handle), prepared?.open);
        }).catch(error => { if (!signal.aborted) report(error); }).finally(() => {
          prepared?.discard();
          if (--queued === 0) update(false);
        });
      };
      for (const request of buffered.splice(0)) receive(request);
      return true;
    },
  };
}
