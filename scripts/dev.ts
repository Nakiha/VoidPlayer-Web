import { createServer } from 'vite';
import { loadConfig } from '../server/config.ts';
import { startService } from '../server/runtime.ts';
// One process owns both listeners; failure of either listener closes the stack.
const config = await loadConfig(process.argv.slice(2), 'dev');
const api = await startService(config, false);
let web: Awaited<ReturnType<typeof createServer>> | undefined;
let closing = false;
const close = async () => { if (closing) return; closing = true; await web?.close(); await api.close(); };
process.on('SIGINT', close); process.on('SIGTERM', close);
try {
  web = await createServer({ server: { host: config.host, port: config.devPort, strictPort: true, proxy: { '/api': `http://${config.host === '::1' ? '[::1]' : config.host}:${config.port}` } } });
  await web.listen(); web.printUrls();
} catch (error) { await close(); console.error(error instanceof Error ? error.message : error); process.exitCode = 1; }
