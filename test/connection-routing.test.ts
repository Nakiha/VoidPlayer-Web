import test from 'node:test';
import assert from 'node:assert/strict';
import { connectionTarget } from '../src/connection.ts';
import { localRequest, setClientAddress } from '../server/reveal.ts';
import type { IncomingMessage } from 'node:http';

test('HTTPS handoff preserves page state but never accepts external or non-page destinations',()=>{
 const origin='https://192.168.1.102:5180/';
 assert.equal(connectionTarget(origin,'/?annotation=abc&space=default#frame').href,origin+'?annotation=abc&space=default#frame');
 assert.equal(connectionTarget(origin,'/admin#caches').href,origin+'admin#caches');
 for(const next of ['//evil.test/','https://evil.test/','javascript:alert(1)','/api/admin/caches','/connection'])assert.equal(connectionTarget(origin,next).href,origin);
 assert.throws(()=>connectionTarget('http://host/'),/HTTPS/);
});
test('gateway peer attribution cannot be spoofed by forwarding headers',()=>{
 const req={socket:{remoteAddress:'127.0.0.1'},headers:{host:'localhost', 'x-forwarded-for':'127.0.0.1'}} as unknown as IncomingMessage;
 assert.equal(localRequest(req),true);setClientAddress(req,'192.168.1.50');assert.equal(localRequest(req),false);setClientAddress(req,'127.0.0.1');assert.equal(localRequest(req),true);
});
