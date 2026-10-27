import {taskSummaries} from '../../tasks/summary.ts';
import {pairPacketCount} from '../../../shared/analysis/quality/frame-pair.ts';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { openIndexDatabase } from '../../sqlite.ts';
import { lockDatabase } from '../../library-store.ts';
import { AdminError } from '../../admin-error.ts';
import type { Actor } from '../../identity.ts';
import type { LibraryPairResult } from '../../../shared/analysis/quality/library-pair.ts';
import { QUALITY_JOB_LIMITS as LIMITS, terminalQualityJob } from '../../../shared/analysis/quality/jobs.ts';
import type { QualityJob, QualityJobPage, QualityJobPhase, QualityJobReason, QualityJobResult, QualityJobState } from '../../../shared/analysis/quality/jobs.ts';
import type { qualityJobRequest } from './job-request.ts';

const columns = `id,revision,sequence,state,phase,actor_id,actor_name,client_id,request_id,idempotency_key,
  created_at,queue_until,started_at,ended_at,cancel_at,cancel_by,cancel_request_id,reason_json,input_json,attempt_id,result_sha`;
const pending = "('queued','preparing','running','cancelling')";
const reason = (code: string, message: string): QualityJobReason => ({code, message});

/** One owner, bounded records, one attempt per submission. The separate SQLite
 * lock is crash-released; recovery cannot run against a live owning service. */
export class QualityJobStore {
  taskSummaries(actor:string){return taskSummaries(this.db,'single',actor);}

