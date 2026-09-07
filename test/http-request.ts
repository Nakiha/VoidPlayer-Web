import { request } from 'node:http';
import { request as secureRequest } from 'node:https';
/** Node fetch rewrites Host; use raw HTTP to exercise non-loopback Host handling. */
export function httpFetch(url: string, options: { method?: string; headers?: Record<string, string>; body?: string; ca?: string; servername?: string } = {}): Promise<Response> {
  return new Promise((resolve, reject) => {
    const req = (url.startsWith('https:') ? secureRequest : request)(url, { method: options.method, headers: options.headers, ca: options.ca, servername: options.servername }, res => {
      const chunks: Buffer[] = [];
      res.on('error', reject); res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve(new Response([204, 304].includes(res.statusCode!) ? null : Buffer.concat(chunks), { status: res.statusCode, headers: Object.fromEntries(Object.entries(res.headers).filter(([, value]) => value !== undefined).map(([key, value]) => [key, Array.isArray(value) ? value.join(', ') : value!])) })));
    });
    req.on('error', reject); req.end(options.body);
  });
}
