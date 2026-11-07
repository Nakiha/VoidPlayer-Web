import { ReportLogs } from './logging/reports.ts';
import type { RuntimeLog } from './logging/runtime.ts';
import { logPolicy } from '../shared/service/logging.ts';
import { requestAuthority } from './http.ts';
import {closeResources} from './shutdown.ts';
import type {AdminStatus,RootConfiguration,LogPage,LogDocument,AnalysisSettings,RootReasonCode} from '../shared/service/admin.ts';
export type {RootReasonCode} from '../shared/service/admin.ts';
import { AnalysisScheduler } from './analysis/bitstream/scheduler.ts';
import { MAX_ANALYSIS_CONCURRENCY, DEFAULT_ANALYSIS_DECODER, MAX_ANALYSIS_THREADS, validAnalysisConcurrency, validAnalysisDecoder } from './analysis/bitstream/limits.ts';
import { promises as fs, constants } from 'node:fs';
import type { IncomingMessage } from './http.ts';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { configRevision } from './config.ts';
import type { ServiceConfig } from './config.ts';
import { normalizeRoots } from './library-store.ts';
import type { MediaRoot } from './library-store.ts';
import { MediaLibraryIndex } from './library.ts';
import { encryptedRequest } from './tls.ts';

export { AdminError } from './admin-error.ts';
import { AdminError } from './admin-error.ts';
import { Measurements } from './measurement.ts';
import { CacheManager } from './caches.ts';
import { AnnotationStore } from './annotations.ts';
import { WorkspaceStore } from './workspaces.ts';
export function adminWriteAllowed(req: IncomingMessage, action = 'admin') {
  if (req.headers['x-voidplayer-action'] !== action) return false;
  try {
    const origin = new URL(req.headers.origin ?? '');
    return origin.host === requestAuthority(req) && origin.protocol === (encryptedRequest(req) ? 'https:' : 'http:');
  } catch { return false; }
}
export async function readAdminJson(req: IncomingMessage, max = 65536): Promise<unknown> {
  if (!String(req.headers['content-type']).startsWith('application/json')) throw new AdminError(415, '请提交 JSON。');
  if (Number(req.headers['content-length']) > max) throw new AdminError(413, '提交内容过大。');
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > max) throw new AdminError(413, '提交内容过大。'); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new AdminError(400, 'JSON 格式无效。'); }
}
async function configText(file: string) { try { return await fs.readFile(file, 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw error; } }
async function atomicWrite(file: string, text: string) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await fs.open(temporary, 'wx', 0o600);
    try { await handle.writeFile(text); await handle.sync(); } finally { await handle.close(); }
    await fs.rename(temporary, file);
  } finally { await fs.rm(temporary, { force: true }); }
}

