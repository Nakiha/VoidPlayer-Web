import {parseBudgetedJson,admitJson} from '../../../shared/analysis/bitstream/json-budget.ts';
import { encodeProduct, decodeProduct, metadataBudgetBytes, productKey, isProduct, validateProduct, PRODUCT_LIMIT } from '../../../shared/analysis/bitstream/products.ts';
import type { AnalysisOutput, AnalysisSummary } from '../../../shared/analysis/bitstream/products.ts';
import { createHash, randomUUID } from "node:crypto";
import {
  open,
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
} from "../../../shared/analysis/bitstream/contract.ts";
import type { AnalysisGop, AnalysisResult } from "../../../shared/analysis/bitstream/contract.ts";
import { AnalysisFailure } from '../../../shared/analysis/bitstream/failure.ts';
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
/** File descriptor size and format admission precede the body allocation. */
async function readBoundedFile(file:string,max:number,jsonLimit?:number):Promise<Uint8Array> {
  const handle=await open(file,'r');try {
    const info=await handle.stat();if(!Number.isSafeInteger(info.size)||info.size<=0||info.size>max)throw new AnalysisFailure('resource-limit','Stored analysis allocation budget exceeded');
    if(jsonLimit!==undefined){const prefix=new Uint8Array(8),probe=await handle.read(prefix,0,Math.min(8,info.size),0);if(prefix[0]===123){if(info.size>jsonLimit)throw new AnalysisFailure('resource-limit','Stored summary page budget exceeded');}else if(probe.bytesRead<8||new DataView(prefix.buffer).getUint32(0,true)!==0x31504156||new DataView(prefix.buffer).getUint32(4,true)>PRODUCT_LIMIT.metadata)throw Error('Invalid stored analysis header');}
    const bytes=new Uint8Array(info.size);let offset=0;while(offset<bytes.length){const read=await handle.read(bytes,offset,bytes.length-offset,offset);if(!read.bytesRead)throw Error('Truncated analysis file');offset+=read.bytesRead;}
    if((await handle.read(new Uint8Array(1),0,1,offset)).bytesRead)throw Error('Analysis file grew during read');return bytes;
  }finally{await handle.close();}
}
/** Each picture is one independently committed chunk. No incomplete chunk is visible. */
export interface StreamChunkRef { id: string; cursor: number; gop: AnalysisGop; au?:number; bytes?:number; cached?:boolean; batchEnd?:number; product?:'summary'|'blocks'; encoding?:string; picture?:import("../../../shared/analysis/bitstream/contract.ts").SourcePictureKey }
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
      const envelope = JSON.parse(new TextDecoder().decode(await readBoundedFile(file,BUDGET.resultBytes)));
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
  productFile(id: string) { return this.filename(id) + '.product'; }
  async getOutput(id: string, au?:number): Promise<AnalysisOutput | null> {
    const file = this.productFile(id), size = await stat(file).catch(() => null);
    if (!size) return this.get(id);
    if (size.size > PRODUCT_LIMIT.frame) { await unlink(file).catch(()=>{}); return null; }
    try {
      const bytes = await readBoundedFile(file,PRODUCT_LIMIT.frame,PRODUCT_LIMIT.page);
      if (bytes.length > PRODUCT_LIMIT.frame) throw new Error('Oversized stored product');
      // Summary pages are a checksummed bounded member table, never coverage bits.
      if (bytes[0] === 123) {
        if (bytes.length > PRODUCT_LIMIT.page) throw new Error('Summary page too large');
        const envelope = parseBudgetedJson(new TextDecoder().decode(bytes)) as {payload:string;checksum:string};
        if (typeof envelope.payload !== 'string' || digest(envelope.payload) !== envelope.checksum) throw new Error('Summary page checksum');
        const page=parseBudgetedJson(envelope.payload,'page') as {pageSchema:number;page:number;members:AnalysisSummary[]};
        if(page.pageSchema!==1||!Number.isSafeInteger(page.page))throw Error('Unknown summary page version');
        const members=page.members;
        if (!Array.isArray(members) || members.length > PRODUCT_LIMIT.pageItems) throw new Error('Summary page members');
        const seen = new Set<number>();
        for (const member of members) { validateProduct(member); if (member.product !== 'summary' || seen.has(member.picture.au)) throw new Error('Invalid summary member'); seen.add(member.picture.au); }
        const namespace=members[0];
        if(!namespace||page.page!==Math.floor(namespace.picture.au/32))throw Error('Empty or mismatched summary page');
        for(const member of members) {
          const key=productKey({...member.picture,au:Math.floor(member.picture.au/32)*32},member.buildId,member.indexIdentity,'summary');
          if(digest(key)!==id || JSON.stringify([member.picture.sourceVersion,member.picture.stream,member.picture.configuration,member.buildId,member.recipe,member.analyzerVersion,member.indexIdentity,Math.floor(member.picture.au/32)])!==JSON.stringify([namespace.picture.sourceVersion,namespace.picture.stream,namespace.picture.configuration,namespace.buildId,namespace.recipe,namespace.analyzerVersion,namespace.indexIdentity,Math.floor(namespace.picture.au/32)]))throw Error('Mixed summary page identity');
        }
        const member = members.find(member => member.picture.au === au);
        await utimes(file,new Date(),new Date()); return member ?? null;
      }
      const value = await decodeProduct(bytes); await utimes(file,new Date(),new Date()); return value;
    } catch { await unlink(file).catch(()=>{}); return null; }
  }
  putOutput(id:string,value:AnalysisOutput,protectedFiles=new Set<string>()) {
    if (!isProduct(value)) return this.put(id,value,protectedFiles);
    validateProduct(value);
    return this.write(async () => {
      if (value.confidence !== 'exact') return;
      const target = this.productFile(id); let bytes:Uint8Array;
      if (value.product === 'summary') {
        if(digest(productKey({...value.picture,au:Math.floor(value.picture.au/32)*32},value.buildId,value.indexIdentity,'summary'))!==id)throw Error('Summary page key mismatch');
        const size = await stat(target).catch(()=>null); let members:AnalysisSummary[] = [];
        if (size && size.size <= PRODUCT_LIMIT.page) {
          try { const envelope=parseBudgetedJson(new TextDecoder().decode(await readBoundedFile(target,PRODUCT_LIMIT.frame,PRODUCT_LIMIT.page))) as {payload:string;checksum:string}; if(digest(envelope.payload)!==envelope.checksum) throw Error('checksum'); const page=parseBudgetedJson(envelope.payload,'page') as {pageSchema:number;page:number;members:AnalysisSummary[]};if(page.pageSchema!==1||page.page!==Math.floor(value.picture.au/32))throw Error('page version');members=page.members; if(!Array.isArray(members)||members.length>32) throw Error('members'); members.forEach(validateProduct); }
          catch { members=[]; }
        }
        const old=members.findIndex(member=>member.picture.au===value.picture.au);
        if (old>=0) {
          const previous=members[old];
          if (JSON.stringify([previous.picture,previous.indexIdentity,previous.buildId,previous.recipe]) !== JSON.stringify([value.picture,value.indexIdentity,value.buildId,value.recipe])) throw new Error('Summary member replacement identity mismatch');
          members[old]=value;
        } else members.push(value);
        if (members.length>32 || members.some(member=>Math.floor(member.picture.au/32)!==Math.floor(value.picture.au/32))) throw new Error('Summary page membership mismatch');
        // Each member is validated and bounded before aggregate serialization.
        if(members.reduce((sum,member)=>sum+metadataBudgetBytes(member)+1,2)*2+256>PRODUCT_LIMIT.page)throw new AnalysisFailure('resource-limit','Summary page preallocation budget exceeded');
        const memberBytes=members.map(member=>JSON.stringify(member));
        if (memberBytes.reduce((sum,item)=>sum+Buffer.byteLength(item)*2+2,256)>PRODUCT_LIMIT.page) throw new AnalysisFailure('resource-limit','Summary page allocation budget exceeded');
        const payload='{"pageSchema":1,"page":'+Math.floor(value.picture.au/32)+',"members":['+memberBytes.join(',')+']}';admitJson(payload,'page'); bytes=Buffer.from(JSON.stringify({payload,checksum:digest(payload)}));
        if(bytes.length>PRODUCT_LIMIT.page) throw new AnalysisFailure('resource-limit','Summary page budget exceeded');
      } else bytes=await encodeProduct(value);
      await mkdir(this.directory,{recursive:true}); await this.reserve(bytes.length,target,protectedFiles);
      const temp=target+'.tmp'; try { await writeFile(temp,bytes); await rename(temp,target); } finally { await unlink(temp).catch(()=>{}); }
    });
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
      if (!/^[a-f0-9]{64}\.json(?:\.manifest|\.page|\.product)?$/.test(name)) continue;
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
    if (!size || size.size > 65536) throw new AnalysisFailure('resource-limit', 'Analysis stream page evicted');
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
    if (Buffer.byteLength(bytes) > 65536) throw new Error('Stream page size budget exceeded');
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
    return Buffer.byteLength(payload);
  }
}
