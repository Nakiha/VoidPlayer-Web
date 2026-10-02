import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { WorkspaceStore } from '../server/workspaces.ts';
import { openIndexDatabase } from '../server/sqlite.ts';
import { AnnotationStore } from '../server/annotations.ts';
import { loadConfig } from '../server/config.ts';
import { startService } from '../server/runtime.ts';
import { parseWorkspace } from '../src/workspace-file.ts';
import { applyMarkEdit } from '../src/session/marks.ts';
import { Viewport } from '../src/viewport.ts';
const alice={id:'alice',name:'Alice'},bob={id:'bob',name:'Bob'};
const document=()=>parseWorkspace({schema:'voidplayer-workspace',version:1,name:'评审',generatedAt:new Date().toISOString(),serverUrl:'http://example.test/',positionUs:0,viewport:new Viewport().snapshot(),tracks:[{slot:'A',mediaId:'video',offsetUs:0}],media:[{id:'video',name:'sample.mp4',size:100,lastModified:10,codec:'h264',decoder:'webcodecs',width:100,height:100,durationUs:1000,firstPtsUs:0,source:{kind:'library',id:'a'.repeat(24),url:`http://example.test/api/media/${'a'.repeat(24)}?v=${'b'.repeat(24)}`}}],marks:[{id:'mark',slot:'A',mediaId:'video',text:'画面问题',severity:3,origin:'human',createdAt:new Date().toISOString(),frame:{ptsUs:0,sourcePtsUs:0,durationUs:33333},comparison:[],region:null}]});

test('sharing rejects unsyncable annotations before creating a workspace', () => {
  const store = new WorkspaceStore(':memory:');
  try {
    const doc = document(), id = randomUUID();
    doc.marks[0].id = 'invalid/id';
    assert.throws(() => store.shareWorkspace(id, { name: '工作区', document: doc }, undefined, alice), /编号无效/);
    assert.throws(() => store.read(id, alice), /不存在/);
    doc.marks[0].id = 'mark';
    doc.marks[0].drawings = Array.from({ length: 5 }, () => ({ tool: 'pen' as const, points: Array.from({ length: 4000 }, () => ({ x: .12345678, y: .12345678 })), color: '#ff0000', strokeWidth: 1 }));
    assert.throws(() => store.shareWorkspace(id, { name: '工作区', document: doc }, undefined, alice), /标注内容过大/);
    assert.equal(store.list(alice, true).entries.length, 0);
  } finally { store.close(); }
});

test('sharing creates a writable workspace with recoverable creation, ordinary saves and restart persistence',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'vp-shared-workspace-')),file=path.join(root,'workspaces.sqlite');let store=new WorkspaceStore(file);
  try{
    const id=randomUUID(),doc=document(),input={name:'工作区',document:doc};
    const shared=store.shareWorkspace(id,input,undefined,alice);assert.equal(shared.record.space,`workspace-${id}`);
    assert.deepEqual(store.shareWorkspace(id,input,undefined,alice),shared);
    assert.throws(()=>store.shareWorkspace(id,{...input,name:'different'},undefined,alice),/其他内容/);
    const next=store.update(id,'"1"',{name:'协作修改',document:{...doc,positionUs:500}},bob);
    assert.equal(next.id,id);assert.equal(next.space,shared.record.space);assert.equal(next.revision,2);
    assert.throws(()=>store.update(id,'"1"',input,alice),/已更新/);
    store.close();store=new WorkspaceStore(file);
    assert.equal(store.read(id,bob).document.positionUs,500);assert.equal(store.read(id,bob).document.marks.length,0,'old snapshots never overwrite live feedback');
    assert.equal(store.list(alice,true).entries.length,1);assert.equal(store.read(id,bob).updatedBy,bob.id);
    assert.throws(()=>store.shareWorkspace(randomUUID(),{name:'local',document:{...doc,media:doc.media.map(m=>({...m,source:undefined}))}},undefined,alice),/本地文件/);
    assert.throws(()=>store.shareWorkspace(randomUUID(),{name:'unpinned',document:{...doc,media:doc.media.map(m=>({...m,source:{...m.source!,url:'http://example.test/file'}}))}},undefined,alice),/固定媒体库版本/);
    store.remove(id,'"2"',bob);assert.throws(()=>store.read(id,alice),/不存在/);
    assert.throws(()=>store.shareWorkspace(id,input,undefined,alice),/已被删除/);
    assert.throws(()=>store.shareWorkspace(id,input,'"2"',alice),/已被删除/);
  }finally{store.close();await rm(root,{recursive:true,force:true});}
});

