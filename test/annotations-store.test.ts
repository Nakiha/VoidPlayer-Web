import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AnnotationStore } from '../server/annotations.ts';
import type { AnnotationDocument } from '../src/annotation-record.ts';
const alice = { id: 'alice', name: 'Alice' }, bob = { id: 'bob', name: 'Bob' };
const document = (id='mark'): AnnotationDocument => ({ media: [{id:'media',name:'a.mp4',size:10,lastModified:1,codec:'avc1',decoder:'webcodecs',width:320,height:180,durationUs:1000000,firstPtsUs:0,source:{kind:'library',id:'library',url:'http://localhost/api/media/library?v=one'}}], mark:{id,text:'original',severity:3,origin:'human',createdAt:'2026-09-08',slot:'A',mediaId:'media',frame:{ptsUs:0,sourcePtsUs:0,durationUs:40000},comparison:[],region:null,drawings:[]} });
test('annotation writes are versioned, idempotent and never resurrect tombstones', () => {
 const dir=mkdtempSync(path.join(os.tmpdir(),'vp-annotations-')),file=path.join(dir,'annotations.sqlite');
 const a=new AnnotationStore(file),b=new AnnotationStore(file);
 try {
  const create={operationId:'create',id:'mark',revision:0,action:'put' as const,document:document()};
  const first=a.mutate('default',create,alice); assert.equal(first.revision,1); assert.equal(first.document.mark.author?.id,'alice');
  assert.deepEqual(b.mutate('default',create,alice),first);
  assert.throws(()=>b.mutate('default',{...create,document:{...document(),mark:{...document().mark,text:'changed'}}},alice),/操作编号/);
  const updated=b.mutate('default',{operationId:'edit',id:'mark',revision:1,action:'put',document:{...document(),mark:{...document().mark,text:'edited'}}},bob);
  assert.equal(updated.revision,2); assert.equal(updated.document.mark.author?.id,'alice'); assert.equal(updated.updatedBy,'bob');
  assert.throws(()=>a.mutate('default',{operationId:'delete-old',id:'mark',revision:1,action:'delete'},alice),/修改或删除/);
  const deleted=a.mutate('default',{operationId:'delete',id:'mark',revision:2,action:'delete'},alice); assert.equal(deleted.deleted,true);
  assert.throws(()=>b.mutate('default',{...create,operationId:'late',revision:2},bob),/修改或删除/);
  assert.throws(()=>b.mutate('default',{...create,operationId:'resurrect',revision:3},bob),/修改或删除/);
  const restored=a.mutate('default',{operationId:'restore',id:'mark',revision:3,action:'restore'},alice); assert.equal(restored.revision,4); assert.equal(restored.deleted,false);
  const changes=a.changes('default',first.sequence); assert.equal(changes.entries.length,1); assert.equal(changes.entries[0].revision,4);
  assert.equal(a.changes('default',changes.cursor).entries.length,0);
  const wrong=document(); wrong.media[0].source!.url='http://localhost/api/media/library?v=two';
  assert.throws(()=>a.mutate('default',{...create,operationId:'wrong-version',revision:4,document:wrong},alice),/媒体版本/);
  assert.equal(a.read('default','mark')?.revision,4,'rejected operations leave no revision change');
  const jpeg=new Uint8Array([255,216,1,2,255,217]); a.putPreview('default','mark',4,jpeg);
  assert.ok(a.preview('default','mark',4)); assert.equal(a.clearPreviews('default').removed,1); assert.equal(a.read('default','mark')?.document.mark.text,'edited');
  assert.throws(()=>a.putPreview('default','mark',3,jpeg),/更新/);
 } finally {a.close();b.close();}
 const reopened=new AnnotationStore(file); try {assert.equal(reopened.read('default','mark')?.revision,4);} finally {reopened.close();rmSync(dir,{recursive:true,force:true});}
});
test('annotation spaces isolate data and changes paginate without losing deletions',()=>{
 const store=new AnnotationStore(':memory:');
 try {
  const space=store.createSpace('second'); assert.equal(store.changes(space.id).entries.length,0);
  for(let i=0;i<205;i++)store.mutate('default',{operationId:`create-${i}`,id:`m-${i}`,revision:0,action:'put',document:document(`m-${i}`)},alice);
  const one=store.changes('default'); assert.equal(one.entries.length,200); assert.equal(one.more,true);
  store.mutate('default',{operationId:'delete-first',id:'m-0',revision:1,action:'delete'},alice);
  const two=store.changes('default',one.cursor); assert.equal(two.entries.length,6); assert.equal(two.entries.at(-1)?.deleted,true);
 } finally {store.close();}
});

test('preview browsing is bounded, revision-aware and cannot undo cache clearing',()=>{
 const store=new AnnotationStore(':memory:'),jpeg=new Uint8Array([255,216,1,2,255,217]);
 try {
  for(let i=0;i<52;i++){const id=`p-${i}`;store.mutate('default',{operationId:id,id,revision:0,action:'put',document:document(id)},alice);store.putPreview('default',id,1,jpeg);}
  const page=store.previewList();assert.equal(page.entries.length,50);assert.equal(page.nextOffset,50);assert.equal(page.bytes,52*jpeg.byteLength);assert.equal(store.previewList(50).entries.length,2);assert.equal(store.previewList(0,'no such name').entries.length,0);
  assert.ok(page.entries.every(entry=>!('document' in entry) && !('data' in entry)));
  const epoch=store.previewEpoch;store.mutate('default',{operationId:'edit-p',id:'p-0',revision:1,action:'put',document:document('p-0')},bob);store.putPreview('default','p-0',2,jpeg);
  assert.throws(()=>store.removePreview('default','p-0',1),/已更新/);assert.ok(store.preview('default','p-0',2));
  assert.equal(store.clearPreviews().removed,52);assert.equal(store.list('default').count,52);assert.throws(()=>store.putPreview('default','p-0',2,jpeg,epoch),/已被清理/);assert.equal(store.previewList().bytes,0);
 }finally{store.close();}
});
