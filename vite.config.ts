import { defineConfig } from 'vite';
import { execFileSync } from 'node:child_process';
let revision = 'unknown';
try { revision = execFileSync('git', ['describe', '--always', '--dirty'], { encoding: 'utf8' }).trim(); } catch { /* Archive without Git metadata. */ }
export default defineConfig({ define: { __BUILD_INFO__: JSON.stringify({ revision, builtAt: new Date().toISOString() }) } });
