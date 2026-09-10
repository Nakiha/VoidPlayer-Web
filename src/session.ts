import { annotationMediaKey } from './annotation-record.ts';
import type { AnnotationDocument } from './annotation-record.ts';
import {recordPresentedFrame,updateMediaInfo} from './media-state.ts';
import type { MediaLoadStatus, MediaOpenProgress } from './media-progress.ts';
import { abortableLoad } from './media-abort.ts';
import { randomUUID } from './uuid.ts';
import { parseWorkspace, workspaceUrl } from './workspace-file.ts';
import type { WorkspaceFile } from './workspace-file.ts';
import { Viewport } from './viewport.ts';
import { SLOTS } from './model.ts';
import { drawingsValue } from './annotation.ts';
import { FrameQueue, PlaybackMeasurements } from './playback.ts';
import { planBackwardStep, planForwardStep, regionValue, slotValue, timeUs } from './model.ts';
import type { FrameInfo, Mark, MediaInfo, Slot } from './model.ts';
import type { DecodedFrame, MediaSource } from './media.ts';
import { contextLog, log, operationContext, traceOperation, withLogContext } from './log.ts';

const errorText = (e: unknown) => e instanceof Error ? e.message : String(e);

type Track = { source: MediaSource; frame: FrameInfo | null; offsetUs:number; failure?: { message: string; positionUs: number }; syncState?: 'index-wait' | 'catching-up' };
export class ReviewSession {
  private order: Slot[] = [...SLOTS];
  private tracks = new Map<Slot, Track>();
  private catalog = new Map<string, MediaInfo>();
  private marks: Mark[] = [];
  private markListeners = new Set<(id: string, document: AnnotationDocument | null) => void>();
  subscribeMarkChanges(listener: (id: string, document: AnnotationDocument | null) => void) { this.markListeners.add(listener); return () => this.markListeners.delete(listener); }
  private markChanged(id: string) {
    const mark = this.marks.find(mark => mark.id === id);
    const ids = new Set(mark ? [mark.mediaId, ...mark.comparison.map(item => item.mediaId)] : []);
    const document = mark ? structuredClone({ mark, media: [...this.catalog.values()].filter(media => ids.has(media.id)) }) : null;
    for (const listener of this.markListeners) listener(id, document);
  }
  /** Persistence ingress only: update annotations without touching decoder/clock state. */
  applyStoredAnnotations(documents: AnnotationDocument[], removeIds: string[]) {
    const loaded = [...this.tracks.values()].map(track => track.source.info);
    const incoming: Mark[] = [];
    for (const document of documents) {
      const saved = document.media.find(media => media.id === document.mark.mediaId);
      const target = saved && loaded.find(media => annotationMediaKey(media) === annotationMediaKey(saved));
      if (!target) continue;
      for (const media of document.media) if (!this.catalog.has(media.id)) this.catalog.set(media.id, media);
      const mark = structuredClone(document.mark); mark.mediaId = target.id;
      mark.comparison = mark.comparison.map(item => {
        const media = document.media.find(media => media.id === item.mediaId);
        const current = media && loaded.find(candidate => annotationMediaKey(candidate) === annotationMediaKey(media));
        return current ? { ...item, mediaId: current.id } : item;
      });
      incoming.push(mark);
    }
    const replace = new Set([...removeIds, ...incoming.map(mark => mark.id)]);
    const next = [...this.marks.filter(mark => !replace.has(mark.id)), ...incoming];
    if (JSON.stringify(next) !== JSON.stringify(this.marks)) { this.marks = next; this.emit(); }
  }
  private actor: { id: string; name: string } | null = null;
  setActor(actor: { id: string; name: string } | null) { this.actor = actor ? { id: actor.id, name: actor.name } : null; }
  private queue: Promise<unknown> = Promise.resolve();
  private mediaLoad: MediaLoadStatus | null = null;
  private abortLoad: (() => void) | undefined;
  private abortIncoming: (() => void) | undefined;
  cancelLoad() {
    this.abortIncoming?.();
    if (this.mediaLoad?.state === 'loading') { this.mediaLoad.state = 'cancelled'; this.mediaLoad.finishedAt = Date.now(); }
    this.emit();
    return this.getState();
  }
  private revision = 0;
  private stopPlayback: (() => void) | undefined;
  // Playback state belongs to a source, not to its position in a track array.
  private readers = new Map<MediaSource, FrameQueue>();
  private releaseReaders(reason: string, sources: Iterable<MediaSource> = this.readers.keys()) {
    for (const source of sources) {
      const reader = this.readers.get(source);
      if (!reader) continue;
      reader.stop(); this.readers.delete(source);
      log.debug('session', '释放播放队列', { mediaId: source.info.id, reason });
    }
  }
  private measurements: PlaybackMeasurements | null = null;
  private busy = false;
  private playing = false;
  private positionUs = 0;
  private error: string | null = null;
  private decodeMs = 0;
  private listeners = new Set<() => void>();
  private progressListeners = new Set<(positionUs: number, durationUs: number) => void>();
  private draw: (slot: Slot, frame: DecodedFrame) => void;
  constructor(draw: (slot: Slot, frame: DecodedFrame) => void) { this.draw = draw; }
  subscribe(listener: () => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  /** Presentation-clock updates, without cloning the full session or rerendering the workbench. */
  subscribeProgress(listener: (positionUs: number, durationUs: number) => void) {
    this.progressListeners.add(listener); return () => this.progressListeners.delete(listener);
  }
  private emitProgress() {
    const durationUs = this.durationUs;
    for (const listener of this.progressListeners) listener(this.positionUs, durationUs);
  }
  private lastTransition = '';
  private emit() {
    const state = { busy: this.busy, playing: this.playing, error: this.error, mediaLoad: this.mediaLoad, tracks: [...this.tracks].map(([slot,t])=>({slot,...t.source.info,offsetUs:t.offsetUs,failure:t.failure,syncState:t.syncState})) };
    const signature = JSON.stringify(state);
    if (signature !== this.lastTransition) {
      log.info('session', '状态变化', { before: this.lastTransition ? JSON.parse(this.lastTransition) : null, after: state, positionUs: this.positionUs });
      this.lastTransition = signature;
    }
    for (const listener of this.listeners) listener();
    this.emitProgress();
  }
  /** Capture before teardown; separate events avoid truncating nested tracks.
   * Never include pixels, file contents or annotation bodies. */
  captureDiagnostics(reason: string, failure?: unknown) {
    const context = { reason, positionUs: this.positionUs, playing: this.playing, busy: this.busy };
    log.warn('session', '故障现场：会话', { ...context, durationUs: this.durationUs, error: failure === undefined ? this.error : errorText(failure), mediaLoad: this.mediaLoad, playback: this.measurements?.snapshot() ?? null });
    for (const [slot, track] of this.tracks) {
      const info = track.source.info;
      log.warn('session', '故障现场：轨道', { ...context, slot, mediaId: info.id, name: info.name, decoder: info.decoder,
        width: info.width, height: info.height, durationUs: info.durationUs, offsetUs: track.offsetUs, frame: track.frame,
        indexState: info.indexState, indexError: info.indexError, indexProgress: info.indexProgress, indexWaiting: info.indexWaiting, syncState: track.syncState, color: info.color });
      log.warn('session', '故障现场：播放队列', { reason, slot, mediaId: info.id, queue: this.readers.get(track.source)?.snapshot() ?? null });
    }
  }
  getState() {
    return structuredClone({
      version: 1, busy: this.busy, playing: this.playing, positionUs: this.positionUs,
      durationUs: this.durationUs, error: this.error, lastDecodeMs: this.decodeMs,
      mediaLoad: this.mediaLoad,
      playback: this.measurements?.snapshot() ?? null,
      frameEvidence: 'decoded-and-drawn-to-canvas', audio: 'muted', color: 'browser-managed-unverified',
      tracks: this.order.flatMap(slot => { const t = this.tracks.get(slot); return t ? [{ slot, ...t.source.info, frame: t.frame, offsetUs:t.offsetUs, failure:t.failure,syncState:t.syncState }] : []; }),
      marks: this.marks,
    });
  }
  reorderTracks(order: Slot[]) {
    if (!Array.isArray(order) || order.length !== this.tracks.size || new Set(order).size !== order.length || order.some(slot => !this.tracks.has(slot))) throw new Error('排序必须包含每个已载入轨道且不重复。');
    this.order = [...order, ...SLOTS.filter(slot => !order.includes(slot))];
    log.info('session', '调整轨道顺序', { order });
    this.emit();
    return this.getState();
  }
  private get durationUs() { return Math.max(0, ...[...this.tracks.values()].filter(t => !t.failure).map(t => t.source.info.durationUs + t.offsetUs)); }
  pause() {
    const wasPlaying = this.playing;
    ++this.revision;
    this.abortLoad?.();
    this.stopPlayback?.();
    this.stopPlayback = undefined;
    this.playing = false;
    this.busy = false;
    if (wasPlaying) log.info('session', '暂停播放', { positionUs: this.positionUs });
    this.emit();
    return this.getState();
  }
  private run<T>(name: string, data: unknown, work: (current: () => boolean) => Promise<T>): Promise<T> {
    return traceOperation('session', name, data, () => {
      const context = operationContext();
      this.cancelLoad(); this.pause();
      const revision = this.revision;
      this.busy = true;
      this.error = null;
      this.emit();
      const current = () => revision === this.revision;
      const operation = this.queue.catch(() => {}).then(async () => {
        if (!current()) throw new DOMException('操作已被更新的请求取代。', 'AbortError');
        try {
          const result = await withLogContext(context, () => work(current));
          if (!current()) throw new DOMException('操作已被更新的请求取代。', 'AbortError');
          return result;
        } catch (e) {
          if (current()) { this.error = e instanceof Error ? e.message : String(e); if (!(e instanceof Error && e.name === 'AbortError')) this.captureDiagnostics('operation-error', e); }
          throw e;
        } finally {
          if (current()) { this.busy = false; withLogContext(context, () => this.emit()); }
        }
      });
      this.queue = operation;
      return operation;
    });
  }
  async load(slot: Slot, open: (signal: AbortSignal, onProgress: MediaOpenProgress) => Promise<MediaSource>, name = '视频') {
    slotValue(slot);
    const scoped = contextLog(), replacing = this.tracks.get(slot)?.source.info.name;
    // Preparing a source is independent of the transport. A second load still
    // supersedes the first, but opening/indexing never owns the session queue.
    if (this.busy) this.pause();
    this.cancelLoad();
    const controller = new AbortController();
    const status: MediaLoadStatus = { name, slot, stage: 'queued', state: 'loading', startedAt: Date.now(), targetPtsUs: this.positionUs };
    let source: MediaSource | undefined, committed = false, released = false;
    const release = () => { if (source && !released) { released = true; source.onInfoChange = undefined; source.dispose(); } };
    const abort = () => { controller.abort(new DOMException('载入已取消。', 'AbortError')); if (!committed) release(); };
    const current = () => !controller.signal.aborted && this.mediaLoad === status;
    const check = () => { if (!current()) throw controller.signal.reason ?? new DOMException('载入已被取代。', 'AbortError'); };
    const progress: MediaOpenProgress = stage => { if (current() && status.state === 'loading') { status.stage = stage; this.emit(); } };
    this.abortIncoming = abort;
    this.mediaLoad = status; this.error = null; this.emit();
    try {
      await traceOperation('session', 'load', { slot, replacing, targetPtsUs: status.targetPtsUs }, async () => {
        // Keep the queued milestone observable and never call a superseded opener.
        await Promise.resolve(); check(); progress('inspect');
        const opened = await abortableLoad<MediaSource>(Promise.resolve().then(() => { check(); return open(controller.signal, progress); }), controller.signal, late => late.dispose());
        source = opened; check();
        if (opened.info.source && [...this.tracks].some(([other, track]) => other !== slot && track.source.info.source?.id === opened.info.source!.id)) throw new Error('该片源已在视图中，不能重复添加。');
        const updatePending = () => {
          if (!current()) return;
          status.indexProgress = opened.info.indexProgress;
          status.indexedDurationUs = opened.info.durationUs;
          this.emit();
        };
        opened.onInfoChange = updatePending;
        let target: number;
        do {
          check(); target = this.positionUs; status.targetPtsUs = target;
          progress(opened.info.indexState === 'building' && target >= opened.info.durationUs ? 'index' : 'synchronize');
          updatePending();
          await abortableLoad(Promise.resolve().then(() => target > 0 ? opened.ensureIndexed?.(target) : undefined), controller.signal);
          check();
          // The playing clock may have moved while this prefix was scanned.
        } while (opened.ensureIndexed && opened.info.indexState === 'building' && this.positionUs >= opened.info.durationUs);
        target = this.positionUs; status.targetPtsUs = target;
        progress(target === 0 ? 'first-frame' : 'synchronize');
        const localTarget = Math.max(0, Math.min(target, opened.info.durationUs - 1));
        const frame = await abortableLoad(Promise.resolve().then(() => opened.frameAt(localTarget)), controller.signal, late => late.close());
        try {
          check();
          // Draw only the incoming source. Existing canvases, decode cursors,
          // buffered frames, alignment offsets and annotation anchors survive.
          this.draw(slot, frame); recordPresentedFrame(opened, frame);
          const previous = this.tracks.get(slot), resume = this.playing;
          if (resume) { ++this.revision; this.stopPlayback?.(); this.stopPlayback = undefined; }
          if (previous) { this.releaseReaders('replace', [previous.source]); if (!previous.failure) previous.source.dispose(); }
          const behind = resume && frame.ptsUs + frame.durationUs <= this.positionUs && opened.info.durationUs > this.positionUs;
          this.tracks.set(slot, { source: opened, frame: this.frameInfo(frame), offsetUs: 0, ...(behind ? { syncState: 'catching-up' as const } : {}) });
          this.catalog.set(opened.info.id, opened.info);
          opened.onInfoChange = () => { if ([...this.tracks.values()].some(t => t.source === opened)) this.emit(); };
          // Adding a short track never clamps the clock. Replacement can shrink
          // the entire session's extent after removing its longest source.
          this.positionUs = Math.min(this.positionUs, Math.max(0, this.durationUs - 1));
          committed = true;
          status.name = opened.info.name; status.state = 'complete'; status.finishedAt = Date.now();
          this.emit();
          if (resume) void this.playbackLoop(this.revision, this.positionUs, performance.now());
        } finally { frame.close(); }
      });
    } catch (error) {
      if (current()) {
        status.state = 'error'; status.error = errorText(error); status.finishedAt = Date.now();
        this.error = errorText(error); this.captureDiagnostics('load-error', error);
      }
      scoped[controller.signal.aborted ? 'info' : 'warn']('session', `载入轨道 ${slot} 失败`, { replacing, targetPtsUs: status.targetPtsUs, error: errorText(error) });
      throw controller.signal.aborted ? controller.signal.reason : error;
    } finally {
      if (!committed) release();
      if (this.abortIncoming === abort) this.abortIncoming = undefined;
      if (this.mediaLoad === status) this.emit();
    }
    scoped.info('media', `轨道 ${slot} 已载入`, { name: source!.info.name, replacing, requestedUs: status.targetPtsUs, positionUs: this.positionUs, frame: this.tracks.get(slot)?.frame });
    return this.getState();
  }
  async removeTrack(slot: Slot) {
    slotValue(slot);
    await this.run('removeTrack', { slot }, async current => {
      const track = this.tracks.get(slot);
      if (track) this.releaseReaders('remove', [track.source]);
      this.tracks.delete(slot);
      if (track && !track.failure) track.source.dispose();
      if (!this.playableEntries().length) { this.positionUs = 0; this.measurements = null; }
      else if (this.positionUs >= this.durationUs) await this.drawAt(this.durationUs - 1, current);
      log.info('session', '关闭轨道', { slot, mediaId: track?.source.info.id });
    });
    return this.getState();
  }
  async setTrackOffset(slot:Slot, offsetUs:number) {
    slotValue(slot);
    if(!Number.isSafeInteger(offsetUs)) throw new Error('偏移必须是整数微秒。');
    await this.run('setTrackOffset',{slot,offsetUs},async current=>{
      const old=this.tracks.get(slot); if(!old)throw new Error('轨道尚未载入。');
      if(!Number.isSafeInteger(old.source.info.durationUs+offsetUs))throw new Error('偏移超出可用时间范围。');
      const next=new Map(this.tracks);next.set(slot,{...old,offsetUs});
      const duration=Math.max(...[...next.values()].map(t=>t.source.info.durationUs+t.offsetUs));
      if(old.source.info.durationUs+offsetUs<=0 || !Number.isSafeInteger(duration))throw new Error('偏移后没有可播放的时间范围。');
      await this.drawAt(Math.min(this.positionUs,duration-1),current,next,()=>{this.tracks=next;});
    });
    return this.getState();
  }
  private async waitForIndex<T>(pending: Promise<T>) {
    const controller = new AbortController();
    const abort = () => controller.abort(new DOMException('定位已取消。', 'AbortError'));
    this.abortLoad = abort;
    try { return await abortableLoad(pending, controller.signal); }
    finally { if (this.abortLoad === abort) this.abortLoad = undefined; }
  }
  private playableEntries() { return [...this.tracks].filter(([, t]) => !t.failure); }
  private failTrack(slot: Slot, track: Track, error: unknown) {
    if (track.failure || this.tracks.get(slot) !== track) return;
    if (error instanceof Error && error.name === 'AbortError') throw error;
    this.captureDiagnostics(`track-${slot}-failure`, error);
    track.failure = { message: errorText(error), positionUs: this.positionUs };
    this.releaseReaders('track-failed', [track.source]);
    try { track.source.dispose(); } catch (cleanup) { log.warn('session', '故障轨道释放失败', { slot, error: errorText(cleanup) }); }
    log.warn('session', '轨道已停用，其余轨道继续', { slot, mediaId: track.source.info.id, ...track.failure });
  }
  private async ensureTrackIndexes(ptsUs: number | undefined, current: () => boolean) {
    const entries = this.playableEntries();
    const results = await this.waitForIndex(Promise.allSettled(entries.map(([, t]) => Promise.resolve().then(() => t.source.ensureIndexed?.(ptsUs === undefined ? undefined : Math.max(0, ptsUs - t.offsetUs))))));
    if (!current()) return;
    results.forEach((r, i) => { if (r.status === 'rejected') this.failTrack(...entries[i], r.reason); });
    if (!this.playableEntries().length) throw new Error('所有轨道均已停用，请重新载入片源。');
  }
  async seek(ptsUs: number) {
    const scoped = contextLog();
    timeUs(ptsUs);
    try {
      await this.run('seek', { ptsUs }, async current => {
        if (!this.tracks.size) throw new Error('请先打开视频。');
        await this.ensureTrackIndexes(ptsUs, current);
        if (!current()) return;
        await this.drawAt(Math.min(ptsUs, Math.max(0, this.durationUs - 1)), current);
      });
    } catch (error) {
      scoped[error instanceof Error && error.name === 'AbortError' ? 'info' : 'warn']('session', '定位失败', { ptsUs, error: errorText(error) });
      throw error;
    }
    scoped.info('session', '定位完成', {
      requestedUs: ptsUs, positionUs: this.positionUs, decodeMs: this.decodeMs,
      frames: Object.fromEntries([...this.tracks].map(([s, t]) => [s, t.frame?.ptsUs ?? null])),
    });
    return this.getState();
  }
  async step(direction: number) {
    const scoped = contextLog();
    if (direction !== -1 && direction !== 1) throw new Error('逐帧方向必须是 -1 或 1。');
    try {
      await this.run('step', { direction }, async current => {
        let entries = this.playableEntries();
        if (!entries.length || entries.some(([, t]) => !t.frame)) throw new Error('请先打开视频。');
        if (direction > 0) {
          await this.ensureTrackIndexes(this.positionUs, current);
          entries = this.playableEntries();
          if (!current()) return;
          await this.stepForward(entries, current);
        }
        else await this.stepBackward(entries, current);
      });
    } catch (error) {
      scoped[error instanceof Error && error.name === 'AbortError' ? 'info' : 'warn']('session', '逐帧失败', { direction, error: errorText(error) });
      throw error;
    }
    scoped.info('session', direction > 0 ? '前进一帧' : '后退一帧', {
      positionUs: this.positionUs, decodeMs: this.decodeMs,
      frames: Object.fromEntries([...this.tracks].map(([s, t]) => [s, t.frame?.ptsUs ?? null])),
    });
    return this.getState();
  }
  // Fair multi-track stepping ported from the native greedy planner: decode each
  // track's successor (or predecessor) frames, let the planner pick the target
  // that steps the most tracks without skipping frames, and keep the current
  // frame on tracks the target does not move.
  private async stepForward(entries: [Slot, Track][], current: () => boolean) {
    this.releaseReaders('step', entries.map(([, t]) => t.source));
    const probed = await Promise.allSettled(entries.map(async ([slot, t]) =>
      [slot, await t.source.framesAfter(t.frame!.ptsUs, 2)] as const));
    const gathered = new Map<Slot, (DecodedFrame | null)[]>();
    for (const r of probed) if (r.status === 'fulfilled') gathered.set(r.value[0], r.value[1]);
    const closeGathered = () => { for (const frames of gathered.values()) for (const f of frames) f?.close(); };
    const failed = probed.find(r => r.status === 'rejected');
    if (!current()) { closeGathered(); throw new DOMException('定位已取消。', 'AbortError'); }
    if (failed?.status === 'rejected') {
      try { probed.forEach((r, i) => { if (r.status === 'rejected') this.failTrack(...entries[i], r.reason); }); } catch (error) { closeGathered(); throw error; }
      entries = entries.filter(([, t]) => !t.failure);
      if (!entries.length) { closeGathered(); throw failed.reason; }
    }
    const target = planForwardStep(
      entries.map(([slot, t]) => {
        const [next, nextNext] = gathered.get(slot) ?? [];
        return { currentUs: t.frame!.ptsUs+t.offsetUs, durationUs: t.frame!.durationUs, nextUs: next ? next.ptsUs+t.offsetUs : null, nextNextUs: nextNext ? nextNext.ptsUs+t.offsetUs : null };
      }));
    if (target == null || target < 0 || target >= this.durationUs) { closeGathered(); return; }
    const selected = new Map<Slot, DecodedFrame>();
    for (const [slot,t] of entries) {
      const next = gathered.get(slot)?.[0];
      if (next && target >= next.ptsUs+t.offsetUs) selected.set(slot, next);
    }
    const chosen = new Set(selected.values());
    for (const frames of gathered.values()) for (const f of frames) if (f && !chosen.has(f)) f.close();
    const kept = new Set(entries.map(([slot]) => slot).filter(slot => !selected.has(slot)));
    await this.drawAt(target, current, this.tracks, undefined, selected, kept);
  }
  private async stepBackward(entries: [Slot, Track][], current: () => boolean) {
    this.releaseReaders('step', entries.map(([, t]) => t.source));
    const probed = await Promise.allSettled(entries.map(async ([slot, t]) => {
      const currentUs = t.frame!.ptsUs;
      if (currentUs <= 0) return [slot, null] as const;
      const frame = await t.source.frameAt(currentUs - 1);
      if (frame.ptsUs >= currentUs) { frame.close(); return [slot, null] as const; }
      return [slot, frame] as const;
    }));
    const gathered = new Map<Slot, DecodedFrame | null>();
    for (const r of probed) if (r.status === 'fulfilled') gathered.set(r.value[0], r.value[1]);
    const closeGathered = () => { for (const f of gathered.values()) f?.close(); };
    const failed = probed.find(r => r.status === 'rejected');
    if (!current()) { closeGathered(); throw new DOMException('定位已取消。', 'AbortError'); }
    if (failed?.status === 'rejected') {
      try { probed.forEach((r, i) => { if (r.status === 'rejected') this.failTrack(...entries[i], r.reason); }); } catch (error) { closeGathered(); throw error; }
      entries = entries.filter(([, t]) => !t.failure);
      if (!entries.length) { closeGathered(); throw failed.reason; }
    }
    const target = planBackwardStep(
      entries.map(([slot, t]) => { const previous=gathered.get(slot); return {currentUs:previous ? Math.max(0,t.frame!.ptsUs+t.offsetUs) : 0,previousUs:previous ? Math.max(0,previous.ptsUs+t.offsetUs) : null}; }));
    if (target == null || target < 0 || target >= this.durationUs) { closeGathered(); return; }
    const selected = new Map<Slot, DecodedFrame>();
    for (const [slot, t] of entries) {
      const previous = gathered.get(slot);
      if (previous && target < t.frame!.ptsUs+t.offsetUs) selected.set(slot, previous);
    }
    for (const [slot, f] of gathered) if (f && !selected.has(slot)) f.close();
    const kept = new Set(entries.map(([slot]) => slot).filter(slot => !selected.has(slot)));
    await this.drawAt(target, current, this.tracks, undefined, selected, kept);
  }
  private frameInfo(frame: FrameInfo): FrameInfo {
    return { ptsUs: frame.ptsUs, sourcePtsUs: frame.sourcePtsUs, durationUs: frame.durationUs };
  }
  private async drawAt(ptsUs: number, current: () => boolean, tracks = this.tracks, commit?: () => void, selected?: Map<Slot, DecodedFrame>, kept?: Set<Slot>) {
    const entries = [...tracks].filter(([, t]) => !t.failure);
    const start = performance.now();
    this.releaseReaders('position', entries.filter(([slot]) => !kept?.has(slot)).map(([, t]) => t.source));
    // Kept tracks hold their current frame (a fair-step target that does not
    // move them); re-resolving them by time could jump past an unseen frame.
    const results = await Promise.allSettled(entries.map(([slot, t]) => {
      if (kept?.has(slot)) return Promise.resolve(null);
      const chosen = selected?.get(slot);
      return chosen ? Promise.resolve(chosen) : t.source.frameAt(Math.max(0,Math.min(t.source.info.durationUs-1,ptsUs-t.offsetUs)));
    }));
    try {
      if (!current()) throw new DOMException('定位已取消。', 'AbortError');
      const failed = results.find(r => r.status === 'rejected');
      if (failed?.status === 'rejected') {
        if (tracks !== this.tracks || commit) throw failed.reason;
        results.forEach((r, i) => { if (r.status === 'rejected') this.failTrack(...entries[i], r.reason); });
        if (!this.playableEntries().length) throw failed.reason;
      }
      for (let i = 0; i < entries.length; i++) {
        const r = results[i];
        if (r.status !== 'fulfilled' || !r.value) continue;
        this.draw(entries[i][0], r.value);
        recordPresentedFrame(entries[i][1].source,r.value);
        entries[i][1].frame = this.frameInfo(r.value);
        entries[i][1].syncState = undefined;
      }
      commit?.();
      this.positionUs = ptsUs;
      this.decodeMs = Math.round(performance.now() - start);
    } finally {
      for (const result of results) if (result.status === 'fulfilled') result.value?.close();
    }
  }
  async play() {
    const scoped = contextLog();
    if (this.playing) return this.getState();
    if (!this.tracks.size) throw new Error('请先载入视频。');
    if (!this.playableEntries().length) throw new Error('所有轨道均已停用，请重新载入片源。');
    if (this.busy) throw new Error('请等待当前操作完成后再播放。');
    if (this.positionUs >= this.durationUs - 1 && !this.playableEntries().some(([, t]) => t.source.info.indexState === 'building')) {
      const seek = this.seek(0), revision = this.revision;
      await seek;
      if (revision !== this.revision) return this.getState();
    }
    if ([...this.tracks.values()].some(t => !t.frame)) throw new Error('请先完成画面定位。');
    this.error = null;
    ++this.revision;
    this.playing = true;
    scoped.info('session', '开始播放', { positionUs: this.positionUs });
    const revision = this.revision;
    const base = this.positionUs;
    const start = performance.now();
    this.emit();
    void this.playbackLoop(revision, base, start);
    return this.getState();
  }
  // Decoders run independently. A bounded queue provides backpressure; the
  // common clock waits for both tracks instead of leaving their frames behind.
  private async playbackLoop(revision: number, base: number, start: number) {
    const scoped = contextLog();
    const active = () => this.playing && revision === this.revision;
    const entries = this.playableEntries();
    const readers = entries.map(([slot, t]) => {
      let reader = this.readers.get(t.source);
      const reused = !!reader;
      if (!reader) { reader = new FrameQueue(t.source.framesFrom(t.frame!.ptsUs)); this.readers.set(t.source, reader); }
      scoped.debug('session', '播放队列就绪', { slot, mediaId: t.source.info.id, reused, frameUs: t.frame!.ptsUs, buffer: reader.snapshot() });
      return reader;
    });
    readers.forEach(r => r.resume());
    const metrics = this.measurements = new PlaybackMeasurements();
    let lastTick = start, lastEmit = start, lastSample = start, lastProgress = start;
    let cancelTick: (() => void) | undefined;
    const stop = () => { readers.forEach(r => r.suspend()); cancelTick?.(); };
    this.stopPlayback = stop;
    const tick = () => new Promise<void>(resolve => {
      const finish = () => { cancelTick = undefined; resolve(); };
      if (typeof requestAnimationFrame === 'function') {
        const id = requestAnimationFrame(finish);
        cancelTick = () => { cancelAnimationFrame(id); finish(); };
      } else {
        const id = setTimeout(finish, 8);
        cancelTick = () => { clearTimeout(id); finish(); };
      }
    });
    try {
      while (active()) {
        await tick();
        if (!active()) break;
        const now = performance.now();
        const elapsed = now - lastTick; lastTick = now;
        readers.forEach((reader, i) => { if (reader.error && !entries[i][1].failure) this.failTrack(...entries[i], reader.error); });
        if (!entries.some(([, t]) => !t.failure)) throw new Error('所有轨道均已停用，请重新载入片源。');
        // A future indexed frame proves coverage, including VFR timestamp gaps.
        // Only a drained producer proves that the final frame covers the end.
        readers.forEach((reader, i) => {
          const track = entries[i][1];
          if (track.source.info.indexWaiting && reader.frames.length === 0) track.syncState = 'index-wait';
          else if (track.syncState) track.syncState = reader.ended || (reader.frames.at(-1)?.ptsUs ?? track.frame!.ptsUs) + track.offsetUs >= this.positionUs ? undefined : 'catching-up';
        });
        const waitingForIndex = (i: number) => !!entries[i][1].syncState;
        const coverage = Math.min(...readers.map((r, i) => entries[i][1].failure || waitingForIndex(i) ? Infinity : r.ended ? this.durationUs - 1
          : (r.frames.at(-1)?.ptsUs ?? entries[i][1].frame!.ptsUs) + entries[i][1].offsetUs));
        const target = Math.max(this.positionUs, Math.min(this.durationUs - 1,
          this.positionUs + Math.round(elapsed * 1000), coverage));
        const advance = target - this.positionUs;
        metrics.waitingMs += Math.max(0, elapsed - advance / 1000);
        if (advance > 0) lastProgress = now;
        if (now - lastProgress > 15000) {
          readers.forEach((reader, i) => {
            const [slot, track] = entries[i];
            if (!track.failure && !track.source.info.indexWaiting && !reader.ended && (reader.frames.at(-1)?.ptsUs ?? track.frame!.ptsUs) + track.offsetUs <= this.positionUs)
              this.failTrack(slot, track, new Error('解码超过 15 秒没有推进，请重新载入此轨道。'));
          });
          lastProgress = now; continue;
        }
        for (let i = 0; i < entries.length; i++) {
          const [slot, track] = entries[i];
          if (track.failure) continue;
          metrics.buffer(slot, readers[i]);
          if(target < track.offsetUs) metrics.holdBeforeStart(slot,now);
          const { frame, dropped } = readers[i].take(target-track.offsetUs);
          if (!frame) continue;
          try {
            if (frame.ptsUs !== track.frame?.ptsUs) {
              this.draw(slot, frame);
              recordPresentedFrame(track.source,frame);
              track.frame = this.frameInfo(frame);
              metrics.draw(slot, performance.now(), dropped);
            }
          } catch (error) { this.failTrack(slot, track, error); } finally { frame.close(); }
        }
        this.positionUs = target;
        metrics.wallMs = performance.now() - start;
        metrics.mediaUs = target - base;
        // Holding a finished track is intentional, not decoder lag or track skew.
        const pts = entries.map(([, t], i) => t.failure ? target : readers[i].ended && target >= t.source.info.durationUs+t.offsetUs
          ? target : Math.min(target,Math.max(0,t.frame!.ptsUs+t.offsetUs)));
        metrics.maxFrameLagUs = Math.max(metrics.maxFrameLagUs, target - Math.min(...pts));
        metrics.maxFrameSkewUs = Math.max(metrics.maxFrameSkewUs, Math.max(...pts) - Math.min(...pts));
        this.emitProgress();
        // Rich UI/state snapshots remain throttled; progress follows every presentation tick.
        if (now - lastEmit >= 100) { lastEmit = now; this.emit(); }
        if (now - lastSample >= 2000) {
          lastSample = now;
          scoped.debug('session', '播放采样', metrics.snapshot());
        }
        if (target >= this.durationUs - 1 && !this.playableEntries().some(([, t]) => t.source.info.indexState === 'building')) {
          this.playing = false;
          scoped.info('session', '播放到末尾结束', { positionUs: target });
        }
      }
    } catch (error) {
      if (active()) {
        this.captureDiagnostics('playback-error', error);
        this.playing = false;
        this.error = errorText(error);
        scoped.warn('session', '播放中断', { positionUs: this.positionUs, error: this.error });
      }
    } finally {
      // Pause retains the iterator and unseen frames. A seek/replacement has
      // already detached and stopped these readers; an older loop must never
      // stop readers that a rapid resume has adopted.
      if (revision === this.revision) this.releaseReaders('playback-finished');
      scoped.info('session', '播放统计', metrics.snapshot());
      if (revision === this.revision) { this.stopPlayback = undefined; this.emit(); }
    }
  }
  addMark(input: { slot: unknown; text: unknown; severity?: unknown; origin?: unknown; region?: unknown; drawings?: unknown }) {
    if (this.busy || this.playing) throw new Error('请暂停并等待画面定位完成后再标注。');
    const slot = slotValue(input.slot);
    const track = this.tracks.get(slot);
    if (track?.syncState) throw new Error('当前轨道尚未同步，请等待追赶完成或定位后再标注。');
    if (!track?.frame || track.failure) throw new Error('当前轨道没有可标注的有效画面，请重新载入停用的片源。');
    const drawings = drawingsValue(input.drawings);
    if (typeof input.text !== 'string' || input.text.length > 2000 || (!input.text.trim() && !drawings.length)) throw new Error('写点文字或在画面上画一笔即可保存。');
    const severity = input.severity ?? 3;
    if (!Number.isInteger(severity) || Number(severity) < 1 || Number(severity) > 5) throw new Error('严重度必须是 1–5。');
    const origin = input.origin ?? 'human';
    if (origin !== 'human' && origin !== 'agent') throw new Error('标注来源无效。');
    const mark: Mark = {
      ...(this.actor ? { author: { ...this.actor } } : {}),
      id: randomUUID(), text: input.text.trim(), severity: Number(severity), origin,
      createdAt: new Date().toISOString(), slot, mediaId: track.source.info.id,
      frame: this.frameInfo(track.frame), offsetUs:track.offsetUs, sessionPtsUs:this.positionUs, region: regionValue(input.region), ...(drawings.length ? { drawings } : {}),
      comparison: [...this.tracks].filter(([, t]) => t.frame && !t.failure && !t.syncState).map(([s, t]) => ({ slot: s, mediaId: t.source.info.id, frame: this.frameInfo(t.frame!), offsetUs:t.offsetUs })),
    };
    this.marks.push(mark); this.markChanged(mark.id);
    log.info('session', '添加标注', { id: mark.id, authorId: this.actor?.id ?? null, slot, severity: mark.severity, origin, frameUs: mark.frame.ptsUs, hasRegion: !!mark.region });
    this.emit();
    return structuredClone(mark);
  }
  updateMark(id: string, input: { text?: unknown; drawings?: unknown }) {
    const mark = this.marks.find(m => m.id === id);
    if (!mark) throw new Error('标注不存在。');
    if (this.busy || this.playing) throw new Error('请暂停并等待画面定位完成后再编辑标注。');
    const track = [...this.tracks.values()].find(t => t.source.info.id === mark.mediaId);
    if (!track?.frame || track.failure || track.syncState || track.frame.ptsUs !== mark.frame.ptsUs) throw new Error('请返回标注对应的画面后再编辑。');
    const text = input.text === undefined ? mark.text : input.text;
    const drawings = input.drawings === undefined ? mark.drawings ?? [] : drawingsValue(input.drawings);
    if (typeof text !== 'string' || text.length > 2000 || (!text.trim() && !drawings.length)) throw new Error('标注不能为空。');
    mark.text = text.trim(); mark.drawings = drawings; this.markChanged(id);
    log.info('session', '修改标注', { id, frameUs: mark.frame.ptsUs }); this.emit();
    return structuredClone(mark);
  }
  deleteMark(id: string) {
    if (!this.marks.some(mark => mark.id === id)) throw new Error('标注不存在。');
    this.marks = this.marks.filter(mark => mark.id !== id); this.markChanged(id);
    log.info('session', '删除标注', { id });
    this.emit();
    return this.getState();
  }
  exportWorkspace(serverUrl: string): WorkspaceFile {
    const media = [...this.catalog.values()].map(info => ({ ...info, ...(info.source ? { source: { ...info.source, url: workspaceUrl(info.source.url, serverUrl) } } : {}) }));
    return structuredClone({ schema: 'voidplayer-workspace', version: 1, generatedAt: new Date().toISOString(), serverUrl: workspaceUrl(serverUrl), positionUs: this.positionUs,
      tracks: this.order.flatMap(slot => { const t = this.tracks.get(slot); return t ? [{ slot, mediaId: t.source.info.id, offsetUs: t.offsetUs }] : []; }),
      media, marks: this.marks, viewport: new Viewport().snapshot() });
  }
  /** Prepare all sources and frames before swapping the active session. UI and agents share this transaction. */
  async restoreWorkspace(value: unknown, open: (info: MediaInfo) => Promise<MediaSource>) {
    const document = parseWorkspace(value);
    await this.run('restoreWorkspace', { tracks: document.tracks.length, marks: document.marks.length }, async current => {
      const next = new Map<Slot, Track>(); let committed = false;
      try {
        for (const track of document.tracks) {
          if (!current()) throw new DOMException('工作区导入已取消。', 'AbortError');
          const info = document.media.find(m => m.id === track.mediaId)!;
          const source = await open(info);
          next.set(track.slot, { source, frame: null, offsetUs: track.offsetUs });
          await this.waitForIndex(Promise.resolve(source.ensureIndexed?.(Math.max(0, document.positionUs - track.offsetUs))));
          const end = source.info.durationUs + track.offsetUs;
          if (!Number.isSafeInteger(end) || end <= 0) throw new Error(`片源 ${info.name} 的时长或偏移已不适用。`);
          updateMediaInfo(source,{id:info.id},'identity'); // Keep mark and comparison anchors stable after reopening decoders.
        }
        const duration = Math.max(0, ...[...next.values()].map(t => t.source.info.durationUs + t.offsetUs));
        await this.drawAt(Math.min(document.positionUs, Math.max(0, duration - 1)), current, next, () => {
          this.releaseReaders('restore');
          for (const track of this.tracks.values()) if (!track.failure) track.source.dispose();
          this.tracks = next; this.order = [...next.keys(), ...SLOTS.filter(slot => !next.has(slot))];
          this.catalog = new Map(document.media.map(info => [info.id, info]));
          for (const track of next.values()) {
            this.catalog.set(track.source.info.id, track.source.info);
            track.source.onInfoChange = () => { if ([...this.tracks.values()].some(t => t.source === track.source)) this.emit(); };
          }
          this.marks = document.marks; this.measurements = null; committed = true;
        });
      } finally { if (!committed) for (const track of next.values()) track.source.dispose(); }
    });
    return this.getState();
  }
  exportReview() {
    return structuredClone({ schema: 'voidplayer-web-review', version: 1, generatedAt: new Date().toISOString(),
      mediaIdentity: 'session-uuid-and-file-metadata-not-content-hash',
      frameEvidence: 'decoded-and-drawn-to-canvas', color: 'browser-managed-unverified',
      alignment: [...this.tracks].map(([slot,t])=>({slot,mediaId:t.source.info.id,offsetUs:t.offsetUs})),
      timeMapping:'sessionUs = normalizedMediaUs + offsetUs; source PTS retained separately',
      media: [...this.catalog.values()], marks: this.marks });
  }
  async dispose() {
    this.cancelLoad(); this.pause();
    this.releaseReaders('dispose');
    await this.queue.catch(() => {});
    for (const t of this.tracks.values()) if (!t.failure) t.source.dispose();
    this.tracks.clear();
    this.listeners.clear();
    this.progressListeners.clear();
  }
}
