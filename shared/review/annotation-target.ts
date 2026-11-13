import type { MediaInfo } from '../media/types.ts';
import type { AnnotationDocument } from './annotation-record.ts';
import { referenceVersion } from '../media/io/media-reference.ts';

/** Same-service aliases use an empty namespace; external libraries retain their Origin. */
export async function annotationTarget(media: MediaInfo, base: string): Promise<string> {
  const source = media.source, version = referenceVersion(source?.url);
  if (!source) return `local-${media.id}`;
  const url = new URL(source.url, base);
  if (!/^[0-9a-f]{24}$/.test(source.id) || !version || !/^[0-9a-f]{24}$/.test(version) ||
    !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== `/api/media/${source.id}/content`)
    throw new Error('标注需要有效的固定版本片源引用。');
  const origin = url.origin, namespace = origin === new URL(base).origin ? '' : origin;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([namespace, source.id, version])));
  return 'media-' + [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
export async function annotationDocumentTarget(document: AnnotationDocument, base: string) {
  const media = document.media.find(item => item.id === document.mark.mediaId);
  if (!media) throw new Error('标注缺少目标片源。');
  return annotationTarget(media, base);
}
