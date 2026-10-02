import type { WorkspaceFile } from './workspace-file.ts';
import { pinLibraryReference } from './media-reference.ts';

/** Sharing stores references, never uploads the user's local videos. */
export async function prepareSharedWorkspace(value: WorkspaceFile) {
  const document = structuredClone(value);
  for (const media of document.media) {
    if (!media.source) throw new Error(`「${media.name}」是本地文件，请先放入服务端媒体库再分享。`);
    media.source = await pinLibraryReference(media, location.href);
  }
  return document;
}

export function mapSharedWorkspace(value: WorkspaceFile, origin: string) {
  const document = structuredClone(value), previous = new URL(document.serverUrl).origin;
  for (const media of document.media) {
    if (!media.source) continue;
    const source = new URL(media.source.url);
    if (source.origin === previous) media.source.url = new URL(source.pathname + source.search, origin).href;
  }
  document.serverUrl = origin + '/';
  return document;
}
