export { ffmpegColorInfo } from '../../shared/media/ffmpeg-color.ts';
const LABELS: Record<string, string> = {
  bt709:'BT.709',bt2020:'BT.2020','bt2020-ncl':'BT.2020 NCL','bt2020-cl':'BT.2020 CL',
  'bt2020-10':'BT.2020 (10-bit)','bt2020-12':'BT.2020 (12-bit)',
  pq:'PQ (ST 2084)',smpte2084:'PQ (ST 2084)',hlg:'HLG (ARIB B67)','arib-std-b67':'HLG (ARIB B67)',
  'display-p3':'Display P3',smpte432:'Display P3',smpte431:'DCI-P3',smpte428:'SMPTE ST 428',
  bt470m:'BT.470 M',bt470bg:'BT.470 BG',smpte170m:'SMPTE 170M',smpte240m:'SMPTE 240M',
  'iec61966-2-1':'sRGB',linear:'Linear',rgb:'RGB',ictcp:'ICtCp',ycgco:'YCgCo',
};
export const colorLabel = (value: string | null | undefined) => value ? LABELS[value] ?? value : '未标记';
export const rangeLabel = (fullRange: boolean | null | undefined) => fullRange == null ? '未标记' : fullRange ? '全范围 (PC)' : '有限范围 (TV)';
