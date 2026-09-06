import type { ColorInfo } from './model.ts';

// FFmpeg AVColor* enums (libavutil/pixfmt.h), shared by container and packet paths.
const PRIMARIES: Record<number, string> = { 1:'bt709',4:'bt470m',5:'bt470bg',6:'smpte170m',7:'smpte240m',8:'film',9:'bt2020',10:'smpte428',11:'smpte431',12:'display-p3',22:'ebu3213' };
const TRANSFER: Record<number, string> = { 1:'bt709',4:'gamma22',5:'gamma28',6:'smpte170m',7:'smpte240m',8:'linear',9:'log100',10:'log316',11:'iec61966-2-4',12:'bt1361',13:'iec61966-2-1',14:'bt2020-10',15:'bt2020-12',16:'pq',17:'smpte428',18:'hlg' };
const MATRIX: Record<number, string> = { 0:'rgb',1:'bt709',4:'fcc',5:'bt470bg',6:'smpte170m',7:'smpte240m',8:'ycgco',9:'bt2020-ncl',10:'bt2020-cl',11:'smpte2085',12:'chroma-derived-ncl',13:'chroma-derived-cl',14:'ictcp',15:'ipt-c2',16:'ycgco-re',17:'ycgco-ro' };
const tagged = (map: Record<number, string>, value?: number) => value == null || value === 2 ? null : map[value] ?? `未识别 (${value})`;
export function ffmpegColorInfo(values: { colorPrimaries?: number; colorTransfer?: number; colorSpace?: number; colorRange?: number }): ColorInfo {
  return { primaries: tagged(PRIMARIES,values.colorPrimaries), transfer: tagged(TRANSFER,values.colorTransfer), matrix: tagged(MATRIX,values.colorSpace),
    // AVCOL_RANGE_MPEG = 1 (TV), AVCOL_RANGE_JPEG = 2 (PC); 0 is unspecified.
    fullRange: values.colorRange === 2 ? true : values.colorRange === 1 ? false : null };
}
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
