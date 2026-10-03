// Preserve the primary exception while attempting every registered teardown.
export async function cleanupResources(steps, failure, report = console.error, label = 'Browser fixture') {
  const errors = [];
  for (const [name, cleanup] of steps) {
    try { await cleanup(); }
    catch (error) { errors.push(error); report(`${label}: ${name} cleanup failed`, error); }
  }
  if (failure) throw failure.error;
  if (errors.length) throw new AggregateError(errors, `${label} cleanup failed`);
}
