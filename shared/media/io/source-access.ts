export type LibraryAccessProblem = 'missing' | 'changed' | 'unavailable';
export type LocalAccessProblem = 'unsupported' | 'unavailable' | 'denied' | 'stale';

/** Diagnostic errors carry reasons without adding UI dependencies to media. */
export class LibraryAccessError extends Error {
  readonly details: string;
  readonly kind: LibraryAccessProblem;
  readonly status?: number;
  constructor(kind: LibraryAccessProblem, name: string, details = '', status?: number) {
    const message = kind === 'missing' ? `媒体库引用「${name}」已失效或文件已移除，请在媒体库中重新选择。` : kind === 'changed' ? `媒体库文件「${name}」与保存的版本不一致，请重新选择并检查标注。` : `无法确认媒体库引用「${name}」，请检查服务连接后重试。`;
    super(message + (details ? ` ${details}` : ''));
    this.details = details;
    this.kind = kind;
    this.status = status;
    this.name = 'LibraryAccessError';
  }
}
