import { AdminError, adminErrorBody } from './admin-error.ts';
import { AGENT_TASKS } from '../shared/service/agent.ts';
import {agentRecovery} from '../shared/service/agent-recovery.ts';

/** Additive fields keep existing UI errors compatible while HTTP clients recover. */
export function agentErrorBody(error: unknown, requestId: string, help: string = AGENT_TASKS.errors) {
  const code=error instanceof AdminError ? error.code : 'internal-error';
  return { ...adminErrorBody(error), code, requestId, recovery:agentRecovery(code), links: { help, tasks:'/api/agent/tasks' } };
}
