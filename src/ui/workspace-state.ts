import type { MediaInfo, Mark, FrameInfo, Slot } from '../model.ts';

export type Panel = 'inspector' | 'subtracks' | 'sources';
export type ReviewTrack = MediaInfo & { slot: Slot; frame: FrameInfo | null; offsetUs?:number };

/** UI-only selection never replaces a media source or changes playback. */
export class WorkspaceState {
  panels: Record<Panel, boolean> = { inspector: false, subtracks: false, sources: false };
  selected: Slot = 'A';
  setPanel(panel: Panel, open: boolean, _width = Infinity) {
    this.panels[panel] = open;

  }
  reconcile(tracks: ReviewTrack[]) {
    if (!tracks.some(t => t.slot === this.selected)) this.selected = tracks[0]?.slot ?? 'A';
  }
}

export function marksForTrack(track: ReviewTrack, marks: Mark[]) {
  // Slot names are reusable. A mark from a replaced file must not appear on
  // the newly loaded file simply because both occupied A.
  return marks.filter(m => m.mediaId === track.id).sort((a, b) => a.frame.ptsUs - b.frame.ptsUs);
}

export function trackTiming(track: ReviewTrack, positionUs: number) {
  return {
    offsetUs: track.offsetUs ?? 0,
    frameDeltaUs: track.frame ? track.frame.ptsUs + (track.offsetUs ?? 0) - positionUs : null,
  };
}

/** The nearest row owns gaps and the trailing blank area of the track list. */
export function nearestTrackIndex(y: number, rows: { top: number; bottom: number }[]): number {
  if (!rows.length || !Number.isFinite(y)) return -1;
  let nearest = 0, distance = Infinity;
  rows.forEach((row, index) => {
    const d = y < row.top ? row.top - y : y > row.bottom ? y - row.bottom : 0;
    if (d < distance) { distance = d; nearest = index; }
  });
  return nearest;
}
