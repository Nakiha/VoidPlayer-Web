// Standalone black-box client. "verify" only reads the configured endpoint.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const fixture = 'voidplayer-provider-check';
const sample = '样片 + %.mp4', sibling = 'another.mp4';
const bytes = replaced => Buffer.from(Array.from({length:8193},(_,i) => (i * 17 + (replaced ? 37 : 1)) & 255));
const [command,target,previous] = process.argv.slice(2);
if (command === 'prepare') {
  const dir = path.join(target,fixture);
  await mkdir(dir);
  await writeFile(path.join(dir,sample),bytes(false),{flag:'wx'});
  await writeFile(path.join(dir,sibling),'second fixture',{flag:'wx'});
  console.log('Created ' + dir);
} else if (command === 'replace') {
  const file = path.join(target,fixture,sample);
  assert.deepEqual(await readFile(file),bytes(false),'replace only operates on the original verification fixture');
  await writeFile(file,bytes(true));
} else if (command === 'verify' || command === 'verify-replaced') {
  const replaced = command === 'verify-replaced';
  if (replaced && !previous) throw new Error('Supply the previous revision printed by verify');
  const headers = process.env.PROVIDER_TOKEN ? {authorization:'Bearer ' + process.env.PROVIDER_TOKEN} : {};
  async function get(op,params,extra = {}) {
    const url = new URL(target.replace(/\/+$/,'')+'/v1/'+op);
    url.search = new URLSearchParams(params);
    return fetch(url,{headers:{...headers,...extra},redirect:'error',signal:AbortSignal.timeout(15000)});
  }
  async function list(directory,limit,match) {
    const seen = new Set(), names = new Set(), entries = [];
    let cursor;
    do {
      const res = await get('list',{directory,limit,...(cursor ? {cursor} : {})});
      assert.equal(res.status,200,'list ' + directory);
      const page = await res.json();
      assert.ok(Array.isArray(page.entries) && page.entries.length <= limit,'list page limit');
      for (const e of page.entries) {
        assert.ok(!names.has(e.name),'duplicate directory entry');
        names.add(e.name); entries.push(e);
      }
      if (match && page.entries.some(match)) return entries;
      cursor = page.nextCursor;
      assert.ok(cursor === null || (typeof cursor === 'string' && cursor && page.entries.length && !seen.has(cursor)),'invalid continuation');
      seen.add(cursor);
    } while (cursor !== null);
    return entries;
  }
  const isFixture = e => e.kind === 'directory' && e.name === fixture;
  assert.ok((await list('',128,isFixture)).some(isFixture),'fixture directory must be listed');
  const files = await list(fixture,1);
  assert.deepEqual(files.map(e => e.name).sort(),[sample,sibling].sort(),'directory pagination');
  const entry = files.find(e => e.name === sample);
  assert.equal(entry.kind,'file');
  const params = {objectId:entry.objectId}, meta = await get('stat',params);
  assert.equal(meta.status,200,'stat');
  const file = await meta.json(), expected = bytes(replaced);
  for (const key of ['objectId','size','revision','lastModified']) assert.equal(file[key],entry[key],'list/stat ' + key);
  assert.equal(file.size,expected.length);
  assert.match(file.revision,/^[A-Za-z0-9_-]{1,512}$/);
  const tag = '"' + file.revision + '"';
  for (const [start,end] of [[0,0],[129,444],[file.size-17,file.size-1]]) {
    const part = await get('content',params,{range:`bytes=${start}-${end}`,'if-match':tag});
    assert.equal(part.status,206,'range status');
    assert.equal(part.headers.get('etag'),tag,'revision echo');
    assert.equal(part.headers.get('content-range'),`bytes ${start}-${end}/${file.size}`);
    assert.deepEqual(Buffer.from(await part.arrayBuffer()),expected.subarray(start,end+1),'range bytes');
  }
  const stale = replaced ? previous : (file.revision === 'absent' ? 'other' : 'absent');
  assert.notEqual(stale,file.revision,'replacement must change the revision');
  const mismatch = await get('content',params,{range:'bytes=0-0','if-match':'"' + stale + '"'});
  assert.equal(mismatch.status,412,'stale revision must fail before bytes are served');
  await mismatch.body?.cancel();
  const outside = await get('content',params,{range:`bytes=${file.size}-${file.size}`,'if-match':tag});
  assert.equal(outside.status,416,'out-of-bounds range');
  await outside.body?.cancel();
  console.log('PASS revision=' + file.revision);
} else {
  throw new Error('Usage: node check.mjs prepare|replace DIRECTORY, verify ENDPOINT, or verify-replaced ENDPOINT OLD_REVISION');
}
