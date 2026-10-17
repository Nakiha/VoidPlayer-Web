// Ordinary failures retain independent outcomes. Cancellation is terminal and
// must never start another browser/service after the active group tears down.
export async function runAnalysisGroups(groups, run, { signal, report = () => {} } = {}) {
  const failures = [];
  for (const group of groups) {
    signal?.throwIfAborted();
    try { await run(group); }
    catch (error) {
      failures.push(error); report(group, error);
      signal?.throwIfAborted();
    }
  }
  signal?.throwIfAborted();
  if (failures.length) throw new AggregateError(failures, 'Analysis behavior groups failed');
}
