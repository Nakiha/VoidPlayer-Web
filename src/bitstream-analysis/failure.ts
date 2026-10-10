import { MediaOpenError } from "../media-errors.ts";
export const ANALYSIS_REASON_CODES = [
  "unsupported-container",
  "unsupported-codec",
  "unsupported-picture-layout",
  "no-safe-anchor-within-budget",
  "unsupported-qp-depth",
  "incomplete-reference-state",
  "ambiguous-picture-identity",
  "resource-limit",
  "source-changed",
  "invalid-request",
  "cancelled",
  "internal-error",
] as const;
export type AnalysisReasonCode = (typeof ANALYSIS_REASON_CODES)[number];
export interface AnalysisFailureInfo {
  code: AnalysisReasonCode;
  kind: "unsupported" | "limited" | "cancelled" | "error";
  message: string;
}
function kind(code: AnalysisReasonCode): AnalysisFailureInfo["kind"] {
  if (code === "resource-limit") return "limited";
  if (code === "cancelled") return "cancelled";
  if (["source-changed", "invalid-request", "internal-error"].includes(code))
    return "error";
  return "unsupported";
}
/** Explicit reasons at the failing boundary; unknown exceptions remain errors.
 * Classification never depends on matching human-readable exception strings. */
export class AnalysisFailure extends Error {
  readonly code: AnalysisReasonCode;
  constructor(code: AnalysisReasonCode, message: string) {
    super(message);
    this.name = "AnalysisFailure";
    this.code = code;
  }
  get info(): AnalysisFailureInfo {
    return {
      code: this.code,
      kind: kind(this.code),
      message: this.message.slice(0, 256),
    };
  }
}
export function failureInfo(error: unknown): AnalysisFailureInfo {
  if (error instanceof AnalysisFailure) return error.info;
  if (error instanceof MediaOpenError) {
    const code = {
      resource: "resource-limit",
      container: "unsupported-container",
      codec: "unsupported-codec",
      input: "incomplete-reference-state",
      decode: "incomplete-reference-state",
    }[error.stage] as AnalysisReasonCode | undefined;
    if (code) return new AnalysisFailure(code, error.message).info;
  }
  if (error instanceof Error && error.name === "AbortError")
    return new AnalysisFailure("cancelled", error.message).info;
  return new AnalysisFailure(
    "internal-error",
    error instanceof Error ? error.message : String(error),
  ).info;
}
/** Error numbers are from the pinned Emscripten libc, not host errno values. */
export function coreFailure(ret: number, operation: string): AnalysisFailure {
  return new AnalysisFailure(
    ret === -48 ? "resource-limit" : "incomplete-reference-state",
    `${operation} (${ret})`,
  );
}
export function restoreFailure(
  value: unknown,
  fallback = "Analysis execution failed",
): AnalysisFailure {
  if (value && typeof value === "object") {
    const v = value as Partial<AnalysisFailureInfo>;
    if (
      ANALYSIS_REASON_CODES.includes(v.code as AnalysisReasonCode) &&
      typeof v.message === "string"
    )
      return new AnalysisFailure(
        v.code as AnalysisReasonCode,
        v.message.slice(0, 256),
      );
  }
  return new AnalysisFailure("internal-error", fallback);
}
