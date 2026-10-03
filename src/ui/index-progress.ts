import { msg, t, formatNumber } from '../i18n.ts';
import type { MediaInfo } from '../model.ts';
export function indexProgressLabel(info: Pick<MediaInfo, 'indexState' | 'indexProgress' | 'indexWaiting'>): string {
  if(info.indexState !== 'building')return '';
  const p=info.indexProgress; const percent=p&&p.totalBytes>0?Math.min(99.9,100*p.scannedBytes/p.totalBytes).toFixed(1):'0.0';
  return t(msg("index.progress", "{waiting, select, yes {等待索引数据} other {正在建立索引}} {percent}%{packets, select, none {} other { · {packets} 包}}"), {waiting:info.indexWaiting?'yes':'no',percent,packets:p?formatNumber(p.packets):'none'});
}
