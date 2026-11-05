import type { IncomingMessage as Http1Request, OutgoingHttpHeaders } from 'node:http';
import type { Http2ServerRequest } from 'node:http2';

export type IncomingMessage = Http1Request | Http2ServerRequest;
/** Public response operations shared by HTTP/1 and HTTP/2; no socket-level methods. */
export interface ServerResponse extends NodeJS.WritableStream {
  statusCode: number;
  readonly headersSent: boolean;
  readonly destroyed: boolean;
  readonly writableEnded: boolean;
  readonly writableFinished: boolean;
  destroy(error?: Error): void;
  setHeader(name: string, value: number | string | readonly string[]): void;
  writeHead(statusCode: number, headers?: OutgoingHttpHeaders): void;
}

/** Resolve the target independently of Origin or forwarded headers. Conflicting targets are invalid. */
export function requestAuthority(req: IncomingMessage): string | undefined {
  const parse = (value: unknown) => {
    if (typeof value !== 'string' || !value || /[\s,/@?#\\]/.test(value)) return undefined;
    try {
      const scheme = (req.socket as { encrypted?: boolean }).encrypted ? 'https' : 'http';
      const url = new URL(`${scheme}://${value}`);
      return url.hostname ? url.host : undefined;
    } catch { return undefined; }
  };
  const host = req.headers.host, authority = req.headers[':authority'];
  const target = parse(authority ?? host);
  if (authority !== undefined && host !== undefined && parse(host) !== target) return undefined;
  return target;
}
