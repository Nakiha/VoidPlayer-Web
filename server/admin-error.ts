export class AdminError extends Error {
  status: number;
  readonly code: string;
  readonly params?: Record<string,string|number>;
  constructor(status: number, message: string, code = `http-${status}`, params?: Record<string,string|number>) { super(message); this.status = status; this.code = code; this.params = params; }
}

/** Additive metadata; existing error/status fields and raw cause remain compatible. */
export function adminErrorBody(error: unknown) {
  return { error: (error as Error).message, ...(error instanceof AdminError ? { code: error.code, ...(error.params ? {params:error.params} : {}) } : {}) };
}
