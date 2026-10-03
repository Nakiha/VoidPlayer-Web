import assert from 'node:assert/strict';
import test from 'node:test';
import { createLocaleController, resolveLocale, parseLanguagePreference } from '../../src/i18n/locale.ts';
import { mediaDiagnostic, MediaOpenError } from '../../src/media-errors.ts';
import { diagnosticMessage } from '../../src/ui/diagnostic-message.ts';
import { setLanguage, t, th, msg } from '../../src/i18n.ts';
import { formatTime } from '../../src/model.ts';
import { parseTimeInput } from '../../src/time-input.ts';

test('locale normalization and initialization contract', () => {
 assert.equal(parseLanguagePreference('zh-TW'),'system');
 assert.equal(resolveLocale('system',['fr','zh-TW']),'zh-CN');assert.equal(resolveLocale('system',['en-GB','zh']),'en');assert.equal(resolveLocale('system',['ja']),'en');
 assert.equal(resolveLocale('zh-CN',['en']),'zh-CN');
});
test('latest choice wins, failed loads retry, static messages cache, fallback remains compiled', async () => {
 let finish!: (value: any) => void, fail!: (error: Error) => void, loads=0, calls=0, commits:string[]=[];
 const zh={greeting:()=>{calls++;return '你好';},missing:()=> '回退'};
 const controller=createLocaleController(zh,()=>{loads++;return new Promise((resolve,reject)=>{finish=resolve;fail=reject;});},(locale)=>commits.push(locale));
 assert.equal(controller.message('greeting'),'你好');assert.equal(controller.message('greeting'),'你好');assert.equal(calls,1);
 let events=0;controller.subscribe(()=>events++);
 const older=controller.set('en',[]);await controller.set('zh-CN',[]);finish({greeting:()=> 'Hello'});await older;
 assert.equal(controller.getLocale(),'zh-CN');assert.equal(events,1);assert.equal(loads,1);
 await controller.set('en',[]);assert.equal(controller.message('greeting'),'Hello');assert.equal(controller.message('missing'),'回退');assert.equal(events,2);
 const life=new AbortController();let disposedEvents=0;controller.subscribe(()=>disposedEvents++,life.signal);life.abort();await controller.set('zh-CN',[]);assert.equal(disposedEvents,0);
 const retry=createLocaleController(zh,()=>{loads++;return new Promise((resolve,reject)=>{finish=resolve;fail=reject;});},()=>{});
 const failed=retry.set('en',[]);fail(new Error('network'));await assert.rejects(failed,/network/);assert.equal(retry.getLocale(),'zh-CN');assert.equal(retry.getPreference(),'system');
 const success=retry.set('en',[]);finish({greeting:()=> 'Hello'});await success;assert.equal(loads,3);assert.equal(retry.getLocale(),'en');
});
test('messages use compiled ICU, escape user content, preserve ASCII timecode and stable diagnostics', async () => {
 await setLanguage('en',{persist:false});
 assert.equal(t(msg('player.frames','{count, plural, other {# 帧}}'),{count:1}),'1 frame');
 assert.equal(t(msg('player.frames','{count, plural, other {# 帧}}'),{count:2}),'2 frames');
 for(const [id,source,single,multiple] of [
  ['player.tracks','{p0, plural, other {# 条轨道}}','1 track','2 tracks'],
 ] as const){assert.equal(t(msg(id,source),{p0:1}),single);assert.equal(t(msg(id,source),{p0:2}),multiple);}
 assert.equal(t(msg('sync.pendingCount','{n, plural, other {# 条标注需要处理}}'),{n:1}),'1 mark needs attention');
 assert.match(t(msg('transfer.pendingRelink','{n, plural, other {# 个片源待重新关联；轨道、偏移和标注已保留。}}'),{n:1}),/^1 source needs relinking;/);
 assert.match(t(msg('shell.trackActions','轨道 {p0} 操作'),{p0:'A'}),/A/);
 assert.ok(th(msg('shell.trackActions','轨道 {p0} 操作'),{p0:'<用户 & "name">'}).includes('&lt;'));
 const error=new MediaOpenError('decode','原始理由','reference-hdr-unsupported');
 const wrapped=new AggregateError([new Error('secondary'),error],'original');assert.equal(mediaDiagnostic(wrapped)?.code,'reference-hdr-unsupported');
 const label=diagnosticMessage('原始理由',mediaDiagnostic(error));assert.match(label,/Managed color/);assert.match(label,/reference-hdr-unsupported \/ decode/);assert.match(label,/原始理由/);
 assert.equal(formatTime(62034567),'01:02.034');assert.equal(parseTimeInput('01:02.035','s'),62035000);
 await setLanguage('zh-CN',{persist:false});assert.equal(formatTime(62034567),'01:02.034');
});
// Compile-time contracts, never executed.
function typedMessages() {
 // @ts-expect-error unknown message ID
 msg('unknown-message','错误');
 // @ts-expect-error missing placeholder
 t(msg('shell.trackActions','轨道 {p0} 操作'));
 // @ts-expect-error extra placeholder
 t(msg('shell.trackActions','轨道 {p0} 操作'),{p0:'A',unexpected:1});
 // @ts-expect-error plural count must be numeric
 t(msg('player.frames','{count, plural, other {# 帧}}'),{count:'two'});
 // @ts-expect-error stale source descriptor
 msg('shell.trackActions','different source');
}
void typedMessages;