test('replies and resolution round-trip with attribution, immutable anchors and atomic validation',()=>{
  const doc=document(),mark=doc.marks[0];
  applyMarkEdit(mark,{reply:'试试第二版',resolved:true},bob);
  assert.equal(mark.replies![0].author.name,'Bob');assert.equal(mark.resolved,true);
  assert.deepEqual(parseWorkspace(doc).marks,doc.marks);
  const before=structuredClone(mark);
  assert.throws(()=>applyMarkEdit(mark,{text:'changed',reply:' ',resolved:false},alice));assert.deepEqual(mark,before);
  assert.throws(()=>parseWorkspace({...doc,marks:[{...mark,resolved:'yes'}]}));
  assert.throws(()=>parseWorkspace({...doc,marks:[{...mark,replies:[mark.replies![0],mark.replies![0]]}]}));
  const store=new AnnotationStore(':memory:');
  try{
    const first=store.mutate('default',{id:mark.id,revision:0,operationId:'first',action:'put',document:{mark,media:doc.media}},alice);
    assert.equal(first.document.mark.replies![0].author.name,'Alice','the server assigns the author of new replies');
    const edit=structuredClone(first.document);applyMarkEdit(edit.mark,{reply:'已调整',resolved:false},bob);
    const second=store.mutate('default',{id:mark.id,revision:1,operationId:'second',action:'put',document:edit},bob);
    assert.equal(second.document.mark.replies![0].author.name,'Alice');assert.equal(second.document.mark.replies![1].author.name,'Bob');
    assert.throws(()=>store.mutate('default',{id:mark.id,revision:1,operationId:'stale',action:'put',document:edit},alice),/其他人/);
    assert.throws(()=>store.mutate('default',{id:mark.id,revision:2,operationId:'erase-replies',action:'put',document:{...edit,mark:{...edit.mark,replies:[]}}},alice),/已有回复/);
  }finally{store.close();}
});

test('shared workspace HTTP allows recipients to save, preserves live deletions and rejects stale or cross-origin writes',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'vp-shared-workspace-http-'));await mkdir(path.join(root,'media'));
  const config=await loadConfig(['--folder',path.join(root,'media'),'--data-dir',path.join(root,'data')],'production');config.port=0;config.logsDir=null;config.indexWatch=false;
  const service=await startService(config,false),base=`http://127.0.0.1:${(service.server.address() as {port:number}).port}`;
  try{
    const identity=await fetch(base+'/api/identity',{method:'POST',headers:{origin:base,'content-type':'application/json','x-voidplayer-action':'identity'},body:JSON.stringify({guest:true})});
    const cookie=identity.headers.get('set-cookie')!.split(';')[0];
    const headers={origin:base,cookie,'content-type':'application/json','x-voidplayer-action':'workspace'};
    const id=randomUUID(),input={id,name:'工作区',document:document()};
    const create=()=>fetch(base+'/api/workspaces/share',{method:'POST',headers,body:JSON.stringify(input)});
    const first=await create();assert.equal(first.status,201);const shared=await first.json();
    assert.equal((await create()).status,201);
    let changes=await fetch(base+`/api/annotations/spaces/${shared.space}`).then(r=>r.json());assert.equal(changes.entries.length,1);
    const deletion=await fetch(base+`/api/annotations/spaces/${shared.space}`,{method:'POST',headers:{...headers,'x-voidplayer-action':'annotation'},body:JSON.stringify({id:'mark',revision:1,operationId:'delete',action:'delete'})});assert.equal(deletion.status,200);
    assert.equal((await create()).status,201);
    changes=await fetch(base+`/api/annotations/spaces/${shared.space}`).then(r=>r.json());assert.equal(changes.entries[0].deleted,true);assert.equal(changes.entries[0].revision,2);
    const update=()=>fetch(base+`/api/workspaces/${id}`,{method:'PUT',headers:{...headers,'if-match':'"1"'},body:JSON.stringify({name:'共同修改',document:{...input.document,positionUs:500}})});
    assert.deepEqual((await Promise.all([update(),update()])).map(r=>r.status).sort(),[200,409]);
    const current=await fetch(base+`/api/workspaces/${id}`).then(r=>r.json());assert.equal(current.document.positionUs,500);assert.equal(current.document.marks.length,0);
    assert.equal((await fetch(base+`/api/workspaces/${id}`,{method:'PUT',headers:{cookie,'content-type':'application/json'},body:JSON.stringify(input)})).status,403);
    assert.deepEqual((await fetch(base+'/api/users').then(r=>r.json())).users,[]);
  }finally{await service.close();await rm(root,{recursive:true,force:true});}
});

