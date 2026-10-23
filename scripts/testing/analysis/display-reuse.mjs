import assert from 'node:assert/strict';

/** Health polling is independent of cached block rendering. Every other
 * request stays forbidden, including analysis polling, assets and media reads. */
export function assertCachedDisplayReuse(requests, baseline, pageUrl, beforeState, afterState) {
  const healthUrl = new URL('/api/health', pageUrl).href;
  const added = requests.slice(baseline);
  const health = added.filter(request => request.method === 'GET' && request.url === healthUrl);
  const unexpected = added.filter(request => !(request.method === 'GET' && request.url === healthUrl));
  const evidence = { before: baseline, after: requests.length, health, unexpected,
    preceding: requests.slice(Math.max(0, baseline - 4), baseline) };
  assert.equal(unexpected.length, 0, 'display switches and hover reuse the existing block data; ' + JSON.stringify(evidence));
  assert.deepEqual(afterState, beforeState, 'display switches and hover start no analysis task or core work');
  return evidence;
}
