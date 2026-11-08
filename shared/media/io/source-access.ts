export type LibraryAccessProblem = 'missing' | 'changed' | 'unavailable';
export type LocalAccessProblem = 'unsupported' | 'unavailable' | 'denied' | 'stale';

/** Diagnostic errors carry reasons without adding UI dependencies to media. */
export class LibraryAccessError extends Error {
  readonly details: string;
  readonly kind: LibraryAccessProblem;
  readonly status?: number;
  constructor(kind: LibraryAccessProblem, name: string, details = '', status?: number) {
    const message = kind === 'missing' ? `无法打开「${name}」：文件已移除` : kind === 'changed' ? `无法打开「${name}」：文件版本已变化` : `无法打开「${name}」：媒体库暂不可用`;
    super(message + (details ? ` ${details}` : ''));
    this.details = details;
    this.kind = kind;
    this.status = status;
    this.name = 'LibraryAccessError';
  }
}
