export type OpenStage = 'input' | 'container' | 'codec' | 'decode' | 'resource';
export class MediaOpenError extends Error {
  readonly stage: OpenStage;
  readonly code?: MediaErrorCode;
  constructor(stage: OpenStage, message: string, code?: MediaErrorCode) {
    super(message);
    this.name = 'MediaOpenError';
    this.stage = stage;
    this.code = code;
  }
}

export type MediaErrorCode = 'reference-hdr-unsupported' | 'reference-format-unsupported';
export type MediaDiagnostic = { code: MediaErrorCode; stage: OpenStage; message: string };
/** Stable UI routing metadata. Raw diagnostics, stage and reason chains stay intact. */
export function mediaDiagnostic(error: unknown): MediaDiagnostic | undefined {
  if(error instanceof MediaOpenError && error.code)return {code:error.code,stage:error.stage,message:error.message};
  if(error instanceof AggregateError)for(const cause of error.errors){const diagnostic=mediaDiagnostic(cause);if(diagnostic)return diagnostic;}
  if(error instanceof Error && error.cause)return mediaDiagnostic(error.cause);
  return undefined;
}
