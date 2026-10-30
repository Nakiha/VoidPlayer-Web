import {closeResources,cleanupAfterFailure} from '../server/shutdown.ts';
import { createServer } from 'vite';
import { loadConfig } from '../server/config.ts';
import { startService } from '../server/runtime.ts';
// One process owns both listeners; failure of either listener closes the stack.
const config = await loadConfig(process.argv.slice(2), 'dev');
const api = await startService(config, false);
let web: Awaited<ReturnType<typeof createServer>> | undefined;
let closing = false;
const close = async () => { if (closing) return; closing = true; await closeResources('Development service shutdown incomplete', [['Vite', () => web?.close()], ['media service', () => api.close()]]); };
const stop = () => { void close().catch(error => { console.error(error); process.exitCode = 1; }); };
process.on('SIGINT', stop); process.on('SIGTERM', stop);
try {
  web = await createServer({ server: { host: config.host, port: config.devPort, strictPort: true, proxy: { '/api': { target: `http://${config.host === '::1' ? '[::1]' : config.host}:${config.port}`, changeOrigin: false } } } });
  await web.listen(); web.printUrls();
} catch (error) { try { await cleanupAfterFailure(error, 'Development service startup failed', [['service', close]]); } catch (failure) { console.error(failure); process.exitCode = 1; } }
