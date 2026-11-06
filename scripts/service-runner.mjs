import { spawn } from 'node:child_process';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { RuntimeLog } from '../server/logging/runtime.ts';
import { DEFAULT_LOG_POLICY } from '../shared/service/logging.ts';

// Capture launchd child output, including Vite and startup failures, in a bounded sink.
const root = path.resolve(import.meta.dirname, '..');
const production = process.argv.includes('--production'), mode = production ? 'production' : 'dev';
const logs = new RuntimeLog(path.join(root, '.run', 'service-logs', mode),
  { segmentBytes: 1024 ** 2, maxBytes: 16 * 1024 ** 2, days: DEFAULT_LOG_POLICY.runtime.days });
await logs.start();
let child;
try {
  child = spawn(process.execPath, [path.join(root, production ? 'server/main.ts' : 'scripts/dev.ts'),
    '--config', path.join(root, 'voidplayer.config.json')], {
    cwd: root, env: { ...process.env, VOIDPLAYER_SERVICE_STDIO: '0' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const capture = (stream, level) => {
    const decoder = new StringDecoder('utf8');
    let pending = '';
    const append = value => {
      pending += value;
      while (pending.length) {
        const newline = pending.indexOf('\n');
        if (newline < 0 && pending.length < 2000) break;
        const length = newline >= 0 && newline < 2000 ? newline : 2000;
        logs.write({ level, event: 'service-console', message: pending.slice(0, length) });
        pending = pending.slice(length + (newline === length ? 1 : 0));
      }
    };
    stream.on('data', chunk => append(decoder.write(chunk)));
    stream.on('end', () => { append(decoder.end()); if (pending) logs.write({ level, event: 'service-console', message: pending }); });
  };
  capture(child.stdout, 'info'); capture(child.stderr, 'error');
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { child.kill(signal); });
  process.exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject); child.once('close', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
} catch (error) { logs.write({ level: 'error', event: 'service-launch-failed', error: String(error) }); process.exitCode = 1; }
finally { await logs.close(); }
