import type { ReviewSession } from '../session.ts';
import type { Slot } from '../../shared/review/model.ts';
import type { AnalysisRank } from '../../shared/analysis/metadata/types.ts';
import { SLOTS, formatTime } from '../../shared/review/model.ts';
import { t, msg } from '../i18n.ts';

type Track = ReturnType<ReviewSession['getState']>['tracks'][number];
type Position = { track: Track; key: string; rank?: AnalysisRank; pending: boolean; chars: number };

/** Read-only PTS ranks remain visible while the next presented frame is queried. */
export function installFramePositions(session: ReviewSession, signal: AbortSignal) {
  const positions = new Map<Slot, Position>();
  let frameMode = false;
  const buttons = new Map(SLOTS.map(slot => [slot, document.getElementById(`pts-${slot}`) as HTMLButtonElement]));

  function render(slot: Slot) {
    const button = buttons.get(slot)!, position = positions.get(slot), track = position?.track;
    const frames = frameMode, rank = position?.rank;
    const text = !track?.frame ? '—' : !frames ? formatTime(track.frame.ptsUs)
      : rank ? `PTS#${rank.rank}${rank.complete ? '' : '~'}` : position?.pending ? 'PTS#…' : 'PTS#—';
    if (button.textContent !== text) button.textContent = text;
    button.style.setProperty('--frame-position-chars', String(position?.chars ?? 9));
    button.setAttribute('aria-busy', String(frames && !!position?.pending));
    button.disabled = !track?.frame;
    const action = frames ? t(msg('player.showFrameTime', '切换为帧时间')) : t(msg('player.showPtsFrameNumber', '切换为 PTS 序帧号'));
    button.setAttribute('aria-label', t(msg('player.toggleFramePosition', '轨道 {slot}：{value}，{action}'), { slot, value: text, action }));
    button.title = action + (track?.frame ? '\n' + t(msg('player.sourceTimestampSFrameDurationS', '源时间戳 {p0} µs · 帧时长 {p1} µs'),
      { p0: track.frame.sourcePtsUs, p1: track.frame.durationUs }) : '');
  }

  function update(tracks: readonly Track[]) {
    for (const slot of SLOTS) {
      const track = tracks.find(track => track.slot === slot), previous = positions.get(slot);
      if (!track?.frame) {
        positions.delete(slot);
        render(slot);
        continue;
      }
      const sameSource = previous?.track.id === track.id && previous.track.sourceGen === track.sourceGen;
      const key = `${track.frame.ptsUs}:${track.offsetUs}:${track.indexState}:${track.indexProgress?.packets}`;
      const position: Position = sameSource && previous.key === key ? previous
        : { track, key, rank: sameSource ? previous.rank : undefined, pending: false, chars: sameSource ? previous.chars : 9 };
      position.track = track;
      positions.set(slot, position);
      if (frameMode && position !== previous) fetchRank(slot, position);
      render(slot);
    }
  }

  function fetchRank(slot: Slot, position: Position) {
    position.pending = true;
    const track = position.track;
    void session.rankAnalysisFrame(slot, track.frame!.ptsUs + track.offsetUs, 'pts').then(result => {
      if (signal.aborted || positions.get(slot) !== position) return;
      if ('rank' in result) {
        position.rank = result;
        position.chars = Math.max(position.chars, String(Math.max(result.rank, result.total - 1)).length + 5);
      }
    }).catch(() => { /* Retain the last confirmed rank until the next frame/index update. */ }).finally(() => {
      if (signal.aborted || positions.get(slot) !== position) return;
      position.pending = false;
      render(slot);
    });
  }

  for (const button of buttons.values()) button.addEventListener('click', () => {
    frameMode = !frameMode;
    for (const slot of SLOTS) {
      const position = positions.get(slot);
      if (frameMode && position && !position.pending) fetchRank(slot, position);
      render(slot);
    }
  }, { signal });
  return { update };
}
