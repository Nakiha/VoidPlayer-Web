import { LocalDatabase } from './local-database.ts';
import type { AnnotationDocument, AnnotationOperation, AnnotationRecord } from './annotation-record.ts';
export type AnnotationDraft = { key: string; space: string; actor: string; id: string; base: number; desired: AnnotationDocument | null; generation: number; attempt?: AnnotationOperation; sentGeneration?: number; conflict?: string };
export type AnnotationPreview = { url: string; width: number; height: number; signature?: string };
export class AnnotationStorage {
  private database = new LocalDatabase('voidplayer-annotations', 3, (db, tx) => {
    for (const name of ['drafts', 'records', 'previews']) {
      if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: 'key' });
    }
    const records = tx.objectStore('records'), drafts = tx.objectStore('drafts');
    if (!records.indexNames.contains('space')) records.createIndex('space', 'space');
    if (!drafts.indexNames.contains('space-actor')) drafts.createIndex('space-actor', ['space', 'actor']);
  }, '本机标注存储被其他页面阻塞。');

  async drafts(space: string, actor: string) {
    const db = await this.database.open();
    return new Promise<AnnotationDraft[]>((resolve, reject) => {
      const request = db.transaction('drafts').objectStore('drafts').index('space-actor').getAll([space, actor]);
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
  }
  async records(space: string) {
    const db = await this.database.open();
    return new Promise<AnnotationRecord[]>((resolve, reject) => {
      const request = db.transaction('records').objectStore('records').index('space').getAll(space);
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
  }
  async change(key: string, update: (draft?: AnnotationDraft) => AnnotationDraft | undefined) {
    const db=await this.database.open();
    return new Promise<AnnotationDraft | undefined>((resolve,reject)=>{
      const tx=db.transaction('drafts','readwrite'), store=tx.objectStore('drafts'); let result: AnnotationDraft | undefined;
      const read=store.get(key); read.onsuccess=()=>{try{result=update(read.result);if(result)store.put(result);else store.delete(key);}catch(error){tx.abort();reject(error);}};
      tx.oncomplete=()=>resolve(result);tx.onabort=()=>reject(tx.error ?? new Error('本机标注未保存。'));
    });
  }
  async remember(records: AnnotationRecord[]) {
    const db=await this.database.open();
    await new Promise<void>((resolve,reject)=>{
      const tx=db.transaction('records','readwrite'),store=tx.objectStore('records');
      for(const record of records){const key=`${record.space}/${record.id}`, read=store.get(key);read.onsuccess=()=>{if(!read.result || read.result.revision<record.revision)store.put({...record,key});};}
      tx.oncomplete=()=>resolve();tx.onabort=()=>reject(tx.error);
    });
  }
  async savePreview(space: string, id: string, preview: { url: string; width: number; height: number; signature?: string }) {
    const db=await this.database.open();await new Promise<void>((resolve,reject)=>{const tx=db.transaction('previews','readwrite');tx.objectStore('previews').put({...preview,key:`${space}/${id}`});tx.oncomplete=()=>resolve();tx.onabort=()=>reject(tx.error);});
  }
  async previews(space: string, ids: string[]): Promise<Map<string, AnnotationPreview>> {
    if (!ids.length) return new Map();
    const db = await this.database.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('previews'), store = tx.objectStore('previews');
      const result = new Map<string, AnnotationPreview>();
      for (const id of new Set(ids)) {
        const request = store.get(`${space}/${id}`);
        request.onsuccess = () => { if (request.result) result.set(id, request.result); };
      }
      tx.oncomplete = () => resolve(result); tx.onabort = () => reject(tx.error);
    });
  }
  async preview(space: string, id: string) { return (await this.previews(space, [id])).get(id); }
  close() { this.database.close(); }

  async claim(key: string, target: string) {
    const db=await this.database.open();
    await new Promise<void>((resolve,reject)=>{
      const tx=db.transaction('drafts','readwrite'),store=tx.objectStore('drafts');let failure:Error|undefined;
      const existing=store.get(target);existing.onsuccess=()=>{
        if(existing.result){failure=new Error('此页面已有这条标注的草稿，请先处理。');tx.abort();return;}
        const read=store.get(key);read.onsuccess=()=>{if(read.result){store.put({...read.result,key:target});store.delete(key);}};
      };
      tx.oncomplete=()=>resolve();tx.onabort=()=>reject(failure??tx.error);
    });
  }
  async resolve(draft: AnnotationDraft, copy?: AnnotationDraft) {
    const db=await this.database.open();
    await new Promise<void>((resolve,reject)=>{
      const tx=db.transaction('drafts','readwrite'),store=tx.objectStore('drafts');let failure:Error|undefined;
      const read=store.get(draft.key);read.onsuccess=()=>{
        if(!read.result || read.result.generation!==draft.generation){failure=new Error('草稿已更新，请重新选择处理方式。');tx.abort();return;}
        if(copy)store.add(copy);store.delete(draft.key);
      };
      tx.oncomplete=()=>resolve();tx.onabort=()=>reject(failure??tx.error);
    });
  }
}
