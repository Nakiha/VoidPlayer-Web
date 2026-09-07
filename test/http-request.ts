import { request } from 'node:http';
/** Node fetch rewrites Host; use raw HTTP to exercise non-loopback Host handling. */
export function httpFetch(url: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Response> {
  return new Promise((resolve, reject) => {
    const req = request(url, { method: options.method, headers: options.headers }, res => {
      const chunks: Buffer[] = [];
      res.on('error', reject); res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve(new Response([204, 304].includes(res.statusCode!) ? null : Buffer.concat(chunks), { status: res.statusCode, headers: Object.fromEntries(Object.entries(res.headers).filter(([, value]) => value !== undefined).map(([key, value]) => [key, Array.isArray(value) ? value.join(', ') : value!])) })));
    });
    req.on('error', reject); req.end(options.body);
  });
}
