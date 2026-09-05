import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createMediaServer } from './app.ts';

// Entry point: node server/main.ts --folder /path/to/media [--folder ...] [--port 5180]
// Binds localhost by default; the whitelist folders are the only readable files.

const args = process.argv.slice(2);
const folders: string[] = [];
let port = 5180;
let host = '127.0.0.1';
let staticDir = path.resolve(new URL('..', import.meta.url).pathname, 'dist');
let logsDir = path.resolve(new URL('..', import.meta.url).pathname, 'logs');

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  const value = () => args[++i];
  if (arg === '--folder') folders.push(value());
  else if (arg.startsWith('--folder=')) folders.push(arg.slice(9));
  else if (arg === '--port') port = Number(value());
  else if (arg.startsWith('--port=')) port = Number(arg.slice(7));
  else if (arg === '--host') host = value();
  else if (arg.startsWith('--host=')) host = arg.slice(7);
  else if (arg === '--static') staticDir = value();
  else if (arg.startsWith('--static=')) staticDir = arg.slice(9);
  else if (arg === '--logs-dir') logsDir = value();
  else if (arg.startsWith('--logs-dir=')) logsDir = arg.slice(11);
  else if (arg === '--no-logs') logsDir = '';
  else if (arg === '--help' || arg === '-h') {
    console.log('node server/main.ts --folder /path [--folder ...] [--port 5180] [--host 127.0.0.1] [--static dist]');
    process.exit(0);
  } else {
    console.error(`未知参数: ${arg}`);
    process.exit(1);
  }
}

if (!folders.length) {
  console.error('至少需要一个 --folder 白名单目录。');
  process.exit(1);
}
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error('端口无效。');
  process.exit(1);
}

const roots: string[] = [];
for (const folder of folders) {
  const abs = path.resolve(folder);
  const stat = await fs.stat(abs).catch(() => null);
  if (!stat?.isDirectory()) {
    console.error(`目录不存在或不可读: ${abs}`);
    process.exit(1);
  }
  roots.push(abs);
}

const staticOk = await fs.stat(path.join(staticDir, 'index.html')).catch(() => null);
const server = createMediaServer({ roots, staticDir: staticOk ? staticDir : undefined, logsDir: logsDir || undefined });
server.listen(port, host, () => {
  console.log(`VoidPlayer web service: http://${host}:${port}/`);
  console.log(`媒体库目录: ${roots.join(', ')}`);
  console.log(`日志接收: ${logsDir ? logsDir : '关闭'}`);
  console.log(staticOk ? `静态资源: ${staticDir}` : '静态资源: 未找到 dist（先 npm run build，或仅用 /api）');
});
