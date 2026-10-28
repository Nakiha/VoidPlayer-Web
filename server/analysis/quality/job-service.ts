import type {QualityExecutionContract} from '../../../shared/analysis/quality/reexecution.ts';
import {randomUUID} from 'node:crypto';
import type {ReexecutionCreation} from './reexecution-ledger.ts';
import { AdminError } from '../../admin-error.ts';
import type { Actor } from '../../identity.ts';
import type { LibraryPairRunner } from './runner.ts';
import { FramePairError } from '../../../shared/analysis/quality/frame-pair.ts';
import { PsnrError } from '../../../shared/analysis/quality/psnr.ts';
import { terminalQualityJob } from '../../../shared/analysis/quality/jobs.ts';
import type { QualityJobReason } from '../../../shared/analysis/quality/jobs.ts';
import { qualityJobRequest, qualityIdempotencyKey } from './job-request.ts';
import { QualityJobStore } from './job-store.ts';
const serviceNow = () => Math.floor(performance.timeOrigin + performance.now());

/** A service-owned controller, never the submission/observer HTTP signal.
 * Busy admission waits in a bounded persisted queue; an actual attempt is never
 * retried, shared or resumed. The runner owns physical-stop and source IO gates. */
export class QualityJobService {
  private store: QualityJobStore;
  private runner: LibraryPairRunner;
  private active?: {id: string; controller: AbortController; done: Promise<void>};
  private closed = false;
  private fatal: unknown;
  private failed = false;
  private closing?: Promise<void>;
  private timer?: ReturnType<typeof setTimeout>;
  private now: () => number;
  constructor(file: string, runner: LibraryPairRunner, now = serviceNow) {
    this.now = now; this.runner = runner; this.store = new QualityJobStore(file, now());
  }
  taskSummaries(actor:string){return this.store.taskSummaries(actor);}
  private available() {
    if (this.closed || this.failed) throw new AdminError(503, 'Quality job service is unavailable.', 'quality-service-unavailable');
  }
  submit(value: unknown, actor: Actor, requestId: string, key: unknown,reexecution?:ReexecutionCreation,expectedExecutionContract?:QualityExecutionContract) {
    this.available();
    const accepted = this.store.submit(qualityJobRequest(value), actor, requestId, qualityIdempotencyKey(key), this.now(),reexecution,expectedExecutionContract);
    if (!accepted.replayed) {this.pump();this.wake();}
    return {...accepted, job: this.store.get(accepted.job.id)};
  }
  get(id: string, actor?: string) {
    const job = this.store.get(id);
    if (actor !== undefined && job.submitted.actorId !== actor) throw new AdminError(404, 'Quality job not found.', 'job-not-found');
    return job;
  }
  reexecutionInput(id:string,actor:string){this.get(id,actor);return this.store.frozenInput(id);}
  reexecutionReceipt(id:string,actor:string,key?:string,request?:import('../../../shared/analysis/quality/reexecution.ts').ReexecutionRequest){this.get(id,actor);const receipt=key&&request?this.store.reexecutions.replay(id,actor,key,request):this.store.reexecutions.get(id,actor);if(receipt)this.store.reexecutions.verify(receipt,this.get(receipt.jobId,actor));return receipt;}
  reexecute(creation:ReexecutionCreation,actor:Actor,requestId:string){this.available();const original=this.get(creation.parentId,actor.id);return this.submit(original.input,actor,requestId,'reexecution:'+randomUUID(),creation);}
  result(id: string, actor?: string) { this.get(id, actor); return this.store.result(id); }
  changes(actor: string | null, after?: number, limit?: number) { return this.store.changes(actor, after, limit); }
  cancel(id: string, actor: string, requestId: string) {
    this.available();this.get(id, actor);
    const job = this.store.cancel(id, actor, requestId, this.now());
    if (job.state === 'cancelling' && this.active?.id === id)
      this.active.controller.abort(new AdminError(499, 'Quality job explicitly cancelled.', 'cancelled'));
    return job;
  }
  private poison(error: unknown) {
    this.failed = true;this.fatal = error;
    console.error('Quality job service stopped; durable state retained', error);
  }
  private wake() {
    try {
    if (this.timer || this.closed || this.failed || this.store.counts().queued === 0) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      try {this.store.expire(this.now());this.pump();this.wake();}catch(error){this.poison(error);}
    },250);this.timer.unref();
    } catch (error) { this.poison(error); }
  }
  private pump() {
    if (this.closed || this.failed || this.active) return;
    try {
      this.store.expire(this.now());const job = this.store.queued();if (!job) return;
      const active = {id: job.id, controller: new AbortController(), done: Promise.resolve()};this.active = active;
      active.done = this.execute(job.id, active.controller).catch(error => this.poison(error)).finally(() => {
        if (this.active === active) this.active = undefined;
        this.wake();
      });
    } catch (error) { this.poison(error); }
  }
  private async execute(id: string, controller: AbortController) {
    const job = this.store.get(id);let attempt: string | null = null;
    try {
      const value = await this.runner.measure(job.input.request, controller.signal, {
        expectedExecutionContract:job.executionContract,
        contract:value=>{if(!attempt)throw Error('Execution contract before admission');this.store.recordExecutionContract(id,attempt,value);},
        admitted: () => { attempt = this.store.start(id, this.now()); },
        phase: phase => { if (attempt) this.store.phase(id, attempt, phase); },
      });
      if (this.closed) this.store.finish(id, attempt, 'interrupted', {code:'service-shutdown',message:'Service stopped; no automatic retry.'}, this.now());
      else this.store.finish(id, attempt, 'completed', null, this.now(), value);
    } catch (error) {
      if (this.runner.stopUncertain) {
        this.store.stopUncertain(id);throw error;
      }
      if (!attempt && error instanceof AdminError && error.code === 'quality-busy') {
        this.store.blocked(id);return;
      }
      const known = error instanceof AdminError || error instanceof FramePairError || error instanceof PsnrError;
      const why: QualityJobReason = known ? {code:error.code,message:error.message.slice(0, 300)}
        : {code:'execution-failed',message:'Quality execution failed; no automatic retry.'};
      this.store.finish(id, attempt, this.closed ? 'interrupted' : 'failed', this.closed
        ? {code:'service-shutdown',message:'Service stopped; no automatic retry.'} : why, this.now());
    }
  }
  resources() {
    return {...this.store.counts(), admissionBlocked: !!this.runner.stopUncertain, available: !this.closed && !this.failed};
  }
  close() { return this.closing ??= this.stop(); }
  private async stop() {
    this.closed = true;clearTimeout(this.timer);this.timer = undefined;
    this.active?.controller.abort(new AdminError(499, 'Quality service stopping.', 'service-shutdown'));
    await this.active?.done;
    if (this.failed) throw this.fatal; // Keep database ownership when stop is uncertain.
    // Queued jobs are not silently resumed on the next startup.
    for (const job of this.store.unfinished()) {
      if (!terminalQualityJob(job.state)) this.store.finish(job.id, job.attempt?.id ?? null, 'interrupted',
        {code:'service-shutdown',message:'Service stopped before execution; no automatic retry.'}, this.now());
    }
    this.store.close();
  }
}
