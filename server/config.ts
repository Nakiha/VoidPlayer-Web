import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { MediaRoot } from './library-store.ts';

export interface ServiceConfig {
  mediaRoots: MediaRoot[]; dataDir: string; host: string; port: number; devPort: number;
  staticDir: string; logsDir: string | null; allowLocalReveal: boolean; indexTtlMs: number; indexWatch: boolean;
  adminUsers: string[];
  origin?: { file: string; revision: string; rootsFromCli: boolean };
}
export const configRevision = (text: string) => createHash('sha256').update(text).digest('hex');
/** Paths in a JSON config are relative to that file; CLI paths are relative to cwd. */
export async function loadConfig(args: string[], mode: 'dev' | 'production', cwd = process.cwd(), paths: { configFile?: string; staticDir?: string; logsDir?: string; dataDir?: string; allowEmptyRoots?: boolean } = {}): Promise<ServiceConfig> {
  let configFile = process.env.VOIDPLAYER_CONFIG;
  const overrides: Record<string, unknown> = {}, folders: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const [flag, inline] = args[i].split(/=(.*)/s);
    const value = () => { const result = inline ?? args[++i]; if (!result || result.startsWith('--')) throw new Error(`${flag} 缺少参数。`); return result; };
    if (flag === '--config') configFile = value();
    else if (flag === '--data-dir') overrides.dataDir = path.resolve(cwd, value());
    else if (flag === '--folder') folders.push(path.resolve(cwd, value()));
    else if (flag === '--port') overrides[mode === 'dev' ? 'devPort' : 'port'] = Number(value());
    else if (flag === '--api-port') overrides.port = Number(value());
    else if (flag === '--host') overrides.host = value();
    else if (flag === '--static') overrides.staticDir = path.resolve(cwd, value());
    else if (flag === '--logs-dir') overrides.logsDir = path.resolve(cwd, value());
    else if (flag === '--no-logs') overrides.logsDir = null;
    else if (flag === '--allow-local-reveal') overrides.allowLocalReveal = true;
    else if (flag !== '--strictPort' || mode !== 'dev') throw new Error(`未知参数: ${args[i]}`);
  }
  const file = path.resolve(cwd, configFile ?? paths.configFile ?? 'voidplayer.config.json');
  let data: Record<string, unknown> = {};
  let configText = '';
  try { configText = await readFile(file, 'utf8'); data = JSON.parse(configText); }
  catch (error) { if (configFile || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const defaults: ServiceConfig = { dataDir: paths.dataDir ?? path.resolve(cwd, '.run/data'), mediaRoots: mode === 'dev' ? [path.resolve(cwd, 'fixtures/video')] : [], host: '127.0.0.1', port: 5180, devPort: 5178, staticDir: paths.staticDir ?? path.resolve(cwd, 'dist'), logsDir: paths.logsDir ?? path.resolve(cwd, 'logs'), allowLocalReveal: false, indexTtlMs: 30000, indexWatch: true, adminUsers: [] };
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('服务配置必须是 JSON 对象。');
  for (const key of Object.keys(data)) if (!Object.hasOwn(defaults, key)) throw new Error(`未知配置项: ${key}`);
  if (process.env.VOIDPLAYER_ADMIN_USERS !== undefined) overrides.adminUsers = process.env.VOIDPLAYER_ADMIN_USERS.split(',').map(id => id.trim()).filter(Boolean);
  const config = { ...defaults, ...data, ...overrides } as ServiceConfig;
  if (folders.length) config.mediaRoots = folders;
  if (!Array.isArray(config.mediaRoots) || (!config.mediaRoots.length && !paths.allowEmptyRoots) || config.mediaRoots.some(r => typeof r === 'string' ? !r.trim() : !r || typeof r.path !== 'string' || !r.path.trim() || typeof r.id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(r.id) || (r.name !== undefined && (typeof r.name !== 'string' || !r.name.trim())) || Object.keys(r).some(k => !['id','path','name'].includes(k)))) throw new Error('请在配置中设置 mediaRoots，或指定 --folder 白名单目录。');
  for (const name of ['port', 'devPort'] as const) if (!Number.isInteger(config[name]) || config[name] < 1 || config[name] > 65535) throw new Error(`${name} 端口无效。`);
  if (mode === 'dev' && config.port === config.devPort) throw new Error('网页端口与媒体端口不能相同。');
  if (typeof config.host !== 'string' || !config.host.trim()) throw new Error('host 无效。');
  if (mode === 'dev' && !['127.0.0.1', 'localhost', '::1'].includes(config.host)) throw new Error('开发服务仅监听本机；远端使用构建后的正式服务。');
  if (typeof config.allowLocalReveal !== 'boolean') throw new Error('allowLocalReveal 必须是布尔值。');
  if (typeof config.indexWatch !== 'boolean') throw new Error('indexWatch 必须是布尔值。');
  if (!Array.isArray(config.adminUsers) || config.adminUsers.length > 100 || config.adminUsers.some(id => typeof id !== 'string' || !id.trim() || id !== id.normalize('NFC').trim() || id.length > 128 || /[\p{Cc}\p{Cf}]/u.test(id)) || new Set(config.adminUsers).size !== config.adminUsers.length) throw new Error('adminUsers 必须是不重复的用户名列表。');
  if (!Number.isInteger(config.indexTtlMs) || config.indexTtlMs < 1000 || config.indexTtlMs > 3600000) throw new Error('indexTtlMs 必须是 1000–3600000 毫秒。');
  if (typeof config.staticDir !== 'string' || !config.staticDir || (config.logsDir !== null && (typeof config.logsDir !== 'string' || !config.logsDir))) throw new Error('staticDir / logsDir 配置无效。');
  if (typeof config.dataDir !== 'string' || !config.dataDir.trim()) throw new Error('dataDir 无效。');
  config.dataDir = path.resolve(path.dirname(file), paths.dataDir ?? config.dataDir);
  config.mediaRoots = config.mediaRoots.map(r => typeof r === 'string' ? path.resolve(path.dirname(file), r) : { ...r, path: path.resolve(path.dirname(file), r.path) });
  config.staticDir = path.resolve(path.dirname(file), config.staticDir);
  if (config.logsDir) config.logsDir = path.resolve(path.dirname(file), config.logsDir);
  return Object.assign(config, { origin: { file, revision: configRevision(configText), rootsFromCli: folders.length > 0 } });
}
