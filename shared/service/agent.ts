import {AGENT_TASK_CATALOG,AGENT_OPERATION_PATH,AGENT_OPERATIONS_VERSION} from './agent-operations.ts';
import {PAGE_TOOLS,PAGE_BRIDGE_LIMITS,PAGE_MCP_VERSIONS,MCP_PAGE_TOOLS} from './page-bridge.ts';
/** Discovery describes this deployment without starting work or creating users. */
export function serviceCapabilities(storageEnabled: boolean, revealEnabled: boolean) {
  return { admin: storageEnabled, workspaces: storageEnabled, annotations: storageEnabled, reveal: revealEnabled };
}
type ServiceCapabilities = ReturnType<typeof serviceCapabilities>;
export type AgentCapability = {
  id: string;
  implemented: boolean;
  enabled: boolean;
  readiness: 'ready' | 'index-warming' | 'needs-identity' | 'per-source' | 'requires-live-session' | 'unavailable';
  requiresBrowser: boolean;
  guide: string;
};
export const AGENT_TASKS = {
  library: '/agent/library.md', workspaces: '/agent/workspaces.md', annotations: '/agent/annotations.md',
  liveSession: '/agent/live-session.md', errors: '/agent/errors.md',
} as const;

export function agentManifest(input: { capabilities: ServiceCapabilities; libraryReady: boolean; frontendAvailable?: boolean; localPageBridge?:boolean; actor: { id: string; name: string } | null }) {
  const { capabilities: c, libraryReady, actor } = input;
  const capabilities: AgentCapability[] = [
    {id:'identity.select',implemented:true,enabled:c.admin,readiness:c.admin?'ready':'unavailable',requiresBrowser:false,guide:AGENT_TASKS.workspaces},
    { id: 'library.browse', implemented: true, enabled: true, readiness: libraryReady ? 'ready' : 'index-warming', requiresBrowser: false, guide: AGENT_TASKS.library },
    { id: 'media.cached-info', implemented: true, enabled: true, readiness: 'per-source', requiresBrowser: false, guide: AGENT_TASKS.library },
    { id: 'media.cached-index-query', implemented: true, enabled: true, readiness: 'per-source', requiresBrowser: false, guide: AGENT_TASKS.library },
    { id: 'media.read', implemented: true, enabled: true, readiness: 'per-source', requiresBrowser: false, guide: AGENT_TASKS.library },
    { id: 'workspaces.read', implemented: true, enabled: c.workspaces, readiness: c.workspaces ? 'ready' : 'unavailable', requiresBrowser: false, guide: AGENT_TASKS.workspaces },
    { id: 'annotations.write', implemented: true, enabled: c.annotations, readiness: !c.annotations ? 'unavailable' : actor ? 'ready' : 'needs-identity', requiresBrowser: false, guide: AGENT_TASKS.annotations },
    { id: 'annotations.events', implemented: true, enabled: c.annotations, readiness: c.annotations ? 'ready' : 'unavailable', requiresBrowser: false, guide: AGENT_TASKS.annotations },
    { id: 'session.view', implemented: true, enabled: !!input.frontendAvailable, readiness: input.frontendAvailable ? 'requires-live-session' : 'unavailable', requiresBrowser: true, guide: AGENT_TASKS.liveSession },
    { id: 'bridge.local-mcp', implemented: true, enabled: !!input.localPageBridge&&!!input.frontendAvailable, readiness: input.localPageBridge&&input.frontendAvailable?'requires-live-session':'unavailable', requiresBrowser: true, guide: AGENT_TASKS.liveSession },
  ];
  return {
    schema: 'voidplayer-agent', version: 1, service: 'voidplayer-media', actor,
    links: { guide: '/agent.md', index: '/llms.txt', health: '/api/health', tasks: AGENT_TASKS,
      taskCatalog:AGENT_TASK_CATALOG,operation:AGENT_OPERATION_PATH+'{id}' },
    operationDiscovery:{schema:'voidplayer-agent-tasks',version:AGENT_OPERATIONS_VERSION,readOnly:true,requiresFrontend:false},
    localMcp:{transport:'stdio',networkMcpEndpoint:false,distribution:'source-checkout-node-24-built-frontend',launch:'node scripts/mcp-page-bridge.ts',versions:PAGE_MCP_VERSIONS,ownedPageOnly:false,existingLoopbackPage:{launch:'node scripts/mcp-page-bridge.ts --existing-origin <exact-loopback-origin>',defaultScopes:[],pairing:'explicit-single-use-page-consent',pairingMs:90000,maximumGrantMs:900000},persistentAuthorization:false,automaticReconnect:false,clientIdentity:'self-declared-not-authenticated',tools:MCP_PAGE_TOOLS.map(tool=>({...tool,scope:Object.hasOwn(PAGE_TOOLS,tool.name)?PAGE_TOOLS[tool.name as keyof typeof PAGE_TOOLS].scope:'read'})),limits:PAGE_BRIDGE_LIMITS,discovery:'Use MCP tools/list for epoch/operationId envelopes and receipt/status tools.',guide:AGENT_TASKS.liveSession},
    capabilities,
    writes: { identity: '/api/identity', identityIsAuthentication: false, originRequired: true,
      actionHeader: 'X-VoidPlayer-Action', cookieRequired: true, completion: 'server-commit', guiAcknowledgementRequired: false },
    annotations: { version: 1, spaces: '/api/annotations/spaces',
      events: '/api/annotations/events/{space}?after={cursor}',
      identity: ['space', 'id'], concurrency: 'expected-revision', idempotency: 'operationId',
      frameTimeUnit: 'integer-microseconds', target: 'document.media + mark.mediaId + mark.frame',
      slotMeaning: 'legacy-display-hint; no loaded track required' },
  };
}
