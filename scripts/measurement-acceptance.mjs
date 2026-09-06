import assert from 'node:assert/strict';
// Run against the actual compiled server (also through the shipped TLS gateway).
// The caller supplies only transport/auth; no measurement implementation is mocked.
export async function verifyMeasurements(send, media) {
  const endpoint = '/api/admin/measurements';
  const request = async (url, method = 'GET', body, binary = false) => {
    const response = await send(url, { method, headers: { ...(method === 'GET' ? {} : { 'x-voidplayer-action': 'admin' }), ...(body === undefined ? {} : { 'content-type': binary ? 'application/octet-stream' : 'application/json' }) }, body: body === undefined ? undefined : binary ? body : JSON.stringify(body) });
    assert.equal(response.status, method === 'POST' && url === endpoint ? 202 : 200, response.body.toString().slice(0, 500)); return response;
  };
  const status = async () => JSON.parse((await request(endpoint)).body).job;
  const wait = async predicate => {
    for (let i = 0; i < 300; i++) { const job = await status(); if (predicate(job)) return job; await new Promise(r => setTimeout(r, 20)); }
    assert.fail('compiled measurement did not settle');
  };
  assert.equal(await status(), null);
  for (const kind of ['download', 'upload', 'storage', 'concurrent']) {
    const { job } = JSON.parse((await request(endpoint, 'POST', { kind, seconds: 5, limitMiB: 64, ...(['storage', 'concurrent'].includes(kind) ? { mediaId: media.id, version: media.version } : {}) })).body);
    if (kind === 'storage') {
      const completed = await wait(value => value.state === 'completed');
      assert.equal(completed.bytes, 64 * 1024 * 1024); assert.equal(completed.reason, 'limit'); assert.equal(completed.errors, 0);
      continue;
    }
    await wait(value => value.state === 'running');
    const at = performance.now();
    const transfers = await Promise.all(Array.from({ length: kind === 'concurrent' ? 4 : 1 }, async () => {
      const response = await request(`${endpoint}/${job.id}/transfer`, 'POST', kind === 'upload' ? Buffer.alloc(1024 * 1024, 57) : undefined, kind === 'upload');
      const bytes = kind === 'upload' ? JSON.parse(response.body).bytes : response.body.length; assert.equal(bytes, Math.min(1024 * 1024, kind === 'concurrent' ? media.size : Infinity)); return bytes;
    }));
    await wait(value => value.activeRequests === 0);
    const finish = JSON.parse((await request(`${endpoint}/${job.id}/finish`, 'POST', { bytes: transfers.reduce((sum, bytes) => sum + bytes, 0), requests: transfers.length, elapsedMs: Math.max(1, performance.now() - at) })).body).job;
    assert.equal(finish.state, 'completed'); assert.equal(finish.errors, 0); assert.ok(finish.client.bytes > 0);
  }
  const { job } = JSON.parse((await request(endpoint, 'POST', { kind: 'download', seconds: 5, limitMiB: 64 })).body);
  assert.equal(JSON.parse((await request(`${endpoint}/${job.id}`, 'DELETE')).body).job.state, 'cancelled');
}
