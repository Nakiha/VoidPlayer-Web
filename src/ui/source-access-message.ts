import { t, msg } from '../i18n.ts';

import type { LibraryAccessProblem, LocalAccessProblem } from '../source-access.ts';

/** Shared reasons for history rows and workspace restoration. */
export function libraryAccessMessage(name: string, reason: LibraryAccessProblem) {
  if (reason === 'missing') return t(msg('sourceAccess.libraryMissing', '媒体库引用「{name}」已失效或文件已移除，请在媒体库中重新选择。'), { name });
  if (reason === 'changed') return t(msg('sourceAccess.libraryChanged', '媒体库文件「{name}」与保存的版本不一致，请重新选择并检查标注。'), { name });
  return t(msg('sourceAccess.libraryUnavailable', '无法确认媒体库引用「{name}」，请检查服务连接后重试。'), { name });
}


export function localAccessMessage(name: string, reason: LocalAccessProblem) {
  if (reason === 'unsupported') return t(msg('sourceAccess.localUnsupported', '当前浏览器不支持保存本地文件访问权限，无法直接恢复「{name}」。请重新选择文件；刷新后仍需重新选择。'), { name });
  if (reason === 'denied') return t(msg('sources.accessDenied', '已拒绝访问本地文件 {name}，如需打开请重新选择'), { name });
  if (reason === 'stale') return t(msg('sourceAccess.localStale', '本地文件「{name}」已变化或不可用，请重新选择并检查标注。'), { name });
  return t(msg('sources.accessExpired', '本地文件访问已过期，请重新选择 {name}'), { name });
}
