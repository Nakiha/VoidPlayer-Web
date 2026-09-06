import { stat, access, mkdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { MediaLibraryIndex } from './library.ts';
import { createMediaServer } from './app.ts';
import type { ServiceConfig } from './config.ts';

export async function validateServiceConfig(config: ServiceConfig, requireStatic = true, checkMedia = true) {
  for (const input of checkMedia ? config.mediaRoots : []) {
    const root = typeof input === 'string' ? input : input.path;
    if (!(await stat(root).catch(() => null))?.isDirectory()) throw new Error(`媒体目录不存在或不可读: ${root}`);
    await access(root, constants.R_OK);
  }
  const staticOk = (await stat(path.join(config.staticDir, 'index.html')).catch(() => null))?.isFile();
  if (requireStatic && !staticOk) throw new Error('缺少构建后的网页，请先运行 npm run build 或使用完整发布包。');
  const proxyToken = process.env.VOIDPLAYER_PROXY_TOKEN;
  if (proxyToken && proxyToken.length < 32) throw new Error('VOIDPLAYER_PROXY_TOKEN 至少需要 32 个字符。');
  if (!['127.0.0.1', 'localhost', '::1'].includes(config.host) && !proxyToken) throw new Error('远端监听需要配置 VOIDPLAYER_PROXY_TOKEN，并通过认证网关访问。');
  await mkdir(config.dataDir, { recursive: true }); await access(config.dataDir, constants.W_OK);
  if (config.logsDir) { await mkdir(config.logsDir, { recursive: true }); await access(config.logsDir, constants.W_OK); }
  return { staticOk, proxyToken };
}

export async function startService(config: ServiceConfig, requireStatic = true) {
  const { staticOk, proxyToken } = await validateServiceConfig(config, requireStatic, false);
  const library = new MediaLibraryIndex(config.mediaRoots, { ttlMs: config.indexTtlMs, database: path.join(config.dataDir, 'library.sqlite'), settleMs: 1000 });
  library.start();
  const server = createMediaServer({ proxyToken, library, roots: library.roots, staticDir: staticOk ? config.staticDir : undefined, logsDir: config.logsDir ?? undefined,
    allowLocalReveal: config.allowLocalReveal && ['127.0.0.1', 'localhost', '::1'].includes(config.host) && ['darwin', 'win32'].includes(process.platform),
  });
  try { await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(config.port, config.host, () => { server.removeListener('error', reject); resolve(); }); }); }
  catch (error) { await library.close(); throw error; }
  console.log(`媒体服务: http://${config.host}:${config.port} · ${config.mediaRoots.length} 个媒体目录`);
  return { server, library, close: async () => { library.stop(); await new Promise<void>(resolve => {
    const force = setTimeout(() => server.closeAllConnections(), 5000); force.unref();
    server.close(() => { clearTimeout(force); resolve(); });
  }); await library.close(); } };
}
