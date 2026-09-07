import { randomUUID } from './uuid.ts';
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogCategory = 'ui' | 'session' | 'media' | 'agent' | 'error';
export type OperationContext = { operationId: string; parentOperationId?: string; source: string };
export type LogEvent = { seq: number; tMs: number; level: LogLevel; cat: LogCategory; msg: string; data?: unknown; context?: OperationContext };
export type LogDocument = {
  schema: 'voidplayer-web-log'; version: 1; sessionId: string; startedAt: string; updatedAt: string;
  environment: Record<string, unknown>; capacity: number; droppedEvents: number; events: LogEvent[];
};
export interface LogStorage { save(document: LogDocument): Promise<void>; list(): Promise<LogDocument[]>; }
export type LogQuery = { sinceSeq?: number; level?: LogLevel; limit?: number; sessionId?: string };
const rank = { debug: 0, info: 1, warn: 2, error: 3 };

// Payloads are bounded, detached JSON. Never store note bodies or file contents.
export function logData(value: unknown): unknown {
  const seen = new WeakSet<object>();
  let budget = 4096;
  const visit = (v: unknown, depth = 0, key = ''): unknown => {
    if (/^(text|note|password|token|secret|authorization)$/i.test(key)) return { omitted: true, length: typeof v === 'string' ? v.length : undefined };
    if (budget <= 0 || depth > 4) return '[truncated]';
    budget -= 8;
    if (typeof v === 'string') { const result = v.slice(0, Math.min(budget, 800)); budget -= result.length; return result; }
    if (typeof v === 'number') return Number.isFinite(v) ? v : String(v);
    if (typeof v === 'bigint') return String(v);
    if (v == null || typeof v === 'boolean') return v ?? null;
    if (typeof v !== 'object') return String(v);
    if (seen.has(v)) return '[circular]';
    seen.add(v);
    if (v instanceof Error) return visit({ name: v.name, message: v.message, stack: v.stack }, depth + 1);
    if (typeof File !== 'undefined' && v instanceof File) return visit({ name: v.name, size: v.size, type: v.type, lastModified: v.lastModified }, depth + 1);
    if (ArrayBuffer.isView(v) || v instanceof ArrayBuffer) return { byteLength: v.byteLength, omitted: true };
    if (Array.isArray(v)) return v.slice(0, 20).map(item => visit(item, depth + 1));
    return Object.fromEntries(Object.entries(v).slice(0, 20).map(([k, x]) => [k.slice(0, 80), visit(x, depth + 1, k)]));
  };
  try { const result = visit(value); const json = JSON.stringify(result); return json.length > 8192 ? { truncated: true, preview: json.slice(0, 4096) } : result; } catch { return '[unreadable payload]'; }
}
export function validateLogQuery(query: LogQuery) {
  const { sinceSeq = 0, level = 'debug', limit = 500, sessionId } = query;
  if (!Number.isSafeInteger(sinceSeq) || sinceSeq < 0) throw new Error('日志序号必须是非负整数。');
  if (typeof level !== 'string' || !Object.hasOwn(rank, level)) throw new Error('日志级别无效。');
  if (!Number.isInteger(limit) || limit < 1 || limit > 2000) throw new Error('日志条数必须是 1–2000。');
  if (sessionId !== undefined && (typeof sessionId !== 'string' || sessionId.length > 100 || !sessionId)) throw new Error('日志会话编号无效。');
  return { sinceSeq, level, limit, sessionId };
}
export function readLogPage(document: LogDocument, query: LogQuery = {}) {
  const { sinceSeq, level, limit } = validateLogQuery(query);
  const firstSeq = document.events[0]?.seq ?? 1;
  const lastSeq = document.events.at(-1)?.seq ?? 0;
  if (query.sessionId && query.sessionId !== document.sessionId) throw new Error('日志会话不匹配。');
  if (sinceSeq > lastSeq) throw new Error('日志游标超出本会话范围，请从 0 重新读取。');
  const matching = document.events.filter(e => e.seq > sinceSeq && rank[e.level] >= rank[level]);
  const events = matching.slice(0, limit);
  const hasMore = matching.length > events.length;
  return structuredClone({ sessionId: document.sessionId, startedAt: document.startedAt, updatedAt: document.updatedAt, environment: document.environment, capacity: document.capacity, firstSeq, lastSeq,
    nextSeq: hasMore ? events.at(-1)!.seq : lastSeq, hasMore,
    gap: sinceSeq < firstSeq - 1, droppedEvents: document.droppedEvents, events });
}

