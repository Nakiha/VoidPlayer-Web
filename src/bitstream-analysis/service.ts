import {analysisIndexIdentity} from './products.ts';
import type {ProductIndexIdentity} from './products.ts';
import {coreAssetUrl} from '../core-url.ts';
import {emptyCounters} from './counters.ts';
import type {AnalysisCounters} from './counters.ts';
import { validateDemandPlan, demandKey } from './demand.ts';
import type { DemandPlan } from './demand.ts';
import { isProduct, isSummary, legacyOf, summaryOf, validateOutput, readBoundedResponse, decodeProduct, PRODUCT_LIMIT } from './products.ts';
import type { AnalysisOutput } from './products.ts';
import { DiagramStore } from "./diagrams.ts";
import { AnalysisPollingBudget } from './task-pool.ts';
import { AnalysisCache } from "./cache.ts";
import {
  BUDGET,
  pictureId,
  matchesAnalysisLayout,
  validateResult,
  validateMetadata,
  validateTarget,
  validateRange,
  validateStream,
} from "./contract.ts";
import type {
  AnalysisResult,
  AnalysisTarget,
  AnalysisRangeTarget,
  AnalysisStreamTarget,
  PresentedFrameToken,
} from "./contract.ts";
import type { MediaSource } from "../media.ts";
import { referenceVersion } from "../media-reference.ts";
import { AnalysisFailure, failureInfo, restoreFailure } from "./failure.ts";
import type { AnalysisFailureInfo } from "./failure.ts";
import type { StreamProgress } from './stream.ts';
import type { Slot } from '../model.ts';
export type DeepAnalysisState = {
  counters?:AnalysisCounters;
  /** Source coverage survives later picture tasks; current task is state/stream. */
  completedStream?: StreamProgress & { slot: Slot; sourceVersion: string };
  stream?: StreamProgress & { slot: Slot; product?:'summary'|'blocks'; window?: AnalysisStreamTarget['window'] };
  queued?: boolean;
  state:
    | "idle"
    | "pending"
    | "paused"
    | "ready"
    | "unsupported"
    | "limited"
    | "error"
    | "cancelled";
  message?: string;
  reason?: AnalysisFailureInfo;
  cacheHit?: boolean;
};
export class BitstreamAnalysisService {
  private cache = new AnalysisCache();
  private diagrams = new DiagramStore();
  queryDiagrams(sourceVersion: string, au: number | null, sourcePtsUs: number, startAu?: number, limit?: number) { return this.diagrams.query(sourceVersion, au, sourcePtsUs, startAu, limit); }
  queryChart(sourceVersion: string, startUs: number, endUs: number, pixelWidth: number, axis: import('../analysis/types.ts').AnalysisAxis = 'pts') { return this.diagrams.queryChart(sourceVersion, startUs, endUs, pixelWidth, axis); }
  chartBounds(sourceVersion: string, axis: import('../analysis/types.ts').AnalysisAxis) { return this.diagrams.chartBounds(sourceVersion, axis); }
  private admission={next:0};
  private contexts=new Map<string,{buildId:string;indexIdentity:ProductIndexIdentity|null;ticket:number}>();
  private displayDemandWindow?:AnalysisStreamTarget["window"];
  private counters=emptyCounters();
  private validateReception(result:AnalysisOutput) {if(isSummary(result))validateOutput(result);else validateMetadata(result);}
  private plans = new Map<string,DemandPlan>();
  private streamBuild?:{sequence:number;buildId:string};
  private activeDemand?: {target:AnalysisStreamTarget; plan:DemandPlan};
  sameDemand(window:NonNullable<AnalysisStreamTarget['window']>) { const active=this.activeDemand; if(active){try{validateStream({...active.target,window});}catch{return false;}} return !!active?.target.window && demandKey(active.plan,window) !== null && demandKey(active.plan,window) === demandKey(active.plan,active.target.window); }
  displayWindow(window:NonNullable<AnalysisStreamTarget['window']>) { this.displayDemandWindow=window;if(this.state.stream){this.state={...this.state,stream:{...this.state.stream,window}};this.changed();} }
  private acceptPlan(plan:DemandPlan,target:AnalysisRangeTarget|AnalysisStreamTarget) { if(!('mode' in target))throw Error('Unexpected demand plan'); validateDemandPlan(plan,target);if(this.streamBuild?.sequence!==this.sequence||plan.buildId!==this.streamBuild.buildId)throw Error('Demand plan build identity mismatch');this.context(target.sourceVersion,plan.buildId,target.indexIdentity??null);this.plans.delete(target.sourceVersion);while(this.plans.size>=8)this.plans.delete(this.plans.keys().next().value!);this.plans.set(target.sourceVersion,plan);this.activeDemand={target,plan}; }
  private cancelActive?: () => void;
  private sequence = 0;
  state: DeepAnalysisState = { state: "idle" };
  private changed: () => void;
  constructor(changed: () => void, stores?: { cache: AnalysisCache; diagrams: DiagramStore; plans:Map<string,DemandPlan>; contexts:Map<string,{buildId:string;indexIdentity:ProductIndexIdentity|null;ticket:number}>; admission:{next:number} }) {
    this.changed = changed;
    if (stores) { this.cache = stores.cache; this.diagrams = stores.diagrams; this.plans=stores.plans;this.contexts=stores.contexts;this.admission=stores.admission; }
  }
  /** Each track owns its task state; all tracks retain one bounded session cache. */
  fork(changed: () => void) {
    return new BitstreamAnalysisService(changed, { cache: this.cache, diagrams: this.diagrams, plans:this.plans,contexts:this.contexts,admission:this.admission });
  }
  cancel() {
    ++this.sequence;
    this.cancelActive?.();
    this.cancelActive = undefined;
    this.state = { state: "cancelled", ...(this.state.stream ? { stream: this.state.stream } : {}) };
    this.changed();
  }
  dispose() {
    this.cancel();
    this.cache.clear(); this.diagrams.clear(); this.plans.clear();this.contexts.clear();this.activeDemand=undefined;
  }
  fail(error: AnalysisFailure): never {
    this.cancel();
    this.state = {
      state: error.info.kind,
      message: error.message,
      reason: error.info,
    };
    this.changed();
    throw error;
  }
  private async currentBuild(source:MediaSource,preparationSequence:number,signal?:AbortSignal) {
    try {
      const url=source.info.source?new URL(source.info.source.url,location.href):new URL(coreAssetUrl('/vendor/voidplayer-analysis/manifest.json',location.href));
      if(source.info.source)url.pathname+='/bitstream-analysis/capabilities';
      const response=await fetch(url,{signal,cache:'no-store'});
      if(!response.ok)throw new AnalysisFailure('source-changed','Analysis identity unavailable');
      const manifest=await response.json(),build=manifest.buildId ?? manifest.revision;
      if(preparationSequence!==this.sequence)throw new AnalysisFailure('cancelled','Analysis preparation superseded');
      signal?.throwIfAborted();
      if(typeof build!=='string'||!build||build.length>128)throw Error('Invalid current analysis build identity');
      return build as string;
    } catch(error) {
      if(preparationSequence===this.sequence)this.fail(restoreFailure(failureInfo(signal?.aborted?new AnalysisFailure('cancelled','Analysis cancelled'):error)));
      throw error;
    }
  }
  private context(source:string,buildId:string,indexIdentity:ProductIndexIdentity|null,ticket?:number) {
    indexIdentity=analysisIndexIdentity(indexIdentity);
    const old=this.contexts.get(source);
    if(old && (old.buildId!==buildId || JSON.stringify(old.indexIdentity)!==JSON.stringify(indexIdentity))){if(ticket===undefined||ticket<old.ticket)throw new AnalysisFailure('source-changed','Analysis namespace superseded');this.cache.invalidateSource(source);}else if(old){old.ticket=Math.max(old.ticket,ticket??old.ticket);return;}
    this.contexts.delete(source);while(this.contexts.size>=8){const stale=this.contexts.keys().next().value!;this.cache.invalidateSource(stale);this.contexts.delete(stale);}this.contexts.set(source,{buildId,indexIdentity,ticket:ticket??++this.admission.next});
  }
  cached(token: PresentedFrameToken) {
    const context=token.picture?this.contexts.get(token.picture.sourceVersion):undefined;
    const hit=token.picture&&context?this.cache.peekProduct(token.picture,context.buildId,context.indexIdentity):null;return hit&&matchesAnalysisLayout(hit,token)?hit:null;
  }
  async request(
    source: MediaSource,
    token: PresentedFrameToken,
    signal?: AbortSignal,
  ): Promise<AnalysisResult> {
    if (!token.picture)
      throw new AnalysisFailure(
        "unsupported-picture-layout",
        "This playback path has no verified picture identity",
      );
    const target: AnalysisTarget = {
      product:"blocks",
      sourceVersion: token.picture.sourceVersion,
      sourcePtsUs: token.sourcePtsUs,
      normalizedMediaUs: token.normalizedMediaUs,
      picture: token.picture,
      ...(source.bitstreamIndexIdentity?{indexIdentity:source.bitstreamIndexIdentity}:{}),
    };
    validateTarget(target);
    signal?.throwIfAborted();
    this.cancel();
    const preparationSequence=this.sequence;
    this.state={state:'pending'};this.changed();
    const admissionTicket=++this.admission.next;
    const expectedBuild=await this.currentBuild(source,preparationSequence,signal);
    if(preparationSequence!==this.sequence)throw new AnalysisFailure('cancelled','Analysis preparation superseded');if(signal?.aborted)this.fail(new AnalysisFailure('cancelled','Analysis cancelled'));
    try{this.context(target.sourceVersion,expectedBuild,target.indexIdentity ?? null,admissionTicket);}catch(error){return this.fail(restoreFailure(failureInfo(error)));}
    const cached=this.cache.getMatching(token.picture,expectedBuild,target.indexIdentity ?? null);
    if(preparationSequence!==this.sequence)throw new AnalysisFailure("cancelled","Analysis preparation superseded");
    signal?.throwIfAborted();
    if (cached && matchesAnalysisLayout(cached,token)) {
      this.state = {
        state: "ready",
        cacheHit: true, counters:{...emptyCounters(),cacheHit:1,uniqueDelivered:1},
        reason: cached.reasonCodes?.length
          ? new AnalysisFailure(
              cached.reasonCodes[0],
              cached.reasons.join("; ") ||
                "QP is unavailable for this bit depth",
            ).info
          : undefined,
      };
      this.changed();
      return cached;
    }
    const seq = ++this.sequence,
      controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    this.cancelActive = () => controller.abort();
    this.state = { state: "pending" };
    this.changed();
    try {
      const result = source.info.source
        ? await this.remote(source, target, controller.signal)
        : source.bitstreamFile
          ? await this.local(source.bitstreamFile, target, controller.signal, (source.getBitstreamFfmpegIndex ?? source.getBitstreamFlvIndex)?.bind(source))
          : await Promise.reject(
              new Error("This source has no local File reference"),
            );
      controller.signal.throwIfAborted();
      this.validateReception(result);
      if(!isProduct(result)||result.product!=='blocks'||result.buildId!==expectedBuild||JSON.stringify(result.indexIdentity)!==JSON.stringify(analysisIndexIdentity(target.indexIdentity)))throw Error('Exact picture product identity mismatch');
      if (
        pictureId(result.picture) !== pictureId(token.picture) ||
        result.sourcePtsUs !== token.sourcePtsUs
      )
        throw new Error("Analysis result identity mismatch");
      if(!matchesAnalysisLayout(result,token))throw new AnalysisFailure('unsupported-picture-layout','Analysis coded layout does not match the presented crop');
      this.context(result.picture.sourceVersion,result.buildId,isProduct(result)?result.indexIdentity:target.indexIdentity ?? null);
      if (!isSummary(result)) this.cache.put(result,target.indexIdentity ?? null); this.diagrams.putSummary(summaryOf(result,target.indexIdentity ?? null));
      if (seq === this.sequence) {
        this.state = {
          state: result.confidence === "exact" ? "ready" : "unsupported",
          message: result.reasons.join("; "),
          reason: result.reasonCodes?.length
            ? new AnalysisFailure(
                result.reasonCodes[0],
                result.reasons.join("; ") ||
                  "QP is unavailable for this bit depth",
              ).info
            : undefined,
          cacheHit: false, counters:this.counters,
        };
        this.changed();
      }
      return isProduct(result) ? (result.product === "blocks" ? legacyOf(result) : (()=>{throw Error("Unexpected summary for exact picture");})()) : result;
    } catch (error) {
      if (seq === this.sequence) {
        const reason = controller.signal.aborted
          ? new AnalysisFailure("cancelled", "Analysis cancelled").info
          : failureInfo(error);
        this.state = {
          state: controller.signal.aborted ? "cancelled" : reason.kind,
          message: reason.message,
          reason,
        };
        this.changed();
      }
      throw error;
    } finally {
      signal?.removeEventListener("abort", abort);
      if (seq === this.sequence) this.cancelActive = undefined;
    }
  }
  async requestRange(
    source: MediaSource,
    target: AnalysisRangeTarget,
    signal?: AbortSignal,
  ): Promise<{ pictures: number }> {
    target={...target,...(source.bitstreamIndexIdentity?{indexIdentity:source.bitstreamIndexIdentity}:{})};
    try {
      validateRange(target);
    } catch (error) {
      return this.fail(restoreFailure(failureInfo(error)));
    }
    this.cancel();
    const controller = new AbortController(),
      abort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    this.cancelActive = () => controller.abort();
    const seq = ++this.sequence;
    this.state = { state: "pending" };
    this.changed();
    let pictures = 0;
    let unsupported: AnalysisFailureInfo | undefined;
    const consume = (result: AnalysisOutput) => {
      this.validateReception(result);
      if(isProduct(result))throw Error('Unexpected product in legacy range');
      if (
        result.picture.sourceVersion !== target.sourceVersion ||
        result.sourcePtsUs < target.firstPtsUs + target.startUs ||
        result.sourcePtsUs >= target.firstPtsUs + target.endUs
      )
        throw new Error("Analysis range identity mismatch");
      this.context(result.picture.sourceVersion,result.buildId,isProduct(result)?result.indexIdentity:target.indexIdentity ?? null);
      if (!isSummary(result)) this.cache.put(result,target.indexIdentity ?? null); this.diagrams.putSummary(summaryOf(result,target.indexIdentity ?? null));
      pictures++;
      this.changed();
      if (result.confidence !== "exact")
        unsupported = new AnalysisFailure(
          result.reasonCodes?.[0] ?? "incomplete-reference-state",
          result.reasons.join("; "),
        ).info;
    };
    try {
      if (source.info.source)
        await this.remoteRange(source, target, controller.signal, consume);
      else if (source.bitstreamFile)
        await this.localRange(
          source.bitstreamFile,
          target,
          controller.signal,
          consume,
          undefined, undefined, (source.getBitstreamFfmpegIndex ?? source.getBitstreamFlvIndex)?.bind(source),
        );
      else throw new Error("No local analysis source");
      controller.signal.throwIfAborted();
      if (seq === this.sequence) {
        this.state = unsupported
          ? {
              state: "unsupported",
              message: unsupported.message,
              reason: unsupported,
            }
          : { state: "ready" };
        this.changed();
      }
      return { pictures };
    } catch (error) {
      if (seq === this.sequence) {
        const reason = controller.signal.aborted
          ? new AnalysisFailure("cancelled", "Analysis cancelled").info
          : failureInfo(error);
        this.state = {
          state: controller.signal.aborted ? "cancelled" : reason.kind,
          message: reason.message,
          reason,
        };
        this.changed();
      }
      throw error;
    } finally {
      signal?.removeEventListener("abort", abort);
      if (seq === this.sequence) this.cancelActive = undefined;
    }
  }
  async requestStream(source: MediaSource, target: AnalysisStreamTarget, slot: Slot, signal?: AbortSignal) {
    target = { ...target, ...(source.bitstreamIndexIdentity ? { indexIdentity: source.bitstreamIndexIdentity } : {}) };
    try { validateStream(target); } catch (error) { return this.fail(restoreFailure(failureInfo(error))); }
    signal?.throwIfAborted();
    this.cancel();
    const preparationSequence=this.sequence;
    this.state={state:'pending',stream:{slot,product:target.product,checkedUs:0,totalUs:target.window?target.window.endUs-target.window.startUs:target.durationUs,pictures:0,totalPictures:0,...(target.window?{window:target.window}:{})}};this.changed();
    const plan=this.plans.get(target.sourceVersion);
    const admissionTicket=++this.admission.next;
    const expectedBuild=await this.currentBuild(source,preparationSequence,signal);
    if(preparationSequence!==this.sequence)throw new AnalysisFailure('cancelled','Analysis preparation superseded');if(signal?.aborted)this.fail(new AnalysisFailure('cancelled','Analysis cancelled'));
    try{this.context(target.sourceVersion,expectedBuild,target.indexIdentity ?? null,admissionTicket);}catch(error){return this.fail(restoreFailure(failureInfo(error)));}
    if(plan&&expectedBuild!==plan.buildId)this.plans.delete(target.sourceVersion);
    if(preparationSequence!==this.sequence)throw new AnalysisFailure('cancelled','Analysis preparation superseded');
    signal?.throwIfAborted();
    if(target.product==='summary' && target.window && plan && expectedBuild===plan.buildId && JSON.stringify(analysisIndexIdentity(plan.indexIdentity))===JSON.stringify(analysisIndexIdentity(target.indexIdentity)) && plan.firstPtsUs===target.firstPtsUs) {
      const key=demandKey(plan,target.window);
      if(key) {
        const groups=plan.groups.filter(g=>JSON.parse(key).includes(g.startAu)); let complete=true,pictures=0;
        for(const group of groups)for(let au=group.startAu;au<group.endAu;au++) {
          const row=plan.times.find(t=>t[0]===au);const entry=this.diagrams.summaryAt(target.sourceVersion,au);
          if(!row||!entry||entry.buildId!==plan.buildId||JSON.stringify(entry.indexIdentity)!==JSON.stringify(analysisIndexIdentity(plan.indexIdentity))||entry.sourcePtsUs!==row[1]||entry.sourceDtsUs!==row[2]||entry.picture.configuration!==group.configuration||entry.confidence!=='exact'){complete=false;break;}pictures++;
        }
        if(complete && pictures){const progress={pictures,totalPictures:pictures,checkedUs:target.window.endUs-target.window.startUs,totalUs:target.window.endUs-target.window.startUs,indexComplete:true,waitingForIndex:false};this.state={state:'ready',cacheHit:true,counters:{...emptyCounters(),cacheHit:pictures,uniqueDelivered:pictures},stream:{slot,...progress,window:target.window}};this.changed();return progress;}
      }
    }
    if(preparationSequence!==this.sequence)throw new AnalysisFailure("cancelled","Analysis preparation superseded");
    this.displayDemandWindow=target.window;
    const seq = ++this.sequence, controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    this.cancelActive = () => controller.abort();
    this.streamBuild={sequence:seq,buildId:expectedBuild};
    let progress: StreamProgress = { checkedUs: 0, totalUs: target.window ? target.window.endUs - target.window.startUs : target.durationUs, pictures: 0, totalPictures: 0 };
    const update = () => {
      controller.signal.throwIfAborted();
      if (seq !== this.sequence) throw new DOMException('Superseded analysis', 'AbortError');
      this.state = { state: 'pending', counters:this.counters, stream: { slot, product:target.product, ...progress, ...(this.displayDemandWindow ? { window: this.displayDemandWindow } : {}) } }; this.changed();
    };
    const delivered = new Set<number>();
    const retainedPlan=this.plans.get(target.sourceVersion);
    if(target.product==='summary' && target.window && retainedPlan && expectedBuild===retainedPlan.buildId) {
      const key=demandKey(retainedPlan,target.window);if(key)for(const group of retainedPlan.groups.filter(g=>JSON.parse(key).includes(g.startAu)))for(let au=group.startAu;au<group.endAu;au++) {
        const retained=this.diagrams.summaryAt(target.sourceVersion,au);
        if(retained && retained.confidence==='exact' && retained.buildId===expectedBuild && JSON.stringify(retained.indexIdentity)===JSON.stringify(analysisIndexIdentity(target.indexIdentity)) && retained.picture.configuration===group.configuration)delivered.add(au);
      }
    }
    if(target.product!=='summary') {
      const groups=target.window&&retainedPlan&&expectedBuild===retainedPlan.buildId?demandKey(retainedPlan,target.window):null;
      for(const entry of this.cache.readablePictures(target.sourceVersion,expectedBuild,target.indexIdentity ?? null)) {
        if(!target.window ? entry.sourcePtsUs>=target.firstPtsUs&&entry.sourcePtsUs<target.firstPtsUs+target.durationUs : groups&&retainedPlan!.groups.some(g=>JSON.parse(groups).includes(g.startAu)&&entry.picture.au>=g.startAu&&entry.picture.au<g.endAu&&entry.picture.configuration===g.configuration))delivered.add(entry.picture.au);
      }
    }
    let consumed = delivered.size;progress={...progress,pictures:consumed};update();
    const consume = (result: AnalysisOutput, coverage=false) => {
      controller.signal.throwIfAborted(); this.validateReception(result);
      if(result.buildId!==expectedBuild)throw Error('Stream build identity mismatch');
      this.context(target.sourceVersion,expectedBuild,target.indexIdentity??null);
      if ((isProduct(result) ? result.product !== target.product || JSON.stringify(result.indexIdentity) !== JSON.stringify(analysisIndexIdentity(target.indexIdentity)) : target.product !== undefined)) throw new Error('Stream product identity mismatch');
      if (seq !== this.sequence || result.picture.sourceVersion !== target.sourceVersion || !result.gop)
        throw new Error('Stream result identity mismatch');
      if (result.confidence !== 'exact') throw new AnalysisFailure(result.reasonCodes?.[0] ?? 'incomplete-reference-state', result.reasons.join('; '));
      if (delivered.has(result.picture.au)) {
        if(coverage)return;
        if(isSummary(result)?!this.diagrams.getSummary(result.picture,result.buildId,result.indexIdentity):!this.cache.getProduct(result.picture,result.buildId,target.indexIdentity ?? null)) {if(isSummary(result))this.diagrams.putSummary(result);else this.cache.put(result,target.indexIdentity ?? null);return;}
        throw new Error('Duplicate stream AU');
      }
      delivered.add(result.picture.au);
      this.context(result.picture.sourceVersion,result.buildId,isProduct(result)?result.indexIdentity:target.indexIdentity ?? null);
      if (!coverage&&!isSummary(result)) this.cache.put(result,target.indexIdentity ?? null);
      if (!this.diagrams.getSummary(result.picture,result.buildId,isProduct(result) ? result.indexIdentity : target.indexIdentity ?? null)) this.diagrams.putSummary(summaryOf(result,target.indexIdentity ?? null));
      consumed++;
      progress = { ...progress, pictures: consumed, gopStartAu: result.gop.startAu }; update();
    };
    const onProgress = (next: StreamProgress) => {
      if (!next || typeof next.indexComplete !== 'boolean' || (next.waitingForIndex !== undefined && typeof next.waitingForIndex !== 'boolean') || ![next.pictures, next.checkedUs, next.totalUs].every(Number.isSafeInteger) || (next.totalPictures !== null && !Number.isSafeInteger(next.totalPictures)) ||
          (next.totalPictures !== null && (next.totalPictures < 0 || next.totalPictures > 250000 || next.pictures > next.totalPictures)) || next.pictures < 0 || next.pictures > 250000 ||
          next.totalUs <= 0 || next.checkedUs < 0 || next.checkedUs > next.totalUs)
        throw new Error('Invalid stream progress');
      // Remote producer may be ahead; displayed coverage counts consumed chunks.
      progress = { ...next, pictures: consumed, checkedUs: next.totalPictures ? Math.min(next.totalUs - 1, Math.floor(next.totalUs * consumed / next.totalPictures)) : 0 }; update();
    };
    try {
      if (source.info.source) await this.remoteRange(source, target, controller.signal, consume, onProgress);
      else if (source.bitstreamFile) await this.localRange(source.bitstreamFile, target, controller.signal, consume, onProgress, source.getBitstreamIndex?.bind(source), (source.getBitstreamFfmpegIndex ?? source.getBitstreamFlvIndex)?.bind(source));
      else throw new AnalysisFailure('invalid-request', 'No stream input');
      controller.signal.throwIfAborted();
      if (!consumed || consumed !== progress.totalPictures || !progress.indexComplete) throw new AnalysisFailure('incomplete-reference-state', 'Incomplete stream coverage');
      progress = { ...progress, checkedUs: progress.totalUs, indexComplete: true, waitingForIndex: false };
      if (seq === this.sequence) { this.state = { state: 'ready', counters:this.counters, stream: { slot, product:target.product, ...progress, ...(this.displayDemandWindow ? { window: this.displayDemandWindow } : {}) } }; this.changed(); }
      return progress;
    } catch (error) {
      if (seq === this.sequence) {
        const reason = failureInfo(controller.signal.aborted ? controller.signal.reason ?? new AnalysisFailure('cancelled', 'Analysis cancelled') : error);
        this.state = { state: reason.kind, reason, message: reason.message, stream: { slot, product:target.product, ...progress, ...(this.displayDemandWindow ? { window: this.displayDemandWindow } : {}) } }; this.changed();
      }
      throw error;
    } finally {
      signal?.removeEventListener('abort', abort);
      if (seq === this.sequence) this.cancelActive = undefined;
    }
  }
  private localRange(
    file: Blob,
    target: AnalysisRangeTarget | AnalysisStreamTarget,
    signal: AbortSignal,
    consume: (result: AnalysisOutput, coverage?:boolean) => void,
    onProgress?: (progress: StreamProgress) => void,
    frontier?: () => Promise<import('./stream.ts').AnalysisIndexFrontier>,
    snapshot?: () => Promise<import("./types.ts").AnalysisIndexSnapshot>,
  ): Promise<void> {
    signal.throwIfAborted();
    const worker = new Worker(new URL("./local-worker.ts", import.meta.url), {
      type: "module",
    });
    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (error?: unknown) => {
        if (settled) return; settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        worker.onmessage = worker.onerror = worker.onmessageerror = null;
        worker.terminate();
        error ? reject(error) : resolve();
      };
      const abort = () => done(signal.reason);
      let timer = setTimeout(
        () =>
          done(
            new AnalysisFailure(
              "resource-limit",
              "Analysis execution time budget exceeded",
            ),
          ),
        30000,
      );
      signal.addEventListener("abort", abort, { once: true });
      worker.onerror = (e) => done(new Error(e.message));
      worker.onmessageerror = () => done(new AnalysisFailure("internal-error", "Analysis Worker message could not be deserialized"));
      worker.onmessage = ({ data }) => {
        if (settled) return;
        if(data.counters)this.counters=data.counters;
        // A long stream has a stall budget rather than a 30-second total lifetime.
        if ('mode' in target) {
          clearTimeout(timer);
          timer = setTimeout(() => done(new AnalysisFailure('resource-limit', 'Analysis stream stalled')), 30000);
        }
        if(data.event==='counters'){this.counters=data.counters;} else if (data.event === 'plan') { try { this.acceptPlan(data.plan,target); } catch(error){done(error);} } else if(data.event === 'coverage') {
          try { if('mode' in target&&data.buildId!==this.streamBuild?.buildId)throw Error('Stream coverage build identity mismatch');const hit=target.product==='summary'?this.diagrams.getSummary(data.picture,data.buildId,target.indexIdentity ?? null):target.product==='blocks'?this.cache.getProduct(data.picture,data.buildId,target.indexIdentity ?? null):this.cache.getMatching(data.picture,data.buildId,target.indexIdentity ?? null); if(!hit){worker.postMessage({event:'coverage-miss',picture:data.picture});return;}consume({...hit,...(data.gop?{gop:data.gop}:{})},true);worker.postMessage({ok:true}); }catch(error){done(error);}
        } else if (data.event === 'snapshot') {
          try {
            void snapshot!().then(index => { if (!settled) worker.postMessage({ event: 'snapshot', index }); }).catch(done);
          } catch (error) { done(error); }
        } else if (data.event === 'cache') {
          try {
            if('mode' in target&&data.buildId!==this.streamBuild?.buildId)throw Error('Stream cache build identity mismatch');
            const hit = data.picture?.sourceVersion !== target.sourceVersion ? null : target.product === 'summary'
              ? this.diagrams.getSummary(data.picture,data.buildId,target.indexIdentity ?? null) : target.product === 'blocks'
              ? this.cache.getProduct(data.picture,data.buildId,target.indexIdentity ?? null) : this.cache.getMatching(data.picture,data.buildId,target.indexIdentity ?? null);
            worker.postMessage({ event: 'cache', result: hit }, hit && isProduct(hit) && hit.product==='blocks' ? [hit.payload] : []);
          } catch (error) { done(error); }
        } else if (data.event === 'index') {
          try {
            void frontier!().then(index => {
              if (!settled) worker.postMessage({ event: 'index', index });
            }).catch(done);
          } catch (error) { done(error); }
        } else if (data.event === 'progress') {
          try { onProgress?.(data.progress); } catch (error) { done(error); }
        } else if (data.event === "chunk") {
          try {
            consume(data.result);
            worker.postMessage({ ok: true });
          } catch (error) {
            done(error);
          }
        } else data.ok ? done() : done(restoreFailure(data.reason, data.error));
      };
      try { worker.postMessage({ file, target, externalIndex: !!frontier, externalSnapshot: !!snapshot, base: location.href }); } catch (error) { done(error); }
    });
  }
  private async remoteRange(
    source: MediaSource,
    target: AnalysisRangeTarget | AnalysisStreamTarget,
    signal: AbortSignal,
    consume: (result: AnalysisOutput, coverage?:boolean) => void,
    onProgress?: (progress: StreamProgress) => void,
  ) {
    const base = new URL(source.info.source!.url, location.href);
    base.pathname += "/bitstream-analysis/requests";
    const headers = {
      "content-type": "application/json",
      "x-voidplayer-action": "bitstream-analysis",
    };
    const response = await fetch(base, {
      method: "POST",
      headers,
      body: JSON.stringify({
        version: referenceVersion(source.info.source!.url),
        target: {...target, ...(source.bitstreamIndexIdentity ? {indexIdentity: source.bitstreamIndexIdentity} : {})},
      }),
      signal,
    });
    if (!response.ok)
      throw restoreFailure(
        (await response.json()).reason,
        `Server analysis unavailable (${response.status})`,
      );
    const request = await response.json(),
      status = new URL(
        `/api/bitstream-analysis/requests/${request.requestId}`,
        base,
      ),
      seen = new Set<string>();
    let cursor = 0;
    const stream = 'mode' in target;
    const budget = new AnalysisPollingBudget(stream);
    try {
      for (;;) {
        if (stream) status.searchParams.set('after', String(cursor));
        signal.throwIfAborted();
        const response = await fetch(status, { signal, cache: "no-store" });
        if (!response.ok)
          throw new AnalysisFailure("cancelled", "Analysis lease expired");
        const state = await response.json();
        signal.throwIfAborted();
        budget.observe(state);
        if(state.counters)this.counters=state.counters;
        if(stream&&state.buildId!==this.streamBuild?.buildId)throw Error('Stream status build identity mismatch');
        if (state.plan) this.acceptPlan(state.plan,target);
        if (state.progress) onProgress?.(state.progress);
        if (this.state.queued !== (state.state === 'queued')) {
          this.state = { ...this.state, queued: state.state === 'queued' }; this.changed();
        }
        if (!Array.isArray(state.chunks) || state.chunks.length > 32)
          throw new Error("Invalid analysis chunk manifest");
        for (const chunk of state.chunks) {
          if (stream) {
            if (chunk.cursor !== cursor + 1) throw new Error('Invalid stream cursor');
          } else if (seen.has(chunk.id)) continue;
          if(stream && chunk.picture && chunk.picture.au===chunk.au && chunk.picture.sourceVersion===target.sourceVersion && chunk.product===target.product && typeof state.buildId==='string') {
            const hit=target.product==='summary'?this.diagrams.getSummary(chunk.picture,state.buildId,target.indexIdentity ?? null):target.product==='blocks'?this.cache.getProduct(chunk.picture,state.buildId,target.indexIdentity ?? null):this.cache.getMatching(chunk.picture,state.buildId,target.indexIdentity ?? null);
            if(hit){consume({...hit,...(chunk.gop?{gop:chunk.gop}:{})},true);cursor=chunk.cursor;budget.progress();continue;}
          }
          const url = new URL(chunk.url, base);
          if (url.origin !== base.origin)
            throw new Error("Invalid analysis chunk origin");
          const response = await fetch(url, { signal });
          const bytes = await readBoundedResponse(response, target.product ? PRODUCT_LIMIT.frame : BUDGET.resultBytes);
          const output=target.product ? await decodeProduct(bytes) : JSON.parse(new TextDecoder().decode(bytes));
          consume(stream&&chunk.gop?{...output,gop:chunk.gop}:output);

          if (stream) cursor = chunk.cursor; else seen.add(chunk.id);
          budget.progress();
        }
        if (state.state === "complete" && (!stream || cursor === state.published)) return;
        if (state.state === "unsupported" && state.result) {
          consume(state.result);
          return;
        }
        if (
          ["error", "cancelled", "limited", "unsupported"].includes(state.state)
        )
          throw restoreFailure(
            state.reason,
            state.error ?? "Analysis cancelled",
          );
        await new Promise((r) => setTimeout(r, 200));
      }
    } finally {
      void fetch(status, { method: "DELETE", headers, keepalive: true }).catch(
        () => {},
      );
    }
  }
  private local(
    file: Blob,
    target: AnalysisTarget,
    signal: AbortSignal,
    snapshot?: () => Promise<import("./types.ts").AnalysisIndexSnapshot>,
  ): Promise<AnalysisOutput> {
    signal.throwIfAborted();
    const worker = new Worker(new URL("./local-worker.ts", import.meta.url), {
      type: "module",
    });
    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (error?: unknown, result?: AnalysisOutput) => {
        if (settled) return; settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        worker.onmessage = worker.onerror = worker.onmessageerror = null;
        worker.terminate();
        error ? reject(error) : resolve(result!);
      };
      const abort = () =>
        done(
          signal.reason ?? new DOMException("Analysis cancelled", "AbortError"),
        );
      const timer = setTimeout(
        () =>
          done(
            new AnalysisFailure(
              "resource-limit",
              "Analysis resource time limit exceeded",
            ),
          ),
        30000,
      );
      signal.addEventListener("abort", abort, { once: true });
      worker.onerror = (e) => done(new Error(e.message));
      worker.onmessageerror = () => done(new AnalysisFailure("internal-error", "Analysis Worker message could not be deserialized"));
      worker.onmessage = ({ data }) => {
        if (settled) return;
        if(data.counters)this.counters=data.counters;
        if (data.event === 'snapshot') {
          try {
            void snapshot!().then(index => { if (!settled) worker.postMessage({ event: 'snapshot', index }); }).catch(done);
          } catch (error) { done(error); }
          return;
        }
        data.ok
          ? done(undefined, data.result)
          : done(restoreFailure(data.reason, data.error));
      };
      try { worker.postMessage({ file, target, externalSnapshot: !!snapshot, base: location.href }); } catch (error) { done(error); }
    });
  }
  private async remote(
    source: MediaSource,
    target: AnalysisTarget,
    signal: AbortSignal,
  ): Promise<AnalysisOutput> {
    const base = new URL(source.info.source!.url, location.href);
    base.pathname += "/bitstream-analysis/requests";
    const headers = {
      "content-type": "application/json",
      "x-voidplayer-action": "bitstream-analysis",
    };
    const response = await fetch(base, {
      method: "POST",
      headers,
      body: JSON.stringify({
        version: referenceVersion(source.info.source!.url),
        target: {...target, ...(source.bitstreamIndexIdentity ? {indexIdentity: source.bitstreamIndexIdentity} : {})},
      }),
      signal,
    });
    if (!response.ok)
      throw restoreFailure(
        (await response.json()).reason,
        `Server analysis unavailable (${response.status})`,
      );
    const request = await response.json();
    const status = new URL(
      `/api/bitstream-analysis/requests/${request.requestId}`,
      base,
    );
    const budget = new AnalysisPollingBudget(false);
    try {
      for (;;) {
        signal.throwIfAborted();
        const response = await fetch(status, { signal, cache: "no-store" });
        if (!response.ok)
          throw new AnalysisFailure(
            "cancelled",
            `Analysis status failed (${response.status})`,
          );
        const state = await response.json();
        signal.throwIfAborted();
        if(state.counters)this.counters=state.counters;
        budget.observe(state);
        if (this.state.queued !== (state.state === 'queued')) {
          this.state = { ...this.state, queued: state.state === 'queued' }; this.changed();
        }
        if (state.state === "unsupported" && state.result) {
          const value=state.result;
          if(target.product==='blocks') {
            if(value.product!=='blocks'||value.confidence!=='partial'||value.validatedBlockCount!==0||value.payload!==null||value.emptyPayload!==true)throw Error('Invalid unsupported product framing');
            const {emptyPayload,...product}=value;return {...product,payload:new ArrayBuffer(0)};
          }
          return value;
        }
        if (
          ["error", "cancelled", "limited", "unsupported"].includes(state.state)
        )
          throw restoreFailure(
            state.reason,
            state.error ?? "Analysis cancelled",
          );
        if (state.state === "complete") {
          const resultURL = new URL(state.resultUrl, base);
          if (resultURL.origin !== base.origin)
            throw new Error("Invalid analysis result origin");
          const response = await fetch(resultURL, { signal });
          if (!response.ok)
            throw new Error(`Analysis result failed (${response.status})`);
          const bytes=await readBoundedResponse(response,target.product?PRODUCT_LIMIT.frame:BUDGET.resultBytes);
          return target.product?await decodeProduct(bytes):JSON.parse(new TextDecoder().decode(bytes));
        }
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            signal.removeEventListener("abort", abort);
            resolve();
          }, 200);
          const abort = () => {
            clearTimeout(timer);
            reject(signal.reason);
          };
          signal.addEventListener("abort", abort, { once: true });
        });
      }
    } finally {
      void fetch(status, { method: "DELETE", headers, keepalive: true }).catch(
        () => {},
      );
    }
  }
}
