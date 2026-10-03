import { t, msg } from '../i18n.ts';
import type { CacheEntry } from '../../server/caches.ts';
import type { RootReasonCode } from '../../server/admin.ts';
/** Actionable UI context plus unchanged diagnostic, never raw-text branching. */
export function requestError(error: unknown) {
  const value = error as {status?: number; message?: string; code?: string};
  const summary = value.code === 'measurement-busy' ? t(msg('admin.measureBusyError', '已有测速任务。请等待完成，或取消当前任务后重试。'))
    : value.code === 'measurement-media-changed' ? t(msg('admin.measureMediaError', '媒体不可读或版本已改变。请重新选择当前可读的非空媒体。'))
    : value.code === 'measurement-finish-pending' ? t(msg('admin.measureFinishError', '当前读取仍在结束。请稍等片刻再提交测量结果。'))
    : value.status === 409 ? t(msg('admin.errorConflict', '内容已改变。请载入最新版本后重试；你的草稿仍保留。'))
    : value.status === 404 ? t(msg('admin.errorMissing', '内容已不存在。请刷新列表后重试。'))
    : value.status === 403 ? t(msg('admin.errorAccess', '操作未获授权。请从服务器的同源页面重试。'))
    : value.status === 413 ? t(msg('admin.errorSize', '提交内容过大。请减少数据量后重试。'))
    : value.status && value.status < 500 ? t(msg('admin.errorInvalid', '请求无法处理。请检查输入和当前版本后重试。'))
    : t(msg('admin.errorUnavailable', '无法完成请求。请检查连接与服务状态后重试。'));
  return t(msg('admin.errorDiagnostic', '{summary}\n原始原因：{reason}'), {summary, reason: value.message ?? String(error)});
}
export function rootReason(code: RootReasonCode | null | undefined, raw: string | null | undefined) {
  const values = {
    'external-change': t(msg('admin.rootExternal', '配置文件已被外部修改，请重启服务以重新载入。')),
    'cli-override': t(msg('admin.rootCli', '当前根目录由 --folder 覆盖，请修改启动参数或改用配置文件。')),
    'no-source': t(msg('admin.rootNoSource', '此服务未提供可写配置来源。')),
    'not-writable': t(msg('admin.rootPermission', '配置所在目录不可写，请调整数据目录权限。')),
  };
  return code ? values[code] : raw ?? '';
}
export function cacheName(entry: CacheEntry) { return entry.nameCode === 'frame-annotation' ? t(msg('sync.frameMark', '画面标注')) : entry.name; }
export function cacheDetail(entry: CacheEntry) {
  const detail = entry.detailData;
  if (!detail) return entry.detail;
  if (detail.kind === 'frames') return t(msg('admin.detailFrames', '{root} · {format} · {frames, plural, other {# 帧}}'), {root:detail.root,format:detail.format,frames:detail.frames});
  if (detail.kind === 'thumbnail') return `${detail.root} · ${detail.width}×${detail.height}`;
  return `${detail.space} · ${detail.text || t(msg('sync.frameMark', '画面标注'))}`;
}
