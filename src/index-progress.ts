import type { MediaInfo } from './model.ts';
export function indexProgressLabel(info: Pick<MediaInfo, 'indexState' | 'indexProgress' | 'indexWaiting'>): string {
  if (info.indexState !== 'building') return '';
  const p = info.indexProgress;
  const percent = p && p.totalBytes > 0 ? Math.min(99.9, 100 * p.scannedBytes / p.totalBytes).toFixed(1) : '0.0';
  return `${info.indexWaiting ? '等待索引数据' : '正在建立索引'} ${percent}%${p ? ` · ${p.packets.toLocaleString()} 包` : ''}`;
}
