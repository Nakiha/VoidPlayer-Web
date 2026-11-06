import { promises as fs, createReadStream, createWriteStream } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createGzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { logFiles } from './files.ts';
import { lockDatabase } from '../library-store.ts';
import type { RuntimeLogPolicy, LogStorageStatus } from '../../shared/service/logging.ts';

const owned = /^runtime-(\d{4}-\d{2}-\d{2})-(\d{13})-[a-f0-9-]{36}\.jsonl(?:\.gz(?:\.tmp)?)?$/;
const MAX_QUEUE_BYTES = 1024 ** 2, MAX_RECORD_BYTES = 16384, MAX_FILES = 1024;

/** One writer owns rotation, gzip and deletion. Requests enqueue bounded records;
 * close waits for all real IO, including the final sealed segment. */
export class RuntimeLog {
  readonly directory: string;
  readonly policy: RuntimeLogPolicy;
  private handle?: FileHandle;
  private active = '';
  private activeBytes = 0;
  private day = '';
  private queue: { line: string; at: number; bytes: number }[] = [];
  private pendingBytes = 0;
  private writing?: Promise<void>;
  private closing?: Promise<void>;
  private closed = false;
  private timer?: ReturnType<typeof setInterval>;
  private bytes = 0;
  private files = 0;
  private dropped = 0;
  private unreported = 0;
  private error: string | null = null;
  private maintenance = false;
  private unlock?: () => void;
  private rescan = false;
  constructor(directory: string, policy: RuntimeLogPolicy) { this.directory = directory; this.policy = policy; }
  async start() {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    this.unlock = lockDatabase(path.join(this.directory, 'writer'));
    try {
      for await (const file of logFiles(this.directory, name => owned.test(name) && name.endsWith('.tmp'))) await fs.unlink(file.file);
      await this.prune();
      // A crash may leave a complete or partial JSONL segment. Preserve its bytes.
      for await (const file of logFiles(this.directory, name => owned.test(name) && name.endsWith('.jsonl'))) await this.compress(file.file);
      await this.prune();
      this.timer = setInterval(() => { this.maintenance = true; this.kick(); }, 3600000);
      this.timer.unref();
    } catch (error) { this.unlock(); this.unlock = undefined; throw error; }
  }
  status(): LogStorageStatus {
    return { directory: this.directory, ...this.policy, bytes: this.bytes, files: this.files, error: this.error,
      dropped: this.dropped, pendingBytes: this.pendingBytes };
  }
  write(entry: Record<string, unknown>) {
    if (this.closed) return;
    let line: string;
    try { line = JSON.stringify({ ...entry, t: entry.t ?? new Date().toISOString() }) + '\n'; }
    catch { this.drop(); return; }
    if (Buffer.byteLength(line) > MAX_RECORD_BYTES) {
      line = JSON.stringify({ t: new Date().toISOString(), level: entry.level ?? 'warn', event: 'log-record-truncated',
        originalEvent: String(entry.event ?? '').slice(0, 100),
        ...(typeof entry.requestId === 'string' ? { requestId: entry.requestId.slice(0, 100) } : {}),
        ...(typeof entry.actorId === 'string' ? { actorId: entry.actorId.slice(0, 100) } : {}), preview: line.slice(0, 2000) }) + '\n';
    }
    const bytes = Buffer.byteLength(line);
    if (this.pendingBytes + bytes > MAX_QUEUE_BYTES) { this.drop(); return; }
    this.queue.push({ line, at: Date.now(), bytes }); this.pendingBytes += bytes;
    this.kick();
  }
  private drop() { this.dropped++; this.unreported++; }
  private kick() {
    if (this.writing) return;
    this.writing = this.drain().finally(() => { this.writing = undefined; if (this.queue.length || this.maintenance) this.kick(); });
  }
  private async drain() {
    try {
      if (this.maintenance) {
        this.maintenance = false;
        if (this.handle && this.day !== new Date().toISOString().slice(0, 10)) await this.seal();
        await this.prune();
      }
      while (this.queue.length) {
        const item = this.queue.shift()!;
        try {
          if (this.unreported) {
            const dropped = this.unreported;
            await this.append(JSON.stringify({ t: new Date().toISOString(), level: 'warn', event: 'log-records-dropped', count: dropped }) + '\n', Date.now());
            this.unreported -= dropped;
          }
          await this.append(item.line, item.at); this.error = null;
        } catch (error) { this.rescan = true; this.fail(error); this.drop(); }
        finally { this.pendingBytes -= item.bytes; }
      }
    } catch (error) { this.fail(error); }
  }
  private fail(error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    // One diagnostic per failure episode; never feed a failed sink into itself.
    if (!this.error) process.stderr.write(`Runtime log storage failed: ${message.slice(0, 500)}\n`);
    this.error = message;
  }
  private async append(line: string, at: number) {
    const bytes = Buffer.byteLength(line), day = new Date(at).toISOString().slice(0, 10);
    if (this.handle && (day !== this.day || this.activeBytes + bytes > this.policy.segmentBytes)) await this.seal();
    if (!this.handle) {
      this.active = path.join(this.directory, `runtime-${day}-${at}-${randomUUID()}.jsonl`);
      this.handle = await fs.open(this.active, 'wx', 0o600); this.activeBytes = 0; this.day = day;
      this.files++;
    }
    if (this.rescan || this.bytes + bytes > this.policy.maxBytes || this.files >= MAX_FILES) {
      await this.prune(bytes); this.rescan = false;
    }
    await this.handle.writeFile(line);
    this.activeBytes += bytes; this.bytes += bytes;
  }
  private async seal() {
    if (!this.handle) return;
    const handle = this.handle, file = this.active;
    try { await handle.sync(); }
    finally {
      await handle.close();
      this.handle = undefined; this.active = ''; this.activeBytes = 0;
    }
    await this.compress(file);
  }
  private async compress(file: string) {
    const temporary = file + '.gz.tmp';
    try {
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink()) throw Error('Invalid runtime log segment');
      // Count raw + gzip + temporary together, reserving incompressible overhead.
      await this.prune(Math.ceil(stat.size * 1.01) + 16384, file);
      const gzip = createGzip();
      gzip.on('data', chunk => { this.bytes += chunk.length; });
      await pipeline(createReadStream(file), gzip, createWriteStream(temporary, { flags: 'wx', mode: 0o600 }));
      const target = await fs.open(temporary, 'r+');
      try { await target.sync(); } finally { await target.close(); }
      await fs.rename(temporary, file + '.gz');
      await fs.unlink(file);
    } finally { await fs.rm(temporary, { force: true }); }
    await this.prune();
  }
  private async prune(reserve = 0, preserve = '') {
    const candidates = [];
    let bytes = 0, files = 0;
    const cutoff = Date.now() - this.policy.days * 86400000;
    for await (const file of logFiles(this.directory, name => owned.test(name))) {
      const protectedFile = file.file === this.active || file.file === preserve;
      if (!protectedFile && Number(owned.exec(file.name)![2]) < cutoff) { await fs.unlink(file.file); continue; }
      bytes += file.stat.size; files++;
      if (!protectedFile) candidates.push(file);
    }
    candidates.sort((a, b) => a.name.localeCompare(b.name));
    for (const file of candidates) {
      if (bytes + reserve <= this.policy.maxBytes && files < MAX_FILES) break;
      await fs.unlink(file.file); bytes -= file.stat.size; files--;
    }
    this.bytes = bytes; this.files = files;
    if (bytes + reserve > this.policy.maxBytes) throw Error('Runtime log storage quota exceeded');
  }
  async flush() { while (this.writing) await this.writing; }
  close() {
    return this.closing ??= (async () => {
      this.closed = true; clearInterval(this.timer);
      await this.flush();
      try { await this.seal(); await this.prune(); } catch (error) { this.fail(error); throw error; }
      finally { this.unlock?.(); this.unlock = undefined; }
    })();
  }
}
