import { FrameQueue, PlaybackMeasurements } from './playback.ts';
import { minFrameDurationUs, planBackwardStep, planForwardStep, regionValue, slotValue, timeUs } from './model.ts';
import type { FrameInfo, Mark, MediaInfo, Slot } from './model.ts';
import type { DecodedFrame, MediaSource } from './media.ts';
import { contextLog, log, operationContext, traceOperation, withLogContext } from './log.ts';

const errorText = (e: unknown) => e instanceof Error ? e.message : String(e);

type Track = { source: MediaSource; frame: FrameInfo | null };
export class ReviewSession {
  private tracks = new Map<Slot, Track>();
  private catalog = new Map<string, MediaInfo>();
  private marks: Mark[] = [];
  private queue: Promise<unknown> = Promise.resolve();
  private revision = 0;
  private stopPlayback: (() => void) | undefined;
  private measurements: PlaybackMeasurements | null = null;
  private busy = false;
  private playing = false;
  private positionUs = 0;
  private error: string | null = null;
  private decodeMs = 0;
  private listeners = new Set<() => void>();
  private draw: (slot: Slot, frame: DecodedFrame) => void;
  constructor(draw: (slot: Slot, frame: DecodedFrame) => void) { this.draw = draw; }
  subscribe(listener: () => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private lastTransition = '';
  private emit() {
    const state = { busy: this.busy, playing: this.playing, error: this.error, tracks: [...this.tracks].map(([slot, t]) => ({ slot, id: t.source.info.id })) };
    const signature = JSON.stringify(state);
    if (signature !== this.lastTransition) {
      log.info('session', '状态变化', { before: this.lastTransition ? JSON.parse(this.lastTransition) : null, after: state, positionUs: this.positionUs });
      this.lastTransition = signature;
    }
    for (const listener of this.listeners) listener();
  }
  getState() {
    return structuredClone({
      version: 1, busy: this.busy, playing: this.playing, positionUs: this.positionUs,
      durationUs: this.durationUs, error: this.error, lastDecodeMs: this.decodeMs,
      playback: this.measurements?.snapshot() ?? null,
      frameEvidence: 'decoded-and-drawn-to-canvas', audio: 'muted', color: 'browser-managed-unverified',
      tracks: [...this.tracks].map(([slot, t]) => ({ slot, ...t.source.info, frame: t.frame })),
      marks: this.marks,
    });
  }
  private get durationUs() { return this.tracks.size ? Math.min(...[...this.tracks.values()].map(t => t.source.info.durationUs)) : 0; }
  pause() {
    const wasPlaying = this.playing;
    ++this.revision;
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
      this.pause();
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
          if (current()) this.error = e instanceof Error ? e.message : String(e);
          throw e;
        } finally {
          if (current()) { this.busy = false; withLogContext(context, () => this.emit()); }
        }
      });
      this.queue = operation;
      return operation;
    });
  }
  async load(slot: Slot, open: () => Promise<MediaSource>) {
    const scoped = contextLog();
    slotValue(slot);
    const replacing = this.tracks.get(slot)?.source.info.name;
    try {
      await this.run('load', { slot }, async current => {
        const source = await open();
        let committed = false;
        try {
          const next = new Map(this.tracks);
          next.set(slot, { source, frame: null });
          await this.drawAt(0, current, next, () => {
            this.tracks.get(slot)?.source.dispose();
            this.tracks = next;
            this.catalog.set(source.info.id, source.info);
            committed = true;
          });
        } finally { if (!committed) source.dispose(); }
      });
    } catch (error) {
      scoped[error instanceof Error && error.name === 'AbortError' ? 'info' : 'warn']('session', `载入轨道 ${slot} 失败`, { replacing, error: errorText(error) });
      throw error;
    }
    const info = this.tracks.get(slot)!.source.info;
    scoped.info('media', `轨道 ${slot} 已载入`, {
      name: info.name, size: info.size, codec: info.codec, decoder: info.decoder,
      width: info.width, height: info.height, durationUs: info.durationUs, replacing,
    });
    return this.getState();
  }
  async seek(ptsUs: number) {
    const scoped = contextLog();
    timeUs(ptsUs);
    try {
      await this.run('seek', { ptsUs }, async current => {
        if (!this.tracks.size) throw new Error('请先打开视频。');
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
        const entries = [...this.tracks];
        if (!entries.length || entries.some(([, t]) => !t.frame)) throw new Error('请先打开视频。');
        if (direction > 0) await this.stepForward(entries, current);
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
    const probed = await Promise.allSettled(entries.map(async ([slot, t]) =>
      [slot, await t.source.framesAfter(t.frame!.ptsUs, 2)] as const));
    const gathered = new Map<Slot, (DecodedFrame | null)[]>();
    for (const r of probed) if (r.status === 'fulfilled') gathered.set(r.value[0], r.value[1]);
    const closeGathered = () => { for (const frames of gathered.values()) for (const f of frames) f?.close(); };
    const failed = probed.find(r => r.status === 'rejected');
    if (failed?.status === 'rejected') { closeGathered(); throw failed.reason; }
    if (!current()) { closeGathered(); throw new DOMException('定位已取消。', 'AbortError'); }
    const target = planForwardStep(
      entries.map(([slot, t]) => {
        const [next, nextNext] = gathered.get(slot) ?? [];
        return { currentUs: t.frame!.ptsUs, nextUs: next?.ptsUs ?? null, nextNextUs: nextNext?.ptsUs ?? null };
      }),
      minFrameDurationUs(entries.map(([, t]) => t.frame!.durationUs)));
    if (target == null) { closeGathered(); return; }
    const selected = new Map<Slot, DecodedFrame>();
    for (const [slot] of entries) {
      const next = gathered.get(slot)?.[0];
      if (next && target >= next.ptsUs) selected.set(slot, next);
    }
    const chosen = new Set(selected.values());
    for (const frames of gathered.values()) for (const f of frames) if (f && !chosen.has(f)) f.close();
    const kept = new Set(entries.map(([slot]) => slot).filter(slot => !selected.has(slot)));
    await this.drawAt(target, current, this.tracks, undefined, selected, kept);
  }
  private async stepBackward(entries: [Slot, Track][], current: () => boolean) {
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
    if (failed?.status === 'rejected') { closeGathered(); throw failed.reason; }
    if (!current()) { closeGathered(); throw new DOMException('定位已取消。', 'AbortError'); }
    const target = planBackwardStep(
      entries.map(([slot, t]) => ({ currentUs: t.frame!.ptsUs, previousUs: gathered.get(slot)?.ptsUs ?? null })));
    if (target == null) { closeGathered(); return; }
    const selected = new Map<Slot, DecodedFrame>();
    for (const [slot, t] of entries) {
      const previous = gathered.get(slot);
      if (previous && target < t.frame!.ptsUs) selected.set(slot, previous);
    }
    for (const [slot, f] of gathered) if (f && !selected.has(slot)) f.close();
    const kept = new Set(entries.map(([slot]) => slot).filter(slot => !selected.has(slot)));
    await this.drawAt(target, current, this.tracks, undefined, selected, kept);
  }
  private frameInfo(frame: FrameInfo): FrameInfo {
    return { ptsUs: frame.ptsUs, sourcePtsUs: frame.sourcePtsUs, durationUs: frame.durationUs };
  }
  private async drawAt(ptsUs: number, current: () => boolean, tracks = this.tracks, commit?: () => void, selected?: Map<Slot, DecodedFrame>, kept?: Set<Slot>) {
    const entries = [...tracks];
    const start = performance.now();
    // Kept tracks hold their current frame (a fair-step target that does not
    // move them); re-resolving them by time could jump past an unseen frame.
    const results = await Promise.allSettled(entries.map(([slot, t]) => {
      if (kept?.has(slot)) return Promise.resolve(null);
      const chosen = selected?.get(slot);
      return chosen ? Promise.resolve(chosen) : t.source.frameAt(ptsUs);
    }));
    try {
      if (!current()) throw new DOMException('定位已取消。', 'AbortError');
      const failed = results.find(r => r.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
      for (let i = 0; i < entries.length; i++) {
        const r = results[i];
        if (r.status !== 'fulfilled' || !r.value) continue;
        this.draw(entries[i][0], r.value);
        entries[i][1].frame = this.frameInfo(r.value);
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
    await this.seek(this.positionUs >= this.durationUs - 1 ? 0 : this.positionUs);
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
    const entries = [...this.tracks];
    const readers = entries.map(([, t]) => new FrameQueue(t.source.framesFrom(t.frame!.ptsUs)));
    const metrics = this.measurements = new PlaybackMeasurements();
    let lastTick = start, lastEmit = start, lastSample = start, lastProgress = start;
    let cancelTick: (() => void) | undefined;
    const stop = () => { readers.forEach(r => r.stop()); cancelTick?.(); };
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
        const failed = readers.find(r => r.error);
        if (failed) throw failed.error;
        // A future indexed frame proves coverage, including VFR timestamp gaps.
        // Only a drained producer proves that the final frame covers the end.
        const coverage = Math.min(...readers.map((r, i) => r.ended ? this.durationUs - 1
          : r.frames.at(-1)?.ptsUs ?? entries[i][1].frame!.ptsUs));
        const target = Math.max(this.positionUs, Math.min(this.durationUs - 1,
          this.positionUs + Math.round(elapsed * 1000), coverage));
        const advance = target - this.positionUs;
        metrics.waitingMs += Math.max(0, elapsed - advance / 1000);
        if (advance > 0) lastProgress = now;
        if (now - lastProgress > 15000) throw new Error('解码超过 15 秒没有推进，请重新载入视频。');
        for (let i = 0; i < entries.length; i++) {
          const [slot, track] = entries[i];
          const { frame, dropped } = readers[i].take(target);
          if (!frame) continue;
          try {
            if (frame.ptsUs !== track.frame?.ptsUs) {
              this.draw(slot, frame);
              track.frame = this.frameInfo(frame);
              metrics.draw(slot, performance.now(), dropped);
            }
          } finally { frame.close(); }
        }
        this.positionUs = target;
        metrics.wallMs = performance.now() - start;
        metrics.mediaUs = target - base;
        const pts = entries.map(([, t]) => t.frame!.ptsUs);
        metrics.maxFrameLagUs = Math.max(metrics.maxFrameLagUs, target - Math.min(...pts));
        metrics.maxFrameSkewUs = Math.max(metrics.maxFrameSkewUs, Math.max(...pts) - Math.min(...pts));
        // Canvas drawing is independent of the expensive DOM/state snapshot.
        if (now - lastEmit >= 100) { lastEmit = now; this.emit(); }
        if (now - lastSample >= 2000) {
          lastSample = now;
          scoped.debug('session', '播放采样', metrics.snapshot());
        }
        if (target >= this.durationUs - 1) {
          this.playing = false;
          scoped.info('session', '播放到末尾结束', { positionUs: target });
        }
      }
    } catch (error) {
      if (active()) {
        this.playing = false;
        this.error = errorText(error);
        scoped.warn('session', '播放中断', { positionUs: this.positionUs, error: this.error });
      }
    } finally {
      stop();
      scoped.info('session', '播放统计', metrics.snapshot());
      if (revision === this.revision) { this.stopPlayback = undefined; this.emit(); }
    }
  }
  addMark(input: { slot: unknown; text: unknown; severity?: unknown; origin?: unknown; region?: unknown }) {
    if (this.busy || this.playing) throw new Error('请暂停并等待画面定位完成后再标注。');
    const slot = slotValue(input.slot);
    const track = this.tracks.get(slot);
    if (!track?.frame) throw new Error('当前轨道没有可标注的画面。');
    if (typeof input.text !== 'string' || !input.text.trim() || input.text.length > 2000) throw new Error('请填写 1–2000 字的标注。');
    const severity = input.severity ?? 3;
    if (!Number.isInteger(severity) || Number(severity) < 1 || Number(severity) > 5) throw new Error('严重度必须是 1–5。');
    const origin = input.origin ?? 'human';
    if (origin !== 'human' && origin !== 'agent') throw new Error('标注来源无效。');
    const mark: Mark = {
      id: crypto.randomUUID(), text: input.text.trim(), severity: Number(severity), origin,
      createdAt: new Date().toISOString(), slot, mediaId: track.source.info.id,
      frame: this.frameInfo(track.frame), region: regionValue(input.region),
      comparison: [...this.tracks].filter(([, t]) => t.frame).map(([s, t]) => ({ slot: s, mediaId: t.source.info.id, frame: this.frameInfo(t.frame!) })),
    };
    this.marks.push(mark);
    log.info('session', '添加标注', { id: mark.id, slot, severity: mark.severity, origin, frameUs: mark.frame.ptsUs, hasRegion: !!mark.region });
    this.emit();
    return structuredClone(mark);
  }
  deleteMark(id: string) {
    if (!this.marks.some(mark => mark.id === id)) throw new Error('标注不存在。');
    this.marks = this.marks.filter(mark => mark.id !== id);
    log.info('session', '删除标注', { id });
    this.emit();
    return this.getState();
  }
  exportReview() {
    return structuredClone({ schema: 'voidplayer-web-review', version: 1, generatedAt: new Date().toISOString(),
      mediaIdentity: 'session-uuid-and-file-metadata-not-content-hash',
      frameEvidence: 'decoded-and-drawn-to-canvas', color: 'browser-managed-unverified',
      media: [...this.catalog.values()], marks: this.marks });
  }
  async dispose() {
    this.pause();
    await this.queue.catch(() => {});
    for (const t of this.tracks.values()) t.source.dispose();
    this.tracks.clear();
    this.listeners.clear();
  }
}
