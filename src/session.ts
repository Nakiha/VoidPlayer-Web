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

type Track = { source: MediaSource; frame: FrameInfo | null; offsetUs:number };
export class ReviewSession {
  private order: Slot[] = [...SLOTS];
  private tracks = new Map<Slot, Track>();
  private catalog = new Map<string, MediaInfo>();
  private marks: Mark[] = [];
  private actor: { id: string; name: string } | null = null;
  setActor(actor: { id: string; name: string } | null) { this.actor = actor ? { id: actor.id, name: actor.name } : null; }
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
    const state = { busy: this.busy, playing: this.playing, error: this.error, tracks: [...this.tracks].map(([slot, t]) => ({ slot, id: t.source.info.id })) };
    const signature = JSON.stringify(state);
    if (signature !== this.lastTransition) {
      log.info('session', '状态变化', { before: this.lastTransition ? JSON.parse(this.lastTransition) : null, after: state, positionUs: this.positionUs });
      this.lastTransition = signature;
    }
    for (const listener of this.listeners) listener();
    this.emitProgress();
  }
  getState() {
    return structuredClone({
      version: 1, busy: this.busy, playing: this.playing, positionUs: this.positionUs,
      durationUs: this.durationUs, error: this.error, lastDecodeMs: this.decodeMs,
      playback: this.measurements?.snapshot() ?? null,
      frameEvidence: 'decoded-and-drawn-to-canvas', audio: 'muted', color: 'browser-managed-unverified',
      tracks: this.order.flatMap(slot => { const t = this.tracks.get(slot); return t ? [{ slot, ...t.source.info, frame: t.frame, offsetUs:t.offsetUs }] : []; }),
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
  private get durationUs() { return Math.max(0, ...[...this.tracks.values()].map(t => t.source.info.durationUs + t.offsetUs)); }
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
          if (source.info.source && [...this.tracks].some(([other, track]) => other !== slot && track.source.info.source?.id === source.info.source!.id)) throw new Error('该片源已在视图中，不能重复添加。');
          const next = new Map(this.tracks);
          next.set(slot, { source, frame: null, offsetUs:0 });
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
  async removeTrack(slot: Slot) {
    slotValue(slot);
    await this.run('removeTrack', { slot }, async current => {
      const track = this.tracks.get(slot);
      this.tracks.delete(slot);
      track?.source.dispose();
      if (!this.tracks.size) { this.positionUs = 0; this.measurements = null; }
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
    const entries = [...tracks];
    const start = performance.now();
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
          : (r.frames.at(-1)?.ptsUs ?? entries[i][1].frame!.ptsUs) + entries[i][1].offsetUs));
        const target = Math.max(this.positionUs, Math.min(this.durationUs - 1,
          this.positionUs + Math.round(elapsed * 1000), coverage));
        const advance = target - this.positionUs;
        metrics.waitingMs += Math.max(0, elapsed - advance / 1000);
        if (advance > 0) lastProgress = now;
        if (now - lastProgress > 15000) throw new Error('解码超过 15 秒没有推进，请重新载入视频。');
        for (let i = 0; i < entries.length; i++) {
          const [slot, track] = entries[i];
          if(target < track.offsetUs) metrics.holdBeforeStart(slot,now);
          const { frame, dropped } = readers[i].take(target-track.offsetUs);
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
        // Holding a finished track is intentional, not decoder lag or track skew.
        const pts = entries.map(([, t], i) => readers[i].ended && target >= t.source.info.durationUs+t.offsetUs
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
  addMark(input: { slot: unknown; text: unknown; severity?: unknown; origin?: unknown; region?: unknown; drawings?: unknown }) {
    if (this.busy || this.playing) throw new Error('请暂停并等待画面定位完成后再标注。');
    const slot = slotValue(input.slot);
    const track = this.tracks.get(slot);
    if (!track?.frame) throw new Error('当前轨道没有可标注的画面。');
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
      comparison: [...this.tracks].filter(([, t]) => t.frame).map(([s, t]) => ({ slot: s, mediaId: t.source.info.id, frame: this.frameInfo(t.frame!), offsetUs:t.offsetUs })),
    };
    this.marks.push(mark);
    log.info('session', '添加标注', { id: mark.id, authorId: this.actor?.id ?? null, slot, severity: mark.severity, origin, frameUs: mark.frame.ptsUs, hasRegion: !!mark.region });
    this.emit();
    return structuredClone(mark);
  }
  updateMark(id: string, input: { text?: unknown; drawings?: unknown }) {
    const mark = this.marks.find(m => m.id === id);
    if (!mark) throw new Error('标注不存在。');
    if (this.busy || this.playing) throw new Error('请暂停并等待画面定位完成后再编辑标注。');
    const track = [...this.tracks.values()].find(t => t.source.info.id === mark.mediaId);
    if (!track?.frame || track.frame.ptsUs !== mark.frame.ptsUs) throw new Error('请返回标注对应的画面后再编辑。');
    const text = input.text === undefined ? mark.text : input.text;
    const drawings = input.drawings === undefined ? mark.drawings ?? [] : drawingsValue(input.drawings);
    if (typeof text !== 'string' || text.length > 2000 || (!text.trim() && !drawings.length)) throw new Error('标注不能为空。');
    mark.text = text.trim(); mark.drawings = drawings;
    log.info('session', '修改标注', { id, frameUs: mark.frame.ptsUs }); this.emit();
    return structuredClone(mark);
  }
  deleteMark(id: string) {
    if (!this.marks.some(mark => mark.id === id)) throw new Error('标注不存在。');
    this.marks = this.marks.filter(mark => mark.id !== id);
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
          const end = source.info.durationUs + track.offsetUs;
          if (!Number.isSafeInteger(end) || end <= 0) throw new Error(`片源 ${info.name} 的时长或偏移已不适用。`);
          source.info.id = info.id; // Keep mark and comparison anchors stable after reopening decoders.
        }
        const duration = Math.max(0, ...[...next.values()].map(t => t.source.info.durationUs + t.offsetUs));
        await this.drawAt(Math.min(document.positionUs, Math.max(0, duration - 1)), current, next, () => {
          for (const track of this.tracks.values()) track.source.dispose();
          this.tracks = next; this.order = [...next.keys(), ...SLOTS.filter(slot => !next.has(slot))];
          this.catalog = new Map(document.media.map(info => [info.id, info]));
          for (const track of next.values()) this.catalog.set(track.source.info.id, track.source.info);
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
    this.pause();
    await this.queue.catch(() => {});
    for (const t of this.tracks.values()) t.source.dispose();
    this.tracks.clear();
    this.listeners.clear();
    this.progressListeners.clear();
  }
}
