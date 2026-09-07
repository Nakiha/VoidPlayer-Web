import { stat, access, mkdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { MediaLibraryIndex } from './library.ts';
import { createMediaServer } from './app.ts';
import type { ServiceConfig } from './config.ts';
import { AdminController } from './admin.ts';
import { prepareTls } from './tls.ts';

export async function validateServiceConfig(config: ServiceConfig, requireStatic = true, checkMedia = true) {
  for (const input of checkMedia ? config.mediaRoots : []) {
    const root = typeof input === 'string' ? input : input.path;
    if (!(await stat(root).catch(() => null))?.isDirectory()) throw new Error(`媒体目录不存在或不可读: ${root}`);
    await access(root, constants.R_OK);
  }
  const staticOk = (await stat(path.join(config.staticDir, 'index.html')).catch(() => null))?.isFile();
  if (requireStatic && !staticOk) throw new Error('缺少构建后的网页，请先运行 npm run build 或使用完整发布包。');
  await mkdir(config.dataDir, { recursive: true }); await access(config.dataDir, constants.W_OK);
  if (config.logsDir) { await mkdir(config.logsDir, { recursive: true }); await access(config.logsDir, constants.W_OK); }
  return { staticOk };
}

export async function startService(config: ServiceConfig, requireStatic = true, build?: { version: string; revision: string }) {
  const { staticOk } = await validateServiceConfig(config, requireStatic, false);
  const tls = config.tls ? await prepareTls(config.tls, config.dataDir) : undefined;
  const library = new MediaLibraryIndex(config.mediaRoots, { ttlMs: config.indexTtlMs, database: path.join(config.dataDir, 'library.sqlite'), settleMs: 1000, watch: config.indexWatch });
  library.start();
  let admin: AdminController;
  try { admin = new AdminController(config, library, build); } catch (error) { await library.close(); throw error; }
  const server = createMediaServer({ library, admin, tls, roots: library.roots, staticDir: staticOk ? config.staticDir : undefined, logsDir: config.logsDir ?? undefined,
    allowLocalReveal: config.allowLocalReveal && ['127.0.0.1', 'localhost', '::1'].includes(config.host) && ['darwin', 'win32'].includes(process.platform),
  });
  try { await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(config.port, config.host, () => { server.removeListener('error', reject); resolve(); }); }); }
  catch (error) { await admin.close(); await library.close(); throw error; }
  const address = tls?.hosts.find(h => !['localhost', '127.0.0.1', '::1'].includes(h)) ?? config.host;
  console.log(`媒体服务: ${tls ? 'https' : 'http'}://${address.includes(':') ? `[${address}]` : address}:${config.port} · ${config.mediaRoots.length} 个媒体目录`);
  if (tls?.caFile) console.log(`首次访问：将 ${tls.caFile} 复制到客户端，导入当前用户的受信任根证书。\nCA SHA-256: ${tls.fingerprint}\nWindows: certutil -user -addstore Root voidplayer-ca.crt`);
  return { server, library, tls, close: async () => { library.stop(); await new Promise<void>(resolve => {
    const force = setTimeout(() => server.closeAllConnections(), 5000); force.unref();
    server.close(() => { clearTimeout(force); resolve(); });
  }); await admin.close(); await library.close(); } };
}
