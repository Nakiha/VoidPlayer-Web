import { defineConfig } from 'vite';
import { execFileSync } from 'node:child_process';
let revision = 'unknown';
try { revision = execFileSync('git', ['describe', '--always', '--dirty'], { encoding: 'utf8' }).trim(); } catch { /* Archive without Git metadata. */ }
export default defineConfig({
  define: { __BUILD_INFO__: JSON.stringify({ revision, builtAt: new Date().toISOString() }) },
  // Dev proxy for the optional media-library service (npm run serve).
  server: { proxy: { '/api': 'http://127.0.0.1:5180' } },
});
