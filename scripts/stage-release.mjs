// The only network mutation here is creating/filling an unpublished draft.
// Published releases, mismatched bytes and unrelated drafts are never replaced.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readReleaseIdentity, readReleaseNotes } from './release-version.mjs';
import { sha256, verifyReleaseSet } from './check-release-set.mjs';

export async function stageRelease({ identity, notes, report, readAsset, api }) {
  assert.ok(identity.tag, 'only a verified tag can create a release draft');
  let object = (await api(`git/ref/tags/${encodeURIComponent(identity.tag)}`)).object;
  for (let depth = 0; object.type === 'tag' && depth < 8; depth++) object = (await api(`git/tags/${object.sha}`)).object;
  assert.equal(object.type, 'commit', 'release tag must resolve to a commit');
  assert.equal(object.sha, identity.revision, 'remote tag must still point at the verified build');
  const marker = `<!-- voidplayer-release:${identity.tag}:${identity.revision} -->`;
  const body = `${notes.trim()}\n\n${marker}\n`;
  // The tag lookup endpoint promises published releases only. List with push
  // credentials so an interrupted draft is found instead of creating another.
  let release;
  for (let page = 1; ; page++) {
    assert.ok(page <= 100, 'release listing limit exceeded');
    const releases = await api(`releases?per_page=100&page=${page}`);
    for (const entry of releases.filter(entry => entry.tag_name === identity.tag)) {
      assert.ok(!release, 'multiple releases use this tag');
      release = entry;
    }
    if (releases.length < 100) break;
  }
  if (release) {
    assert.equal(release.draft, true, 'refuse to modify a published release');
    assert.equal(release.target_commitish, identity.revision, 'draft revision must match');
    assert.equal(release.body, body, 'draft notes and provenance must match');
  }
  const expected = new Map(report.assets.map(asset => [asset.name, asset]));
  // Preflight every existing asset before uploading any missing ones.
  const existing = release ? await api(`releases/${release.id}/assets?per_page=100`) : [];
  for (const asset of existing) {
    const local = expected.get(asset.name);
    assert.ok(local, `unexpected draft asset: ${asset.name}`);
    assert.equal(asset.state, 'uploaded');
    assert.equal(asset.size, local.bytes);
    assert.equal(asset.digest, `sha256:${local.sha256}`, `existing draft asset differs: ${asset.name}`);
  }
  if (!release) release = await api('releases', { method: 'POST', json: { tag_name: identity.tag, target_commitish: identity.revision, name: `VoidPlayer ${identity.version}`, body, draft: true, prerelease: identity.version.includes('-') } });
  for (const asset of report.assets) {
    if (existing.some(item => item.name === asset.name)) continue;
    const bytes = await readAsset(asset.name);
    assert.equal(sha256(bytes), asset.sha256, 'local bytes changed after verification');
    const uploaded = await api(release.upload_url.split('{')[0] + '?name=' + encodeURIComponent(asset.name), { method: 'POST', bytes, contentType: asset.name.endsWith('.gz') ? 'application/gzip' : 'text/plain' });
    assert.equal(uploaded.name, asset.name); assert.equal(uploaded.state, 'uploaded');
    assert.equal(uploaded.size, asset.bytes); assert.equal(uploaded.digest, `sha256:${asset.sha256}`);
  }
  const final = await api(`releases/${release.id}`);
  assert.equal(final.draft, true, 'release stays unpublished');
  assert.equal(final.assets.length, expected.size);
  for (const asset of final.assets) {
    assert.equal(asset.state, 'uploaded');
    assert.equal(asset.digest, `sha256:${expected.get(asset.name)?.sha256}`);
  }
  return final.html_url;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(import.meta.dirname, '..'), directory = path.resolve(process.argv[2] || 'artifacts/release-set');
  const identity = await readReleaseIdentity(root), notes = await readReleaseNotes(root, identity);
  const report = await verifyReleaseSet(directory, identity, { bunVersion: (await readFile(path.join(root, '.bun-version'), 'utf8')).trim(), coreSource: JSON.parse(await readFile(path.join(root, 'scripts/release-core.json'), 'utf8')) });
  const repository = process.env.GITHUB_REPOSITORY;
  assert.match(repository || '', /^[\w.-]+\/[\w.-]+$/);
  assert.ok(process.env.GH_TOKEN, 'GH_TOKEN is required');
  const apiRoot = `${process.env.GITHUB_API_URL || 'https://api.github.com'}/repos/${repository}/`;
  const api = async (endpoint, { method = 'GET', json, bytes, contentType } = {}) => {
    const response = await fetch(endpoint.startsWith('https://') ? endpoint : apiRoot + endpoint, { method, headers: { authorization: `Bearer ${process.env.GH_TOKEN}`, accept: 'application/vnd.github+json', 'content-type': contentType || 'application/json', 'X-GitHub-Api-Version': '2022-11-28' }, body: bytes || (json && JSON.stringify(json)), signal: AbortSignal.timeout(180000) });
    if (!response.ok) throw new Error(`GitHub release API ${method}: HTTP ${response.status}`);
    return response.json();
  };
  console.log('Draft verified:', await stageRelease({ identity, notes, report, readAsset: name => readFile(path.join(directory, name)), api }));
}
