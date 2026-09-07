import { stat, access, mkdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { MediaLibraryIndex } from './library.ts';
import { createMediaServer } from './app.ts';
import type { ServiceConfig } from './config.ts';
import { AdminController } from './admin.ts';
import { prepareTls } from './tls.ts';
import type { Server } from 'node:http';

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
  const connection = tls ? { ...tls, port: config.port } : undefined;
  const server = createMediaServer({ library, admin, tls, connection, roots: library.roots, staticDir: staticOk ? config.staticDir : undefined, logsDir: config.logsDir ?? undefined,
    allowLocalReveal: config.allowLocalReveal && ['127.0.0.1', 'localhost', '::1'].includes(config.host) && ['darwin', 'win32'].includes(process.platform),
  });
  try { await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(config.port, config.host, () => { server.removeListener('error', reject); resolve(); }); }); }
  catch (error) { await admin.close(); await library.close(); throw error; }
  let guide: Server | undefined;
  if (connection) {
    connection.port = (server.address() as { port: number }).port;
    if (config.httpPort !== null) {
      guide = createMediaServer({ library, roots: library.roots, connection, guideOnly: true, staticDir: staticOk ? config.staticDir : undefined });
      const httpPort = config.httpPort ?? (config.port === 0 ? 0 : config.port === 65535 ? 65534 : config.port + 1);
      try { await new Promise<void>((resolve, reject) => { guide!.once('error', reject); guide!.listen(httpPort, config.host, () => { guide!.removeListener('error', reject); resolve(); }); }); }
      catch (error) { await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }); await admin.close(); await library.close(); throw new Error(`HTTP 引导端口 ${httpPort} 无法启动；可用 --http-port 更换端口或 --no-http-guide 禁用。`, { cause: error }); }
    }
  }
  const address = tls?.hosts.find(h => !['localhost', '127.0.0.1', '::1'].includes(h)) ?? config.host;
  console.log(`媒体服务: ${tls ? 'https' : 'http'}://${address.includes(':') ? `[${address}]` : address}:${config.port} · ${config.mediaRoots.length} 个媒体目录`);
  if (tls?.caFile) console.log(`首次访问：将 ${tls.caFile} 复制到客户端，导入当前用户的受信任根证书。\nCA SHA-256: ${tls.fingerprint}\nWindows: certutil -user -addstore Root voidplayer-ca.crt`);
  if (guide) console.log(`证书安装引导: http://${address.includes(':') ? `[${address}]` : address}:${(guide.address() as { port: number }).port}/`);
  return { server, library, tls, guide, close: async () => { library.stop(); await Promise.all([server, ...(guide ? [guide] : [])].map(listener => new Promise<void>(resolve => {
    const force = setTimeout(() => listener.closeAllConnections(), 5000); force.unref();
    listener.close(() => { clearTimeout(force); resolve(); });
  }))); await admin.close(); await library.close(); } };
}
