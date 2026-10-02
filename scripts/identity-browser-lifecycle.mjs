// Keep both test listeners ephemeral initially. Pin only the player origin for
// browser reloads; its adjacent port is not reserved for the HTTP guide.
export function identityBrowserService(config, startService) {
  config.httpPort = 0;
  let service;
  const close = async () => {
    const previous = service;
    service = undefined;
    await previous?.close();
  };
  const start = async () => {
    service = await startService(config);
    config.port = service.server.address().port;
    return service;
  };
  return { start, close, restart: async () => { await close(); return start(); } };
}

// Attempt every cleanup even when an earlier resource fails. In particular, a
// secondary teardown exception must never replace a restart/assertion failure.
export async function cleanupIdentityBrowser(steps, failure, report = console.error) {
  const errors = [];
  for (const [name, cleanup] of steps) {
    try { await cleanup(); }
    catch (error) { errors.push(error); report(`Identity browser: ${name} cleanup failed`, error); }
  }
  if (failure) throw failure.error;
  if (errors.length) throw new AggregateError(errors, 'Identity browser cleanup failed');
}
