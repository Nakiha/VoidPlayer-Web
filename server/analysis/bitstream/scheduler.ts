import type {AnalysisResources} from '../../../shared/service/admin.ts';
import {validateDemandPlan} from '../../../shared/analysis/bitstream/demand.ts';
import type {DemandPlan} from '../../../shared/analysis/bitstream/demand.ts';
import { analysisIndexIdentity, isProduct, isSummary, validateOutput, productKey, metadata, metadataBudgetBytes, PRODUCT_LIMIT, SUMMARY_BATCH_LIMIT } from '../../../shared/analysis/bitstream/products.ts';
import type { AnalysisOutput, AnalysisSummary } from '../../../shared/analysis/bitstream/products.ts';
import { FLV_MEDIA_INDEX_IDENTITY, JS_TS_MEDIA_INDEX_IDENTITY,JS_MATROSKA_MEDIA_INDEX_IDENTITY } from '../../../shared/media/indexing/media-index-identity.ts';
import { DEFAULT_ANALYSIS_CONCURRENCY, validAnalysisConcurrency, ANALYSIS_WORKER_HEAP_BYTES } from './limits.ts';
import { Worker } from "node:worker_threads";
import { randomUUID, createHash } from "node:crypto";
import { open, readFile } from "node:fs/promises";
import path from "node:path";
import {
  ANALYSIS_RECIPE,
  ANALYZER_VERSION,
  BUDGET,
  validateTarget,
  validateRange,
  validateStream,
  pictureId,
} from "../../../shared/analysis/bitstream/contract.ts";
import type {
  AnalysisTarget,
  AnalysisRangeTarget,
  AnalysisStreamTarget,
} from "../../../shared/analysis/bitstream/contract.ts";
import { libraryAnalysisIndex } from "./index.ts";
import { AnalysisStore } from "./store.ts";
import {
  AnalysisFailure,
  failureInfo,
  restoreFailure,
} from "../../../shared/analysis/bitstream/failure.ts";
import type { AnalysisFailureInfo } from "../../../shared/analysis/bitstream/failure.ts";
import type { MediaLibraryIndex } from "../../library.ts";
declare const VOIDPLAYER_COMPILED: boolean;
import type { StreamChunkRef } from './store.ts';
import type { StreamProgress } from '../../../shared/analysis/bitstream/stream.ts';
type Work = {
  counters?:import("../../../shared/analysis/bitstream/counters.ts").AnalysisCounters;
  plan?:DemandPlan;
  published: number;
  batchStart?: number;
  pending: StreamChunkRef[];
  page: StreamChunkRef[];
  progress?: StreamProgress;
  wake?: () => void;
  writing?: Set<string>;
  done?: Promise<void>;
  id: string;
  mediaId: string;
  version: string;
  filePath: string;
  target: AnalysisTarget | AnalysisRangeTarget | AnalysisStreamTarget;
  chunks: string[];
  buildId: string;
  state:
    | "queued"
    | "running"
    | "complete"
    | "unsupported"
    | "limited"
    | "error"
    | "cancelled";
  error?: string;
  reason?: AnalysisFailureInfo;
  unsupportedResult?: AnalysisOutput;
  consumers: Set<string>;
  worker?: Worker;
  seq: number;
};
type Consumer = { work: Work; owner: string; expires: number; cursor: number; delivered: number; planDelivered?:boolean };
// Reserve capacity before constructing a worker, including index-waiting and
// consumer-backpressured jobs. Per-window admission cannot bound a shared server.
/** Bounded independent jobs; matching demands share work and consumer leases. */
export class AnalysisScheduler {
  private work = new Map<string, Work>();
  private consumers = new Map<string, Consumer>();
  private running = new Set<Work>();
  private timer?: ReturnType<typeof setInterval>;
  private closed = false;
  private concurrency = DEFAULT_ANALYSIS_CONCURRENCY;
  setConcurrency(value: number) {
    if (!validAnalysisConcurrency(value)) throw new RangeError("Invalid analysis concurrency");
    this.concurrency = value;
    // Reductions only affect future admission; existing workers keep their slots.
    this.pump();
  }
  resources(): AnalysisResources {
    return { concurrency: this.concurrency, running: this.running.size, queued: [...this.work.values()].filter(work => work.state === "queued").length };
  }
  private pendingSubmissions = 0;
  private resultReads = 0;
  private waitingReads: { signal: AbortSignal; resolve: (release: () => void) => void; reject: (error: unknown) => void; abort: () => void }[] = [];
  /** Bound transport buffers separately from worker concurrency. Busy readers
   * wait instead of failing an otherwise healthy parallel analysis. */
  waitForResultRead(signal: AbortSignal): Promise<() => void> {
    signal.throwIfAborted();
    if (this.closed) return Promise.reject(new AnalysisFailure('cancelled', 'Analysis service closed'));
    const release = this.reserveResultRead();
    if (release) return Promise.resolve(release);
    if (this.waitingReads.length >= BUDGET.requests) return Promise.reject(new AnalysisFailure('resource-limit', 'Analysis result transport queue full'));
    return new Promise((resolve, reject) => {
      const entry = { signal, resolve, reject, abort: () => {
        this.waitingReads = this.waitingReads.filter(item => item !== entry); reject(signal.reason);
      } };
      signal.addEventListener('abort', entry.abort, { once: true }); this.waitingReads.push(entry);
    });
  }
  private pumpReads() {
    while (!this.closed && this.waitingReads.length && this.resultReads < 2) {
      const entry = this.waitingReads.shift()!;
      entry.signal.removeEventListener('abort', entry.abort);
      entry.resolve(this.reserveResultRead()!);
    }
  }
  reserveResultRead() {
    if (this.resultReads >= 2) return null;
    this.resultReads++;
    let released = false;
    return () => {
      if (!released) {
        released = true;
        this.resultReads--; this.pumpReads();
      }
    };
  }
  private submissions: Promise<unknown> = Promise.resolve();
  readonly store: AnalysisStore;
  private library: MediaLibraryIndex;
  private coreDir: string;
  private now: () => number;
  private leaseMs: number;
  private unregisterQuality: () => void;
  constructor(
    library: MediaLibraryIndex,
    coreDir: string,
    directory: string,
    now = () => Date.now(),
    leaseMs: number = BUDGET.leaseMs,
  ) {
    this.library = library;
    this.coreDir = coreDir;
    this.now = now;
    this.leaseMs = leaseMs;
    this.unregisterQuality = library.qualityAdmission.register(() => !!(this.pendingSubmissions || this.running.size || [...this.work.values()].some(work => work.state === 'queued')));
    this.store = new AnalysisStore(directory, undefined, () => this.protectedFiles());
  }
  async buildIdentity() { const manifest=JSON.parse(await readFile(path.join(this.coreDir,'manifest.json'),'utf8'));return manifest.buildId ?? manifest.revision; }
  submit(
    mediaId: string,
    version: string,
    target: AnalysisTarget | AnalysisRangeTarget | AnalysisStreamTarget,
    owner: string,
  ) {
    try { this.library.qualityAdmission.ordinary(); } catch { return Promise.reject(new AnalysisFailure('resource-limit','Quality execution owns the compute admission')); }
    if (this.closed || this.pendingSubmissions >= BUDGET.requests)
      return Promise.reject(
        new AnalysisFailure("resource-limit", "Analysis request queue full"),
      );
    this.pendingSubmissions++;
    const task = this.submissions
      .then(() => this.submitInner(mediaId, version, target, owner))
      .finally(() => {
        this.pendingSubmissions--;
      });
    this.submissions = task.catch(() => {});
    return task;
  }
  private async submitInner(
    mediaId: string,
    version: string,
    target: AnalysisTarget | AnalysisRangeTarget | AnalysisStreamTarget,
    owner: string,
  ) {
    if (this.closed) throw new Error("Analysis service closed");
    if (!target || typeof target !== "object") throw new AnalysisFailure("invalid-request", "Invalid analysis target");
    if ("mode" in target) validateStream(target);
    else if ("startUs" in target) validateRange(target);
    else validateTarget(target);
    if (target.sourceVersion !== `${mediaId}@${version}`)
      throw new AnalysisFailure(
        "source-changed",
        "Analysis source version mismatch",
      );
    if (this.consumers.size >= BUDGET.requests)
      throw new AnalysisFailure(
        "resource-limit",
        "Analysis request queue full",
      );
    const filePath = await this.library.resolve(mediaId, version);
    if (!filePath)
      throw new AnalysisFailure(
        "source-changed",
        "Analysis media version changed",
      );
    // Resolve legacy TS requests before cache lookup or index subscription. Old
    // FFmpeg AU ordinals cannot be reinterpreted in the JS picture namespace.
    const probe = await open(filePath, 'r');
    try {
      const header = Buffer.alloc(9); await probe.read(header, 0, 9, 0);
      if (header[0] === 0x47 && target.indexIdentity?.kind !== 'js-ts') {
        if ('picture' in target && target.picture)
          throw new AnalysisFailure('ambiguous-picture-identity', 'TS picture requires the current JS playback identity');
        target = {...target, indexIdentity: JS_TS_MEDIA_INDEX_IDENTITY};
      }
      if(header.readUInt32BE(0)===0x1a45dfa3&&target.indexIdentity?.kind!=='js-matroska'){
        if('picture' in target&&target.picture)throw new AnalysisFailure('ambiguous-picture-identity','Matroska picture requires the current JS playback identity');
        target={...target,indexIdentity:JS_MATROSKA_MEDIA_INDEX_IDENTITY};
      }
      if(target.indexIdentity?.kind==='ffmpeg'&&['ftyp','moov','moof','mdat','free','wide'].includes(header.toString('ascii',4,8))){
        if('picture' in target&&target.picture)throw new AnalysisFailure('ambiguous-picture-identity','MP4 picture requires the current JS playback identity');
        target={...target,indexIdentity:undefined};
      }
    } finally { await probe.close(); }
    const manifest = JSON.parse(
      await readFile(path.join(this.coreDir, "manifest.json"), "utf8"),
    );
    if (manifest.abi !== 1 || manifest.semanticVersion !== ANALYZER_VERSION)
      throw new Error("Analysis core ABI/version mismatch");
    if (!Number.isSafeInteger(manifest.heapMaxBytes) || manifest.heapMaxBytes <= 0 ||
        manifest.heapMaxBytes > ANALYSIS_WORKER_HEAP_BYTES)
      throw new AnalysisFailure('resource-limit', 'Analysis core exceeds server heap reservation');
    const id = target.product==='blocks' && 'picture' in target && target.picture
      ? createHash("sha256").update(productKey(target.picture,manifest.buildId ?? manifest.revision,target.indexIdentity ?? null,'blocks')).digest("hex")
      : createHash("sha256")
      .update(
        JSON.stringify([
          target.sourceVersion, ...(target.product ? [target.product] : []),
          ...(target.product || target.indexIdentity || 'mode' in target || 'startUs' in target ? [target.product ? analysisIndexIdentity(target.indexIdentity) : target.indexIdentity ?? null] : []),
          "mode" in target ? ['stream', target.firstPtsUs, target.durationUs, target.window ?? null] : "startUs" in target
            ? [target.firstPtsUs, target.startUs, target.endUs]
            : target.picture
              ? pictureId(target.picture)
              : target.sourcePtsUs,
          ANALYSIS_RECIPE,
          ANALYZER_VERSION,
          (manifest.buildId ?? manifest.revision),
        ]),
      )
      .digest("hex");
    let work = this.work.get(id);
    if (work?.state === "complete") {
      let valid = true;
      for (const chunk of work.chunks)
        if (!(await this.store.getOutput(chunk,"picture" in target ? target.picture?.au : undefined))) {
          valid = false;
          break;
        }
      if (!valid) {
        work.state = "error";
        work.error = "Analysis cache evicted";
        work.seq++;
        this.work.delete(id);
        work = undefined;
      }
    }
    if (
      !work ||
      ["cancelled", "error", "unsupported", "limited"].includes(work.state)
    ) {
      const chunks = "startUs" in target ? await this.store.manifest(id) : null;
      const cached = "startUs" in target || "mode" in target ? null : await this.store.getOutput(id,"picture" in target ? target.picture?.au : undefined);
      if (
        cached &&
        (cached.buildId !== (manifest.buildId ?? manifest.revision) ||
          cached.picture.sourceVersion !== target.sourceVersion)
      )
        throw new Error("Invalid analysis cache identity");
      work = {
        published: 0, pending: [], page: [],
        id,
        mediaId,
        version,
        filePath,
        target,
        chunks: chunks ?? (cached ? [id] : []),
        buildId: (manifest.buildId ?? manifest.revision),
        state: cached || chunks ? "complete" : "queued",
        consumers: new Set(),
        seq: 0,
      };
      this.work.set(id, work);
    }
    if (this.closed) throw new Error("Analysis service closed");
    const requestId = randomUUID();
    work.consumers.add(requestId);
    this.consumers.set(requestId, {
      work,
      owner, cursor: 0, delivered: 0,
      expires: this.now() + this.leaseMs,
    });
    if (!this.timer) {
      this.timer = setInterval(() => this.expire(), 1000);
      this.timer.unref();
    }
    void this.pump();
    return {
      requestId,
      state: work.state,
      leaseMs: this.leaseMs,
      cacheHit: work.state === "complete",
    };
  }
  status(id: string, owner: string) {
    const consumer = this.consumers.get(id);
    if (!consumer || consumer.owner !== owner || consumer.expires <= this.now())
      return null;
    consumer.expires = this.now() + this.leaseMs;
    const w = consumer.work;
    const plan=w.plan && !consumer.planDelivered ? w.plan : undefined; if(plan)consumer.planDelivered=true;
    return {
      ...(plan?{plan}:{}),
      counters:w.counters,
      buildId:w.buildId,
      state: w.state,
      seq: w.seq,
      error: w.error,
      reason: w.reason,
      ...(w.unsupportedResult ? { result: isProduct(w.unsupportedResult)&&w.unsupportedResult.product==='blocks' ? {...w.unsupportedResult,payload:null,emptyPayload:true} : w.unsupportedResult } : {}),
      leaseMs: this.leaseMs,
      ...('mode' in w.target ? { published: w.published, progress: w.progress } : {}),
      chunks: w.chunks.map((id) => ({
        id,
        url: `/api/media/${w.mediaId}/bitstream-analysis/chunks/${id}?v=${w.version}`,
      })),
      ...(!("startUs" in w.target) && !("mode" in w.target) && w.state === "complete"
        ? {
            resultUrl: `/api/media/${w.mediaId}/bitstream-analysis/chunks/${w.id}?v=${w.version}`,
          }
        : {}),
    };
  }
  /** Cursor acknowledges only previously delivered descriptors. The worker
   * stalls at 32 unconsumed chunks; leases release disconnected consumers. */
  async streamStatus(id: string, owner: string, after: number, packGops = false) {
    const status = this.status(id, owner), c = this.consumers.get(id);
    if (!status || !c) return null;
    if (!('mode' in c.work.target)) throw new AnalysisFailure('invalid-request', 'Cursor requires a stream request');
    if (!Number.isSafeInteger(after) || after < c.cursor || after > c.delivered)
      throw new AnalysisFailure('invalid-request', 'Invalid stream acknowledgement');
    c.cursor = after;
    const w = c.work;
    const published = w.batchStart ?? w.published;
    this.advance(w);
    const refs: StreamChunkRef[] = [];
    let cursor = after;
    while (cursor < published && refs.length < 32) {
      const page = await this.store.streamPage(w.id, Math.floor(cursor / 32));
      const remaining = page.slice(cursor % 32, cursor % 32 + Math.min(32 - refs.length, published - cursor));
      if (!remaining.length) throw new Error('Incomplete stream page');
      refs.push(...remaining); cursor += remaining.length;
    }
    const chunks: (StreamChunkRef & { url: string; startCursor?: number; cachedGop?: AnalysisSummary[] })[] = [];
    let bytes = 0;
    for (const ref of refs) {
      if (packGops && ref.cached && ref.batchEnd && w.target.product === 'summary') {
        // One transport packet per cached GOP (or bounded part). Cursor values
        // still acknowledge individual pictures, so older clients keep working.
        const summaries: AnalysisSummary[] = [];
        const end = ref.batchEnd;
        if (end > published || end - ref.cursor + 1 > SUMMARY_BATCH_LIMIT.pictures) throw Error('Invalid cached GOP cursor');
        if (ref.cursor <= after || ref.cursor <= (chunks.at(-1)?.cursor ?? after)) continue;
        let current = ref.cursor;
        while (current <= end) {
          const page = await this.store.streamPage(w.id, Math.floor((current - 1) / 32));
          for (const member of page.slice((current - 1) % 32)) {
            if (current > end) break;
            if (!member.cached || member.batchEnd !== end || member.cursor !== current || JSON.stringify(member.gop) !== JSON.stringify(ref.gop)) throw Error('Invalid cached GOP member');
            const output = await this.store.getOutput(member.id, member.au);
            if (!output || !isSummary(output) || output.buildId !== w.buildId || output.picture.sourceVersion !== w.target.sourceVersion || output.picture.au !== member.au ||
                JSON.stringify(output.indexIdentity) !== JSON.stringify(analysisIndexIdentity(w.target.indexIdentity))) throw Error('Cached GOP member unavailable');
            const value = { ...output, gop: member.gop };
            const size = metadataBudgetBytes(value) + 64;
            if (bytes + size > SUMMARY_BATCH_LIMIT.bytes) {
              if (!summaries.length) throw new AnalysisFailure('resource-limit', 'Cached GOP transport budget exceeded');
              break;
            }
            summaries.push(value); bytes += size; current++;
          }
          if (bytes >= SUMMARY_BATCH_LIMIT.bytes || (current <= end && summaries.length && bytes + PRODUCT_LIMIT.metadata > SUMMARY_BATCH_LIMIT.bytes)) break;
        }
        chunks.push({ ...ref, url: `/api/media/${w.mediaId}/bitstream-analysis/chunks/${ref.id}?v=${w.version}&au=${ref.au}`,
          startCursor: ref.cursor, cursor: current - 1, cachedGop: summaries });
        cursor = current - 1;
        // A cached GOP is shown atomically; other GOPs follow in the next poll.
        break;
      }
      chunks.push({ ...ref, url: `/api/media/${w.mediaId}/bitstream-analysis/chunks/${ref.id}?v=${w.version}${ref.au === undefined ? "" : `&au=${ref.au}`}` });
    }
    cursor = chunks.at(-1)?.cursor ?? after;
    c.delivered = Math.max(c.delivered, cursor);
    return { ...status, published, chunks };
  }
  private advance(w: Work) {
    if (!('mode' in w.target)) return;
    const acknowledged = Math.min(...[...w.consumers].map(id => this.consumers.get(id)?.cursor ?? w.published));
    while (w.pending.length && w.pending[0].cursor <= acknowledged) w.pending.shift();
    if (w.pending.length < 32 && w.pending.reduce((sum,ref)=>sum+(ref.bytes ?? BUDGET.resultBytes),0) + (w.target.product ? PRODUCT_LIMIT.frame : BUDGET.resultBytes) <= PRODUCT_LIMIT.inFlight) { const wake = w.wake; w.wake = undefined; wake?.(); }
  }
  private protectedFiles() {
    const files = new Set<string>();
    // All unread chunks and in-flight commits must survive writes by other jobs.
    for (const w of this.work.values()) {
      for (const file of w.writing ?? []) files.add(file);
      if (!w.consumers.size) continue;
      for (const ref of w.pending) {
        files.add(this.outputFile(w,ref.id));
        files.add(this.store.streamPageFile(w.id, Math.floor((ref.cursor - 1) / 32)));
      }
      for (const chunk of w.chunks) files.add(this.outputFile(w,chunk));
    }
    return files;
  }
  private outputFile(work:Work,id:string) { return work.target.product ? this.store.productFile(id) : this.store.chunkFile(id); }
  private pictureChunk(work:Work,picture:import('../../../shared/analysis/bitstream/contract.ts').SourcePictureKey) {
    if (work.target.product) {
      const member = work.target.product === 'summary' ? {...picture,au:Math.floor(picture.au/32)*32} : picture;
      return createHash('sha256').update(productKey(member,work.buildId,work.target.indexIdentity ?? null,work.target.product)).digest('hex');
    }
    return createHash('sha256').update(JSON.stringify([work.target.sourceVersion,...(work.target.indexIdentity?[work.target.indexIdentity]:[]),pictureId(picture),ANALYSIS_RECIPE,ANALYZER_VERSION,work.buildId])).digest('hex');
  }
  release(id: string, owner?: string) {
    const c = this.consumers.get(id);
    if (!c || (owner !== undefined && c.owner !== owner)) return false;
    this.consumers.delete(id);
    c.work.consumers.delete(id);
    this.advance(c.work);
    if (!c.work.consumers.size) {
      if (c.work.state === "queued" || c.work.state === "running") {
        c.work.state = "cancelled";
        c.work.seq++;
        void c.work.worker?.terminate();
      }
      if (this.work.get(c.work.id) === c.work) this.work.delete(c.work.id);
    }
    return true;
  }
  expire() {
    for (const [id, c] of this.consumers)
      if (c.expires <= this.now()) this.release(id);
  }
  private pump() {
    if (this.closed) return;
    // Prioritize paused-picture demand over queued ranges/streams. Running work
    // retains its decoder; a slot is released only after worker termination.
    const queued = [...this.work.values()].filter(w => w.state === 'queued' && w.consumers.size);
    queued.sort((a, b) => Number('mode' in a.target || 'startUs' in a.target) - Number('mode' in b.target || 'startUs' in b.target));
    for (const work of queued) {
      if (this.running.size >= this.concurrency) break;
      work.state = 'running'; work.seq++; this.running.add(work);
      work.done = this.run(work);
    }
  }
  private async run(work: Work) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let index: Awaited<ReturnType<typeof libraryAnalysisIndex>> | undefined;
    try {
      if (!(await this.library.resolve(work.mediaId, work.version)))
        throw new AnalysisFailure(
          "source-changed",
          "Analysis media changed before execution",
        );
      if (this.closed || work.state !== "running" || !work.consumers.size)
        return;
      let flvSnapshot, jsSnapshot;
      if ('mode' in work.target && work.target.indexIdentity)
        index = await libraryAnalysisIndex(this.library, work.mediaId, work.version, work.filePath, work.target.indexIdentity);
      {
        const probe = await open(work.filePath, 'r');
        let flv = false;
        try { const header = Buffer.alloc(3); await probe.read(header, 0, 3, 0); flv = header.toString('ascii') === 'FLV'; }
        finally { await probe.close(); }
        if (flv && (!('mode' in work.target) || work.target.window)) {
          if (index && work.target.indexIdentity?.kind !== 'flv') { index.close(); index = undefined; }
          index ??= await libraryAnalysisIndex(this.library, work.mediaId, work.version, work.filePath, FLV_MEDIA_INDEX_IDENTITY);
          if ('mode' in work.target && work.target.window) {
            work.progress = { pictures: 0, totalPictures: null, checkedUs: 0, totalUs: work.target.window.endUs - work.target.window.startUs, indexComplete: false, waitingForIndex: true }; work.seq++;
          }
          flvSnapshot = await index.snapshot(() => !this.closed && work.state === 'running' && !!work.consumers.size);
          if (!await this.library.resolve(work.mediaId, work.version)) throw new AnalysisFailure('source-changed', 'Analysis source changed during indexing');
        }

      }
      if(work.target.indexIdentity?.kind==='js-ts'||work.target.indexIdentity?.kind==='js-matroska'){index??=await libraryAnalysisIndex(this.library,work.mediaId,work.version,work.filePath,work.target.indexIdentity);jsSnapshot=await index.jsSnapshot(()=>!this.closed&&work.state==='running'&&!!work.consumers.size);}
      if (this.closed || work.state !== 'running' || !work.consumers.size) return;
      const worker = (work.worker = new Worker(
        new URL(
          typeof VOIDPLAYER_COMPILED !== "undefined" && VOIDPLAYER_COMPILED
            ? "./analysis/bitstream/worker.ts"
            : "./worker.ts",
          import.meta.url,
        ),
        {
          workerData: {
            filePath: work.filePath,
            coreDir: this.coreDir,
            target: work.target,
            externalIndex: !!index,
            flvSnapshot, jsSnapshot,
          },
        },
      ));
      await new Promise<void>((resolve, reject) => {
        const armTimer = () => {
          clearTimeout(timer);
          timer = setTimeout(() => {
            void worker.terminate(); reject(new AnalysisFailure('resource-limit', 'Analysis execution stalled'));
          }, 30000);
        };
        armTimer();
        const acknowledge = (value: unknown, transfer:ArrayBuffer[] = []) => {
          if (work.state !== 'running' || !work.consumers.size) return;
          try {
            worker.postMessage(value,transfer);
          } catch (error) { reject(error); }
        };
        worker.on("message", async (m) => {
          if(m.type==='counters'){work.counters=m.counters;work.seq++;return;}
          if(m.type==='plan'){try{if(!('mode' in work.target))throw Error('Unexpected demand plan');validateDemandPlan(m.plan,work.target);work.plan=m.plan;work.seq++;}catch(error){reject(error);}return;}
          if (m.type === 'cache') {
            try {
              if (work.state !== 'running' || !work.consumers.size ||
                  m.picture?.sourceVersion !== work.target.sourceVersion)
                throw new AnalysisFailure('cancelled', 'Analysis demand expired');
              const id = this.pictureChunk(work,m.picture);
              const result=await this.store.getOutput(id,m.picture.au);acknowledge({ type: 'cache', result },result && isProduct(result)&&result.product==='blocks'?[result.payload]:[]);
            } catch (error) { reject(error); }
            return;
          }
          if (m.type === 'index') {
            try { acknowledge({ type: 'index', index: await index!.read() }); }
            catch (error) { acknowledge({ type: 'index', error: String(error), reason: failureInfo(error) }); reject(error); }
            return;
          }
          if (m.type === 'progress') {
            if ('mode' in work.target && work.state === 'running') {
              work.progress = m.progress; work.seq++; armTimer();
            }
            return;
          }
          if (m.type === "chunk" || m.type === 'cached-gop') {
            if(m.counters)work.counters=m.counters;
            try {
              const batch = m.type === 'cached-gop';
              const results: AnalysisOutput[] = batch ? m.results : [m.result];
              if (batch) {
                if (!('mode' in work.target) || work.target.product !== 'summary' || !Array.isArray(results) ||
                    !results.length || results.length > SUMMARY_BATCH_LIMIT.pictures) throw Error('Invalid cached GOP batch');
                let bytes = 0; const seen = new Set<number>(), group = JSON.stringify(results[0]?.gop);
                for (const result of results) {
                  validateOutput(result); bytes += metadataBudgetBytes(result) + 64;
                  if (!isSummary(result) || !result.gop || JSON.stringify(result.gop) !== group || seen.has(result.picture.au) ||
                      bytes > SUMMARY_BATCH_LIMIT.bytes) throw Error('Invalid cached GOP coverage');
                  seen.add(result.picture.au);
                }
              }
              const batchEnd = batch ? work.published + results.length : undefined;
              if (batch) {
                const bytes = results.reduce((sum, result) => sum + metadataBudgetBytes(result) + 64, 0);
                while (work.pending.length && work.pending.reduce((sum, ref) => sum + (ref.bytes ?? BUDGET.resultBytes), 0) + bytes + PRODUCT_LIMIT.frame > PRODUCT_LIMIT.inFlight) {
                  clearTimeout(timer);
                  await new Promise<void>(resolve => { work.wake = resolve; });
                  if (work.state !== 'running' || !work.consumers.size) throw new AnalysisFailure('cancelled', 'Analysis demand expired');
                }
              }
              if (batch) work.batchStart = work.published;
              const cacheHit = batch || m.cacheHit;
              for (const [resultIndex, result] of results.entries()) {
                if (work.state !== "running" || !work.consumers.size)
                  throw new Error("Analysis demand expired");
                validateOutput(result);
                if (isProduct(result) ? result.product !== work.target.product || JSON.stringify(result.indexIdentity) !== JSON.stringify(analysisIndexIdentity(work.target.indexIdentity)) : work.target.product !== undefined) throw new Error('Worker product identity mismatch');
                if (
                  result.picture.sourceVersion !== work.target.sourceVersion ||
                  result.buildId !== work.buildId
                )
                  throw new Error("Analysis worker identity mismatch");
                if (
                  !("startUs" in work.target) && !("mode" in work.target) &&
                  (result.sourcePtsUs !== work.target.sourcePtsUs ||
                    (work.target.picture &&
                      pictureId(result.picture) !==
                        pictureId(work.target.picture)))
                )
                  throw new Error("Analysis worker target mismatch");
                if (
                  "startUs" in work.target &&
                  (result.sourcePtsUs <
                    work.target.firstPtsUs + work.target.startUs ||
                    result.sourcePtsUs >=
                      work.target.firstPtsUs + work.target.endUs)
                )
                  throw new Error("Analysis worker range identity mismatch");
                if (!(await this.library.resolve(work.mediaId, work.version)))
                  throw new AnalysisFailure(
                    "source-changed",
                    "Analysis source changed during execution",
                  );
                if (result.confidence !== "exact") {
                  // Unsupported summaries are transient lease-scoped control data,
                  // never committed as exact chunks or complete range coverage.
                  if (
                    (!isProduct(result) && result.blocks.length) ||
                    JSON.stringify(result).length > 16384
                  )
                    throw new AnalysisFailure(
                      "resource-limit",
                      "Unsupported summary budget exceeded",
                    );
                  if(isProduct(result)&&result.product==='blocks'&&(result.validatedBlockCount!==0||result.payload.byteLength!==0))throw Error('Unsupported inline products must have empty records');
                  work.unsupportedResult = result;
                  const reason = new AnalysisFailure(
                    result.reasonCodes?.[0] ?? "incomplete-reference-state",
                    result.reasons.join("; ") || "Exact analysis is unsupported",
                  );
                  work.reason = reason.info;
                  work.state = "unsupported";
                  work.seq++;
                  throw reason;
                }
                const chunk = 'startUs' in work.target || 'mode' in work.target ? this.pictureChunk(work,result.picture) : work.id;
                const resultBytes = isProduct(result) ? (result.product === 'blocks' ? result.payload.byteLength : 0) + Buffer.byteLength(JSON.stringify(isProduct(result) && result.product === 'blocks' ? {...result,payload:undefined} : result)) + 40 : Math.min(BUDGET.resultBytes,result.blocks.length*128+metadataBudgetBytes(metadata(result))+64);
                if (resultBytes > (isProduct(result) ? PRODUCT_LIMIT.frame : BUDGET.resultBytes)) throw new AnalysisFailure('resource-limit','Analysis frame budget exceeded');
                if (!("mode" in work.target) && work.chunks.length >= 32)
                  throw new AnalysisFailure(
                    "resource-limit",
                    "Analysis chunk count budget exceeded",
                  );
                if ('mode' in work.target) {
                  if (!result.gop) throw new Error('Missing stream GOP');
                  const ref: StreamChunkRef = { id: chunk, cursor: work.published + 1, gop: result.gop, picture:result.picture, au:result.picture.au, bytes:resultBytes, ...(batch ? { cached: true, batchEnd } : {}), ...(isProduct(result)?{product:result.product,encoding:result.encoding}:{}) };
                  work.writing = new Set([this.outputFile(work,chunk),
                    this.store.streamPageFile(work.id, Math.floor(work.published / 32))]);
                  const protectedFiles = this.protectedFiles();
                  if(!cacheHit || !await this.store.getOutput(chunk,result.picture.au)){const written=await this.store.putOutput(chunk, result, protectedFiles);if(typeof written==='number')ref.bytes=written;}
                  if (work.state !== 'running' || !work.consumers.size) throw new AnalysisFailure('cancelled', 'Analysis demand expired');
                  protectedFiles.add(this.outputFile(work,chunk));
                  const page = Math.floor(work.published / 32);
                  if (!(work.published % 32)) work.page = [];
                  work.page.push(ref);
                  if (!batch || work.page.length === 32 || resultIndex === results.length - 1)
                    await this.store.putStreamPage(work.id, page, work.page, protectedFiles);
                  work.published++; work.pending.push(ref); work.seq++; work.writing = undefined;
                  if (batch && resultIndex === results.length - 1) work.batchStart = undefined;
                  if (resultIndex === results.length - 1 && (work.pending.length >= 32 || work.pending.reduce((sum,ref)=>sum+(ref.bytes ?? BUDGET.resultBytes),0) + (work.target.product ? PRODUCT_LIMIT.frame : BUDGET.resultBytes) > PRODUCT_LIMIT.inFlight)) {
                    clearTimeout(timer); // Consumer wait is governed by leases, not decoder stall time.
                    await new Promise<void>(resolve => { work.wake = resolve; });
                  }
                  if (work.state !== 'running' || !work.consumers.size) throw new AnalysisFailure('cancelled', 'Analysis demand expired');
                } else {
                  work.writing = new Set([this.outputFile(work,chunk)]);
                  if(!cacheHit || !await this.store.getOutput(chunk,result.picture.au))await this.store.putOutput(chunk, result);
                  work.chunks.push(chunk); work.seq++; work.writing = undefined;
                }
                if ('mode' in work.target) armTimer();
              }
              acknowledge({ ok: true });
            } catch (error) {
              acknowledge({
                ok: false,
                error: String(error),
                reason: failureInfo(error),
              });
              reject(error);
            }
          } else m.ok ? resolve() : reject(restoreFailure(m.reason, m.error));
        });
        worker.once("error", reject);
        worker.once("messageerror", () => reject(new Error("Analysis Worker reply could not be deserialized")));
        worker.once("exit", () => reject(new Error("Analysis worker exited")));
      });
      if (work.state !== "running" || !work.consumers.size) return;
      if ('mode' in work.target && (!work.progress || work.published !== work.progress.totalPictures))
        throw new AnalysisFailure('incomplete-reference-state', 'Incomplete stream output');
      if ("startUs" in work.target)
        await this.store.putManifest(work.id, work.chunks);
      work.state = "complete";
      work.seq++;
    } catch (error) {
      if (work.state === "running") {
        work.reason = failureInfo(error);
        work.state = work.reason.kind;
        work.error = error instanceof Error ? error.message : String(error);
        work.seq++;
      }
    } finally {
      index?.close();
      clearTimeout(timer);
      await work.worker?.terminate();
      work.worker = undefined;
      work.writing = undefined; this.running.delete(work);
      void this.pump();
    }
  }
  async close() {
    this.closed = true;
    clearInterval(this.timer);
    for (const entry of this.waitingReads.splice(0)) {
      entry.signal.removeEventListener('abort', entry.abort);
      entry.reject(new AnalysisFailure('cancelled', 'Analysis service closed'));
    }
    for (const id of this.consumers.keys()) this.release(id);
    await Promise.all([...this.running].map(work => work.done));
    await this.store.flush();
    this.unregisterQuality();
  }
}
