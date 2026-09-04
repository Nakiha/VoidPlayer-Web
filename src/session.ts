import { regionValue, slotValue, stepTarget, timeUs } from './model.ts';
import type { FrameInfo, Mark, MediaInfo, Slot } from './model.ts';
import type { DecodedFrame, MediaSource } from './media.ts';

type Track = { source: MediaSource; frame: FrameInfo | null };
export class ReviewSession {
  private tracks = new Map<Slot, Track>();
  private catalog = new Map<string, MediaInfo>();
  private marks: Mark[] = [];
  private queue: Promise<unknown> = Promise.resolve();
  private revision = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private busy = false;
  private playing = false;
  private positionUs = 0;
  private error: string | null = null;
  private decodeMs = 0;
  private listeners = new Set<() => void>();
  private draw: (slot: Slot, frame: DecodedFrame) => void;
  constructor(draw: (slot: Slot, frame: DecodedFrame) => void) { this.draw = draw; }
  subscribe(listener: () => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private emit() { for (const listener of this.listeners) listener(); }
  getState() {
    return structuredClone({
      version: 1, busy: this.busy, playing: this.playing, positionUs: this.positionUs,
      durationUs: this.durationUs, error: this.error, lastDecodeMs: this.decodeMs,
      frameEvidence: 'decoded-and-drawn-to-canvas', audio: 'muted', color: 'browser-managed-unverified',
      tracks: [...this.tracks].map(([slot, t]) => ({ slot, ...t.source.info, frame: t.frame })),
      marks: this.marks,
    });
  }
  private get durationUs() { return this.tracks.size ? Math.min(...[...this.tracks.values()].map(t => t.source.info.durationUs)) : 0; }
  pause() {
    ++this.revision;
    clearTimeout(this.timer);
    this.playing = false;
    this.busy = false;
    this.emit();
    return this.getState();
  }
  private run<T>(work: (current: () => boolean) => Promise<T>): Promise<T> {
    this.pause();
    const revision = this.revision;
    this.busy = true;
    this.error = null;
    this.emit();
    const current = () => revision === this.revision;
    const operation = this.queue.catch(() => {}).then(async () => {
      if (!current()) throw new Error('操作已被更新的请求取代。');
      try {
        const result = await work(current);
        if (!current()) throw new Error('操作已被更新的请求取代。');
        return result;
      } catch (e) {
        if (current()) this.error = e instanceof Error ? e.message : String(e);
        throw e;
      } finally {
        if (current()) { this.busy = false; this.emit(); }
      }
    });
    this.queue = operation;
    return operation;
  }
  async load(slot: Slot, open: () => Promise<MediaSource>) {
    slotValue(slot);
    await this.run(async current => {
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
    return this.getState();
  }
  async seek(ptsUs: number) {
    timeUs(ptsUs);
    await this.run(async current => {
      if (!this.tracks.size) throw new Error('请先打开视频。');
      await this.drawAt(Math.min(ptsUs, Math.max(0, this.durationUs - 1)), current);
    });
    return this.getState();
  }
  async step(direction: number, referenceSlot: Slot = 'A') {
    slotValue(referenceSlot);
    if (direction !== -1 && direction !== 1) throw new Error('逐帧方向必须是 -1 或 1。');
    await this.run(async current => {
      const track = this.tracks.get(referenceSlot);
      if (!track?.frame) throw new Error(`请先打开视频 ${referenceSlot}。`);
      const selected = await track.source.frameAt(stepTarget(track.frame, direction, this.durationUs));
      // Align other tracks to the selected frame's start, not the probe just
      // before/after its boundary (important with different frame rates).
      await this.drawAt(selected.ptsUs, current, this.tracks, undefined, { slot: referenceSlot, frame: selected });
    });
    return this.getState();
  }
  private frameInfo(frame: FrameInfo): FrameInfo {
    return { ptsUs: frame.ptsUs, sourcePtsUs: frame.sourcePtsUs, durationUs: frame.durationUs };
  }
  private async drawAt(ptsUs: number, current: () => boolean, tracks = this.tracks, commit?: () => void, selected?: { slot: Slot; frame: DecodedFrame }) {
    const entries = [...tracks];
    const start = performance.now();
    const results = await Promise.allSettled(entries.map(([slot, t]) => selected?.slot === slot ? Promise.resolve(selected.frame) : t.source.frameAt(ptsUs)));
    try {
      if (!current()) throw new Error('定位已取消。');
      const failed = results.find(r => r.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
      for (let i = 0; i < entries.length; i++) {
        const r = results[i];
        if (r.status !== 'fulfilled') continue;
        this.draw(entries[i][0], r.value);
        entries[i][1].frame = this.frameInfo(r.value);
      }
      commit?.();
      this.positionUs = ptsUs;
      this.decodeMs = Math.round(performance.now() - start);
    } finally {
      for (const result of results) if (result.status === 'fulfilled') result.value.close();
    }
  }
  async play() {
    await this.seek(this.positionUs >= this.durationUs - 1 ? 0 : this.positionUs);
    this.playing = true;
    const revision = this.revision;
    const base = this.positionUs;
    const start = performance.now();
    this.emit();
    const tick = async () => {
      if (revision !== this.revision || !this.playing) return;
      const target = Math.min(this.durationUs - 1, base + Math.round((performance.now() - start) * 1000));
      const pending = this.drawAt(target, () => revision === this.revision && this.playing);
      this.queue = pending;
      try {
        await pending;
        if (revision !== this.revision || !this.playing) return;
        if (target >= this.durationUs - 1) this.playing = false;
        this.emit();
        if (this.playing) this.timer = setTimeout(() => void tick(), 16);
      } catch (e) {
        if (revision !== this.revision) return;
        this.playing = false;
        this.error = e instanceof Error ? e.message : String(e);
        this.emit();
      }
    };
    this.timer = setTimeout(() => void tick(), 0);
    return this.getState();
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
    this.emit();
    return structuredClone(mark);
  }
  deleteMark(id: string) {
    if (!this.marks.some(mark => mark.id === id)) throw new Error('标注不存在。');
    this.marks = this.marks.filter(mark => mark.id !== id);
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
