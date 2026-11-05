import test from 'node:test';
import assert from 'node:assert/strict';
import { connect, constants } from 'node:http2';
import type { ClientHttp2Session, IncomingHttpHeaders, OutgoingHttpHeaders } from 'node:http2';
import { mkdtemp, mkdir, writeFile, rm, utimes } from 'node:fs/promises';
import { tmpdir, networkInterfaces } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { prepareTls } from '../../server/tls.ts';
import { requestAuthority } from '../../server/http.ts';
import type { IncomingMessage } from '../../server/http.ts';
import { createRequestServer, ProtocolGateway } from '../../server/protocol-server.ts';
import { localRequest, setClientAddress } from '../../server/reveal.ts';
import { serveFile } from '../../server/http-utils.ts';
import { sendMediaIndexStream } from '../../server/routes/index-stream.ts';
import { loadConfig } from '../../server/config.ts';
import { startService } from '../../server/runtime.ts';
import { httpFetch } from '../http-request.ts';

function read(client: ClientHttp2Session, url: string, headers: OutgoingHttpHeaders = {}, body?: string) {
  return new Promise<{ status: number; headers: IncomingHttpHeaders; bytes: Buffer; json(): any }>((resolve, reject) => {
    const request = client.request({ ':path': url, ...headers }), chunks: Buffer[] = [];
    let reply: IncomingHttpHeaders;
    request.once('response', value => { reply = value; });
    request.on('data', bytes => chunks.push(typeof bytes === 'string' ? Buffer.from(bytes) : bytes));
    request.once('error', reject);
    request.once('end', () => {
      const bytes = Buffer.concat(chunks);
      resolve({ status: Number(reply[':status']), headers: reply, bytes, json: () => JSON.parse(bytes.toString()) });
    });
    request.end(body);
  });
}

test('request authority normalizes both protocols and rejects conflicting or malformed targets', () => {
  const authority = (headers: Record<string, unknown>, encrypted = true) => requestAuthority({ headers, socket: { encrypted } } as IncomingMessage);
  assert.equal(authority({ host: 'LOCALHOST:443' }), 'localhost');
  assert.equal(authority({ ':authority': '[::1]:8443' }), '[::1]:8443');
  assert.equal(authority({ ':authority': 'LOCALHOST:443', host: 'localhost' }), 'localhost');
  assert.equal(authority({ host: 'localhost:80' }, false), 'localhost');
  for (const value of ['', 'user@localhost', 'localhost/path', 'localhost?x', 'localhost#x', 'localhost,other', ' localhost', 'localhost\\x']) {
    assert.equal(authority({ ':authority': value }), undefined);
  }
  assert.equal(authority({ ':authority': 'other.test', host: 'localhost' }), undefined);
  assert.equal(authority({ origin: 'https://localhost', 'x-forwarded-host': 'localhost' }), undefined);
});

