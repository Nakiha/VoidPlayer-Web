import test from 'node:test';
import assert from 'node:assert/strict';
import { setLanguage } from '../../src/i18n.ts';
import { requestError, rootReason, cacheDetail, cacheName } from '../../src/admin/diagnostics.ts';
import { apiError } from '../../src/api-error.ts';
import { AdminError, adminErrorBody } from '../../server/admin-error.ts';
import { CacheManager } from '../../server/caches.ts';
import type { CacheEntry } from '../../server/caches.ts';

test('additive API metadata retains status, raw cause and parameters through both UI locales', async()=>{
 const error=new AdminError(409,'服务端原始诊断','configuration-changed',{revision:'r1'});
 const body=adminErrorBody(error);assert.deepEqual(body,{error:'服务端原始诊断',code:'configuration-changed',params:{revision:'r1'}});
 const client=apiError(error.status,body);assert.equal(client.status,409);assert.equal(client.message,body.error);assert.equal(client.code,body.code);assert.deepEqual(client.params,body.params);
 await setLanguage('en',{persist:false});assert.match(requestError(client),/draft is preserved/);assert.match(requestError(client),/服务端原始诊断/);
 await setLanguage('zh-CN',{persist:false});assert.match(requestError(client),/草稿仍保留/);assert.match(requestError(client),/服务端原始诊断/);
 assert.equal(apiError(503,{}).message,'HTTP 503');
 await setLanguage('en',{persist:false});
 assert.match(requestError(apiError(409,{error:'original busy cause',code:'measurement-busy'})),/cancel the current test/);
 assert.doesNotMatch(requestError(apiError(409,{error:'original busy cause',code:'measurement-busy'})),/content has changed/);
 assert.match(requestError(apiError(409,{error:'original pending cause',code:'measurement-finish-pending'})),/still finishing/);
 await setLanguage('zh-CN',{persist:false});
});

test('server-owned cache descriptions have stable structured fields; names and diagnostic fields stay unchanged',async()=>{
 const frames={list:()=>({entries:[{id:'media-id',version:'v1',name:'用户 User.mp4',root:'归档 User',kind:'ffmpeg',frames:12,bytes:64,createdAt:1700000000000}],count:1,bytes:64,limitBytes:100,nextOffset:null})};
 const manager=new CacheManager('/unused',frames as any,{} as any);
 const entry=manager.list('frame-indexes').entries[0] as CacheEntry;
 assert.equal(entry.name,'用户 User.mp4');assert.equal(entry.detail,'归档 User · ffmpeg · 12 帧');
 assert.deepEqual(entry.detailData,{kind:'frames',root:'归档 User',format:'ffmpeg',frames:12});
 await setLanguage('en',{persist:false});assert.equal(cacheDetail(entry),'归档 User · ffmpeg · 12 frames');assert.equal(cacheName(entry),'用户 User.mp4');
 const preview={...entry,name:'画面标注',nameCode:'frame-annotation' as const,detailData:{kind:'annotation' as const,space:'用户空间',text:''}};
 assert.equal(cacheName(preview),'Frame mark');assert.equal(cacheDetail(preview),'用户空间 · Frame mark');
 assert.match(rootReason('cli-override','original diagnostic'),/--folder/);assert.equal(rootReason(undefined,'older server reason'),'older server reason');
 await setLanguage('zh-CN',{persist:false});assert.equal(cacheDetail(entry),entry.detail);assert.equal(cacheName(preview),'画面标注');
});
