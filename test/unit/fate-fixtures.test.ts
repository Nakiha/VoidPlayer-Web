import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fateManifest, readFateManifests, syncFateFixtures, type ManifestDocument } from '../../scripts/testing/fate-fixtures.ts';
import { downloadPinnedSample } from '../../scripts/testing/pinned-download.ts';

const bodies = [Buffer.from('fixed FATE bytes'), Buffer.from('timestamp sample')];
const documents: ManifestDocument[] = ['fate-samples.json','fate-timestamp-samples.json'].map((name, i) => ({name,
  text: JSON.stringify([{file:`sample-${i}.bin`,url:`https://fate-suite.ffmpeg.org/test/${i}`,
    size:bodies[i].length,sha256:createHash('sha256').update(bodies[i]).digest('hex')}])}));
async function fixture(t: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'fate-fixtures-'));
  t.after(() => rm(directory, {recursive:true,force:true})); return directory;
}
const neverDownload = async () => assert.fail('verified cache must not access the network');

test('manifest key covers both complete documents and CLI uses the same validated key', async () => {
  const key = fateManifest(documents).key;
  assert.match(key, /^fate-v1-[a-f0-9]{64}$/);
  assert.equal(fateManifest(structuredClone(documents)).key,key);
  for (const index of [0,1]) {
    const changed = structuredClone(documents); changed[index].text += '\n';
    assert.notEqual(fateManifest(changed).key,key);
  }
  const actual = await readFateManifests();
  assert.equal(execFileSync(process.execPath,['scripts/sync-fate-samples.mjs','--cache-key'],{encoding:'utf8'}).trim(), fateManifest(actual).key);
  for (const patch of [{file:'../escape'}, {url:'https://example.invalid/file'}, {size:0}, {sha256:'bad'}]) {
    const changed = structuredClone(documents), entries = JSON.parse(changed[0].text);
    Object.assign(entries[0],patch); changed[0].text=JSON.stringify(entries);
    assert.throws(() => fateManifest(changed), /Invalid|official/);
  }
  assert.throws(() => fateManifest([documents[1],documents[0]]), /ordered/);
  const duplicated=structuredClone(documents); duplicated[1].text=duplicated[0].text;
  assert.throws(() => fateManifest(duplicated), /duplicate/);
});

test('complete valid cache and verification-only mode never fetch; each file is checked', async t => {
  const directory=await fixture(t);
  for (let i=0;i<2;i++) await writeFile(join(directory,`sample-${i}.bin`),bodies[i]);
  for (const verifyOnly of [false,true]) assert.deepEqual(await syncFateFixtures(directory,documents,{verifyOnly,download:neverDownload}),
    {key:fateManifest(documents).key,verified:2,cached:2,downloaded:0});
  await writeFile(join(directory,'sample-1.bin'),Buffer.alloc(bodies[1].length));
  await assert.rejects(syncFateFixtures(directory,documents,{download:neverDownload}), /sample-1.bin.*SHA-256/);
});

test('missing cache files use only pinned official requests and validate before atomic install', async t => {
  const directory=await fixture(t), requests:string[]=[];
  const result=await syncFateFixtures(directory,documents,{download:sample=>downloadPinnedSample(sample,{
    fetchImpl:async url=>{requests.push(String(url));return new Response(bodies[Number(String(url).split('/').at(-1))]);},
    wait:async()=>assert.fail('no retry required')})});
  assert.deepEqual(requests,['https://fate-suite.ffmpeg.org/test/0','https://fate-suite.ffmpeg.org/test/1']);
  assert.deepEqual(result,{key:fateManifest(documents).key,verified:2,cached:0,downloaded:2});
  assert.deepEqual((await readdir(directory)).sort(),['sample-0.bin','sample-1.bin']);
  for(let i=0;i<2;i++) assert.deepEqual(await readFile(join(directory,`sample-${i}.bin`)),bodies[i]);
  await rm(join(directory,'sample-1.bin')); requests.length=0;
  const partial=await syncFateFixtures(directory,documents,{download:async sample=>{requests.push(sample.url);return bodies[1];}});
  assert.equal(partial.cached,1);assert.equal(partial.downloaded,1);assert.equal(requests.length,1);
});

test('corruption anywhere fails before fetching missing entries and never silently repairs', async t => {
  for (const bytes of [Buffer.alloc(bodies[1].length),bodies[1].subarray(1)]) {
    const directory=await fixture(t);await writeFile(join(directory,'sample-1.bin'),bytes);
    await assert.rejects(syncFateFixtures(directory,documents,{download:neverDownload}), /sample-1.bin.*(?:size|SHA-256)/);
    assert.deepEqual(await readFile(join(directory,'sample-1.bin')),bytes);
    assert.deepEqual(await readdir(directory),['sample-1.bin']);
  }
  // A matching digest cannot compensate for a wrong manifest byte count.
  const directory=await fixture(t);await writeFile(join(directory,'sample-0.bin'),bodies[0]);
  const changed=structuredClone(documents),entry=JSON.parse(changed[0].text);entry[0].size++;changed[0].text=JSON.stringify(entry);
  await assert.rejects(syncFateFixtures(directory,changed,{download:neverDownload}), /size mismatch/);
});

test('failed downloads and verify-only misses cannot leave a usable cache or partial file', async t => {
  for(const download of [async()=>Buffer.from('changed'),async()=>{throw new TypeError('official source unavailable');}]) {
    const directory=await fixture(t);
    await assert.rejects(syncFateFixtures(directory,documents,{download}), /mismatch|unavailable/);
    assert.deepEqual(await readdir(directory),[]);
  }
  const directory=await fixture(t);
  await assert.rejects(syncFateFixtures(directory,documents,{verifyOnly:true,download:neverDownload}), /missing pinned/);
});

test('nonregular files and a redirected cache directory are rejected', async t => {
  const directory=await fixture(t);await mkdir(join(directory,'sample-0.bin'));
  await assert.rejects(syncFateFixtures(directory,documents,{download:neverDownload}), /regular FATE file/);
  const target=join(directory,'target'),link=join(directory,'redirect');await mkdir(target);
  await symlink(target,link,'junction');
  await assert.rejects(syncFateFixtures(link,documents,{download:neverDownload}), /regular FATE directory/);
});