test('HTTP/2 through the production gateway supports identity writes, Range/HEAD and HTTP/1.1 fallback', { timeout: 20000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'vp-h2-runtime-'));
  let service: Awaited<ReturnType<typeof startService>> | undefined, client: ClientHttp2Session | undefined;
  try {
    await mkdir(path.join(root, 'media'));
    await mkdir(path.join(root, 'dist'));
    await writeFile(path.join(root, 'dist/index.html'), 'VoidPlayer HTTP/2');
    await writeFile(path.join(root, 'media/clip.mp4'), '0123456789');
    await utimes(path.join(root, 'media/clip.mp4'), 1, 1);
    const config = await loadConfig(['--https', 'voidplayer.test', '--folder', path.join(root, 'media'),
      '--static', path.join(root, 'dist'), '--no-logs'], 'production', root, { dataDir: path.join(root, 'data') });
    Object.assign(config, { host: '127.0.0.1', port: 0, httpPort: null, indexWatch: false });
    service = await startService(config);
    const port = (service.server.address() as { port: number }).port, host = `voidplayer.test:${port}`;
    const base = `https://127.0.0.1:${port}`, ca = service.tls!.ca!;
    assert.equal((await httpFetch(base + '/api/health', { ca })).status, 200, 'TLS HTTP/1.1 clients remain supported');
    assert.equal((await httpFetch(`http://127.0.0.1:${port}/api/health`)).status, 200, 'plain HTTP still shares the port');
    client = connect(base, { ca });
    await once(client, 'connect');
    assert.equal(client.alpnProtocol, 'h2');
    const get = (url: string, headers: OutgoingHttpHeaders = {}, body?: string) => read(client!, url, { ':authority': host, ...headers }, body);
    const health = await get('/api/health');
    assert.equal(health.status, 200);
    assert.equal(health.headers['cross-origin-embedder-policy'], 'require-corp');
    const write = (origin: string) => get('/api/identity', { ':method': 'POST', origin,
      'x-voidplayer-action': 'identity', 'content-type': 'application/json' }, JSON.stringify({ name: 'HTTP2 user' }));
    const identity = await write(`https://${host}`);
    assert.equal(identity.status, 200, 'a DATA body without Content-Length is read correctly');
    const cookie = identity.headers['set-cookie']![0];
    assert.match(cookie, /; Secure/);
    assert.equal((await get('/api/health', { cookie: cookie.split(';')[0] })).json().actor.id, identity.json().actor.id);
    assert.equal((await write(`http://${host}`)).status, 403);
    assert.equal((await write('https://other.test')).status, 403);
    assert.equal((await get('/api/health', { host: 'localhost' })).status, 400, 'Host cannot override a conflicting :authority');
    const listing = await service.library.list(), media = '/api/media/' + listing.entries[0].id;
    const range = await get(media, { range: 'bytes=2-5' });
    assert.equal(range.status, 206);
    assert.equal(range.headers['content-range'], 'bytes 2-5/10');
    assert.equal(range.bytes.toString(), '2345');
    const head = await get(media, { ':method': 'HEAD' });
    assert.equal(head.status, 200); assert.equal(head.bytes.length, 0); assert.equal(head.headers['content-length'], '10');
    assert.equal((await get(media, { range: 'bytes=100-200' })).status, 416);
    const capabilities = (await get('/api/agent')).json().capabilities;
    assert.equal(capabilities.find((c: { id: string }) => c.id === 'bridge.local-mcp').enabled, false);
    const adminHeaders = { cookie: cookie.split(';')[0], origin: `https://${host}`, 'x-voidplayer-action': 'admin' };
    const measurement = '/api/admin/measurements';
    const start = async (kind: string) => {
      const response = await get(measurement, { ...adminHeaders, ':method': 'POST', 'content-type': 'application/json' },
        JSON.stringify({ kind, seconds: 5, limitMiB: 64 }));
      assert.equal(response.status, 202);
      for (let i = 0; i < 100; i++) {
        const job = (await get(measurement, adminHeaders)).json().job;
        if (job.state === 'running') return job.id as string;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      throw new Error('Measurement did not become ready');
    };
    const downloadId = await start('download'), transfer = `${measurement}/${downloadId}/transfer`;
    assert.equal((await get(transfer, { ...adminHeaders, ':method': 'POST' })).bytes.length, 1024 * 1024,
      'an empty DATA frame is accepted without Content-Length');
    assert.equal((await get(transfer, { ...adminHeaders, ':method': 'POST' }, 'unexpected body')).status, 400,
      'nonempty DATA cannot bypass the no-body download contract');
    assert.equal((await get('/api/health')).status, 200);
    await get(`${measurement}/${downloadId}`, { ...adminHeaders, ':method': 'DELETE' });
    const uploadId = await start('upload');
    const upload = await get(`${measurement}/${uploadId}/transfer`, { ...adminHeaders, ':method': 'POST',
      'content-type': 'application/octet-stream', 'content-length': '4' }, 'data');
    assert.equal(upload.status, 200); assert.equal(upload.json().bytes, 4);
    await get(`${measurement}/${uploadId}`, { ...adminHeaders, ':method': 'DELETE' });
    const closed = once(client, 'close');
    await service.close();
    await closed;
    client = undefined;
  } finally {
    client?.destroy();
    await service?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('HTTP/2 retains the gateway peer instead of trusting loopback or forwarded request claims', { timeout: 15000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'vp-h2-peer-')), gateway = new ProtocolGateway();
  const address = Object.values(networkInterfaces()).flat().find(n => n?.family === 'IPv4' && !n.internal)?.address ?? '127.0.0.1';
  let client: ClientHttp2Session | undefined;
  const tls = await prepareTls({ hosts: ['127.0.0.1'] }, root);
  const backend = createRequestServer(tls, (req, res) => {
    setClientAddress(req, gateway.clientAddress(req));
    res.end(JSON.stringify({ peer: gateway.clientAddress(req), authority: requestAuthority(req), local: localRequest(req) }));
  });
  await new Promise<void>(resolve => backend.listen(0, '127.0.0.1', resolve));
  const port = (backend.address() as { port: number }).port, front = gateway.create(port, port);
  await new Promise<void>(resolve => front.listen(0, address, resolve));
  try {
    client = connect(`https://${address}:${(front.address() as { port: number }).port}`, { ca: tls.ca, servername: 'localhost' });
    const value = await read(client, '/', { ':authority': 'localhost', 'x-forwarded-for': '127.0.0.1' });
    assert.deepEqual(value.json(), { peer: address, authority: 'localhost', local: address === '127.0.0.1' });
  } finally {
    client?.destroy();
    front.closeAllConnections(); backend.closeAllConnections();
    await Promise.all([front, backend].map(server => new Promise<void>(resolve => server.close(() => resolve()))));
    await rm(root, { recursive: true, force: true });
  }
});

