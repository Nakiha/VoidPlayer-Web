/** Transport diagnostics are locale-independent and preserve the original cause. */
export class ApiError extends Error {
  readonly status: number; readonly diagnostic: string; readonly code?: string; readonly params?: Record<string,string|number>;
  constructor(status: number, diagnostic: string, code?: string, params?: Record<string, string | number>) { super(diagnostic); this.status=status; this.diagnostic=diagnostic; this.code=code; this.params=params; }
}
export function apiError(status: number, value: { error?: string; code?: string; params?: Record<string,string | number> }) {
  return new ApiError(status, value.error ?? `HTTP ${status}`, value.code, value.params);
}
