import { stat } from 'node:fs/promises';
import path from 'node:path';
import { MediaLibraryIndex } from './library.ts';
import { createMediaServer } from './app.ts';
import type { ServiceConfig } from './config.ts';

export async function startService(config: ServiceConfig, requireStatic = true) {
  for (const root of config.mediaRoots) if (!(await stat(root).catch(() => null))?.isDirectory()) throw new Error(`媒体目录不存在或不可读: ${root}`);
  const staticOk = (await stat(path.join(config.staticDir, 'index.html')).catch(() => null))?.isFile();
  if (requireStatic && !staticOk) throw new Error('缺少构建后的网页，请先运行 npm run build 或使用完整发布包。');
  const proxyToken = process.env.VOIDPLAYER_PROXY_TOKEN;
  if (proxyToken && proxyToken.length < 32) throw new Error('VOIDPLAYER_PROXY_TOKEN 至少需要 32 个字符。');
  if (!['127.0.0.1', 'localhost', '::1'].includes(config.host) && !proxyToken) throw new Error('远端监听需要配置 VOIDPLAYER_PROXY_TOKEN，并通过认证网关访问。');
  const library = new MediaLibraryIndex(config.mediaRoots, { ttlMs: config.indexTtlMs });
  await library.list();
  const server = createMediaServer({ proxyToken, library, roots: config.mediaRoots, staticDir: staticOk ? config.staticDir : undefined, logsDir: config.logsDir ?? undefined,
    allowLocalReveal: config.allowLocalReveal && ['127.0.0.1', 'localhost', '::1'].includes(config.host) && ['darwin', 'win32'].includes(process.platform),
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(config.port, config.host, () => { server.removeListener('error', reject); resolve(); }); });
  console.log(`媒体服务: http://${config.host}:${config.port} · ${config.mediaRoots.length} 个媒体目录`);
  return { server, close: () => new Promise<void>(resolve => {
    const force = setTimeout(() => server.closeAllConnections(), 5000); force.unref();
    server.close(() => { clearTimeout(force); resolve(); });
  }) };
}