test('cancelled Range and NDJSON streams release IO while another stream on the same session stays usable', { timeout: 15000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'vp-h2-stream-')), data = Buffer.alloc(8 * 1024 * 1024, 37);
  const file = path.join(root, 'data.bin');
  await writeFile(file, data);
  const tls = await prepareTls({ hosts: ['127.0.0.1'] }, root);
  const released = new Map<string, () => void>(), failures: unknown[] = [];
  const server = createRequestServer(tls, async (req, res) => {
    if (req.url === '/health') { res.end('ok'); return; }
    try {
      if (req.url === '/file') await serveFile(req, res, file);
      else await sendMediaIndexStream(res, data, 1, 'test', -1);
    } catch (error) { if (!res.destroyed) failures.push(error); }
    finally { released.get(req.url!)?.(); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const client = connect(`https://127.0.0.1:${(server.address() as { port: number }).port}`, { ca: tls.ca });
  try {
    for (const url of ['/file', '/index']) {
      const finished = new Promise<void>(resolve => released.set(url, resolve));
      const request = client.request({ ':path': url, range: 'bytes=0-8388607' });
      request.on('error', () => {});
      const received = once(request, 'data');
      request.end();
      await received;
      const closed = once(request, 'close');
      request.close(constants.NGHTTP2_CANCEL);
      await closed;
      assert.equal((await read(client, '/health')).bytes.toString(), 'ok');
      await finished;
      assert.equal(client.destroyed, false);
    }
    assert.deepEqual(failures, []);
  } finally {
    client.destroy(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test('HTTP/2 shutdown drains an active response and closes idle sessions', { timeout: 15000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'vp-h2-drain-'));
  const tls = await prepareTls({ hosts: ['127.0.0.1'] }, root);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const server = createRequestServer(tls, async (_req, res) => { res.write('start'); await gate; res.end('end'); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const client = connect(`https://127.0.0.1:${(server.address() as { port: number }).port}`, { ca: tls.ca });
  try {
    const request = client.request({ ':path': '/' }), chunks: Buffer[] = [];
    request.on('data', bytes => chunks.push(typeof bytes === 'string' ? Buffer.from(bytes) : bytes));
    const started = once(request, 'data'), ended = once(request, 'end');
    request.end(); await started;
    let settled = false;
    const closed = new Promise<void>((resolve, reject) => server.close(error => {
      settled = true; if (error) reject(error); else resolve();
    }));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false);
    release(); await ended; await closed;
    assert.equal(Buffer.concat(chunks).toString(), 'startend');
  } finally {
    release(); client.destroy(); server.closeAllConnections();
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test('forced HTTP/2 shutdown terminates held streams and the underlying connections', { timeout: 15000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'vp-h2-force-'));
  const tls = await prepareTls({ hosts: ['127.0.0.1'] }, root);
  const server = createRequestServer(tls, (_req, res) => { res.write('held'); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const client = connect(`https://127.0.0.1:${(server.address() as { port: number }).port}`, { ca: tls.ca });
  client.on('error', () => {});
  try {
    const request = client.request({ ':path': '/' });
    request.on('error', () => {});
    const started = once(request, 'data'), ended = new Promise<void>(resolve => request.once('close', resolve));
    request.end(); await started;
    const closed = new Promise<void>(resolve => server.close(() => resolve()));
    server.closeAllConnections();
    await Promise.all([ended, closed]);
    assert.equal(request.closed, true);
  } finally {
    client.destroy(); server.closeAllConnections();
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
