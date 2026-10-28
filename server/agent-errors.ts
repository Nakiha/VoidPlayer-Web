import { AdminError, adminErrorBody } from './admin-error.ts';
import { AGENT_TASKS } from '../shared/service/agent.ts';
import {agentRecovery} from '../shared/service/agent-recovery.ts';

export function agentRecoveryFields(code:string,operation?:string){
  return {recovery:agentRecovery(code,operation),links:{help:AGENT_TASKS.errors,tasks:'/api/agent/tasks',...(operation?{operation:'/api/agent/operations/'+operation}:{})}};
}

/** Additive fields keep existing UI errors compatible while HTTP clients recover. */
export function agentErrorBody(error: unknown, requestId: string, help: string = AGENT_TASKS.errors) {
  const code=error instanceof AdminError ? error.code : 'internal-error';
  return { ...adminErrorBody(error), code, requestId, ...agentRecoveryFields(code),links:{...agentRecoveryFields(code).links,help} };
}
