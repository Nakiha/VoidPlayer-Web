import { t, msg } from '../i18n.ts';

import type { LibraryAccessProblem, LocalAccessProblem } from '../../shared/media/io/source-access.ts';

/** Shared reasons for history rows and workspace restoration. */
export function libraryAccessMessage(name: string, reason: LibraryAccessProblem) {
  if (reason === 'missing') return t(msg('sourceAccess.libraryMissing', '无法打开「{name}」：文件已移除'), { name });
  if (reason === 'changed') return t(msg('sourceAccess.libraryChanged', '无法打开「{name}」：文件版本已变化'), { name });
  return t(msg('sourceAccess.libraryUnavailable', '无法打开「{name}」：媒体库暂不可用'), { name });
}


export function localAccessMessage(name: string, reason: LocalAccessProblem) {
  if (reason === 'unsupported') return t(msg('sourceAccess.localUnsupported', '当前浏览器不支持保存本地文件访问权限，无法直接恢复「{name}」，请重新选择文件；刷新后仍需重新选择'), { name });
  if (reason === 'denied') return t(msg('sources.accessDenied', '已拒绝访问本地文件 {name}，如需打开请重新选择'), { name });
  if (reason === 'stale') return t(msg('sourceAccess.localStale', '无法打开本地文件「{name}」：文件已变化或不可用'), { name });
  return t(msg('sources.accessExpired', '本地文件访问已过期，请重新选择 {name}'), { name });
}
