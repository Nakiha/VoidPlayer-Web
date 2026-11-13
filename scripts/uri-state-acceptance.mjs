import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { emptyUriState } from '../shared/review/uri-state.ts';
export async function verifyUriSharing(send, media, serverUrl, owner) {
  const state = { ...emptyUriState(), tracks: [{ slot: 'A', id: media.id, version: media.version, offsetUs: 0, visible: true }], positionUs: 100 };
  const encoded = await send('/api/uri/encode', { method: 'POST', headers: { 'content-type': 'application/json', 'x-voidplayer-action': 'uri' }, body: JSON.stringify({ state }) });
  assert.equal(encoded.status, 200, encoded.body.toString()); const { token } = JSON.parse(encoded.body);
  const target = 'media-' + createHash('sha256').update(JSON.stringify(['', media.id, media.version])).digest('hex');
  const document = {
    media: [{ id: 'release-media', name: media.name, size: media.size, lastModified: media.lastModified, codec: 'test', decoder: 'webcodecs', width: 100, height: 100, durationUs: 1000000, firstPtsUs: 0, source: { kind: 'library', id: media.id, url: new URL(`/api/media/${media.id}/content?v=${media.version}`, serverUrl).href } }],
    mark: { id: 'release-mark', slot: 'A', mediaId: 'release-media', text: 'Persisted source annotation', severity: 3, origin: 'human', createdAt: new Date().toISOString(), frame: { ptsUs: 100, sourcePtsUs: 100, durationUs: 1000 }, region: null, comparison: [] },
  };
  const operation = { operationId: 'release-annotation', id: document.mark.id, revision: 0, action: 'put', document };
  const response = await send('/api/annotations/media/' + target, { method: 'POST', headers: { 'content-type': 'application/json', 'x-voidplayer-action': 'annotation' }, body: JSON.stringify(operation) });
  assert.equal(response.status, 200, response.body.toString()); const record = JSON.parse(response.body);
  assert.equal(record.document.mark.author.id, owner);
  const expected = { token, state, target, record }; await verifyUriRestore(send, expected); return expected;
}
export async function verifyUriRestore(send, expected) {
  const read = await send('/api/uri/decode?s=' + expected.token, { method: 'GET', headers: {} });
  assert.equal(read.status, 200, read.body.toString()); assert.deepEqual(JSON.parse(read.body).state, expected.state);
  const annotation = await send(`/api/annotations/media/${expected.target}/${expected.record.id}`, { method: 'GET', headers: {} });
  assert.equal(annotation.status, 200, annotation.body.toString()); assert.deepEqual(JSON.parse(annotation.body), expected.record);
}