test('v4 data and old URLs migrate to writable workspaces without reviving a deleted workspace',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'vp-shared-workspace-migration-')),file=path.join(root,'workspaces.sqlite');
  const oldShare=randomUUID(),oldReview=randomUUID(),doc=document(),db=openIndexDatabase(file);
  db.exec(`CREATE TABLE workspaces(id TEXT PRIMARY KEY,name TEXT NOT NULL,owner TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,updated_by TEXT NOT NULL,revision INTEGER NOT NULL,bytes INTEGER NOT NULL,tracks INTEGER NOT NULL,marks INTEGER NOT NULL,document TEXT NOT NULL);
    CREATE TABLE users(id TEXT PRIMARY KEY,name TEXT NOT NULL UNIQUE,kind TEXT NOT NULL);
    CREATE TABLE workspace_shares(id TEXT PRIMARY KEY,created_at TEXT NOT NULL,owner TEXT NOT NULL,document TEXT NOT NULL);
    CREATE TABLE reviews(id TEXT PRIMARY KEY,space TEXT NOT NULL UNIQUE,owner TEXT NOT NULL,revision INTEGER NOT NULL,creation_hash TEXT NOT NULL);
    CREATE TABLE review_versions(review TEXT NOT NULL,revision INTEGER NOT NULL,name TEXT NOT NULL,updated_at TEXT NOT NULL,updated_by TEXT NOT NULL,document TEXT NOT NULL,PRIMARY KEY(review,revision)); PRAGMA user_version=4;`);
  db.prepare('INSERT INTO workspace_shares VALUES(?,?,?,?)').run(oldShare,new Date().toISOString(),alice.id,JSON.stringify(doc));
  db.prepare('INSERT INTO reviews VALUES(?,?,?,?,?)').run(oldReview,`review-${oldReview}`,alice.id,2,'old');
  db.prepare('INSERT INTO review_versions VALUES(?,?,?,?,?,?)').run(oldReview,2,'旧评审',new Date().toISOString(),alice.id,JSON.stringify({...doc,positionUs:500}));db.close();
  const store=new WorkspaceStore(file);
  try{
    const shared=store.fromLegacy(oldShare,'share');assert.equal(shared.record.id,oldShare);assert.equal(shared.seeds!.document.marks.length,1);
    store.update(oldShare,'"1"',{name:'可修改',document:{...doc,positionUs:300}},bob);
    assert.equal(store.fromLegacy(oldShare,'share').record.revision,2);
    store.remove(oldShare,'"2"',bob);assert.throws(()=>store.fromLegacy(oldShare,'share'),/已被删除/);
    const review=store.fromLegacy(oldReview,'review');assert.equal(review.record.space,`review-${oldReview}`);assert.equal(review.seeds,undefined);
    assert.equal(store.read(oldReview,bob).document.positionUs,500);store.update(oldReview,'"1"',{name:'同一工作区',document:doc},bob);
    assert.equal(store.list(bob,true).entries.length,1);
  }finally{store.close();await rm(root,{recursive:true,force:true});}
});
