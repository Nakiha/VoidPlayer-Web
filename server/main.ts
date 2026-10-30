import { loadConfig } from './config.ts';
import { startService } from './runtime.ts';
if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log('node server/main.ts [--config voidplayer.config.json] [--folder /media] [--port 5180] [--host 127.0.0.1] [--static dist] [--allow-local-reveal]');
} else {
  try {
    const service = await startService(await loadConfig(process.argv.slice(2), 'production'));
    let closing = false;
    const close = async () => { if (closing) return; closing = true; await service.close(); };
    const stop = () => { void close().catch(error => { console.error(error); process.exitCode = 1; }); };
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
  } catch (error) { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; }
}
