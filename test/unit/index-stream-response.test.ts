import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { ServerResponse } from 'node:http';
import { sendMediaIndexStream, writeMediaIndexEvent, INDEX_STREAM_BATCH_BYTES } from '../../server/routes/index-stream.ts';

class Response extends EventEmitter {
  destroyed=false;
  headersSent=false;
  writes:string[]=[];
  ended=0;
  blockAt=0;
  writeHead(){this.headersSent=true;}
  write(value:string){this.writes.push(value);return this.writes.length!==this.blockAt;}
  end(){this.ended++;this.emit('finish');}
  destroy(){this.destroyed=true;this.emit('close');}
  get response(){return this as unknown as ServerResponse;}
}
const turn=()=>new Promise(resolve=>setImmediate(resolve));

test('index stream holds its consumer cursor at backpressure until drain, then resumes with unchanged framing',{timeout:1500},async()=>{
  const bytes=Buffer.from(JSON.stringify({payload:'x'.repeat(INDEX_STREAM_BATCH_BYTES*2)}));
  const response=new Response();response.blockAt=2;
  const pending=sendMediaIndexStream(response.response,bytes,4,'flv',0);
  await turn();assert.equal(response.writes.length,2,'no progress or following batch before drain');assert.equal(response.ended,0);
  const first=response.writes.map(value=>JSON.parse(value));assert.equal(first[0].type,'manifest');assert.equal(first[1].seq,1);
  response.emit('drain');await pending;
  const events=response.writes.map(value=>JSON.parse(value));
  assert.deepEqual(events.map(value=>value.type),['manifest','batch','progress','batch','progress','complete']);
  assert.equal(events[1].data,bytes.subarray(INDEX_STREAM_BATCH_BYTES,INDEX_STREAM_BATCH_BYTES*2).toString('base64'));
  assert.equal(events[3].seq,2);assert.equal(events.at(-1).lastSeq,2);assert.equal(response.ended,1);
  for(const name of ['drain','close','finish'])assert.equal(response.listenerCount(name),0);
});

test('disconnect during a blocked index write releases listeners and never writes or ends again',{timeout:1500},async()=>{
  const response=new Response();response.blockAt=1;
  const pending=sendMediaIndexStream(response.response,Uint8Array.of(1,2),1,'js-ts',-1);
  await turn();assert.equal(response.listenerCount('drain'),1);assert.equal(response.listenerCount('close'),1);
  response.destroy();await pending;response.emit('drain');assert.equal(response.writes.length,1);assert.equal(response.ended,0);
  assert.equal(response.listenerCount('drain'),0);assert.equal(response.listenerCount('close'),0);
  await assert.rejects(writeMediaIndexEvent(response.response,{type:'complete'}),/断开/);assert.equal(response.writes.length,1);
});
