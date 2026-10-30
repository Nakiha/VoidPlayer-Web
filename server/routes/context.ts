import type {QualityApplication} from '../quality-application.ts';
import type { Actor } from '../identity.ts';
import type { MediaLibraryIndex } from '../library.ts';
import type { ServerOptions } from '../app.ts';

/** Per-request routing state shared by all route handlers. */
export type RouteContext = {
  options: ServerOptions;
  library: MediaLibraryIndex;
  quality:QualityApplication;
  actor: Actor | null;
  requestId: string;
  adminExtra: {
    traffic: { activeRequests: number; completedRequests: number; abortedRequests: number };
    sockets: Set<unknown>;
    recentRequests: Record<string, unknown>[];
  };
};
