// Acceptance helpers used by the extracted native-release browser harness.
import assert from 'node:assert/strict';
import { readFile, rename, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { sha256 } from './check-release-set.mjs';

export async function generatedLibrary(directory) {
  directory = path.resolve(directory);
  const fixture = JSON.parse(await readFile(path.join(directory, 'fixture.json'), 'utf8'));
  assert.equal(fixture.schema, 'voidplayer-generated-library'); assert.equal(fixture.version, 1);
  const safePath = value => {
    assert.ok(typeof value === 'string' && value && !path.isAbsolute(value) && !value.split(/[\\/]/).some(p => p === '..' || p === '.'));
    return path.join(directory, value);
  };
  const roots = fixture.roots.map(r => ({ ...r, path: safePath(r.path) }));
  for (const entry of fixture.entries) {
    const root = roots.find(r => r.id === entry.rootId); assert.ok(root);
    safePath(entry.name);
    const bytes = await readFile(path.join(root.path, entry.name));
    assert.equal(bytes.length, entry.size); assert.equal(sha256(bytes), entry.sha256, entry.name);
  }
  let base, selected, offline = false;
  const rootToMove = roots.find(r => r.id === fixture.playback[0].rootId);
  async function json(route, options) {
    const response = await fetch(base + route, { signal: AbortSignal.timeout(10000), ...options });
    assert.ok(response.ok, `${response.status} ${route}`); return response.json();
  }
  async function idle() {
    for (let i = 0; i < 1200; i++) {
      const state = await json('/api/library/scan');
      if (state.ready && !state.scanning && !state.queuedDirectories) return state;
      await new Promise(r => setTimeout(r, 50));
    }
    throw new Error('generated library scan timeout');
  }
  async function refresh() {
    return json('/api/library/scan?action=refresh', { method: 'POST', headers: { Origin: base, 'x-voidplayer-action': 'scan' } });
  }
  async function range(entry, start = 0) {
    const expected = fixture.entries.find(e => e.rootId === entry.rootId && e.name === entry.name); assert.ok(expected);
    const root = roots.find(r => r.id === entry.rootId);
    const bytes = await readFile(path.join(root.path, entry.name)), end = Math.min(start + 4095, bytes.length - 1);
    const response = await fetch(`${base}/api/media/${entry.id}?v=${entry.version}`, { headers: { Range: `bytes=${start}-${end}` }, signal: AbortSignal.timeout(10000) });
    assert.equal(response.status, 206); assert.equal(response.headers.get('content-range'), `bytes ${start}-${end}/${bytes.length}`);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes.subarray(start, end + 1));
  }
  return {
    roots, playback: fixture.playback,
    async verify(url) {
      base = url;
      const state = await idle(); assert.ok(state.roots.every(r => r.state === 'ready'), JSON.stringify(state));
      const found = [], expected = new Map(fixture.entries.map(e => [`${e.rootId}/${e.name}`, e]));
      let offset = 0, revision;
      do {
        const page = await json(`/api/library/browse?recursive=1&limit=200&offset=${offset}${revision === undefined ? '' : `&revision=${revision}`}`);
        assert.equal(page.total, fixture.entries.length); assert.ok(page.entries.length <= 200);
        revision = page.revision; found.push(...page.entries); offset = page.nextOffset;
      } while (offset !== null);
      assert.equal(found.length, expected.size); assert.equal(new Set(found.map(e => e.id)).size, expected.size);
      for (const entry of found) { const match = expected.get(`${entry.rootId}/${entry.name}`); assert.ok(match, entry.name); assert.equal(entry.size, match.size); }
      const sameNames = found.filter(e => e.name === 'same-name.mp4'); assert.equal(sameNames.length, 3); assert.equal(new Set(sameNames.map(e => e.id)).size, 3);
      for (const root of roots) {
        const folders = await json(`/api/library/browse?root=${root.id}&limit=200`);
        assert.ok(folders.directories.some(d => d.name === '分页目录'));
        const page = await json(`/api/library/browse?root=${root.id}&directory=${encodeURIComponent('分页目录')}&limit=200`);
        assert.equal(page.total, 260); assert.equal(page.entries.length, 200); assert.equal(page.nextOffset, 200);
        const tail = await json(`/api/library/browse?root=${root.id}&directory=${encodeURIComponent('分页目录')}&limit=200&offset=200&revision=${page.revision}`);
        assert.equal(tail.entries.length, 60);
      }
      const deep = await json('/api/library/browse?root=archive&recursive=1&search=level-12'); assert.equal(deep.entries.length, 1);
      selected = fixture.playback.map(p => found.find(e => e.rootId === p.rootId && e.name === p.name)); assert.ok(selected.every(Boolean));
      // Assert that actual Range work overlaps a scan, not just runs after it.
      assert.equal((await refresh()).scanning, true);
      let duringScan = 0, rounds = 0;
      const start = performance.now();
      do {
        const scanning = (await json('/api/library/scan')).scanning;
        await Promise.all([...selected, ...sameNames.slice(0, 2)].map((entry, i) => range(entry, i * 97)));
        if (scanning) duringScan++;
        rounds++;
        if (!scanning) break;
      } while (rounds < 100);
      assert.ok(duringScan > 0, 'Range requests must overlap scanning'); await idle();
      console.log(`PASS generated library: ${found.length} exact indexed paths, 3 roots, 12 levels, 260-item folder pagination, duplicate names, ${rounds * 4} byte-exact parallel Ranges (${duringScan} rounds during scan, ${Math.round(performance.now() - start)} ms)`);
      return selected;
    },
    async disconnect() {
      await rename(rootToMove.path, rootToMove.path + '.offline'); offline = true;
      await refresh(); await this.verifyOffline();
    },
    async verifyOffline() {
      const state = await idle(); assert.equal(state.roots.find(r => r.id === rootToMove.id).state, 'offline');
      const cached = await json(`/api/library/browse?root=${rootToMove.id}&recursive=1&search=level-12`);
      assert.equal(cached.entries[0].id, selected[0].id);
      assert.equal((await fetch(`${base}/api/media/${selected[0].id}?v=${selected[0].version}`)).status, 404);
      await range(selected[1]); // Other roots remain readable during the outage.
    },
    async reconnect() {
      if (offline) { await rename(rootToMove.path + '.offline', rootToMove.path); offline = false; }
      await refresh(); const state = await idle(); assert.ok(state.roots.every(r => r.state === 'ready'));
      for (const entry of selected) await range(entry);
      console.log('PASS generated library: unavailable root retains IDs, other roots serve media, restart while offline and reconnect preserve versioned references');
    },
    async replacement() {
      const entry = selected[0], file = path.join(rootToMove.path, entry.name);
      const original = fixture.entries.find(e => e.rootId === entry.rootId && e.name === entry.name);
      try {
        await copyFile(safePath('masters/h264-1.mp4'), file); await refresh(); await idle();
        const changed = (await json('/api/library/browse?root=archive&recursive=1&search=level-12')).entries[0];
        assert.equal(changed.id, entry.id); assert.notEqual(changed.version, entry.version);
        assert.equal((await fetch(`${base}/api/media/${entry.id}?v=${entry.version}`)).status, 409);
        console.log('PASS generated library: replacement preserves media ID and rejects stale version URL');
      } finally { await copyFile(safePath('masters/' + original.master), file); }
    },
    async cleanup() { if (offline) { await rename(rootToMove.path + '.offline', rootToMove.path); offline = false; } },
  };
}
