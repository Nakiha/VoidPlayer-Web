import type {CambiRef,CambiEvidence} from '../shared/review/cambi-evidence.ts';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { openIndexDatabase } from './sqlite.ts';
import { AdminError } from './admin-error.ts';
import type { CacheEntry } from './caches.ts';
import type { Actor } from './identity.ts';
import { AnnotationCommandError, applyAnnotationOperation, parseAnnotationOperation } from '../shared/review/annotation-command.ts';
import { annotationEvent } from '../shared/review/annotation-events.ts';
import type { AnnotationEvent, AnnotationEventPage } from '../shared/review/annotation-events.ts';
import type { AnnotationRecord, AnnotationPage } from '../shared/review/annotation-record.ts';
import type { QualityEvidenceRef, QualityEvidence } from '../shared/review/quality-evidence.ts';
import type { QualityJobResult } from '../shared/analysis/quality/jobs.ts';

const validId = (id: unknown): id is string => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,200}$/.test(id);
export const ANNOTATION_BYTES = 512 * 1024;
export const ANNOTATION_EVENT_RETENTION = 10000;
export class AnnotationStore {
  private db: ReturnType<typeof openIndexDatabase>;
  constructor(file: string) {
    if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
    const db = this.db = openIndexDatabase(file);
    const version = Number(db.prepare('PRAGMA user_version').get()!.user_version);
    if (version > 5) { db.close(); throw new Error('标注数据库来自更新的程序。'); }
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=1000;
      CREATE TABLE IF NOT EXISTS spaces(id TEXT PRIMARY KEY,name TEXT NOT NULL,created_at TEXT NOT NULL);
      INSERT OR IGNORE INTO spaces VALUES('default','共享评审',strftime('%Y-%m-%dT%H:%M:%fZ','now'));
      CREATE TABLE IF NOT EXISTS annotations(space TEXT NOT NULL,id TEXT NOT NULL,revision INTEGER NOT NULL,sequence INTEGER NOT NULL,deleted INTEGER NOT NULL,updated_at TEXT NOT NULL,updated_by TEXT NOT NULL,document TEXT NOT NULL,PRIMARY KEY(space,id));
      CREATE INDEX IF NOT EXISTS annotation_sequence ON annotations(space,sequence);
      CREATE TABLE IF NOT EXISTS annotation_clock(id INTEGER PRIMARY KEY,sequence INTEGER NOT NULL);
      INSERT OR IGNORE INTO annotation_clock VALUES(1,0);
      CREATE TABLE IF NOT EXISTS annotation_operations(id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,result TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS annotation_previews(space TEXT NOT NULL,id TEXT NOT NULL,revision INTEGER NOT NULL,data BLOB NOT NULL,PRIMARY KEY(space,id));
      CREATE TABLE IF NOT EXISTS annotation_preview_epoch(id INTEGER PRIMARY KEY,epoch INTEGER NOT NULL);
      INSERT OR IGNORE INTO annotation_preview_epoch VALUES(1,0);
      CREATE TABLE IF NOT EXISTS annotation_events(sequence INTEGER PRIMARY KEY,space TEXT NOT NULL,event TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS annotation_events_space ON annotation_events(space,sequence);
      CREATE TABLE IF NOT EXISTS annotation_event_floor(id INTEGER PRIMARY KEY,sequence INTEGER NOT NULL);
      INSERT OR IGNORE INTO annotation_event_floor SELECT 1,sequence FROM annotation_clock WHERE id=1;
      PRAGMA user_version=5;`);
  }
  /** Keep current and replayable shared evidence intact when private results
   * are released. IDs are validated by the caller and the bound LIKE parameter
   * is deliberately conservative: historical references also pin the result. */
  referencesQualityResult(id:string){
    const pattern='%'+id+'%';
    return !!this.db.prepare('SELECT 1 FROM annotations WHERE document LIKE ? LIMIT 1').get(pattern)
      ||!!this.db.prepare('SELECT 1 FROM annotation_operations WHERE result LIKE ? LIMIT 1').get(pattern)
      ||!!this.db.prepare('SELECT 1 FROM annotation_events WHERE event LIKE ? LIMIT 1').get(pattern);
  }
  spaces() { return this.db.prepare('SELECT id,name FROM spaces ORDER BY created_at,id').all(); }
  createSpace(name: unknown) {
    if (typeof name !== 'string' || !name.trim() || name.length > 120) throw new AdminError(400, '请填写评审空间名称。');
    const id = randomUUID(); this.db.prepare('INSERT INTO spaces VALUES(?,?,?)').run(id, name.trim(), new Date().toISOString()); return { id, name: name.trim() };
  }
  ensureSpace(id: string, name: string) {
    if (!validId(id) || !name.trim() || name.length > 200) throw new AdminError(400, '评审名称无效。');
    this.db.prepare('INSERT OR IGNORE INTO spaces VALUES(?,?,?)').run(id, name, new Date().toISOString());
  }
  private space(id: string) { if (!validId(id) || !this.db.prepare('SELECT 1 FROM spaces WHERE id=?').get(id)) throw new AdminError(404, '评审空间不存在。', 'annotation-space-not-found'); }
  read(space: string, id: string): AnnotationRecord | null {
    this.space(space);
    const row = this.db.prepare('SELECT * FROM annotations WHERE space=? AND id=?').get(space, id);
    return row ? { id: String(row.id), space, revision: Number(row.revision), sequence: Number(row.sequence), deleted: !!row.deleted, updatedAt: String(row.updated_at), updatedBy: String(row.updated_by), document: JSON.parse(String(row.document)) } : null;
  }
  changes(space: string, cursor = 0): AnnotationPage {
    this.space(space);
    if (!Number.isSafeInteger(cursor) || cursor < 0) throw new AdminError(400, '标注同步位置无效。');
    const rows = this.db.prepare('SELECT id,sequence FROM annotations WHERE space=? AND sequence>? ORDER BY sequence LIMIT 201').all(space, cursor);
    const page: typeof rows = []; let bytes=0;
    for(const row of rows.slice(0,200)){const size=Number(this.db.prepare('SELECT length(document) AS size FROM annotations WHERE space=? AND id=?').get(space,row.id)!.size);if(page.length && bytes+size>512*1024)break;page.push(row);bytes+=size;} return { entries: page.map(row => this.read(space, String(row.id))!), cursor: page.length ? Number(page.at(-1)!.sequence) : cursor, more: rows.length > page.length };
  }
  /** Bounded operation history, independent of both current rows and GUI consumers. */
  events(space: string, after?: number): AnnotationEventPage {
    this.space(space);
    if (after !== undefined && (!Number.isSafeInteger(after) || after < 0)) throw new AdminError(400, '操作同步位置无效。', 'invalid-event-cursor');
    this.db.exec('BEGIN');
    try {
      const head = Number(this.db.prepare('SELECT sequence FROM annotation_clock WHERE id=1').get()!.sequence);
      const floor = Number(this.db.prepare('SELECT sequence FROM annotation_event_floor WHERE id=1').get()!.sequence);
      const reason = after !== undefined && after < floor ? 'history-expired' : after !== undefined && after > head ? 'cursor-ahead' : undefined;
      const rows = reason ? [] : after === undefined
        ? this.db.prepare('SELECT event FROM annotation_events WHERE space=? ORDER BY sequence DESC LIMIT 50').all(space).reverse()
        : this.db.prepare('SELECT event FROM annotation_events WHERE space=? AND sequence>? ORDER BY sequence LIMIT 101').all(space, after);
      const events: AnnotationEvent[] = rows.slice(0, 100).map(row => JSON.parse(String(row.event)));
      const more = rows.length > events.length;
      const page: AnnotationEventPage = { schema: 'voidplayer-annotation-events', version: 1, space, events,
        cursor: more ? events.at(-1)!.sequence : head, head, more, resetRequired: !!reason,
        ...(reason ? { reason } : {}), snapshotUrl: `/api/annotations/spaces/${space}?after=0` };
      this.db.exec('COMMIT'); return page;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  mutate(space: string, value: unknown, actor: Actor, requestId?: string,
    quality?: { origin: string; resolve(ref: QualityEvidenceRef): QualityJobResult;resolveCambi?(ref:CambiRef):{completedAt:number;value:CambiEvidence['value']} }): AnnotationRecord {
    this.space(space);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const operation = parseAnnotationOperation(value);
      // Keep the receipt fingerprint compatible with pending writes from v1 clients.
      const fingerprint = createHash('sha256').update(JSON.stringify([space, actor.id, operation])).digest('hex');
      const receipt = this.db.prepare('SELECT fingerprint,result FROM annotation_operations WHERE id=?').get(operation.operationId);
      if (receipt) {
        if (receipt.fingerprint !== fingerprint) throw new AdminError(409, '操作编号已用于不同的内容。', 'operation-id-reused');
        this.db.exec('COMMIT'); return JSON.parse(String(receipt.result));
      }
      const current = this.read(space, operation.id), now = new Date().toISOString();
      let evidence: QualityEvidence | undefined;
      if (operation.action === 'attach-quality-result'||operation.action==='create-quality-candidate') {
        // Resolve after the receipt and revision check: a lost response can be
        // replayed after source/result cleanup without consulting the private job.
        if (operation.action==='create-quality-candidate'?!!current:!current || current.deleted || current.revision !== operation.revision)
          throw new AnnotationCommandError(409, 'annotation-revision-conflict', 'Annotation changed or was deleted.');
        if (!quality) throw new AdminError(503, 'Quality evidence is unavailable.', 'evidence-unavailable');
        const result = quality.resolve(operation.evidence!);
        evidence = {schema:'voidplayer-annotation-psnr',version:1,id:operation.operationId,ref:operation.evidence!,
          serviceOrigin:quality.origin,completedAt:result.completedAt,attachedAt:now,attachedBy:{id:actor.id,name:actor.name},
          verification:'server-verified',value:result.value};
      }
      let cambi:CambiEvidence|undefined;
      if(operation.action==='create-cambi-candidate'){
        if(current)throw new AnnotationCommandError(409,'annotation-revision-conflict','Candidate exists');
        if(!quality?.resolveCambi)throw new AdminError(503,'CAMBI result unavailable','evidence-unavailable');
        const result=quality.resolveCambi(operation.cambi!);cambi={schema:'voidplayer-annotation-cambi',version:result.value.frame.target.indexIdentity.kind==='mp4'?2:1,id:operation.operationId,ref:operation.cambi!,serviceOrigin:quality.origin,completedAt:result.completedAt,attachedAt:now,attachedBy:{id:actor.id,name:actor.name},verification:'server-verified',value:result.value};
      }
      const document = applyAnnotationOperation(operation, current, actor, now, evidence,cambi);
      const json = JSON.stringify(document);
      if (Buffer.byteLength(json) > ANNOTATION_BYTES) throw new AdminError(413, '单条标注内容过大。', 'annotation-too-large');
      this.db.exec('UPDATE annotation_clock SET sequence=sequence+1 WHERE id=1');
      const sequence = Number(this.db.prepare('SELECT sequence FROM annotation_clock WHERE id=1').get()!.sequence);
      const record: AnnotationRecord = { space, id: operation.id, revision: (current?.revision ?? 0) + 1, sequence, deleted: operation.action === 'delete', updatedAt: now, updatedBy: actor.id, document };
      this.db.prepare('INSERT INTO annotations VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(space,id) DO UPDATE SET revision=excluded.revision,sequence=excluded.sequence,deleted=excluded.deleted,updated_at=excluded.updated_at,updated_by=excluded.updated_by,document=excluded.document')
        .run(space, record.id, record.revision, sequence, Number(record.deleted), now, actor.id, json);
      this.db.prepare('DELETE FROM annotation_previews WHERE space=? AND id=?').run(space, record.id);
      this.db.prepare('INSERT INTO annotation_operations VALUES(?,?,?)').run(operation.operationId, fingerprint, JSON.stringify(record));
      this.db.prepare('INSERT INTO annotation_events VALUES(?,?,?)').run(sequence, space, JSON.stringify(annotationEvent(record, operation, actor, requestId)));
      const floor = Math.max(0, sequence - ANNOTATION_EVENT_RETENTION);
      this.db.prepare('DELETE FROM annotation_events WHERE sequence<=?').run(floor);
      this.db.prepare('UPDATE annotation_event_floor SET sequence=max(sequence,?) WHERE id=1').run(floor);
      this.db.exec('COMMIT'); return record;
    } catch (error) {
      this.db.exec('ROLLBACK');
      if (error instanceof AnnotationCommandError) throw new AdminError(error.status, error.message, error.code);
      throw error;
    }
  }
  list(space: string, search = '', deleted = false, before = Number.MAX_SAFE_INTEGER) {
    this.space(space);
    if (search.length > 200 || !Number.isSafeInteger(before) || before < 0) throw new AdminError(400, '标注筛选无效。');
    const rows = this.db.prepare('SELECT id,sequence FROM annotations WHERE space=? AND deleted=? AND sequence<? AND instr(lower(document),lower(?))>0 ORDER BY sequence DESC LIMIT 41').all(space, Number(deleted), before, search);
    const entries = rows.slice(0,40).map(row=>this.read(space,String(row.id))!);
    const totals = this.db.prepare('SELECT count(*) AS count FROM annotations WHERE space=? AND deleted=?').get(space,Number(deleted))!;
    const bytes = this.db.prepare('SELECT coalesce(sum(length(data)),0) AS bytes FROM annotation_previews WHERE space=?').get(space)!;
    return { entries, next: rows.length>40 ? entries.at(-1)!.sequence : null, count: Number(totals.count), previewBytes: Number(bytes.bytes) };
  }
  preview(space: string, id: string, revision: number) {
    const current = this.read(space, id);
    if (!current || current.deleted || current.revision !== revision) throw new AdminError(404, '预览不存在。');
    return this.db.prepare('SELECT data FROM annotation_previews WHERE space=? AND id=? AND revision=?').get(space, id, revision)?.data as Uint8Array | undefined;
  }
  get previewEpoch() { return Number(this.db.prepare('SELECT epoch FROM annotation_preview_epoch WHERE id=1').get()!.epoch); }
  putPreview(space: string, id: string, revision: number, data: Uint8Array, epoch = this.previewEpoch) {
    if (epoch !== this.previewEpoch) throw new AdminError(409, '预览缓存已被清理，未保存旧请求。');
    if (data.byteLength > 128 * 1024 || data[0] !== 255 || data[1] !== 216 || data.at(-2) !== 255 || data.at(-1) !== 217) throw new AdminError(400, '预览需要小于 128 KiB 的 JPEG 图片。');
    const current = this.read(space, id);
    if (!current || current.deleted || current.revision !== revision) throw new AdminError(409, '标注已更新，未保存旧预览。');
    this.db.prepare('INSERT INTO annotation_previews VALUES(?,?,?,?) ON CONFLICT(space,id) DO UPDATE SET revision=excluded.revision,data=excluded.data').run(space, id, revision, data);
    let bytes=Number(this.db.prepare('SELECT coalesce(sum(length(data)),0) AS bytes FROM annotation_previews').get()!.bytes);
    while(bytes>256*1024*1024){const oldest=this.db.prepare('SELECT rowid,length(data) AS bytes FROM annotation_previews ORDER BY rowid LIMIT 1').get()!;this.db.prepare('DELETE FROM annotation_previews WHERE rowid=?').run(oldest.rowid);bytes-=Number(oldest.bytes);}
    return { ok: true };
  }
  previewList(offset = 0, search = '') {
    if (!Number.isSafeInteger(offset) || offset < 0 || search.length > 200) throw new AdminError(400, '缓存分页或搜索参数无效。');
    const total = this.db.prepare('SELECT count(*) AS count,coalesce(sum(length(data)),0) AS bytes FROM annotation_previews').get()!;
    // Extract only the fields needed by the cache browser; never return vector documents or blobs in a listing.
    const rows = this.db.prepare(`SELECT p.space,p.id,p.revision,length(p.data) AS bytes,a.updated_at,s.name AS space_name,
      json_extract(a.document,'$.mark.text') AS text,
      (SELECT json_extract(value,'$.name') FROM json_each(a.document,'$.media') WHERE json_extract(value,'$.id')=json_extract(a.document,'$.mark.mediaId') LIMIT 1) AS media_name
      FROM annotation_previews p JOIN annotations a ON a.space=p.space AND a.id=p.id JOIN spaces s ON s.id=p.space
      WHERE instr(lower(coalesce(text,'') || ' ' || coalesce(media_name,'') || ' ' || s.name),lower(?))>0
      ORDER BY a.updated_at DESC,p.space,p.id LIMIT 51 OFFSET ?`).all(search,offset);
    const entries: CacheEntry[] = rows.slice(0,50).map(row=>({id:String(row.id),scope:String(row.space),version:String(row.revision),name:String(row.media_name ?? '画面标注'),...(row.media_name == null ? {nameCode:'frame-annotation' as const} : {}),detailData:{kind:'annotation' as const,space:String(row.space_name),text:String(row.text || '').slice(0,160)},detail:`${row.space_name} · ${String(row.text || '画面标注').slice(0,160)}`,bytes:Number(row.bytes),updatedAt:Date.parse(String(row.updated_at)),previewUrl:`/api/annotations/spaces/${row.space}/${row.id}/preview?revision=${row.revision}`}));
    return {entries,nextOffset:rows.length>50?offset+50:null,count:Number(total.count),bytes:Number(total.bytes),limitBytes:256*1024*1024,epoch:this.previewEpoch};
  }
  removePreview(space: string, id: string, revision: number) {
    this.space(space);
    if (!Number.isSafeInteger(revision) || revision<1) throw new AdminError(400, '预览版本无效。');
    const row=this.db.prepare('SELECT revision FROM annotation_previews WHERE space=? AND id=?').get(space,id);
    if(row && Number(row.revision)!==revision)throw new AdminError(409, '预览已更新，请刷新后重试。');
    const result=this.db.prepare('DELETE FROM annotation_previews WHERE space=? AND id=? AND revision=?').run(space,id,revision);
    this.db.exec('UPDATE annotation_preview_epoch SET epoch=epoch+1 WHERE id=1');
    return {removed:Number(result.changes)};
  }
  clearPreviews(space?: string) {
    if(space)this.space(space);
    const result=space?this.db.prepare('DELETE FROM annotation_previews WHERE space=?').run(space):this.db.prepare('DELETE FROM annotation_previews').run();
    this.db.exec('UPDATE annotation_preview_epoch SET epoch=epoch+1 WHERE id=1');
    return {removed:Number(result.changes)};
  }
  close() { this.db.close(); }
}
