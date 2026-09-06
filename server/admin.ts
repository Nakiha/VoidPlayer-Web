import { promises as fs, constants } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { configRevision } from './config.ts';
import type { ServiceConfig } from './config.ts';
import { normalizeRoots } from './library-store.ts';
import type { MediaRoot } from './library-store.ts';
import { MediaLibraryIndex, fileVersion } from './library.ts';
import { requestActor } from './identity.ts';
import { localRequest } from './reveal.ts';

export class AdminError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
export function adminIdentity(req: IncomingMessage, proxyToken: string | undefined, users: string[]) {
  if (!proxyToken) return localRequest(req) ? { id: 'local', name: '本机管理员' } : null;
  const actor = requestActor(req, proxyToken);
  return actor && users.includes(actor.id) ? actor : null;
}
export function adminWriteAllowed(req: IncomingMessage, proxyToken?: string) {
  if (req.headers['x-voidplayer-action'] !== 'admin') return false;
  try {
    const origin = new URL(req.headers.origin ?? '');
    return origin.host === req.headers.host && origin.protocol === `${proxyToken ? req.headers['x-forwarded-proto'] ?? 'https' : 'http'}:`;
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
const logName = (name: string) => /^voidplayer-log-[A-Za-z0-9_.-]{1,180}\.json$/.test(name);

export class AdminController {
  readonly config: ServiceConfig;
  readonly library: MediaLibraryIndex;
  private build: { version: string; revision: string };
  private mutation: Promise<unknown> | null = null;
  private cpu = process.cpuUsage();
  private cpuAt = performance.now();
  private cpuPercent = 0;
  constructor(config: ServiceConfig, library: MediaLibraryIndex, build = { version: 'development', revision: 'source' }) { this.config = config; this.library = library; this.build = build; }
  status() {
    const now = performance.now(), elapsed = now - this.cpuAt;
    if (elapsed >= 500) {
      const current = process.cpuUsage();
      this.cpuPercent = (current.user + current.system - this.cpu.user - this.cpu.system) / (elapsed * 1000) * 100;
      this.cpu = current; this.cpuAt = now;
    }
    const memory = process.memoryUsage();
    return { ...this.build, runtime: process.versions.bun ? `Bun ${process.versions.bun}` : `Node ${process.versions.node}`, platform: `${process.platform} ${process.arch}`, uptimeSeconds: process.uptime(), cpuPercent: this.cpuPercent, logicalCpus: os.availableParallelism(), memory: { rss: memory.rss, heapUsed: memory.heapUsed, systemTotal: os.totalmem(), systemFree: os.freemem() }, dataDir: this.config.dataDir, logsEnabled: !!this.config.logsDir, library: this.library.status() };
  }
  async roots() {
    const origin = this.config.origin;
    const changed = !!origin && configRevision(await configText(origin.file)) !== origin.revision;
    const writeAccess = !!origin && await fs.access(path.dirname(origin.file), constants.W_OK).then(() => true, () => false);
    return { roots: this.library.definitions.map(({ id, path, name }) => ({ id, path, name })), revision: origin?.revision ?? null, writable: !!origin && !origin.rootsFromCli && !changed && writeAccess, changedExternally: changed, configFile: origin?.file ?? null, reason: changed ? '配置文件已被外部修改，请重启服务以重新载入。' : origin?.rootsFromCli ? '当前根目录由 --folder 覆盖，请修改启动参数或改用配置文件。' : !origin ? '此服务未提供可写配置来源。' : !writeAccess ? '配置所在目录不可写，请调整数据目录权限。' : null };
  }
  saveRoots(document: unknown) {
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
  async logs(before = '', limit = 40) {
    if (!this.config.logsDir) return { entries: [], next: null, enabled: false };
    if (before && !logName(before)) throw new AdminError(400, '日志分页位置无效。');
    // Keep only the next page while walking the directory. Large log folders
    // do not become an unbounded array or synchronously block media requests.
    const names: string[] = [];
    const directory = await fs.opendir(this.config.logsDir).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (directory) for await (const entry of directory) if (entry.isFile() && logName(entry.name) && (!before || entry.name < before)) {
      names.push(entry.name); names.sort((a, b) => a > b ? -1 : a < b ? 1 : 0); if (names.length > limit + 1) names.pop();
    }
    const entries = [];
    for (const name of names.slice(0, limit)) {
      const stat = await fs.lstat(path.join(this.config.logsDir, name)).catch(() => null);
      if (stat?.isFile() && !stat.isSymbolicLink()) entries.push({ name, size: stat.size, receivedAt: stat.mtime.toISOString(), version: fileVersion(stat) });
    }
    return { entries, next: names.length > limit ? names[limit - 1] : null, enabled: true };
  }
  private async logFile(name: string, version: string | null) {
    if (!this.config.logsDir || !logName(name)) throw new AdminError(404, '日志不存在。');
    const directory = await fs.realpath(this.config.logsDir);
    const file = path.join(directory, name);
    const stat = await fs.lstat(file).catch(() => null);
    if (!stat?.isFile() || stat.isSymbolicLink()) throw new AdminError(404, '日志不存在。');
    if (version && fileVersion(stat) !== version) throw new AdminError(409, '日志已改变，请重新载入。');
    return { file, stat };
  }
  async readLog(name: string, version: string | null) {
    const { file, stat } = await this.logFile(name, version);
    if (stat.size > 11 * 1024 * 1024) throw new AdminError(413, '日志超过预览大小上限。');
    const handle = await fs.open(file, 'r');
    try {
      if (fileVersion(await handle.stat()) !== fileVersion(stat)) throw new AdminError(409, '日志已改变，请重新载入。');
      const text = await handle.readFile('utf8');
      try { return { name, version: fileVersion(stat), document: JSON.parse(text) as unknown }; }
      catch { throw new AdminError(422, '日志不是有效的 JSON。'); }
    } finally { await handle.close(); }
  }
  async deleteLog(name: string, version: string | null) {
    if (!version) throw new AdminError(428, '删除需要当前日志版本。');
    const { file } = await this.logFile(name, version); await fs.unlink(file); return { ok: true };
  }
  async close() { await this.mutation?.catch(() => {}); }
}