export class SessionLog {
  private document: LogDocument;
  private started = performance.now();
  private nextSeq = 1;
  private storage?: LogStorage;
  private timer?: ReturnType<typeof setTimeout>;
  private writes: Promise<void> = Promise.resolve();
  private dirty = false;
  private listeners = new Set<() => void>();
  storageState: 'memory' | 'pending' | 'saved' | 'failed' = 'memory';
  storageError: string | null = null;
  constructor(capacity = 2000) {
    this.document = { schema: 'voidplayer-web-log', version: 1, sessionId: randomUUID(), startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), environment: {}, capacity, droppedEvents: 0, events: [] };
  }
  subscribe(fn: () => void) { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }
  private notify() { for (const fn of this.listeners) { try { fn(); } catch { /* Logging cannot break playback. */ } } }
  append(level: LogLevel, cat: LogCategory, msg: string, data?: unknown, context?: OperationContext) {
    this.document.events.push({ seq: this.nextSeq++, tMs: Math.round(performance.now() - this.started), level, cat, msg: msg.slice(0, 800), ...(data === undefined ? {} : { data: logData(data) }), ...(context ? { context: { ...context } } : {}) });
    if (this.document.events.length > this.document.capacity) {
      this.document.events.shift(); this.document.droppedEvents++;
    }
    this.document.updatedAt = new Date().toISOString();
    this.dirty = true;
    if (this.storage) {
      this.storageState = 'pending';
      this.timer ??= setTimeout(() => { this.timer = undefined; void this.flush(); }, 250);
    }
    this.notify();
  }
  snapshot() { return structuredClone(this.document); }
  read(query: LogQuery = {}) { return readLogPage(this.document, query); }
  attach(storage: LogStorage, environment: Record<string, unknown>) {
    this.storage = storage; this.document.environment = logData(environment) as Record<string, unknown>;
    this.dirty = true; return this.flush();
  }
  flush(): Promise<void> {
    clearTimeout(this.timer); this.timer = undefined;
    if (!this.storage) return Promise.resolve();
    this.writes = this.writes.then(async () => {
      if (!this.dirty) return;
      const document = this.snapshot(); this.dirty = false;
      try {
        await this.storage!.save(document);
        this.storageState = this.dirty ? 'pending' : 'saved'; this.storageError = null;
      } catch (error) {
        this.dirty = true; this.storageState = 'failed';
        this.storageError = error instanceof Error ? error.message : String(error);
      }
      this.notify();
    });
    return this.writes;
  }
  async archives() { return this.storage ? this.storage.list() : []; }
  dispose() { clearTimeout(this.timer); this.listeners.clear(); return this.flush(); }
}
export const sessionLog = new SessionLog();
let activeContext: OperationContext | undefined;
export const operationContext = () => activeContext;
export function withLogContext<T>(context: OperationContext | undefined, action: () => T): T {
  const previous = activeContext; activeContext = context;
  try { return action(); } finally { activeContext = previous; }
}
export function contextLog(context = activeContext) {
  return Object.fromEntries(Object.keys(rank).map(level => [level, (cat: LogCategory, msg: string, data?: unknown) => sessionLog.append(level as LogLevel, cat, msg, data, context)])) as Record<LogLevel, (cat: LogCategory, msg: string, data?: unknown) => void>;
}
export const log = Object.fromEntries(Object.keys(rank).map(level => [level, (cat: LogCategory, msg: string, data?: unknown) => sessionLog.append(level as LogLevel, cat, msg, data, activeContext)])) as ReturnType<typeof contextLog>;
export function traceOperation<T>(source: string, action: string, data: unknown, work: () => T): T {
  const context = { operationId: randomUUID(), parentOperationId: activeContext?.operationId, source: source === 'session' ? activeContext?.source ?? source : source };
  const scoped = contextLog(context); const start = performance.now();
  scoped.info(source === 'agent' ? 'agent' : source === 'ui' ? 'ui' : 'session', '操作请求', { action, arguments: data });
  const done = (error?: unknown, failed = false) => {
    const status = !failed ? 'completed' : error instanceof Error && error.name === 'AbortError' ? 'cancelled' : 'failed';
    scoped[status === 'failed' ? 'warn' : 'info']('session', '操作结束', { action, status, durationMs: Math.round(performance.now() - start), ...(failed ? { error } : {}) });
  };
  try {
    const result = withLogContext(context, work);
    if (result instanceof Promise) return result.then(value => { done(); return value; }, error => { done(error, true); throw error; }) as T;
    done(); return result;
  } catch (error) { done(error, true); throw error; }
}
export const getLogEvents = (query: LogQuery = {}) => sessionLog.read(query);
export async function getLogSessions() {
  let archives: LogDocument[] = []; let historyError: string | null = null;
  try { archives = await sessionLog.archives(); } catch (error) { historyError = String(error); }
  const current = sessionLog.snapshot();
  const documents = [current, ...archives.filter(d => d.sessionId !== current.sessionId)].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  return { storage: sessionLog.storageState, error: sessionLog.storageError ?? historyError,
    sessions: documents.map(d => ({ sessionId: d.sessionId, startedAt: d.startedAt, updatedAt: d.updatedAt, events: d.events.length, droppedEvents: d.droppedEvents, current: d.sessionId === current.sessionId })) };
}
export async function exportLog(sessionId = sessionLog.snapshot().sessionId) {
  const current = sessionLog.snapshot();
  const document = sessionId === current.sessionId ? current : (await sessionLog.archives()).find(d => d.sessionId === sessionId);
  if (!document) throw new Error('该日志会话不存在或已超过保留期限。');
  return { ...document, exportedAt: new Date().toISOString(), storage: sessionLog.storageState, storageError: sessionLog.storageError };
}
export async function readLogs(query: LogQuery = {}) {
  validateLogQuery(query);
  return readLogPage(await exportLog(query.sessionId), query);
}
