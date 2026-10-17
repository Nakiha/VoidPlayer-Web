import test from 'node:test';
import assert from 'node:assert/strict';
import { staticTsPsi } from '../../shared/media/containers/ts-static-psi.ts';
import { TsCombinationNotMigrated } from '../../shared/media/containers/ts-packet-source.ts';
import { MediaOpenError } from '../../shared/media/io/media-errors.ts';
function crc(data:number[]){let value=0xffffffff;for(const byte of data){value^=byte<<24;for(let bit=0;bit<8;bit++)value=(value<<1)^(value&0x80000000?0x04c11db7:0);}return [value>>>24,(value>>>16)&255,(value>>>8)&255,value&255];}
const section=(data:number[])=>Uint8Array.from([...data,...crc(data)]);
const pat=section([0,0xb0,13,0,1,0xc1,0,0,0,1,0xe1,0]);
const pmt=section([2,0xb0,18,0,1,0xc1,0,0,0xe1,1,0xf0,0,0x1b,0xe1,1,0xf0,0]);
function packet(pid:number,...sections:Uint8Array[]){const value=new Uint8Array(188).fill(255);value.set([0x47,0x40|(pid>>8),pid&255,0x10,0]);let at=5;for(const bytes of sections){value.set(bytes,at);at+=bytes.length;}return value;}
const prefix=Uint8Array.from([...packet(0,pat),...packet(256,pmt),...packet(8191)]);
const hard=(error:unknown)=>error instanceof MediaOpenError && !(error instanceof TsCombinationNotMigrated);

test('normal same-packet repeated complete PSI sections and bounded stuffing pointer remain static',()=>{
  const check=staticTsPsi(prefix);assert.doesNotThrow(()=>check(packet(256,pmt,pmt)));
  const pointed=packet(256);pointed[4]=2;pointed.set(pmt,7);assert.doesNotThrow(()=>check(pointed));
});

test('a CRC-valid changed second section declares dynamic PSI rather than silently admitting it',()=>{
  const changed=[...pmt.subarray(0,-4)];changed[5]^=2;
  assert.throws(()=>staticTsPsi(prefix)(packet(256,pmt,section(changed))),TsCombinationNotMigrated);
  assert.throws(()=>staticTsPsi(Uint8Array.from([...packet(0,pat),...packet(256,pmt,section(changed)),...packet(8191)])),TsCombinationNotMigrated);
});

test('bad CRC in the second section and invalid adaptation/pointer envelopes are hard failures',()=>{
  const corrupt=pmt.slice();corrupt[corrupt.length-1]^=1;
  assert.throws(()=>staticTsPsi(prefix)(packet(256,pmt,corrupt)),hard);
  for(const length of [184,255]){const bad=packet(256,pmt);bad[3]=0x30;bad[4]=length;assert.throws(()=>staticTsPsi(prefix)(bad),hard);}
  const badPointer=packet(256,pmt);badPointer[4]=184;assert.throws(()=>staticTsPsi(prefix)(badPointer),hard);
});

test('fragmented or non-current table scope stays explicit while malformed stuffing cannot disappear',()=>{
  for(const field of ['last','current']){
    const data=[...pmt.subarray(0,-4)];if(field==='last')data[7]=1;else data[5]&=~1;
    assert.throws(()=>staticTsPsi(prefix)(packet(256,section(data))),TsCombinationNotMigrated);
  }
  const tail=packet(256,pmt);tail[187]=0;assert.throws(()=>staticTsPsi(prefix)(tail),hard);
});