  private db: ReturnType<typeof openIndexDatabase>;
  private unlock: () => void;
  constructor(file: string, now = Date.now()) {
    mkdirSync(path.dirname(file), {recursive: true});
    this.unlock = lockDatabase(file);
    let db: ReturnType<typeof openIndexDatabase> | undefined;
    try {
      this.db = db = openIndexDatabase(file);
      db.exec('PRAGMA busy_timeout=0; PRAGMA foreign_keys=ON;');
      if (Number(db.prepare('PRAGMA user_version').get()!.user_version) > 1)
        throw new Error('Quality history requires a newer application.');
      db.exec(`PRAGMA journal_mode=WAL; PRAGMA journal_size_limit=1048576; PRAGMA wal_autocheckpoint=100;
        BEGIN IMMEDIATE;
        CREATE TABLE IF NOT EXISTS quality_clock(id INTEGER PRIMARY KEY,sequence INTEGER NOT NULL);
        INSERT OR IGNORE INTO quality_clock VALUES(1,0);
        CREATE TABLE IF NOT EXISTS quality_jobs(
          ordinal INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,
          revision INTEGER NOT NULL DEFAULT 1,sequence INTEGER NOT NULL,state TEXT NOT NULL,phase TEXT NOT NULL,
          actor_id TEXT NOT NULL,actor_name TEXT NOT NULL,client_id TEXT NOT NULL,request_id TEXT NOT NULL,idempotency_key TEXT NOT NULL,
          fingerprint TEXT NOT NULL,input_json TEXT NOT NULL,reserved_bytes INTEGER NOT NULL,
          created_at INTEGER NOT NULL,queue_until INTEGER NOT NULL,started_at INTEGER,ended_at INTEGER,
          cancel_at INTEGER,cancel_by TEXT,cancel_request_id TEXT,reason_json TEXT,attempt_id TEXT,result_json TEXT,result_sha TEXT,
          UNIQUE(actor_id,client_id,idempotency_key));
        CREATE INDEX IF NOT EXISTS quality_job_changes ON quality_jobs(sequence);
        CREATE TABLE IF NOT EXISTS quality_attempts(id TEXT PRIMARY KEY,job_id TEXT UNIQUE NOT NULL REFERENCES quality_jobs(id),
          state TEXT NOT NULL,phase TEXT NOT NULL,started_at INTEGER NOT NULL,ended_at INTEGER);
        PRAGMA user_version=1; COMMIT;`);
      this.recover(now);
    } catch (error) { try { db?.close(); } finally { this.unlock(); } throw error; }
  }
  private transaction<T>(action: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = action(); this.db.exec('COMMIT'); return value; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  private tick() {
    this.db.exec('UPDATE quality_clock SET sequence=sequence+1 WHERE id=1');
    return Number(this.db.prepare('SELECT sequence FROM quality_clock WHERE id=1').get()!.sequence);
  }
  private patch(id: string, fields: Record<string, string | number | null>) {
    const entries = Object.entries(fields);
    this.db.prepare(`UPDATE quality_jobs SET ${entries.map(([key]) => `${key}=?`).join(',')},revision=revision+1,sequence=? WHERE id=?`)
      .run(...entries.map(([, value]) => value), this.tick(), id);
  }
  private recover(now: number) {
    this.transaction(() => {
      const rows = this.db.prepare(`SELECT id,attempt_id FROM quality_jobs WHERE state IN ${pending}`).all();
      for (const row of rows) {
        this.patch(String(row.id), {state: 'interrupted', phase: 'done', ended_at: now,
          reason_json: JSON.stringify(reason('service-restarted', 'The previous service stopped before a terminal commit. No automatic retry.'))});
        if (row.attempt_id) this.db.prepare("UPDATE quality_attempts SET state='interrupted',phase='done',ended_at=? WHERE id=?").run(now, row.attempt_id);
      }
    });
  }
  get(id: string): QualityJob {
    const row = this.db.prepare(`SELECT ${columns} FROM quality_jobs WHERE id=?`).get(id);
    if (!row) throw new AdminError(404, 'Quality job not found.', 'job-not-found');
    const input = JSON.parse(String(row.input_json)) as QualityJob['input'];
    const attempt = row.attempt_id ? this.db.prepare('SELECT * FROM quality_attempts WHERE id=?').get(row.attempt_id) : null;
    const completed = row.state === 'completed';
    return {schema: 'voidplayer-quality-job', version: 1, id: String(row.id), revision: Number(row.revision), sequence: Number(row.sequence),
      state: row.state as QualityJobState, phase: row.phase as QualityJobPhase,
      submitted: {actorId: String(row.actor_id), actorName: String(row.actor_name), client: input.client,
        requestId: String(row.request_id), idempotencyKey: String(row.idempotency_key)},
      createdAt: Number(row.created_at), queueUntil: Number(row.queue_until),
      startedAt: row.started_at === null ? null : Number(row.started_at), endedAt: row.ended_at === null ? null : Number(row.ended_at),
      cancelRequestedAt: row.cancel_at === null ? null : Number(row.cancel_at), cancelRequestedBy: row.cancel_by === null ? null : String(row.cancel_by),
      cancelRequestId: row.cancel_request_id === null ? null : String(row.cancel_request_id),
      reason: row.reason_json ? JSON.parse(String(row.reason_json)) : null, input,
      attempt: attempt ? {id: String(attempt.id), number: 1, state: attempt.state as QualityJobState, phase: attempt.phase as QualityJobPhase,
        startedAt: Number(attempt.started_at), endedAt: attempt.ended_at === null ? null : Number(attempt.ended_at)} : null,
      result: {available: completed && !!row.result_sha, url: `/api/quality/jobs/${row.id}/result`, digest: row.result_sha ? String(row.result_sha) : null},
      progress: {scoredPairs: completed ? 1 : 0, targetPairs: 1, decodedFrames: completed ?
        [input.request.reference,input.request.distorted].reduce((n,t)=>n+pairPacketCount(t),0) : null}};
  }
  submit(request: ReturnType<typeof qualityJobRequest>, actor: Actor, requestId: string, key: string, now: number) {
    return this.transaction(() => {
      const prior = this.db.prepare('SELECT id,fingerprint FROM quality_jobs WHERE actor_id=? AND client_id=? AND idempotency_key=?')
        .get(actor.id, request.input.client.id, key);
      if (prior) {
        if (prior.fingerprint !== request.fingerprint) throw new AdminError(409, 'Idempotency-Key already binds another request.', 'idempotency-conflict');
        return {job: this.get(String(prior.id)), replayed: true};
      }
      const history = this.db.prepare('SELECT count(*) AS count,coalesce(sum(reserved_bytes),0) AS bytes FROM quality_jobs').get()!;
      const charge = Buffer.byteLength(request.json) + LIMITS.resultBytes;
      if (Number(history.count) >= LIMITS.historyRows || Number(history.bytes) + charge > LIMITS.reservedBytes)
        throw new AdminError(429, 'Quality history budget is full; existing history is retained.', 'quality-history-full');
      if (Number(this.db.prepare("SELECT count(*) AS count FROM quality_jobs WHERE state='queued'").get()!.count) >= LIMITS.queued)
        throw new AdminError(429, 'Quality queue is full.', 'quality-queue-full');
      if (Number(this.db.prepare(`SELECT count(*) AS count FROM quality_jobs WHERE actor_id=? AND state IN ${pending}`).get(actor.id)!.count) >= LIMITS.actorOutstanding)
        throw new AdminError(429, 'Actor quality admission is full.', 'quality-actor-limit');
      const id = randomUUID();
      this.db.prepare(`INSERT INTO quality_jobs(id,sequence,state,phase,actor_id,actor_name,client_id,request_id,idempotency_key,
        fingerprint,input_json,reserved_bytes,created_at,queue_until) VALUES(?,?,'queued','queued',?,?,?,?,?,?,?,?,?,?)`)
        .run(id, this.tick(), actor.id, actor.name.slice(0, 120), request.input.client.id, requestId, key,
          request.fingerprint, request.json, charge, now, now + LIMITS.queueWaitMs);
      return {job: this.get(id), replayed: false};
    });
  }
  queued() {
    const row = this.db.prepare("SELECT id FROM quality_jobs WHERE state='queued' ORDER BY ordinal LIMIT 1").get();
    return row ? this.get(String(row.id)) : null;
  }
  expire(now: number) {
    this.transaction(() => {
      for (const row of this.db.prepare("SELECT id FROM quality_jobs WHERE state='queued' AND queue_until<=?").all(now))
        this.patch(String(row.id), {state: 'failed', phase: 'done', ended_at: now,
          reason_json: JSON.stringify(reason('queue-expired', 'Queue waiting deadline exceeded; execution did not start.'))});
    });
  }
  blocked(id: string) {
    const job = this.get(id);
    if (job.state === 'queued' && job.reason?.code !== 'compute-busy') this.transaction(() => this.patch(id, {
      reason_json: JSON.stringify(reason('compute-busy', 'Waiting for the shared instance compute admission.'))}));
  }
  start(id: string, now: number): string {
    return this.transaction(() => {
      const job = this.get(id);
      if (job.state !== 'queued') throw new AdminError(409, 'Job is no longer eligible for execution.', 'job-not-queued');
      if (now >= job.queueUntil) throw new AdminError(408, 'Queue waiting deadline exceeded.', 'queue-expired');
      const attempt = randomUUID();
      this.db.prepare("INSERT INTO quality_attempts VALUES(?,?,'preparing','source',?,NULL)").run(attempt, id, now);
      this.patch(id, {attempt_id: attempt, state: 'preparing', phase: 'source', started_at: now, reason_json: null});
      return attempt;
    });
  }
  phase(id: string, attempt: string, phase: 'source' | 'resolve' | 'decode' | 'publish') {
    const job = this.get(id), order = ['source', 'resolve', 'decode', 'publish'];
    if (job.attempt?.id !== attempt || terminalQualityJob(job.state) || job.state === 'cancelling'
      || order.indexOf(phase) <= order.indexOf(job.phase)) return;
    this.transaction(() => {
      const state = phase === 'decode' || phase === 'publish' ? 'running' : 'preparing';
      this.patch(id, {state, phase});
      this.db.prepare('UPDATE quality_attempts SET state=?,phase=? WHERE id=?').run(state, phase, attempt);
    });
  }
  cancel(id: string, actor: string, requestId: string, now: number) {
    return this.transaction(() => {
      const job = this.get(id);
      if (terminalQualityJob(job.state) || job.state === 'cancelling') return job;
      const queued = job.state === 'queued';
      this.patch(id, {state: queued ? 'cancelled' : 'cancelling', phase: queued ? 'done' : 'stopping', cancel_at: now,
        cancel_by: actor, cancel_request_id: requestId, ended_at: queued ? now : null,
        reason_json: JSON.stringify(reason('cancel-requested', 'Explicit cancellation requested.'))});
      if (job.attempt) this.db.prepare("UPDATE quality_attempts SET state='cancelling',phase='stopping' WHERE id=?").run(job.attempt.id);
      return this.get(id);
    });
  }
  finish(id: string, attempt: string | null, state: 'completed' | 'failed' | 'interrupted', why: QualityJobReason | null, now: number, value?: LibraryPairResult) {
    return this.transaction(() => {
      const job = this.get(id);
      if (terminalQualityJob(job.state) || (job.attempt?.id ?? null) !== attempt) return false;
      let result: string | null = null, digest: string | null = null;
      const finalState = job.cancelRequestedAt !== null ? 'cancelled' : state;
      if (finalState === 'completed') {
        if (!attempt || !value) throw new Error('Completed quality attempt has no result');
        const envelope: QualityJobResult = {schema: 'voidplayer-quality-job-result', version: 1, jobId: id, attemptId: attempt,
          submitted: job.submitted, completedAt: now, value};
        result = JSON.stringify(envelope);
        if (Buffer.byteLength(result) > LIMITS.resultBytes) throw new AdminError(413, 'Quality result budget exceeded.', 'budget-exceeded');
        digest = createHash('sha256').update(result).digest('hex');
      }
      this.patch(id, {state: finalState, phase: 'done', ended_at: now, result_json: result, result_sha: digest,
        reason_json: JSON.stringify(finalState === 'cancelled' ? reason('cancelled', 'Execution stopped after explicit cancellation.') : why)});
      if (attempt) this.db.prepare("UPDATE quality_attempts SET state=?,phase='done',ended_at=? WHERE id=?").run(finalState, now, attempt);
      return true;
    });
  }
  stopUncertain(id: string) {
    this.transaction(() => {
      const job = this.get(id);
      this.patch(id, {state: 'cancelling', phase: 'stopping', reason_json: JSON.stringify(
        reason('worker-stop-uncertain', 'Physical Worker exit is unconfirmed; capacity remains occupied.'))});
      if (job.attempt) this.db.prepare("UPDATE quality_attempts SET state='cancelling',phase='stopping' WHERE id=?").run(job.attempt.id);
    });
  }
  result(id: string): QualityJobResult {
    const job = this.get(id);
    if (!job.result.available) throw new AdminError(409, 'Quality result is not available.', 'result-unavailable');
    const raw = String(this.db.prepare('SELECT result_json FROM quality_jobs WHERE id=?').get(id)!.result_json);
    if (Buffer.byteLength(raw) > LIMITS.resultBytes || createHash('sha256').update(raw).digest('hex') !== job.result.digest)
      throw new AdminError(500, 'Quality history result failed integrity checks.', 'stored-result-invalid');
    return JSON.parse(raw);
  }
  changes(actor: string | null, after = 0, limit: number = LIMITS.pageSize): QualityJobPage {
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > LIMITS.pageSize)
      throw new AdminError(400, 'Invalid quality history cursor or page size.', 'invalid-cursor');
    const head = Number(this.db.prepare('SELECT sequence FROM quality_clock WHERE id=1').get()!.sequence);
    if (after > head) throw new AdminError(409, 'Quality history cursor is ahead; restart from zero.', 'cursor-ahead');
    const rows = actor === null
      ? this.db.prepare('SELECT id FROM quality_jobs WHERE sequence>? ORDER BY sequence LIMIT ?').all(after, limit + 1)
      : this.db.prepare('SELECT id FROM quality_jobs WHERE actor_id=? AND sequence>? ORDER BY sequence LIMIT ?').all(actor, after, limit + 1);
    const entries = rows.slice(0, limit).map(row => {const {input, ...summary} = this.get(String(row.id)); return summary;});
    const more = rows.length > limit;
    return {schema: 'voidplayer-quality-jobs', version: 1, entries, head, cursor: more ? entries.at(-1)!.sequence : head, more};
  }
  unfinished() {
    return this.db.prepare(`SELECT id FROM quality_jobs WHERE state IN ${pending}`).all().map(row => this.get(String(row.id)));
  }
  counts() {
    const counts = {queued: 0, activeAttempts: 0};
    for (const row of this.db.prepare(`SELECT state,count(*) AS n FROM quality_jobs WHERE state IN ${pending} GROUP BY state`).all())
      if (row.state === 'queued') counts.queued = Number(row.n); else counts.activeAttempts += Number(row.n);
    return counts;
  }
  close() { this.db.close(); this.unlock(); }
}
