import type { AnnotationDocument, AnnotationOperation, AnnotationRecord } from './annotation-record.ts';
export type AnnotationDraft = { key: string; space: string; actor: string; id: string; base: number; desired: AnnotationDocument | null; generation: number; attempt?: AnnotationOperation; sentGeneration?: number; conflict?: string };
export class AnnotationStorage {
  private db: Promise<IDBDatabase>;
  constructor() {
    this.db = new Promise((resolve, reject) => {
      const request = indexedDB.open('voidplayer-annotations', 2);
      request.onupgradeneeded = () => { for(const name of ['drafts','records','previews'])if(!request.result.objectStoreNames.contains(name))request.result.createObjectStore(name,{keyPath:'key'}); };
      request.onerror = () => reject(request.error); request.onblocked = () => reject(new Error('本机标注存储被其他页面阻塞。'));
      request.onsuccess = () => { request.result.onversionchange = () => request.result.close(); resolve(request.result); };
    });
    void this.db.catch(() => {});
  }
  async drafts() { const db = await this.db; return new Promise<AnnotationDraft[]>((resolve,reject)=>{const r=db.transaction('drafts').objectStore('drafts').getAll();r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);}); }
  async records(space: string) { const db=await this.db; return new Promise<AnnotationRecord[]>((resolve,reject)=>{const r=db.transaction('records').objectStore('records').getAll();r.onsuccess=()=>resolve(r.result.filter(row=>row.space===space));r.onerror=()=>reject(r.error);}); }
  async change(key: string, update: (draft?: AnnotationDraft) => AnnotationDraft | undefined) {
    const db=await this.db;
    return new Promise<AnnotationDraft | undefined>((resolve,reject)=>{
      const tx=db.transaction('drafts','readwrite'), store=tx.objectStore('drafts'); let result: AnnotationDraft | undefined;
      const read=store.get(key); read.onsuccess=()=>{try{result=update(read.result);if(result)store.put(result);else store.delete(key);}catch(error){tx.abort();reject(error);}};
      tx.oncomplete=()=>resolve(result);tx.onabort=()=>reject(tx.error ?? new Error('本机标注未保存。'));
    });
  }
  async remember(records: AnnotationRecord[]) {
    const db=await this.db;
    await new Promise<void>((resolve,reject)=>{
      const tx=db.transaction('records','readwrite'),store=tx.objectStore('records');
      for(const record of records){const key=`${record.space}/${record.id}`, read=store.get(key);read.onsuccess=()=>{if(!read.result || read.result.revision<record.revision)store.put({...record,key});};}
      tx.oncomplete=()=>resolve();tx.onabort=()=>reject(tx.error);
    });
  }
  async savePreview(space: string, id: string, preview: { url: string; width: number; height: number; signature?: string }) {
    const db=await this.db;await new Promise<void>((resolve,reject)=>{const tx=db.transaction('previews','readwrite');tx.objectStore('previews').put({...preview,key:`${space}/${id}`});tx.oncomplete=()=>resolve();tx.onabort=()=>reject(tx.error);});
  }
  async preview(space: string, id: string) {
    const db=await this.db;return new Promise<{url:string;width:number;height:number;signature?:string}|undefined>((resolve,reject)=>{const r=db.transaction('previews').objectStore('previews').get(`${space}/${id}`);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
  }

  async claim(key: string, target: string) {
    const db=await this.db;
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
    const db=await this.db;
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
