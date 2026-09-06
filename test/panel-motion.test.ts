import test from 'node:test';
import assert from 'node:assert/strict';
import { installPanelMotion } from '../src/ui/panel-motion.ts';

test('panel exit stays mounted, reversed toggles cancel stale hiding, and reduced motion hides immediately', t => {
  t.mock.timers.enable({apis:['setTimeout']});
  function element() {
    const classes = new Set<string>();
    return {
      hidden:true, inert:false, offsetWidth:240,
      style:{width:'',height:'',removeProperty(name:string) { (this as Record<string, unknown>)[name] = ''; }},
      classList:{add:(name:string)=>classes.add(name),remove:(name:string)=>classes.delete(name),toggle:(name:string,on:boolean)=>on?classes.add(name):classes.delete(name)},
      getBoundingClientRect:()=>({width:240,height:180}),
    };
  }
  const panel = element(), workspace = element();
  let reduced = false;
  const overrides = {
    document:{getElementById:()=>panel},
    matchMedia:()=>({matches:reduced}),
    getComputedStyle:()=>({getPropertyValue:()=> '220ms'}),
  };
  for (const [key,value] of Object.entries(overrides)) {
    const previous = Object.getOwnPropertyDescriptor(globalThis,key);
    Object.defineProperty(globalThis,key,{configurable:true,value});
    t.after(()=>{ if(previous) Object.defineProperty(globalThis,key,previous); else Reflect.deleteProperty(globalThis,key); });
  }
  const life = new AbortController();
  const motion = installPanelMotion(workspace as unknown as HTMLElement,life.signal);
  motion.set('sources',true);
  assert.equal(panel.hidden,false);
  motion.set('sources',false);
  assert.equal(panel.hidden,false);
  assert.equal(panel.inert,true);
  assert.equal(panel.style.width,'240px');
  t.mock.timers.tick(100);
  motion.set('sources',true);
  t.mock.timers.tick(220);
  assert.equal(panel.hidden,false);
  assert.equal(panel.inert,false);
  assert.equal(panel.style.width,'');
  motion.set('sources',false);
  t.mock.timers.tick(220);
  assert.equal(panel.hidden,true);
  reduced = true;
  motion.set('sources',true);
  motion.set('sources',false);
  assert.equal(panel.hidden,true);
  life.abort();
});
