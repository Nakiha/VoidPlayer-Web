import { annotationThumbnails } from './annotation-thumbnails.ts';

export type MarkPreview = { url: string; width: number; height: number; signature?: string };

/**
 * Single publish contract for annotation previews: memory map, persistence
 * event, and visible cards. Hydration (IndexedDB/server/file) runs async and
 * may land after cards render without a marks change to retrigger them, so
 * publishing must patch the DOM in place instead of relying on re-render.
 */
export function publishMarkPreview(id: string, preview: MarkPreview) {
  annotationThumbnails.set(id, preview);
  window.dispatchEvent(new CustomEvent('voidplayer-annotation-preview', { detail: { id, preview } }));
  for (const thumbnail of document.querySelectorAll<HTMLElement>('[data-mark-thumbnail]')) {
    if (thumbnail.dataset.markThumbnail !== id) continue;
    let image = thumbnail.querySelector('img');
    if (!image) { image = document.createElement('img'); image.alt = '标注画面'; thumbnail.replaceChildren(image); }
    image.width = preview.width; image.height = preview.height; image.src = preview.url;
  }
}
