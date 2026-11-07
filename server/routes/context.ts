import type { Actor } from '../identity.ts';
import type { MediaLibraryIndex } from '../library.ts';
import type { ServerOptions } from '../app.ts';
import type { ReportLogs } from '../logging/reports.ts';

/** Per-request routing state shared by all route handlers. */
export type RouteContext = {
  options: ServerOptions;
  library: MediaLibraryIndex;
  actor: Actor | null;
  requestId: string;
  reports: ReportLogs;
  adminExtra: {
    traffic: { activeRequests: number; completedRequests: number; abortedRequests: number };
    sockets: Set<unknown>;
    recentRequests: Record<string, unknown>[];
  };
};
