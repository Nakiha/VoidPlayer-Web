import { createServer, connect, type Server, type Socket } from 'node:net';
import type { IncomingMessage } from 'node:http';

export type ManagedServer = Server & { closeAllConnections(): void };
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
