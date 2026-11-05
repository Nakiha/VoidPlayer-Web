import { createServer, connect, type Server, type Socket } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { createSecureServer } from 'node:http2';
import type { ServerHttp2Session } from 'node:http2';
import type { ServerOptions as HttpsOptions } from 'node:https';
import type { IncomingMessage, ServerResponse } from './http.ts';

export type ManagedServer = Server & { closeAllConnections(): void };

/** Keep routes on the compatibility API; each HTTP/2 stream retains its own request lifecycle. */
export function createRequestServer(tls: HttpsOptions | undefined,
  listener: (req: IncomingMessage, res: ServerResponse) => void): ManagedServer {
  if (!tls) return createHttpServer(listener);
  const server = createSecureServer({ ...tls, allowHTTP1: true });
  const sessions = new Set<ServerHttp2Session>(), sockets = new Set<Socket>();
  const http1 = new Map<Socket, number>();
  let closing = false;
  server.on('request', (req, res) => {
    // Node 24's HTTP/2 compatibility response predates the Writable destroyed getter.
    if ('stream' in req && !('destroyed' in res)) {
      const stream = req.stream;
      Object.defineProperty(res, 'destroyed', { get: () => stream.destroyed || stream.closed });
    }
    if (req.httpVersionMajor === 1) {
      const socket = req.socket;
      if (!http1.has(socket)) socket.once('close', () => http1.delete(socket));
      http1.set(socket, (http1.get(socket) ?? 0) + 1);
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        const active = (http1.get(socket) ?? 1) - 1;
        if (http1.has(socket)) http1.set(socket, active);
        if (closing && !active) socket.end(() => socket.destroy());
      };
      res.once('finish', finish);
      res.once('close', finish);
    }
    listener(req, res);
  });
  server.on('connection', socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  server.on('session', session => {
    sessions.add(session);
    session.once('close', () => sessions.delete(session));
    if (closing) session.close();
  });
  // Peer resets/protocol errors belong to the affected stream/session, not the process.
  server.on('sessionError', () => {});
  server.on('stream', stream => { stream.on('error', () => {}); });
  const close = server.close.bind(server);
  server.close = callback => {
    closing = true;
    close(callback);
    for (const session of sessions) session.close();
    for (const [socket, active] of http1) if (!active) socket.destroy();
    return server;
  };
  return Object.assign(server, { closeAllConnections() {
    for (const session of sessions) session.destroy();
    for (const socket of sockets) socket.destroy();
  } });
}

/** The gateway uses public TCP APIs on both Node and the standalone Bun runtime.
 * Pipes preserve backpressure; TLS terminates only in the existing HTTPS server. */
export class ProtocolGateway {
  private peers = new Map<string, string>();
  clientAddress = (req: IncomingMessage) => this.peers.get(`${req.socket.localPort}/${req.socket.remotePort}`) ?? req.socket.remoteAddress ?? '';
  create(httpPort: number, httpsPort: number): ManagedServer {
    const sockets = new Set<Socket>();
    const server = createServer(client => {
      sockets.add(client); let upstream: Socket | undefined;
      const timeout = setTimeout(() => client.destroy(), 10000); timeout.unref();
      client.once('error', () => client.destroy());
      client.once('close', () => { clearTimeout(timeout); sockets.delete(client); upstream?.destroy(); });
      client.once('data', (first: Buffer) => {
        client.pause();
        // TLS handshake record or an HTTP method. Do not reinterpret a failed TLS handshake as HTTP.
        if (first[0] !== 22 && !(first[0]! >= 65 && first[0]! <= 90)) { client.destroy(); return; }
        upstream = connect({ host: '127.0.0.1', port: first[0] === 22 ? httpsPort : httpPort });
        let peerKey: string | undefined;
        upstream.once('error', () => client.destroy());
        upstream.once('close', () => { if (peerKey !== undefined) this.peers.delete(peerKey); if(!upstream?.readableEnded)client.destroy(); });
        upstream.once('connect', () => {
          clearTimeout(timeout); peerKey = `${upstream!.remotePort}/${upstream!.localPort}`;
          this.peers.set(peerKey, client.remoteAddress ?? '');
          upstream!.write(first); client.pipe(upstream!); upstream!.pipe(client);
        });
      });
    }) as ManagedServer;
    server.closeAllConnections = () => { for (const socket of sockets) socket.destroy(); };
    return server;
  }
}
