import { mkdir, writeFile, unlink, access } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const production = process.argv.includes('--production');
const mode = production ? 'production' : 'dev';
const command = process.argv[2] ?? 'status';
if (process.platform !== 'darwin') throw new Error('此命令管理 macOS 用户服务；Linux / 容器部署见 deploy/README.md。');
const label = `org.voidplayer.web.${mode}.${createHash('sha256').update(root).digest('hex').slice(0, 8)}`;
const domain = `gui/${process.getuid()}`;
const target = `${domain}/${label}`;
const file = path.join(homedir(), 'Library/LaunchAgents', `${label}.plist`);
const run = (...args) => execFileSync('/bin/launchctl', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const exists = () => { try { run('print', target); return true; } catch { return false; } };
const escape = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
if (command === 'install') {
  await access(path.join(root, 'voidplayer.config.json')).catch(() => { throw new Error('请先复制 voidplayer.config.example.json 为 voidplayer.config.json，并检查媒体目录。'); });
  if (exists()) throw new Error('该服务已经安装并运行；先 stop，再 install 更新配置。');
  await mkdir(path.dirname(file), { recursive: true }); await mkdir(path.join(root, '.run'), { recursive: true });
  const args = [process.execPath, path.join(root, production ? 'server/main.ts' : 'scripts/dev.ts'), '--config', path.join(root, 'voidplayer.config.json')];
  await writeFile(file, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array>${args.map(arg => `<string>${escape(arg)}</string>`).join('')}</array>
<key>WorkingDirectory</key><string>${escape(root)}</string>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>${escape(process.env.PATH ?? '/usr/bin:/bin')}</string></dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict><key>ThrottleInterval</key><integer>5</integer>
<key>StandardOutPath</key><string>${escape(path.join(root, '.run', `${mode}.log`))}</string>
<key>StandardErrorPath</key><string>${escape(path.join(root, '.run', `${mode}.error.log`))}</string>
</dict></plist>\n`, { mode: 0o600 });
  run('bootstrap', domain, file); console.log(`已安装并启动 ${mode} 用户服务；下次登录自动运行。日志: .run/${mode}.log`);
} else if (command === 'start') {
  if (exists()) run('kickstart', target); else run('bootstrap', domain, file);
  console.log('服务已启动。');
} else if (command === 'stop' || command === 'uninstall') {
  if (exists()) run('bootout', target);
  if (command === 'uninstall') await unlink(file).catch(error => { if (error.code !== 'ENOENT') throw error; });
  console.log(command === 'stop' ? '服务已停止；下次登录仍会启动。' : '服务已卸载。');
} else if (command === 'status') {
  if (!exists()) { console.log('服务未运行。'); process.exitCode = 1; }
  else { const output = run('print', target); console.log(output.split('\n').filter(line => /state =|pid =|last exit code =|runs =/.test(line)).join('\n')); }
} else throw new Error('用法: npm run service -- install|start|stop|status|uninstall [--production]');
