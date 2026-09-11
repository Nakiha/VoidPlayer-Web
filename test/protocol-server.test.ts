import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import os from 'node:os';
import { ProtocolGateway } from '../server/protocol-server.ts';

test('gateway handles a fragmented HTTP method, retains peer attribution and closes incomplete clients',async()=>{
 const gateway=new ProtocolGateway();
 const address=Object.values(os.networkInterfaces()).flat().find(i=>i?.family==='IPv4' && !i.internal)?.address??'127.0.0.1';
 const payload=Buffer.alloc(8*1024*1024,37);
 const backend=createServer((req,res)=>{res.setHeader('connection','close');res.end(req.url==='/large'?payload:JSON.stringify({peer:gateway.clientAddress(req),url:req.url}));});
 await new Promise<void>(resolve=>backend.listen(0,'127.0.0.1',resolve));
 const port=(backend.address() as {port:number}).port,front=gateway.create(port,port);
 await new Promise<void>(resolve=>front.listen(0,address,resolve));const publicPort=(front.address() as {port:number}).port;
 try{
  const result=await new Promise<string>((resolve,reject)=>{
   const client=connect(publicPort,address);let text='';client.on('error',reject);client.on('data',data=>text+=data);client.on('end',()=>resolve(text));
   client.on('connect',()=>{client.write('G');setTimeout(()=>client.write('ET /llms.txt?x=1 HTTP/1.1\r\nHost: localhost\r\nX-Forwarded-For: 127.0.0.1\r\nConnection: close\r\n\r\n'),15);});
  });
  assert.match(result,/200 OK/);assert.ok(result.includes(JSON.stringify({peer:address,url:'/llms.txt?x=1'})));
  const bytes=await new Promise<Buffer>((resolve,reject)=>{
    const client=connect(publicPort,address),chunks:Buffer[]=[];client.on('error',reject);client.on('data',chunk=>chunks.push(typeof chunk==='string'?Buffer.from(chunk):chunk));client.on('end',()=>resolve(Buffer.concat(chunks)));
    client.on('connect',()=>{client.write('GET /large HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n');client.pause();setTimeout(()=>client.resume(),100);});
  });
  assert.deepEqual(bytes.subarray(bytes.indexOf('\r\n\r\n')+4),payload,'slow readers receive the final buffered bytes before close');
  const accepted=new Promise<void>(resolve=>front.once('connection',()=>resolve()));
  const incomplete=connect(publicPort,address);await accepted;
  const closed=new Promise<void>(resolve=>incomplete.once('close',()=>resolve()));front.closeAllConnections();await closed;
 }finally{front.closeAllConnections();backend.closeAllConnections();await Promise.all([front,backend].map(server=>new Promise<void>(resolve=>server.close(()=>resolve()))));}
});
