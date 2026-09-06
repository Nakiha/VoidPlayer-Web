import assert from 'node:assert/strict';
export async function verifySavedWorkspaces(send, media, serverUrl, owner) {
  const headers = { 'content-type': 'application/json', 'x-voidplayer-action': 'workspace' };
  const now = new Date().toISOString();
  const document = {
    schema: 'voidplayer-workspace', version: 1, generatedAt: now, serverUrl, positionUs: 100,
    tracks: [{ slot: 'A', mediaId: 'release-media', offsetUs: 0 }],
    media: [{ id: 'release-media', name: media.name, size: media.size, lastModified: media.lastModified, codec: 'test', decoder: 'webcodecs', width: 100, height: 100, durationUs: 1000000, firstPtsUs: 0, source: { kind: 'library', id: media.id, url: new URL(`/api/media/${media.id}?v=${media.version}`, serverUrl).href } }],
    marks: [{ id: 'release-mark', slot: 'A', mediaId: 'release-media', text: 'Persisted review', severity: 3, origin: 'human', createdAt: now, frame: { ptsUs: 100, sourcePtsUs: 100, durationUs: 1000 }, region: null, comparison: [], drawings: [{ id: 'box', tool: 'rect', color: '#ff3b30', strokeWidth: 4, points: [{ x: .1, y: .1 }, { x: .5, y: .5 }] }] }],
    viewport: { mode: 'side-by-side', arrangement: 'horizontal', splitPos: .5, zoom: 1, offsetX: 0, offsetY: 0, pixelSize: 'uniform' }, thumbnails: [],
  };
  const made = await send('/api/workspaces', { method: 'POST', headers, body: JSON.stringify({ name: 'Released review', document, owner: 'forged' }) });
  assert.equal(made.status, 201, made.body.toString()); const first = JSON.parse(made.body); assert.equal(first.owner, owner); assert.equal(first.revision, 1);
  const changed = { ...document, positionUs: 200 };
  const updated = await send('/api/workspaces/' + first.id, { method: 'PUT', headers: { ...headers, 'if-match': '"1"' }, body: JSON.stringify({ name: 'Updated review', document: changed }) });
  assert.equal(updated.status, 200, updated.body.toString());
  const stale = await send('/api/workspaces/' + first.id, { method: 'DELETE', headers: { ...headers, 'if-match': '"1"' } }); assert.equal(stale.status, 409);
  const expected = { ...JSON.parse(updated.body), document: changed };
  await verifyWorkspaceRestore(send, expected);
  return expected;
}
export async function verifyWorkspaceRestore(send, expected) {
  const read = await send('/api/workspaces/' + expected.id, { method: 'GET', headers: {} }); assert.equal(read.status, 200, read.body.toString()); assert.deepEqual(JSON.parse(read.body), expected);
}
