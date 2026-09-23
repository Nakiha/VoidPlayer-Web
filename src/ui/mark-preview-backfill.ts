import { captureFrame } from '../presenter.ts';
import { DEFAULT_ANNOTATION_COLOR, drawAnnotations } from '../annotation.ts';
import { log } from '../log.ts';
import type { Slot } from '../model.ts';
import type { ReviewSession } from '../session.ts';
import { annotationThumbnails, thumbnailSignature } from './annotation-thumbnails.ts';
import { publishMarkPreview } from './mark-preview-publish.ts';

type StateTrack = ReturnType<ReviewSession['getState']>['tracks'][number];
type StateMark = ReturnType<ReviewSession['getState']>['marks'][number];
const short = (id: string) => id.slice(0, 8);
const summary = (url: string) => `${url.slice(0, 32)}…(${url.length})`;

/** The entry may reference an unreachable preview (service URL on a page
 * without the service, a corrupt cache row); confirm it decodes. */
function probeImage(url: string, timeoutMs = 5000): Promise<boolean> {
  return new Promise(resolve => {
    let done = false;
    const finish = (ok: boolean) => { if (!done) { done = true; resolve(ok); } };
    const timer = setTimeout(() => finish(false), timeoutMs);
    const image = new Image();
    image.onload = () => { clearTimeout(timer); finish(true); };
    image.onerror = () => { clearTimeout(timer); finish(false); };
    image.src = url;
  });
}

/**
 * Backfill annotation thumbnails from the presented frame.
 * The editor only generates previews while it is open; marks restored from
 * workspaces, created by the agent, or synced without a preview otherwise
 * render "暂无预览" forever. When playback settles paused on a mark's frame,
 * capture that frame once and publish through the same map + event + DOM
 * contract as the editor, so IndexedDB persistence and server upload pick it
 * up identically. Matching mirrors the editor anchor (media + raw PTS).
 * Signed entries are kept only after their URL proves decodable; a stale
 * service URL or corrupt cache row is regenerated, not skipped.
 */
export function installMarkPreviewBackfill(session: ReviewSession, sources: Record<Slot, HTMLCanvasElement>, editing: () => boolean) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  const verifiedUrls = new Set<string>();
  function schedule() { clearTimeout(timer); timer = setTimeout(() => void fill(), 300); }
  async function generate(track: StateTrack, mark: StateMark, signature: string): Promise<boolean> {
    if (!track.frame) return false;
    const source = captureFrame(sources[track.slot]);
    if (!source.width || !source.height) { log.debug('ui', '跳过标注缩略图补抓', { reason: 'empty-source', slot: track.slot }); return false; }
    const thumb = document.createElement('canvas');
    thumb.width = 320; thumb.height = Math.max(1, Math.round(320 * source.height / Math.max(1, source.width)));
    const ctx = thumb.getContext('2d')!;
    ctx.drawImage(source, 0, 0, thumb.width, thumb.height);
    const stageWidth = document.getElementById(`stage-${track.slot}`)?.clientWidth ?? thumb.width;
    drawAnnotations(ctx, (mark.drawings ?? []).filter(d => d.tool !== 'text' || d.text?.trim()), thumb.width, thumb.height, DEFAULT_ANNOTATION_COLOR, thumb.width / Math.max(1, stageWidth));
    const blob = await new Promise<Blob | null>(resolve => thumb.toBlob(resolve, 'image/jpeg', .78));
    if (!blob) { log.debug('ui', '跳过标注缩略图补抓', { reason: 'encode-missing', id: short(mark.id) }); return false; }
    if (blob.size > 128 * 1024) { log.debug('ui', '跳过标注缩略图补抓', { reason: 'oversize', id: short(mark.id), size: blob.size }); return false; }
    const settled = session.getState();
    if (settled.playing || settled.busy) { log.debug('ui', '跳过标注缩略图补抓', { reason: 'unsettled', id: short(mark.id) }); return false; }
    const current = settled.marks.find(candidate => candidate.id === mark.id);
    if (!current || thumbnailSignature(current) !== signature) { log.debug('ui', '跳过标注缩略图补抓', { reason: 'mark-changed', id: short(mark.id) }); return false; }
    const presented = settled.tracks.find(candidate => candidate.slot === track.slot);
    if (presented?.id !== track.id || presented?.frame?.ptsUs !== track.frame.ptsUs) { log.debug('ui', '跳过标注缩略图补抓', { reason: 'frame-moved', id: short(mark.id) }); return false; }
    const url = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(reader.error); reader.readAsDataURL(blob); });
    const preview = { url, width: thumb.width, height: thumb.height, signature };
    verifiedUrls.add(url);
    publishMarkPreview(mark.id, preview);
    log.debug('ui', '补抓标注缩略图', { id: short(mark.id), slot: track.slot, size: blob.size });
    return true;
  }
  async function fill() {
    if (running) return;
    const state = session.getState();
    if (state.playing || state.busy || editing()) {
      log.debug('ui', '跳过标注缩略图补抓', { reason: 'settled', playing: state.playing, busy: state.busy, editing: editing() });
      return;
    }
    const anchored = state.tracks.flatMap(track => {
      if (!track.visible || !track.frame) return [];
      return state.marks
        .filter(mark => mark.mediaId === track.id && mark.frame.ptsUs === track.frame!.ptsUs)
        .map(mark => ({ track, mark }));
    });
    running = true;
    try {
      const job = anchored.find(({ mark }) => annotationThumbnails.get(mark.id)?.signature !== thumbnailSignature(mark));
      if (job) {
        if (await generate(job.track, job.mark, thumbnailSignature(job.mark))) schedule();
        return;
      }
      const verify = anchored.find(({ mark }) => {
        const entry = annotationThumbnails.get(mark.id);
        return !!entry && !verifiedUrls.has(entry.url);
      });
      if (!verify) {
        log.debug('ui', '跳过标注缩略图补抓', {
          reason: 'no-candidate',
          tracks: state.tracks.map(track => ({ slot: track.slot, media: short(track.id), pts: track.frame?.ptsUs ?? null, visible: track.visible })),
          marks: state.marks.slice(0, 10).map(mark => {
            const entry = annotationThumbnails.get(mark.id);
            return { id: short(mark.id), media: short(mark.mediaId), pts: mark.frame.ptsUs, preview: entry ? summary(entry.url) : null };
          }),
        });
        return;
      }
      const entry = annotationThumbnails.get(verify.mark.id)!;
      if (await probeImage(entry.url)) {
        verifiedUrls.add(entry.url);
        publishMarkPreview(verify.mark.id, entry);
        log.debug('ui', '标注缩略图可用', { id: short(verify.mark.id), preview: summary(entry.url) });
        return;
      }
      log.debug('ui', '标注缩略图损坏，重抓', { id: short(verify.mark.id), preview: summary(entry.url) });
      if (await generate(verify.track, verify.mark, thumbnailSignature(verify.mark))) schedule();
    } catch (error) {
      log.warn('ui', '标注缩略图补抓失败', { error: error instanceof Error ? error.message : String(error) });
    } finally { running = false; }
  }
  return { schedule, dispose() { clearTimeout(timer); } };
}
