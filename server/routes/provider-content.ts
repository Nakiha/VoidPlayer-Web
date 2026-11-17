import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { IncomingMessage, ServerResponse } from '../http.ts';
import { parseRange } from '../http-utils.ts';
import { readProvider, PROVIDER_BLOCK, type ProviderSource } from '../media-provider.ts';

export async function serveProvider(req: IncomingMessage, res: ServerResponse, source: ProviderSource, version: string, signal: AbortSignal) {
  const {size} = source, range = parseRange(req.headers.range,size);
  const base = {etag:'"' + version + '"', 'content-type':'application/octet-stream', 'cache-control':'no-store', 'accept-ranges':'bytes'};
  if (range === 'unsatisfiable' || (range && !size)) {
    res.writeHead(416,{...base,'content-range':`bytes */${size}`});
    res.end();
    return;
  }
  const {start,end} = range ?? {start:0,end:size-1};
  const headers = {...base,'content-length':end-start+1,...(range ? {'content-range':`bytes ${start}-${end}/${size}`} : {})};
  if (req.method === 'HEAD' || !size) { res.writeHead(range ? 206 : 200,headers); res.end(); return; }
  // Read the first block before committing the HTTP status. Later failures truncate the stream.
  const first = await readProvider(source,start,Math.min(PROVIDER_BLOCK,end-start+1),signal);
  res.writeHead(range ? 206 : 200,headers);
  async function* blocks() {
    yield first;
    for (let at = start + first.length; at <= end; at += PROVIDER_BLOCK)
      yield await readProvider(source,at,Math.min(PROVIDER_BLOCK,end-at+1),signal);
  }
  await pipeline(Readable.from(blocks()),res,{signal});
}
