/** Single identity contract for workspace restore, share links and relinking.
 *
 * A media file is identified by (basename, size). A bare lastModified drift
 * (touch, backup restore, permission change, editor rewrite preserving bytes)
 * is accepted with a warning instead of failing the restore; the pinned `?v=`
 * version stays a byte-serving cache key and is no longer part of identity,
 * because server ctime/inode churn rotates it without byte changes.
 */
export type MediaIdentityMeta = { name: string; size: number; lastModified: number };
export type MediaIdentityMismatch = { field: 'name' | 'size'; expected: string | number; actual: string | number };
export type MediaIdentityMatch =
  | { ok: true; mtimeChanged: boolean }
  | { ok: false; mismatches: MediaIdentityMismatch[] };

export const mediaBasename = (name: string) => name.split('/').at(-1) ?? name;

export function matchMediaIdentity(record: MediaIdentityMeta, candidate: MediaIdentityMeta): MediaIdentityMatch {
  const mismatches: MediaIdentityMismatch[] = [];
  if (mediaBasename(candidate.name) !== mediaBasename(record.name)) {
    mismatches.push({ field: 'name', expected: mediaBasename(record.name), actual: mediaBasename(candidate.name) });
  }
  if (candidate.size !== record.size) mismatches.push({ field: 'size', expected: record.size, actual: candidate.size });
  if (mismatches.length) return { ok: false, mismatches };
  return { ok: true, mtimeChanged: candidate.lastModified !== record.lastModified };
}

export const describeMediaMismatch = (displayName: string, mismatches: MediaIdentityMismatch[]) =>
  `片源 ${displayName} 已发生变化，与工作区记录不一致（${mismatches.map(m => m.field === 'name' ? `文件名 ${m.expected} → ${m.actual}` : `大小 ${m.expected} → ${m.actual}`).join('、')}）。请重新选择片源并检查标注。`;

export const mediaMtimeWarning = (displayName: string) =>
  `「${displayName}」修改时间与工作区记录不一致，已按同名同大小文件恢复；如内容被替换请重新检查标注。`;