export class AdminController {
  readonly reports: ReportLogs;
  private runtimeLog?: RuntimeLog;
  readonly config: ServiceConfig;
  readonly library: MediaLibraryIndex;
  private analysisInstance?: AnalysisScheduler;
  get analysis() { return this.analysisFor(process.env.VOIDPLAYER_ANALYSIS_CORE_DIR || path.join(this.config.staticDir, 'vendor/voidplayer-analysis')); }
  analysisFor(coreDir: string) {
    if (!this.analysisInstance) {
      this.analysisInstance = new AnalysisScheduler(this.library, coreDir, this.library.analysisDirectory);
      this.library.registerIndexReader(() => this.analysisInstance!.close());
      this.analysisInstance.configure(this.config.analysisConcurrency, this.config.analysisDecoder ?? DEFAULT_ANALYSIS_DECODER);
    }
    return this.analysisInstance;
  }
  readonly measurements: Measurements;
  readonly workspaces: WorkspaceStore;
  readonly annotations: AnnotationStore;
  private build: { version: string; revision: string };
  private mutation: Promise<unknown> | null = null;
  private cpu = process.cpuUsage();
  private cpuAt = performance.now();
  private cpuPercent = 0;
  constructor(config: ServiceConfig, library: MediaLibraryIndex, build = { version: 'development', revision: 'source' },
    runtimeLog?: RuntimeLog) {
    this.runtimeLog = runtimeLog; this.reports = new ReportLogs(config.logsDir, logPolicy(config.logging).reports);
    this.config = config; this.library = library; this.build = build;
    this.measurements = new Measurements(library);
    this.workspaces = new WorkspaceStore(path.join(config.dataDir, 'workspaces.sqlite'));
    try { this.annotations = new AnnotationStore(path.join(config.dataDir, 'annotations.sqlite')); }
    catch (error) {
      try { this.workspaces.close(); }
      catch (cleanup) { throw new AggregateError([error, cleanup], 'Admin initialization failed', { cause: error }); }
      throw error;
    } }
  get caches() { return new CacheManager(this.config.dataDir, this.library.frameIndexes, this.annotations, this.library.thumbnails); }
  status(): AdminStatus {
    const now = performance.now(), elapsed = now - this.cpuAt;
    if (elapsed >= 500) {
      const current = process.cpuUsage();
      this.cpuPercent = (current.user + current.system - this.cpu.user - this.cpu.system) / (elapsed * 1000) * 100;
      this.cpu = current; this.cpuAt = now;
    }
    const memory = process.memoryUsage();
    return { ...this.build, analysis: this.analysis.resources(), runtime: process.versions.bun ? `Bun ${process.versions.bun}` : `Node ${process.versions.node}`, platform: `${process.platform} ${process.arch}`, uptimeSeconds: process.uptime(), cpuPercent: this.cpuPercent, logicalCpus: os.availableParallelism(), memory: { rss: memory.rss, heapUsed: memory.heapUsed, systemTotal: os.totalmem(), systemFree: os.freemem() }, dataDir: this.config.dataDir, logsEnabled: !!this.config.logsDir, library: this.library.status() };
  }
  async roots(): Promise<RootConfiguration> {
    const origin = this.config.origin;
    const changed = !!origin && configRevision(await configText(origin.file)) !== origin.revision;
    const writeAccess = !!origin && await fs.access(path.dirname(origin.file), constants.W_OK).then(() => true, () => false);
    return { roots: this.library.definitions.map(({ id, path, name }) => ({ id, path, name })), revision: origin?.revision ?? null, writable: !!origin && !origin.rootsFromCli && !changed && writeAccess, changedExternally: changed, configFile: origin?.file ?? null, reasonCode: (changed ? 'external-change' : origin?.rootsFromCli ? 'cli-override' : !origin ? 'no-source' : !writeAccess ? 'not-writable' : null) as RootReasonCode | null, reason: changed ? '配置文件已被外部修改，请重启服务以重新载入。' : origin?.rootsFromCli ? '当前根目录由 --folder 覆盖，请修改启动参数或改用配置文件。' : !origin ? '此服务未提供可写配置来源。' : !writeAccess ? '配置所在目录不可写，请调整数据目录权限。' : null };
  }
  saveRoots(document: unknown) {
    if (this.closing) throw new AdminError(503, '服务正在关闭。');
    if (this.mutation) throw new AdminError(409, '另一项配置修改正在保存，请稍后重试。');
    const operation = this.updateRoots(document).finally(() => { this.mutation = null; });
    this.mutation = operation; return operation;
  }
  private async updateRoots(document: unknown) {
    const input = document as { revision?: unknown; roots?: unknown } | null;
    if (!input || typeof input.revision !== 'string' || !Array.isArray(input.roots) || !input.roots.length || input.roots.length > 64) throw new AdminError(400, '请提供配置版本，并保留 1–64 个媒体根目录。');
    if (input.roots.some(r => !r || typeof r !== 'object' || typeof r.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(r.id) || typeof r.path !== 'string' || !path.isAbsolute(r.path) || r.path.length > 4096 || r.path.includes('\0') || typeof r.name !== 'string' || !r.name.trim() || r.name.length > 120 || Object.keys(r).some(k => !['id', 'path', 'name'].includes(k)))) throw new AdminError(400, '每个目录需要有效的 ID、名称和服务器上的绝对路径。');
    const roots = input.roots as MediaRoot[];
    try { normalizeRoots(roots); } catch (error) { throw new AdminError(400, (error as Error).message); }
    const origin = this.config.origin;
    if (!origin || origin.rootsFromCli) throw new AdminError(409, '当前目录由启动参数提供，无法写回配置文件。');
    if (input.revision !== origin.revision) throw new AdminError(409, '配置已更新，请重新载入后再编辑。');
    const before = await configText(origin.file);
    if (configRevision(before) !== origin.revision) throw new AdminError(409, '配置文件已被外部修改，请重启服务后再编辑。');
    const after = JSON.stringify({ ...(before ? JSON.parse(before) : {}), mediaRoots: roots }, null, 2) + '\n';
    await this.library.reconfigure(roots, async () => {
      // Recheck after waiting for the scan to cancel, before replacing the file.
      if (configRevision(await configText(origin.file)) !== origin.revision) throw new AdminError(409, '配置文件已被外部修改。');
      await atomicWrite(origin.file, after);
      return async () => { if (before) await atomicWrite(origin.file, before); else await fs.rm(origin.file, { force: true }); };
    });
    this.config.mediaRoots = roots; origin.revision = configRevision(after);
    return this.roots();
  }
  async analysisSettings(): Promise<AnalysisSettings> {
    const origin = this.config.origin;
    const changed = !!origin && configRevision(await configText(origin.file)) !== origin.revision;
    const writeAccess = !!origin && await fs.access(path.dirname(origin.file), constants.W_OK).then(() => true, () => false);
    return { ...this.analysis.resources(), decoder: this.config.analysisDecoder ?? DEFAULT_ANALYSIS_DECODER,
      maxThreads: MAX_ANALYSIS_THREADS, min: 1, max: MAX_ANALYSIS_CONCURRENCY, revision: origin?.revision ?? null,
      writable: !!origin && !changed && writeAccess,
      reasonCode: (changed ? 'external-change' : !origin ? 'no-source' : !writeAccess ? 'not-writable' : null) as RootReasonCode | null };
  }
  saveAnalysisSettings(document: unknown) {
    if (this.closing) throw new AdminError(503, '服务正在关闭。');
    if (this.mutation) throw new AdminError(409, '另一项配置修改正在保存，请稍后重试。');
    const operation = this.updateAnalysisSettings(document).finally(() => { this.mutation = null; });
    this.mutation = operation; return operation;
  }
  private async updateAnalysisSettings(document: unknown) {
    const input = document as { revision?: unknown; concurrency?: unknown; decoder?: unknown } | null;
    if (!input || typeof input.revision !== 'string' || !validAnalysisConcurrency(input.concurrency))
      throw new AdminError(400, '请提供配置版本及 1–32 的分析并发数。');
    const decoder = input.decoder === undefined ? this.config.analysisDecoder ?? DEFAULT_ANALYSIS_DECODER : input.decoder;
    if (!validAnalysisDecoder(decoder))
      throw new AdminError(400, '请选择 1–4 个分析线程，帧上下文数须介于 1 和线程数之间。');
    const origin = this.config.origin;
    if (!origin || input.revision !== origin.revision) throw new AdminError(409, '配置已更新或无法写回，请重新载入后再编辑。');
    const before = await configText(origin.file);
    if (configRevision(before) !== origin.revision) throw new AdminError(409, '配置文件已被外部修改，请重启服务后再编辑。');
    const after = JSON.stringify({ ...(before ? JSON.parse(before) : {}), analysisConcurrency: input.concurrency, analysisDecoder: decoder }, null, 2) + '\n';
    await atomicWrite(origin.file, after);
    this.config.analysisConcurrency = input.concurrency; this.config.analysisDecoder = decoder;
    origin.revision = configRevision(after);
    this.analysis.configure(input.concurrency, decoder);
    return this.analysisSettings();
  }
  async logs(before = '', limit = 40): Promise<LogPage> {
    const page = await this.reports.list(before, limit);
    if (page.storage) page.storage.runtime = this.runtimeLog?.status() ?? null;
    return page;
  }
  readLog(name: string, version: string | null): Promise<LogDocument> { return this.reports.read(name, version); }
  deleteLog(name: string, version: string | null) { return this.reports.delete(name, version); }
  private closing?: Promise<void>;
  close() { return this.closing ??= closeResources('Admin shutdown incomplete', [
    ['reports', () => this.reports?.close()],
    ['measurements', () => this.measurements.close()],
    // A pending settings write may create the analysis scheduler. Drain that
    // producer before closing its eventual executor; the library waits for both.
    ['configuration mutation and bitstream analysis', async () => {
      await this.mutation?.catch(() => {});
      await this.analysisInstance?.close();
    }],
    ['workspaces', () => this.workspaces.close()],
    ['annotations', () => this.annotations.close()],
  ]); }
}
