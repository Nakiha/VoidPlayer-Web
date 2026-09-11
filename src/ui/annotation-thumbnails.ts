import type { Mark } from '../model.ts';
export const thumbnailSignature = (mark: Mark) => JSON.stringify([mark.frame, mark.text, mark.drawings ?? []]);
/** Session-only preview cache shared by the editor, list and seek tooltip.
 * No DOM dependencies, persistence or media decoding on read. */
export const annotationThumbnails = new Map<string, { url: string; width: number; height: number; signature?: string }>();
