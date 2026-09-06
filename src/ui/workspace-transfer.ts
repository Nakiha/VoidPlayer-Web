import type { ReviewSession } from '../session.ts';
import type { MediaInfo } from '../model.ts';
import { openMedia, openMediaFromUrl } from '../media.ts';
import { compressWorkspace, parseWorkspace, readWorkspaceFile } from '../workspace-file.ts';
import type { WorkspaceFile } from '../workspace-file.ts';
import { annotationThumbnails } from './annotation-thumbnails.ts';
import { pinLibraryReference } from '../media-reference.ts';
import { icon } from './icons.ts';

export const isWorkspaceFile = (file: File) => /\.(voidplayer|json|gz)$/i.test(file.name);
const matchesFile = (file: File, info: MediaInfo) => file.name === info.name.split('/').at(-1) && file.size === info.size && file.lastModified === info.lastModified;

/** Browser files cannot be reopened from a JSON path. Resolve every missing file before touching the session. */
async function resolveLocalFiles(media: MediaInfo[], supplied: File[]) {
  const files = new Map<string, File>();
  for (const info of media) { const file = supplied.find(f => matchesFile(f, info)); if (file) files.set(info.id, file); }
  const missing = media.filter(info => !files.has(info.id));
  if (!missing.length) return files;
  const dialog = document.createElement('dialog'); dialog.className = 'workspace-relink'; dialog.setAttribute('aria-label', '重新连接本地视频');
  dialog.innerHTML = `<header class="dialog-heading"><h2>重新连接本地视频</h2><button class="icon-button" aria-label="取消导入">${icon('close')}</button></header><p>工作区保存了视频引用。请重新选择这些本地文件，或取消以保留当前工作区。</p><div class="relink-files"></div><p role="alert"></p><button class="relink-continue" disabled>打开工作区</button>`;
  const proceed = dialog.querySelector<HTMLButtonElement>('.relink-continue')!;
  for (const info of missing) {
    const label = document.createElement('label'); label.className = 'relink-file';
    const name = document.createElement('span'); name.textContent = info.name;
    const input = document.createElement('input'); input.type = 'file'; input.accept = 'video/*,.mkv,.ts,.flv,.avi'; input.setAttribute('aria-label', `重新选择 ${info.name}`);
    input.onchange = () => {
      const file = input.files?.[0]; files.delete(info.id);
      const valid = file && matchesFile(file, info);
      dialog.querySelector('[role=alert]')!.textContent = valid ? '' : '文件名、大小或修改时间与工作区记录不一致，请选择原始文件。';
      if (valid) files.set(info.id, file);
      proceed.disabled = files.size !== media.length;
    };
    label.append(name, input); dialog.querySelector('.relink-files')!.append(label);
  }
  document.body.append(dialog);
  return new Promise<Map<string, File> | null>(resolve => {
    dialog.querySelector('header button')!.addEventListener('click', () => dialog.close());
    proceed.onclick = () => dialog.close('open');
    dialog.addEventListener('close', () => { const result = dialog.returnValue === 'open' ? files : null; dialog.remove(); resolve(result); }, { once: true });
    dialog.showModal();
  });
}

export function installWorkspaceTransfer(session: ReviewSession, options: {
  act(action: () => unknown | Promise<unknown>, name: string): Promise<void>;
  capture(): Pick<WorkspaceFile, 'viewport' | 'layout'>;
  restore(document: WorkspaceFile): void;
  beforeRestore(): void;
  closeSettings(): Promise<void>;
}) {
  const input = document.getElementById('workspace-file') as HTMLInputElement;
  const lifetime = new AbortController(); let importing = false;
  function exportWorkspace() {
    const document = { ...session.exportWorkspace(new URL('/', location.href).href), ...options.capture() };
    document.thumbnails = document.marks.flatMap(mark => { const image = annotationThumbnails.get(mark.id); return image ? [{ id: mark.id, ...image }] : []; });
    return document;
  }
  async function importWorkspace(value: unknown, supplied: File[] = []) {
    if (importing) throw new Error('工作区正在导入，请等待完成。');
    importing = true;
    try {
      const document = parseWorkspace(value, location.href);
      await options.closeSettings();
      const active = document.tracks.map(t => document.media.find(m => m.id === t.mediaId)!);
      const files = await resolveLocalFiles(active.filter(m => !m.source), supplied);
      if (!files) return;
      options.beforeRestore();
      await session.restoreWorkspace(document, async info => {
        if (!info.source) return openMedia(files.get(info.id)!);
        const reference = await pinLibraryReference(info, location.href);
        const source = await openMediaFromUrl(reference.url, info); source.info.source = reference; return source;
      });
      annotationThumbnails.clear();
      for (const { id, ...image } of document.thumbnails ?? []) annotationThumbnails.set(id, image);
      options.restore(document);
    } finally { importing = false; }
  }
  async function importFile(file: File, supplied: File[] = []) { await importWorkspace(await readWorkspaceFile(file, location.href), supplied); }
  document.getElementById('workspace-import')!.addEventListener('click', () => input.click(), { signal: lifetime.signal });
  input.addEventListener('change', () => { const file = input.files?.[0]; input.value = ''; if (file) void options.act(() => importFile(file), 'workspace.import'); }, { signal: lifetime.signal });
  document.getElementById('export')!.addEventListener('click', () => void options.act(async () => {
    const blob = await compressWorkspace(exportWorkspace()), url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = `VoidPlayer-${new Date().toISOString().slice(0, 10)}.voidplayer`; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, 'workspace.export'), { signal: lifetime.signal });
  return { exportWorkspace, importWorkspace, importFile, dispose() { lifetime.abort(); } };
}
