export type ShutdownStep = readonly [name: string, close: () => unknown];

/** Start every independent owner before awaiting any of them. A failed owner
 * retains its own unresolved resources; callers close shared dependencies only
 * after this group succeeds. Rejections are observed immediately and together. */
export async function closeResources(message: string, steps: readonly ShutdownStep[]): Promise<void> {
  const outcomes = await Promise.allSettled(steps.map(([, close]) => Promise.resolve().then(close)));
  const errors = outcomes.flatMap((outcome, index) => outcome.status === 'rejected'
    ? [new Error(`${steps[index][0]} failed to close`, { cause: outcome.reason })] : []);
  if (errors.length) throw new AggregateError(errors, message);
}

/** Startup rollback must preserve the initiating failure as well as cleanup
 * failures, rather than replacing it with the first failed close operation. */
export async function cleanupAfterFailure(error: unknown, message: string, steps: readonly ShutdownStep[]): Promise<never> {
  try { await closeResources(message, steps); }
  catch (cleanup) { throw new AggregateError([error, cleanup], message, { cause: error }); }
  throw error;
}
