// Standalone Node 24+ reference implementation of the read-only media provider protocol.
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const fail = status => Object.assign(new Error(),{status});
const revision = s => createHash('sha256').update([s.dev,s.ino,s.size,s.mtimeNs,s.ctimeNs].join(':')).digest('base64url');
const description = (objectId,s) => ({objectId, revision:revision(s), size:Number(s.size), lastModified:Number(s.mtimeMs)});
const json = (res,body) => { res.writeHead(200,{'content-type':'application/json'}); res.end(JSON.stringify(body)); };

export async function createFileProvider(directory,{token} = {}) {
  const root = await realpath(directory);
  async function location(key) {
    if (typeof key !== 'string' || key.includes('\\') || key.includes('\0') || (key && key.split('/').some(p => !p || p.startsWith('.'))))
      throw fail(400);
    const file = path.resolve(root,key);
    const relative = path.relative(root,file);
    if (relative === '..' || relative.startsWith('..'+path.sep) || path.isAbsolute(relative) || await realpath(file) !== file) throw fail(404);
    return file;
  }
  async function list(res,params) {
    const directory = params.get('directory'), limit = Number(params.get('limit'));
    if (!Number.isInteger(limit) || limit < 1 || limit > 128) throw fail(400);
    const file = await location(directory);
    const before = revision(await stat(file,{bigint:true}));
    const children = (await readdir(file,{withFileTypes:true}))
      .filter(e => !e.name.startsWith('.') && e.name.length <= 255 && !/[\\\x00-\x1f]/.test(e.name) && (e.isDirectory() || e.isFile()))
      .sort((a,b) => a.name < b.name ? -1 : Number(a.name > b.name));
    let offset = 0;
    if (params.has('cursor')) {
      const [snapshot,position] = params.get('cursor').split('.');
      offset = Number(position);
      if (!Number.isSafeInteger(offset) || offset < 0 || snapshot !== before) throw fail(409);
    }
    const entries = await Promise.all(children.slice(offset,offset+limit).map(async e => {
      if (e.isDirectory()) return {kind:'directory',name:e.name};
      const objectId = directory ? directory + '/' + e.name : e.name;
      return {kind:'file',name:e.name,...description(objectId,await stat(await location(objectId),{bigint:true}))};
    }));
    if (revision(await stat(await location(directory),{bigint:true})) !== before) throw fail(409);
    const next = offset + entries.length;
    json(res,{entries,nextCursor:next < children.length ? before + '.' + next : null});
  }
  async function object(req,res,params,content) {
    const objectId = params.get('objectId'), file = await location(objectId);
    const handle = await open(file,constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const opened = await handle.stat({bigint:true});
      if (!opened.isFile()) throw fail(404);
      const meta = description(objectId,opened), tag = '"' + meta.revision + '"';
      const verify = async () => {
        if (revision(await stat(await location(objectId),{bigint:true})) !== meta.revision
          || revision(await handle.stat({bigint:true})) !== meta.revision) throw fail(412);
      };
      await verify();
      if (!content) { json(res,meta); return; }
      if (req.headers['if-match'] !== tag) throw fail(412);
      const range = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range ?? '');
      if (!range) throw fail(416);
      const start = Number(range[1]), end = Number(range[2]), length = end-start+1;
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || length <= 0 || length > 1048576 || end >= meta.size) throw fail(416);
      const bytes = Buffer.alloc(length);
      for (let filled = 0; filled < length;) {
        if (res.destroyed) return;
        const {bytesRead} = await handle.read(bytes,filled,length-filled,start+filled);
        if (!bytesRead) throw fail(412);
        filled += bytesRead;
      }
      await verify();
      res.writeHead(206,{'content-type':'application/octet-stream',etag:tag,'content-length':length,
        'content-range':`bytes ${start}-${end}/${meta.size}`});
      res.end(bytes);
    } finally { await handle.close(); }
  }
  return createServer(async (req,res) => {
    try {
      if (token && req.headers.authorization !== 'Bearer ' + token) throw fail(401);
      if (req.method !== 'GET') throw fail(405);
      const url = new URL(req.url,'http://localhost');
      switch (url.pathname) {
        case '/v1/list': await list(res,url.searchParams); break;
        case '/v1/stat': await object(req,res,url.searchParams,false); break;
        case '/v1/content': await object(req,res,url.searchParams,true); break;
        default: throw fail(404);
      }
    } catch (error) {
      if (!res.destroyed) {
        res.writeHead(error.status ?? (error.code === 'ENOENT' || error.code === 'ENOTDIR' ? 404 : 503));
        res.end();
      }
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (!process.argv[2]) throw new Error('Usage: node server.mjs DIRECTORY [PORT]');
  const server = await createFileProvider(process.argv[2],{token:process.env.PROVIDER_TOKEN});
  server.listen(Number(process.argv[3] ?? 5191),'127.0.0.1',() => console.log('http://127.0.0.1:' + server.address().port));
}
