import test from 'node:test';
import assert from 'node:assert/strict';
import { checkSequence, checkFrame, expectedAt, classify, pixelSignature } from '../scripts/fate-oracle.ts';
const frames = [0,40000,80000].map(ptsUs=>({ptsUs,width:8,height:8,signature:Array(48).fill(30)}));
test('FATE oracle rejects silent missing frames, incorrect timestamps, geometry, pixels and seek results',()=>{
  assert.deepEqual(checkSequence(frames,frames),[]);
  assert.ok(checkSequence(frames.slice(0,2),frames).some(f=>f.code==='count'));
  assert.ok(checkSequence([frames[0],frames[2]],frames).some(f=>f.code==='pts'));
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
