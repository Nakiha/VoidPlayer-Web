import type { MediaInfo } from '../model.ts';
import type { MediaSource } from '../media.ts';
/** A reference placeholder owns no decoder and never fabricates a frame. */
export function unavailableSource(info: MediaInfo): MediaSource {
  const unavailable = () => { throw new Error('片源待重新关联。'); };
  return { info: structuredClone(info), frameAt: async () => unavailable(), framesAfter: async () => unavailable(),
    async *framesFrom() { unavailable(); }, dispose() {} };
}
