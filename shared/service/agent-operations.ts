import type { AgentCapability } from './agent.ts';

export const AGENT_OPERATIONS_VERSION = 1;
export const AGENT_TASK_CATALOG = '/api/agent/tasks';
export const AGENT_OPERATION_PATH = '/api/agent/operations/';
export const AGENT_WORKFLOWS = [
  { id: 'identity', title: 'Select an intranet identity', guide: '/agent/workspaces.md' },
  { id: 'library', title: 'Browse and describe media sources', guide: '/agent/library.md' },
] as const;
export type AgentTaskId = typeof AGENT_WORKFLOWS[number]['id'];
export type AgentOperation = {
  id: string; task: AgentTaskId; method: 'GET' | 'POST'; path: string; capability: string;
  effect: 'read' | 'identity-selection'; identity: boolean; replay: 'none';
  request: { description: string }; output: string; next: string[];
};
export const AGENT_OPERATIONS: readonly AgentOperation[] = [
  { id: 'identity.users', task: 'identity', method: 'GET', path: '/api/users', capability: 'identity.select', effect: 'read',
    identity: false, replay: 'none', request: { description: 'No request body.' }, output: 'Self-declared users, not authenticated principals.', next: ['identity.select'] },
  { id: 'identity.select', task: 'identity', method: 'POST', path: '/api/identity', capability: 'identity.select', effect: 'identity-selection',
    identity: false, replay: 'none', request: { description: 'Explicit {id} selects a user; {mode:"create",name} creates one.' },
    output: 'Actor and Set-Cookie. Never blindly repeat uncertain user creation.', next: ['library.browse'] },
  { id: 'library.browse', task: 'library', method: 'GET', path: '/api/library/browse', capability: 'library.browse', effect: 'read',
    identity: false, replay: 'none', request: { description: 'Optional root, directory, search, recursive, limit, offset and revision.' },
    output: 'Version-pinned media entries and folder navigation.', next: [] },
];
export function agentTaskCatalog() {
  return { schema: 'voidplayer-agent-tasks', version: AGENT_OPERATIONS_VERSION,
    entries: AGENT_WORKFLOWS.map(task => ({ ...task, links: { describe: `${AGENT_TASK_CATALOG}/${task.id}`, guide: task.guide } })) };
}
export function agentTask(id: string) {
  const task = AGENT_WORKFLOWS.find(task => task.id === id);
  return task ? { schema: 'voidplayer-agent-task', version: AGENT_OPERATIONS_VERSION, ...task,
    operations: AGENT_OPERATIONS.filter(operation => operation.task === id).map(operation => ({ id: operation.id,
      method: operation.method, path: operation.path, links: { describe: AGENT_OPERATION_PATH + operation.id,
        guide: `/agent/operations/${operation.id}.md` } })) } : null;
}
export function agentOperation(id: string, capabilities: AgentCapability[]) {
  const operation = AGENT_OPERATIONS.find(operation => operation.id === id);
  if (!operation) return null;
  const capability = capabilities.find(capability => capability.id === operation.capability);
  const task = AGENT_WORKFLOWS.find(task => task.id === operation.task)!;
  return { schema: 'voidplayer-agent-operation', version: AGENT_OPERATIONS_VERSION, ...operation,
    execution: { host: 'service', requiresBrowser: false, sideEffects: operation.effect, guiAcknowledgementRequired: false },
    availability: capability ? { implemented: capability.implemented, enabled: capability.enabled, readiness: capability.readiness }
      : { implemented: false, enabled: false, readiness: 'unavailable' },
    identity: { cookieRequired: operation.identity, isAuthentication: false },
    write: operation.method === 'POST' ? { origin: 'exact-service-origin', contentType: 'application/json',
      actionHeader: 'X-VoidPlayer-Action', action: 'identity', idempotency: operation.replay, keyHeader: null } : null,
    recovery: { unknownPost: 'Do not blindly repeat uncertain identity creation.', sourceChanged: 'Browse again and use the new pinned version.' },
    links: { task: `${AGENT_TASK_CATALOG}/${task.id}`, guide: task.guide, help: '/agent/errors.md',
      next: operation.next.map(id => AGENT_OPERATION_PATH + id) } };
}
