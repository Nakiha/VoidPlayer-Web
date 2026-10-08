import test from 'node:test';
import assert from 'node:assert/strict';
import { checkSequence, checkFrame, expectedAt, classify, pixelSignature } from '../../scripts/fate-oracle.ts';
import { createHash } from 'node:crypto';
import { downloadPinnedSample } from '../../scripts/testing/pinned-download.ts';
const frames = [0,40000,80000].map(ptsUs=>({ptsUs,width:8,height:8,signature:Array(48).fill(30)}));
test('FATE oracle rejects silent missing frames, incorrect timestamps, geometry, pixels and seek results',()=>{
  assert.deepEqual(checkSequence(frames,frames),[]);
  assert.ok(checkSequence(frames.slice(0,2),frames).some(f=>f.code==='count'));
  assert.ok(checkSequence([frames[0],frames[2]],frames).some(f=>f.code==='pts'));
  for(const ptsUs of [NaN,Infinity,0.5]) assert.ok(checkFrame({...frames[0],ptsUs},frames[0],'frame').some(f=>f.code==='pts'));
  assert.ok(checkFrame({...frames[0],width:4,bytes:256},frames[0],'frame').some(f=>f.code==='geometry'));
  assert.ok(checkFrame({...frames[0],signature:Array(48).fill(130)},frames[0],'frame').some(f=>f.code==='pixels'));
  assert.equal(expectedAt(frames,79000),frames[1]);assert.equal(expectedAt(frames,0),frames[0]);assert.equal(expectedAt(frames,999999),frames[2]);
  assert.ok(checkFrame(frames[2],expectedAt(frames,79000),'seek').some(f=>f.code==='pts'));
  assert.deepEqual(pixelSignature(new Uint8Array(8*8*4).fill(30),8,8),Array(48).fill(30));
});
test('known failures do not hide new failure kinds and expected rejection cannot silently pass',()=>{
  assert.equal(classify([{code:'geometry',detail:''}],{known:['geometry']}),'known-failure');
  assert.equal(classify([{code:'geometry',detail:''},{code:'pixels',detail:''}],{known:['geometry']}),'fail');
  assert.equal(classify([],{reject:'container'}),'fail');
  assert.equal(classify([{code:'open:container',detail:''}],{reject:'container'}),'expected-rejection');
  assert.equal(classify([{code:'open:input',detail:''}],{reject:'container'}),'fail');
});

const bytes = Buffer.from('pinned FATE sample');
const sample = { file: 'sample.bin', url: 'https://example.invalid/sample.bin', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
test('pinned sample transport and server retries still validate the downloaded bytes', async () => {
  for (const first of [() => { throw new TypeError('fetch failed'); }, () => new Response(null, {status: 503}), () => new Response(new ReadableStream({start(controller) {controller.error(new TypeError('terminated'));}}))]) {
    let calls = 0; const waits: number[] = [];
    const actual = await downloadPinnedSample(sample, { fetchImpl: async () => ++calls === 1 ? first() : new Response(bytes), wait: async ms => {waits.push(ms);}, onRetry() {} });
    assert.deepEqual(actual, bytes); assert.equal(calls, 2); assert.deepEqual(waits, [1000]);
  }
});
test('pinned sample integrity and permanent HTTP failures never retry or accept changed bytes', async () => {
  for (const response of [() => new Response(bytes.subarray(1)), () => new Response(Buffer.alloc(bytes.length)), () => new Response(Buffer.concat([bytes, bytes])), () => new Response(null, {status: 404})]) {
    let calls = 0;
    await assert.rejects(downloadPinnedSample(sample, {fetchImpl: async () => {calls++; return response();}, wait: async () => assert.fail('must not retry'), onRetry() {}}), /checksum mismatch|exceeds pinned size|HTTP 404/);
    assert.equal(calls, 1);
  }
});
test('pinned sample retries are bounded and transport exhaustion remains a failure', async () => {
  let calls = 0; const waits: number[] = [];
  await assert.rejects(downloadPinnedSample(sample, {fetchImpl: async () => {calls++; throw new TypeError('fetch failed');}, wait: async ms => {waits.push(ms);}, onRetry() {}}), /fetch failed/);
  assert.equal(calls, 3); assert.deepEqual(waits, [1000, 2000]);
});
