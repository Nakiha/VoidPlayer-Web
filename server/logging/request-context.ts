import type {IncomingMessage} from '../http.ts';
import type {MediaLibraryIndex} from '../library.ts';

const QUERY_KEYS = new Set(['root','directory','search','recursive','limit','offset','revision','v','kind','stream','schema',
  'indexer','view','axis','startTick','endTick','after','buildId','recipe','download','page','pageSize','pack','au']);
export function requestContext(req:IncomingMessage, library:MediaLibraryIndex) {
  let url:URL;
  try {url=new URL(req.url ?? '/', 'http://localhost');}
  catch {return {url:'invalid-request-target'};}
  const query:Record<string,string> = {};
  for (const [key,value] of url.searchParams) if (QUERY_KEYS.has(key)) query[key] = value.slice(0,key === 'directory'?1024:300);
  const id = /^\/api\/media\/([0-9a-f]{24})(?:\/|$)/.exec(url.pathname)?.[1];
  let entry:ReturnType<MediaLibraryIndex['describe']>=null;
  try {if(id)entry=library.describe(id);} catch { /* Logging also works while the store is shutting down. */ }
  const range = typeof req.headers.range === 'string' && /^bytes=\d*-\d*$/.test(req.headers.range) ? req.headers.range.slice(0,80) : undefined;
  return {url:url.pathname,...(Object.keys(query).length?{query}:{}),...(id?{media:{id,
    ...(entry?{rootId:entry.rootId,root:entry.root,path:entry.name,version:entry.version}:{}),
    ...(query.v?{requestedVersion:query.v}:{})}}:{}),...(range?{range}:{})};
}
