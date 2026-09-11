import {test} from 'node:test';
import assert from 'node:assert/strict';
import {schedulePresentationTick} from '../src/presentation-tick.ts';

test('visible playback recovers from a starved rAF and cancels the late callback',async()=>{
 const oldRaf=globalThis.requestAnimationFrame,oldCancel=globalThis.cancelAnimationFrame,oldDoc=Object.getOwnPropertyDescriptor(globalThis,'document');
 let delayed:FrameRequestCallback|undefined,cancelled=0,calls=0;
 globalThis.requestAnimationFrame=cb=>{delayed=cb;return 7;};globalThis.cancelAnimationFrame=id=>{assert.equal(id,7);cancelled++;};
 Object.defineProperty(globalThis,'document',{configurable:true,value:{visibilityState:'visible'}});
 try{
  const cancel=schedulePresentationTick(()=>calls++);
  await new Promise(r=>setTimeout(r,45));assert.equal(calls,1);assert.equal(cancelled,1);
  delayed!(100);cancel();assert.equal(calls,1,'late rAF and pause cannot produce duplicate ticks');
 }finally{globalThis.requestAnimationFrame=oldRaf;globalThis.cancelAnimationFrame=oldCancel;if(oldDoc)Object.defineProperty(globalThis,'document',oldDoc);else Reflect.deleteProperty(globalThis,'document');}
});

test('pause resolves a pending tick once and prevents timer/RAF work after cancellation',async()=>{
 const oldRaf=globalThis.requestAnimationFrame,oldCancel=globalThis.cancelAnimationFrame,oldDoc=Object.getOwnPropertyDescriptor(globalThis,'document');
 let late:FrameRequestCallback|undefined,calls=0;
 globalThis.requestAnimationFrame=cb=>{late=cb;return 1;};globalThis.cancelAnimationFrame=()=>{};
 Object.defineProperty(globalThis,'document',{configurable:true,value:{visibilityState:'visible'}});
 try{const cancel=schedulePresentationTick(()=>calls++);cancel();late!(0);await new Promise(r=>setTimeout(r,30));assert.equal(calls,1);}
 finally{globalThis.requestAnimationFrame=oldRaf;globalThis.cancelAnimationFrame=oldCancel;if(oldDoc)Object.defineProperty(globalThis,'document',oldDoc);else Reflect.deleteProperty(globalThis,'document');}
});
