import { AdminError, adminErrorBody } from './admin-error.ts';
import { AGENT_TASKS } from '../shared/service/agent.ts';

/** Additive fields keep existing UI errors compatible while HTTP clients recover. */
export function agentErrorBody(error: unknown, requestId: string, help: string = AGENT_TASKS.errors) {
  return { ...adminErrorBody(error), code: error instanceof AdminError ? error.code : 'internal-error', requestId, links: { help } };
}
