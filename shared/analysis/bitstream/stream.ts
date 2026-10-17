import type { AnalysisPacket } from './input.ts';
import type { AnalysisGop } from './contract.ts';

/** Confirmed contiguous decode-order prefix; null is allowed only for a
 * complete index whose adapter does not expose a packet count. */
export interface AnalysisIndexFrontier { packets: number | null; complete: boolean }
export interface StreamProgress {
  indexComplete?: boolean;
  waitingForIndex?: boolean;
  checkedUs: number;
  totalUs: number;
  pictures: number;
  totalPictures: number | null;
  gopStartAu?: number;
}

/** Container key markers partition decode/AU order. They do not prove that a
 * group can be decoded independently; only inspected syntax proves a closed anchor. */
export function groupAnalysisGops(packets: readonly AnalysisPacket[]) {
  const groups: AnalysisGop[] = [];
  for (const packet of packets) {
    const previous = groups[groups.length - 1];
    if (!previous || packet.key || packet.discontinuity || packet.configuration !== previous.configuration) {
      if (previous) previous.endAu = packet.au;
      groups.push({ startAu: packet.au, endAu: packets.at(-1)!.au + 1,
        configuration: packet.configuration, anchor: 'unknown' });
    }
  }
  return groups;
}

/** Select complete decode-order GOPs intersecting the visible chart clock. */
export function viewportAnalysisGops(packets: readonly AnalysisPacket[], firstPtsUs: number, window: { startUs: number; endUs: number; axis: 'pts' | 'dts' }) {
  const groups = groupAnalysisGops(packets);
  const selected = new Set<number>();
  for (const packet of packets) {
    const time = window.axis === 'dts' ? packet.dts : packet.pts;
    if (time != null && time - firstPtsUs >= window.startUs && time - firstPtsUs < window.endUs) selected.add(gopForAu(groups, packet.au).startAu);
  }
  return groups.filter(group => selected.has(group.startAu));
}

export function gopForAu(groups: readonly AnalysisGop[], au: number): AnalysisGop {
  let lo = 0, hi = groups.length;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >>> 1;
    if (groups[mid].startAu <= au) lo = mid; else hi = mid;
  }
  const group = groups[lo];
  if (!group || au < group.startAu || au >= group.endAu) throw new Error('Invalid GOP membership');
  return group;
}
