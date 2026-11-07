/** Recovery suggestions never authorize a mutation. */
export function agentRecovery(code: string, _operation?: string) {
  const next = (action: string, operations: string[], retry: 'same-operation' | 'explicit-revision' | 'none' = 'none') =>
    ({ action, retry, operations: operations.map(id => '/api/agent/operations/' + id) });
  switch (code) {
    case 'identity-required': return next('Explicitly select an identity and retain its cookie.', ['identity.users', 'identity.select']);
    case 'actor-changed': return next('Keep pending writes bound to the original actor.', ['identity.users']);
    case 'origin-required': return next('Use the exact service Origin, JSON content type and documented action header.', ['identity.select']);
    case 'source-changed': case 'source-version-changed': case 'stale-source': case 'stale-index':
      return next('Browse again and explicitly select the current source version.', ['library.browse'], 'explicit-revision');
    case 'invalid-cursor': return next('Restart from the first page with the same filters.', ['library.browse']);
    case 'operation-id-reused': return next('Compare the original actor, operation ID and body. Do not replace an uncertain operation.', []);
    case 'storage-unavailable': return next('This deployment cannot persist the request. Check its storage configuration.', []);
    default: return next('Read the operation guide and retain the original request and response.', []);
  }
}
