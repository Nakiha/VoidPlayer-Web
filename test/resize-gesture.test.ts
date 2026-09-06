import test from 'node:test';
import assert from 'node:assert/strict';
import { installResizeGesture } from '../src/ui/resize-gesture.ts';

test('dock push closes at the fixed minimum before restoring size; reversal and cancellation keep it open', t => {
  const previous = Object.getOwnPropertyDescriptor(globalThis,'window');
  Object.defineProperty(globalThis,'window',{configurable:true,value:new EventTarget()});
  t.after(()=>{ if(previous) Object.defineProperty(globalThis,'window',previous); else Reflect.deleteProperty(globalThis,'window'); });
  class Handle extends EventTarget {
    captured = false;
    classList = {add() {},remove() {}};
    focus() {} setAttribute() {}
    setPointerCapture() { this.captured = true; }
    hasPointerCapture() { return this.captured; }
    releasePointerCapture() { this.captured = false; }
  }
  const handle = new Handle();
  let size = 180, pushed = 0, veil = 0;
  const closes:number[] = [];
  installResizeGesture(handle as unknown as HTMLElement, {
    axis:'y',direction:-1,size:()=>size,bounds:()=>({min:128,max:420}),
    resize:value=>{size=Math.max(128,Math.min(420,value));},threshold:()=>32,reset:()=>180,
    dragging() {},preview:(p,v)=>{pushed=p;veil=v;},collapse:()=>{closes.push(size);},
  },new AbortController().signal);
  function send(type:string,y=0,key='') {
    const event = new Event(type,{cancelable:true});
    Object.assign(event,{pointerId:1,button:0,clientY:y,key}); handle.dispatchEvent(event);
  }
  send('pointerdown',100); send('pointermove',152);
  assert.equal(size,128); assert.equal(pushed,0);
  send('pointermove',184);
  assert.equal(size,128); assert.equal(pushed,32); assert.equal(veil,1);
  send('pointerup',184);
  assert.deepEqual(closes,[128]); assert.equal(size,180); assert.equal(pushed,0);
  send('pointerdown',100); send('pointermove',184); send('pointermove',140); send('pointerup',140);
  assert.equal(size,140); assert.deepEqual(closes,[128]);
  send('pointerdown',100); send('pointermove',184); send('keydown',0,'Escape');
  assert.equal(size,140); assert.deepEqual(closes,[128]); assert.equal(veil,0);
});
