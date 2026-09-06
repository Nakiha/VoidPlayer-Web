import path from 'node:path';
import { homedir } from 'node:os';
import { mkdir, writeFile } from 'node:fs/promises';
import { loadConfig } from './config.ts';
import { startService, validateServiceConfig } from './runtime.ts';
import { normalizeRoots } from './library-store.ts';

// Replaced by the release builder; the source entry can also run under Bun.
declare const VOIDPLAYER_COMPILED: boolean;
declare const VOIDPLAYER_VERSION: string;
declare const VOIDPLAYER_REVISION: string;
const compiled = typeof VOIDPLAYER_COMPILED !== 'undefined' && VOIDPLAYER_COMPILED;
const version = typeof VOIDPLAYER_VERSION === 'undefined' ? 'development' : VOIDPLAYER_VERSION;
const revision = typeof VOIDPLAYER_REVISION === 'undefined' ? 'source' : VOIDPLAYER_REVISION;

function defaultDataDirectory() {
  if (process.env.VOIDPLAYER_DATA_DIR) return path.resolve(process.env.VOIDPLAYER_DATA_DIR);
  if (process.platform === 'darwin') return path.join(homedir(), 'Library', 'Application Support', 'VoidPlayer');
  if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA || path.join(homedir(), 'AppData', 'Local'), 'VoidPlayer');
  return path.join(process.env.XDG_DATA_HOME || path.join(homedir(), '.local', 'share'), 'voidplayer');
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--version')) { console.log(`VoidPlayer ${version} (${revision})`); return; }
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(`VoidPlayer ${version}
用法: voidplayer [选项]
  --init --folder /media       创建配置（不会覆盖已有文件），然后退出
  --data-dir /data             配置、媒体索引和上传日志的数据目录
  --config /path/config.json   使用指定配置；相对路径以该配置为基准
  --folder /media              媒体白名单目录，可重复指定
  --port 5180 --host 127.0.0.1  监听地址；远端访问需要认证网关
  --static /path/dist          覆盖随包网页资源目录
  --no-logs                   禁用用户主动上传日志
  --check                     检查配置与目录后退出
  --healthcheck               检查运行中的服务是否就绪
  --version                   显示版本
默认数据目录: ${defaultDataDirectory()}`);
    return;
  }
  let dataDir = defaultDataDirectory();
  const args: string[] = [];
  let init = false, check = false, healthcheck = false;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--init') init = true;
    else if (flag === '--check') check = true;
    else if (flag === '--healthcheck') healthcheck = true;
    else if (flag === '--data-dir' || flag.startsWith('--data-dir=')) {
      const value = flag === '--data-dir' ? argv[++i] : flag.slice('--data-dir='.length);
      if (!value || value.startsWith('--')) throw new Error('--data-dir 缺少路径。');
      dataDir = path.resolve(value);
    } else args.push(flag);
  }
  if (Number(init) + Number(check) + Number(healthcheck) > 1) throw new Error('--init、--check 和 --healthcheck 不能组合。');
  if (init && (process.env.VOIDPLAYER_CONFIG || args.some(a => a === '--config' || a.startsWith('--config=')))) throw new Error('--init 请使用 --data-dir 指定位置，不要同时指定 --config / VOIDPLAYER_CONFIG。');
  const configFile = path.join(dataDir, 'voidplayer.config.json');
  const appDir = compiled ? path.dirname(process.execPath) : path.resolve(import.meta.dirname, '..');
  const config = await loadConfig(args, 'production', process.cwd(), { configFile, dataDir, staticDir: path.join(appDir, 'dist'), logsDir: path.join(dataDir, 'logs') });
  if (healthcheck) {
    const host = config.host === '0.0.0.0' ? '127.0.0.1' : config.host === '::' ? '[::1]' : config.host.includes(':') ? `[${config.host}]` : config.host;
    const response = await fetch(`http://${host}:${config.port}/api/ready`, { signal: AbortSignal.timeout(2500) });
    if (!response.ok || !(await response.json() as { ready?: boolean }).ready) throw new Error('服务尚未就绪。');
    return;
  }
  if (init || check) {
    await validateServiceConfig(config);
    if (init) {
      await mkdir(dataDir, { recursive: true });
      // Resource paths remain release-relative so moving/upgrading the app works.
      const { staticDir: _static, devPort: _dev, dataDir: _data, origin: _origin, ...rest } = config;
      const stored = { ...rest, mediaRoots: normalizeRoots(config.mediaRoots).map(({ id, path, name }) => ({ id, path, name })), ...(args.some(a => a === '--static' || a.startsWith('--static=')) ? { staticDir: config.staticDir } : {}) };
      if (stored.logsDir === path.join(dataDir, 'logs')) stored.logsDir = 'logs';
      await writeFile(configFile, JSON.stringify(stored, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      console.log(`配置已创建: ${configFile}\n再次运行相同程序和 --data-dir 即可启动。`);
    } else console.log(`配置与目录检查通过: ${configFile}`);
    return;
  }
  console.log(`VoidPlayer ${version} (${revision})\n数据目录: ${dataDir}`);
  const service = await startService(config, true, { version, revision });
  let closing = false;
  const close = async () => { if (closing) return; closing = true; await service.close(); };
  process.on('SIGINT', close); process.on('SIGTERM', close);
}
void main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  console.error('运行 voidplayer --help 查看用法；首次可使用 --init --folder /媒体目录。');
  process.exitCode = 1;
});
