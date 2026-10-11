import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  writeFile,
  rename,
  stat,
  readdir,
  unlink,
  utimes,
} from "node:fs/promises";
import path from "node:path";
import {
  BUDGET,
  validateResult,
} from "../../src/bitstream-analysis/contract.ts";
import type { AnalysisGop, AnalysisResult } from "../../src/bitstream-analysis/contract.ts";
import { AnalysisFailure } from '../../src/bitstream-analysis/failure.ts';
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
/** Each picture is one independently committed chunk. No incomplete chunk is visible. */
export interface StreamChunkRef { id: string; cursor: number; gop: AnalysisGop }
export class AnalysisStore {
  readonly directory: string;
  readonly quota: number;
  private writes: Promise<unknown> = Promise.resolve();
  private protectedFiles: () => Set<string>;
  private write<T>(action: () => Promise<T>): Promise<T> {
    const result = this.writes.then(action); this.writes = result.catch(() => {}); return result;
  }
  async flush() { await this.writes; }
  constructor(directory: string, quota = 128 * 1024 * 1024, protectedFiles = () => new Set<string>()) {
    this.directory = directory;
    this.quota = quota; this.protectedFiles = protectedFiles;
  }
  private filename(id: string) {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("Invalid analysis chunk");
    return path.join(this.directory, id + ".json");
  }
  async get(id: string): Promise<AnalysisResult | null> {
    const file = this.filename(id),
      s = await stat(file).catch(() => null);
    if (!s) return null;
    if (s.size > BUDGET.resultBytes) {
      await unlink(file);
      return null;
    }
    try {
      const envelope = JSON.parse(await readFile(file, "utf8"));
      if (
        typeof envelope.payload !== "string" ||
        digest(envelope.payload) !== envelope.checksum
      )
        throw new Error("Analysis checksum mismatch");
      const result = JSON.parse(envelope.payload);
      validateResult(result);
      if (result.confidence !== "exact")
        throw new Error("Incomplete analysis chunk");
      await utimes(file, new Date(), new Date());
      return result;
    } catch {
      await unlink(file).catch(() => {});
      return null;
    }
  }
  async manifest(id: string): Promise<string[] | null> {
    const file = this.filename(id) + ".manifest";
    const size = await stat(file).catch(() => null);
    if (!size || size.size > 4096) return null;
    try {
      const value = JSON.parse(await readFile(file, "utf8"));
      if (
        !Array.isArray(value.chunks) ||
        value.chunks.length > 32 ||
        value.chunks.some(
          (id: unknown) => typeof id !== "string" || !/^[a-f0-9]{64}$/.test(id),
        ) ||
        digest(JSON.stringify(value.chunks)) !== value.checksum
      )
        return null;
      for (const chunk of value.chunks)
        if (!(await this.get(chunk))) return null;
      return value.chunks;
    } catch {
      return null;
    }
  }
  private async reserve(
    bytes: number,
    target: string,
    protectedFiles = new Set<string>(),
  ) {
    const files = [] as { file: string; bytes: number; mtime: number }[];
    for (const name of await readdir(this.directory)) {
      if (!/^[a-f0-9]{64}\.json(?:\.manifest|\.page)?$/.test(name)) continue;
      const file = path.join(this.directory, name),
        s = await stat(file).catch(() => null);
      if (!s || file === target) continue;
      files.push({ file, bytes: s.size, mtime: s.mtimeMs });
    }
    files.sort((a, b) => a.mtime - b.mtime);
    let total = files.reduce((n, f) => n + f.bytes, 0);
    while (
      (total + bytes > this.quota || files.length >= 1024) &&
      files.length
    ) {
      const index = files.findIndex((file) => !protectedFiles.has(file.file) && !this.protectedFiles().has(file.file));
      if (index < 0)
        throw new AnalysisFailure("resource-limit", "Analysis cache quota cannot retain pending results");
      const [old] = files.splice(index, 1);
      await unlink(old.file);
      total -= old.bytes;
    }
    if (total + bytes > this.quota)
      throw new AnalysisFailure("resource-limit", "Analysis cache quota exceeded");
  }
  putManifest(id: string, chunks: string[]) { return this.write(() => this.putManifestInner(id, chunks)); }
  private async putManifestInner(id: string, chunks: string[]) {
    if (!chunks.length || chunks.length > 32)
      throw new Error("Analysis manifest budget exceeded");
    await mkdir(this.directory, { recursive: true });
    const target = this.filename(id) + ".manifest",
      temp = target + ".tmp";
    const payload = JSON.stringify({
      chunks,
      checksum: digest(JSON.stringify(chunks)),
    });
    if (Buffer.byteLength(payload) > 4096)
      throw new Error("Analysis manifest budget exceeded");
    for (const chunk of chunks)
      if (!(await this.get(chunk)))
        throw new Error("Analysis range cache coverage evicted");
    await this.reserve(
      Buffer.byteLength(payload),
      target,
      new Set(chunks.map((chunk) => this.filename(chunk))),
    );
    try {
      await writeFile(temp, payload);
      await rename(temp, target);
    } finally {
      await unlink(temp).catch(() => {});
    }
  }
  streamPageFile(id: string, page: number) {
    if (!Number.isSafeInteger(page) || page < 0 || page > 7812) throw new Error('Invalid stream page');
    return this.filename(digest(`${id}:stream:${page}`)) + '.page';
  }
  async streamPage(id: string, page: number): Promise<StreamChunkRef[]> {
    const file = this.streamPageFile(id, page), size = await stat(file).catch(() => null);
    if (!size || size.size > 16384) throw new AnalysisFailure('resource-limit', 'Analysis stream page evicted');
    const envelope = JSON.parse(await readFile(file, 'utf8'));
    if (typeof envelope.payload !== 'string' || digest(envelope.payload) !== envelope.checksum)
      throw new Error('Invalid stream page checksum');
    const refs: StreamChunkRef[] = JSON.parse(envelope.payload);
    if (!Array.isArray(refs) || !refs.length || refs.length > 32 || refs.some((ref, i) =>
        !ref || !/^[a-f0-9]{64}$/.test(ref.id) || ref.cursor !== page * 32 + i + 1 || !ref.gop))
      throw new Error('Invalid stream page');
    await utimes(file, new Date(), new Date());
    return refs;
  }
  putStreamPage(id: string, page: number, refs: StreamChunkRef[], protectedFiles: Set<string>) {
    return this.write(() => this.putStreamPageInner(id, page, refs, protectedFiles));
  }
  private async putStreamPageInner(id: string, page: number, refs: StreamChunkRef[], protectedFiles: Set<string>) {
    if (!refs.length || refs.length > 32) throw new Error('Invalid stream page size');
    const payload = JSON.stringify(refs), bytes = JSON.stringify({ payload, checksum: digest(payload) });
    if (Buffer.byteLength(bytes) > 16384) throw new Error('Stream page size budget exceeded');
    const target = this.streamPageFile(id, page), temp = target + '.tmp';
    await mkdir(this.directory, { recursive: true });
    await this.reserve(Buffer.byteLength(bytes), target, protectedFiles);
    try { await writeFile(temp, bytes); await rename(temp, target); }
    finally { await unlink(temp).catch(() => {}); }
  }
  chunkFile(id: string) { return this.filename(id); }
  put(id: string, result: AnalysisResult, protectedFiles = new Set<string>()) {
    return this.write(() => this.putInner(id, result, protectedFiles));
  }
  private async putInner(id: string, result: AnalysisResult, protectedFiles: Set<string>) {
    validateResult(result);
    if (result.confidence !== "exact") return;
    const payload = JSON.stringify(result),
      envelope = JSON.stringify({ checksum: digest(payload), payload }),
      bytes = Buffer.byteLength(envelope);
    if (bytes > BUDGET.resultBytes || bytes > this.quota)
      throw new AnalysisFailure("resource-limit", "Analysis cache quota exceeded");
    await mkdir(this.directory, { recursive: true });
    await this.reserve(bytes, this.filename(id), protectedFiles);
    const temp = path.join(this.directory, randomUUID() + ".tmp");
    try {
      await writeFile(temp, envelope, { flag: "wx" });
      await rename(temp, this.filename(id));
    } finally {
      await unlink(temp).catch(() => {});
    }
  }
}
