/** Public recovery facts. These are suggestions, never authorization to execute. */
export function agentRecovery(code:string,operation?:string){
  const next=(action:string,operations:string[],retry:'same-operation'|'explicit-revision'|'none'='none')=>({action,retry,operations:operations.map(id=>'/api/agent/operations/'+id)});
  switch(code){
    case 'identity-required':return next('Explicitly select an identity, then retain its cookie and capture its actor ID.',['identity.users','identity.select']);
    case 'actor-changed':return next('Stop. Keep pending writes bound to the original actor; do not replay them as the new actor.',['identity.users']);
    case 'origin-required':return next('Use the exact service Origin, JSON content type and the documented action header. Do not weaken the server policy.',['identity.select']);
    case 'cache-miss':case 'index-not-ready':case 'quality-index-required':return next('Read source discovery; a quality-index preparation requires explicit write permission. Metadata alone is insufficient.',['library.describe','library.prepare']);
    case 'source-changed':case 'source-version-changed':case 'stale-source':case 'stale-index':return next('Stop. Re-discover facts, then require an explicit revised source selection, relation and cache-pinned plan.',['library.describe','quality.source','plan.create'],'explicit-revision');
    case 'discovery-snapshot-changed':case 'invalid-cursor':return next('Restart the first page with the same filters, limit and actor. This does not authorize any mutation.',['library.discover','single.history']);
    case 'component-unavailable':case 'unsupported-platform':{const metric=operation?.startsWith('xpsnr.')?'xpsnr':'vmaf';return next(`Native ${metric.toUpperCase()} is unavailable. Keep the requested metric unchanged; explicitly choose another task if desired.`,[metric+'.capability','single.submit']);}
    case 'preparation-storage-unavailable':case 'quality-storage-unavailable':case 'storage-unavailable':return next('This deployment cannot persist the requested work. Read discovery or use an explicitly configured persistent deployment.',['library.discover']);
    case 'idempotency-conflict':case 'operation-id-reused':case 'publication-conflict':return next('Compare the frozen original actor, body and key/policy. Never choose a new key to escape an uncertain result.',['single.history','library.preparations']);
    case 'service-restarted':case 'interrupted':return next('Read the original durable record and receipt. No automatic recomputation; a new attempt needs explicit authorization.',['library.preparations','single.history']);
    default:return next('Read the operation guide and original durable record. Unknown errors do not authorize retry, preparation, metric substitution or publication.',[]);
  }
}
