import { promises as fs } from 'node:fs';
import path from 'node:path';
import { AdminError } from '../admin-error.ts';
import { fileVersion } from '../library.ts';
import { logFiles } from './files.ts';
import { serverLog } from './logger.ts';
import { lockDatabase } from '../library-store.ts';
import type { LogPage, LogDocument } from '../../shared/service/admin.ts';
import type { ReportLogPolicy, LogStorageStatus } from '../../shared/service/logging.ts';

export const reportName = (name: string) => /^voidplayer-log-[A-Za-z0-9_.-]{1,180}\.json$/.test(name);
type Receipt = { id: string; receivedAt: string; actorId: string | null };

/** Uploaded reports are retained evidence: quota rejects new reports rather
 * than evicting existing reports. Expiration is an explicit opt-in policy. */
export class ReportLogs {
  private tail: Promise<unknown> = Promise.resolve();
  private pending = 0;
  private closed = false;
  private timer?: ReturnType<typeof setInterval>;
  private error: string | null = null;
  private ready?: Promise<void>;
  private unlock?: () => void;
  readonly directory: string | null;
  readonly policy: ReportLogPolicy;
  constructor(directory: string | null, policy: ReportLogPolicy) { this.directory = directory; this.policy = policy; }
  private run<T>(work: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new AdminError(503, '日志存储正在关闭。'));
    if (this.pending >= 8) return Promise.reject(new AdminError(429, '日志存储繁忙，请稍后重试。', 'log-storage-busy'));
    this.pending++;
    const result = this.tail.then(async () => { await this.initialize(); return work(); });
    this.tail = result.catch(error => { if (!(error instanceof AdminError)) this.error = String(error); }).finally(() => { this.pending--; });
    return result;
  }
  async start() {
    if (!this.directory) return;
    await this.run(() => this.scan());
    if (this.policy.days) {
      this.timer = setInterval(() => { void this.run(() => this.scan()).catch(error => {
        this.error = String(error); serverLog.error('report-log-maintenance-failed', error);
      }); }, 3600000);
      this.timer.unref();
    }
  }
  private initialize() {
    return this.ready ??= (async () => {
      if (!this.directory) return;
      await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
      this.unlock = lockDatabase(path.join(this.directory, 'reports'));
      try {
        for await (const file of logFiles(this.directory, name => name.endsWith('.tmp') && reportName(name.slice(0, -4))))
          await fs.unlink(file.file);
      } catch (error) { this.unlock(); this.unlock = undefined; throw error; }
    })();
  }
  private async scan(): Promise<LogStorageStatus> {
    let bytes = 0, files = 0;
    if (this.directory) for await (const file of logFiles(this.directory, reportName)) {
      if (this.policy.days && file.stat.mtimeMs < Date.now() - this.policy.days * 86400000) {
        await fs.unlink(file.file);
        serverLog.info('report-log-expired', { name: file.name, bytes: file.stat.size });
      } else { bytes += file.stat.size; files++; }
    }
    this.error = null;
    return { directory: this.directory, ...this.policy, bytes, files, error: this.error };
  }
  upload(read: () => Promise<Record<string, unknown>>, receipt: Receipt) {
    return this.run(async () => {
      if (!this.directory) throw new AdminError(404, 'log upload not enabled');
      const doc = await read();
      if (doc?.schema !== 'voidplayer-web-log' || typeof doc.sessionId !== 'string' || !/^[0-9a-zA-Z-]{1,100}$/.test(doc.sessionId))
        throw new AdminError(400, '不是有效的日志文档');
      const data = JSON.stringify({ ...doc, serverReceipt: receipt });
      await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
      const storage = await this.scan();
      if (storage.files >= this.policy.maxFiles || storage.bytes + Buffer.byteLength(data) > this.policy.maxBytes)
        throw new AdminError(507, '上传日志存储已满，请在管理页下载并删除旧报告后重试。', 'log-storage-full');
      const name = `voidplayer-log-${receipt.receivedAt.replace(/[:.]/g, '-')}-${receipt.id}-${doc.sessionId.slice(0, 8)}.json`;
      const file = path.join(this.directory, name);
      const temporary = file + '.tmp';
      const handle = await fs.open(temporary, 'wx', 0o600);
      try {
        try { await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); }
        // UUID names and the directory writer lock make publication exclusive;
        // check legacy/manual collisions too. Rename works on filesystems without hard links.
        if (await fs.lstat(file).then(() => true, (error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return false;
          throw error;
        })) throw new AdminError(409, '日志文件已存在。');
        await fs.rename(temporary, file);
      } finally { await fs.rm(temporary, { force: true }); }
      serverLog.info('report-log-received', { name, bytes: Buffer.byteLength(data), requestId: receipt.id, actorId: receipt.actorId });
      return { ok: true, name };
    });
  }
  list(before = '', limit = 40): Promise<LogPage> {
    return this.run(async () => {
      if (before && !reportName(before)) throw new AdminError(400, '日志分页位置无效。');
      const storage = await this.scan(), names: string[] = [];
      if (this.directory) for await (const file of logFiles(this.directory, reportName)) if (!before || file.name < before) {
        names.push(file.name); names.sort((a, b) => b.localeCompare(a)); if (names.length > limit + 1) names.pop();
      }
      const entries = [];
      for (const name of names.slice(0, limit)) {
        const { stat } = await this.file(name, null);
        entries.push({ name, size: stat.size, receivedAt: stat.mtime.toISOString(), version: fileVersion(stat) });
      }
      return { entries, next: names.length > limit ? names[limit - 1] : null, enabled: !!this.directory,
        storage: { reports: storage, runtime: null } };
    });
  }
  private async file(name: string, version: string | null) {
    if (!this.directory || !reportName(name)) throw new AdminError(404, '日志不存在。');
    const directory = await fs.realpath(this.directory);
    const file = path.join(directory, name), stat = await fs.lstat(file).catch(() => null);
    if (!stat?.isFile() || stat.isSymbolicLink()) throw new AdminError(404, '日志不存在。');
    if (version && fileVersion(stat) !== version) throw new AdminError(409, '日志已改变，请重新载入。');
    return { file, stat };
  }
  read(name: string, version: string | null): Promise<LogDocument> {
    return this.run(async () => {
      const { file, stat } = await this.file(name, version);
      if (stat.size > 11 * 1024 ** 2) throw new AdminError(413, '日志超过预览大小上限。');
      const handle = await fs.open(file, 'r');
      try {
        if (fileVersion(await handle.stat()) !== fileVersion(stat)) throw new AdminError(409, '日志已改变，请重新载入。');
        const text = await handle.readFile('utf8');
        try { return { name, version: fileVersion(stat), document: JSON.parse(text) }; }
        catch { throw new AdminError(422, '日志不是有效的 JSON。'); }
      } finally { await handle.close(); }
    });
  }
  delete(name: string, version: string | null) {
    return this.run(async () => {
      if (!version) throw new AdminError(428, '删除需要当前日志版本。');
      const { file, stat } = await this.file(name, version);
      await fs.unlink(file);
      serverLog.info('report-log-deleted', { name, bytes: stat.size });
      return { ok: true };
    });
  }
  async close() { this.closed = true; clearInterval(this.timer); await this.tail; this.unlock?.(); this.unlock = undefined; }
}
