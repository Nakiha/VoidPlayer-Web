import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,access} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {NativeVmafService} from '../../server/analysis/vmaf/service.ts';
import {NativeXpsnrService} from '../../server/analysis/xpsnr/service.ts';
import type {WasmVmafRunner} from '../../server/analysis/vmaf/wasm-runner.ts';
import type {WasmXpsnrRunner} from '../../server/analysis/xpsnr/wasm-runner.ts';
import type {CorrespondenceService} from '../../server/analysis/quality/correspondence-service.ts';
import {openIndexDatabase} from '../../server/sqlite.ts';

const plans={} as CorrespondenceService;
for(const kind of ['vmaf','xpsnr'] as const){
  const create=(file:string,executor:unknown)=>kind==='vmaf'?new NativeVmafService(file,executor as WasmVmafRunner,plans):new NativeXpsnrService(file,executor as WasmXpsnrRunner,plans);
  test(`${kind}: recovery preserves arbitrary database names and refuses future schemas without leaking ownership`,async()=>{
    const directory=await mkdtemp(path.join(tmpdir(),'vp-temporal-store-')),file=path.join(directory,'history.sqlite');
    try{
      const executor={stopUncertain:false,close:async()=>{},assertAvailable(){}};
      const service=create(file,executor);await service.ready;await access(file);await service.close();await access(file);
      const db=openIndexDatabase(file);db.exec('PRAGMA user_version=99');db.close();assert.throws(()=>create(file,executor),/newer application/);
      const check=openIndexDatabase(file);assert.equal(check.prepare('PRAGMA user_version').get()!.user_version,99);check.exec('PRAGMA user_version=2');check.close();
      const reopened=create(file,executor);await reopened.ready;await reopened.close();
    }finally{await rm(directory,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
  });
  test(`${kind}: executor rejection is observed while an attempt drains, and unresolved ownership stays locked`,async()=>{
    const directory=await mkdtemp(path.join(tmpdir(),'vp-temporal-stop-')),file=path.join(directory,`history.quality-${kind}.sqlite`);
    let service:any,release!:()=>void;const done=new Promise<void>(r=>release=r),failure=Error('executor exit unconfirmed');
    try{
      const executor={stopUncertain:false,close:async()=>{throw failure;},assertAvailable(){}};
      service=create(file,executor);await service.ready;const controller=new AbortController();service.active.set('owned-attempt',{id:'owned-attempt',controller,done});
      const closed=service.close();assert.equal(service.close(),closed);await new Promise(r=>setImmediate(r));assert.equal(controller.signal.aborted,true);release();
      await assert.rejects(closed,(error:AggregateError)=>{assert.ok(error.errors.some(e=>e.cause===failure));return true;});
      assert.throws(()=>create(file,{...executor,close:async()=>{}}),/另一个实例/);
    }finally{
      release();if(service){service.db.close();service.unlock();}
      await rm(directory,{recursive:true,force:true,maxRetries:10,retryDelay:100});
    }
  });
}

for(const kind of ['vmaf','xpsnr','cambi'] as const)test(`${kind}: result release advances observation atomically and keeps immutable receipt`,async()=>{
 const {releaseScoringResult}=await import('../../server/analysis/quality/result-retention.ts');
 const db=openIndexDatabase(':memory:'),table=kind==='cambi'?'cambi_jobs':`quality_${kind}_jobs`,publications=kind==='cambi'?'cambi_publications':`quality_${kind}_publications`,column=kind==='cambi'?'job':'job_id';
 try{
  db.exec(`CREATE TABLE ${table}(id TEXT PRIMARY KEY,body TEXT,result TEXT,reserved INTEGER,snapshot TEXT,prepared TEXT);CREATE TABLE ${publications}(${column} TEXT,body TEXT);CREATE TABLE quality_reexecutions(job_id TEXT,body TEXT);CREATE TABLE cambi_heat(job TEXT,data BLOB)`);
  const body={state:'completed',revision:7,resultDigest:'a'.repeat(64),attemptId:'original-attempt'};
  db.prepare(`INSERT INTO ${table} VALUES(?,?,?,?,?,?)`).run('job',JSON.stringify(body),'{}',1024,null,null);db.prepare('INSERT INTO cambi_heat VALUES(?,?)').run('job',new Uint8Array([1]));
  releaseScoringResult(db,kind,'job');const row=db.prepare(`SELECT body,result FROM ${table} WHERE id=?`).get('job')!;
  assert.deepEqual(JSON.parse(String(row.body)),{...body,revision:8});assert.equal(row.result,null);
  releaseScoringResult(db,kind,'job');assert.equal(JSON.parse(String(db.prepare(`SELECT body FROM ${table}`).get()!.body)).revision,8,'repeated release does not invent another change');
  if(kind==='cambi')assert.equal(db.prepare('SELECT count(*) n FROM cambi_heat').get()!.n,0);
 }finally{db.close();}
});

// A real portable pair measurement supplies validated evidence; mutate only the
// frozen facts to prove that the shared post-check rejects drift for both metrics.
for (const kind of ['vmaf', 'xpsnr'] as const) test(`${kind}: prepared facts bind recipe, source identity and frozen budgets`, async () => {
  const { pairViewFixture } = await import('../helpers/pair-view-fixture.ts');
  const { validatePreparedFacts } = await import('../../server/analysis/quality/prepared-facts.ts');
  const { VmafError } = await import('../../shared/analysis/quality/vmaf.ts');
  const { XpsnrError } = await import('../../shared/analysis/quality/xpsnr.ts');
  const f = await pairViewFixture(), ErrorType = kind === 'vmaf' ? VmafError : XpsnrError;
  const make = () => ({
    sequence: { pairs: [{ ...structuredClone(f.request), roi: structuredClone(f.evidence.value.result.metric.roi) }] },
    pairs: [structuredClone(f.evidence.value)], geometry: { width: 32, height: 32, bitDepth: 8 },
    raw: { bytes: 3072, referenceSha256: 'a'.repeat(64), distortedSha256: 'b'.repeat(64) }, work: { readBytes: 1, packets: 1, outputFrames: 1, inputBytes: 1 },
  } as unknown as import('../../shared/analysis/quality/temporal-contract.ts').TemporalPrepared);
  const snapshot = { value: { rangePlan: { input: { budget: {
    maxReadBytes: 1, maxPackets: 1, maxOutputFrames: 1, maxInputBytes: 1,
  } } } } } as import('../../shared/analysis/quality/temporal-contract.ts').TemporalPlanSnapshot;
  const input = { metrics: { ssim: false }, budget: { maxRawBytes: 3072 } };
  const check = (v: ReturnType<typeof make>, i = input, bytes = 1e6) =>
    validatePreparedFacts(v, snapshot, i, bytes, (code, message) => new ErrorType(code, message));
  assert.doesNotThrow(() => check(make()));
  const rejects = (v: ReturnType<typeof make>, code = 'worker-result-invalid') =>
    assert.throws(() => check(v), (error: unknown) => error instanceof ErrorType && error.code === code);
  for (const side of ['reference', 'distorted'] as const)
    for (const field of ['mediaId', 'mediaVersion', 'size', 'indexIdentity', 'indexBuildId', 'sourcePtsUs', 'picture', 'decode'] as const) {
      const v = make(); Object.assign(v.sequence.pairs[0][side], { [field]: 'changed' }); rejects(v);
    }
  let v = make(); v.sequence.pairs[0].roi.x++; rejects(v);
  v = make(); v.geometry.bitDepth = 10; rejects(v);
  assert.throws(() => check(make(), { ...input, metrics: { ssim: true } }), { code: 'worker-result-invalid' });
  for (const field of ['readBytes', 'packets', 'outputFrames', 'inputBytes'] as const) {
    v = make(); v.work[field]++; rejects(v);
  }
  v = make(); v.raw.bytes++; rejects(v);
  v = make(); v.raw.referenceSha256 = 'changed'; rejects(v);
  assert.throws(() => check(make(), { ...input, budget: { maxRawBytes: 3071 } }), { code: 'budget-exceeded' });
  assert.throws(() => check(make(), input, 1), { code: 'budget-exceeded' });
});
