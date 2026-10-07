import { t, msg } from '../i18n.ts';
import type { ReviewSession } from '../session.ts';
import type { Slot } from '../model.ts';
import type { ToastStack } from './toast.ts';

type Track = ReturnType<ReviewSession['getState']>['tracks'][number];

/** Track notices follow session state; dismissing one does not replay it on each render. */
export function createTrackToasts(toasts: Pick<ToastStack, 'show'>, openLogs: () => void, signal: AbortSignal) {
  const notices = new Map<Slot, { signature: string; dismiss: () => void }>();
  signal.addEventListener('abort', () => {
    for (const notice of notices.values()) notice.dismiss();
    notices.clear();
  }, { once: true });

  return (tracks: readonly Track[]) => {
    if (signal.aborted) return;
    // Relink notices and their action are owned by workspace-transfer.
    const active = tracks.filter(track => !track.pendingRelink && (track.failure || track.syncState));
    const slots = new Set(active.map(track => track.slot));
    for (const [slot, notice] of notices) {
      if (!slots.has(slot)) { notice.dismiss(); notices.delete(slot); }
    }
    for (const track of active) {
      const signature = JSON.stringify([track.id, track.sourceGen, track.failure?.message, track.syncState]);
      if (notices.get(track.slot)?.signature === signature) continue;
      notices.get(track.slot)?.dismiss();
      const failed = !!track.failure;
      const dismiss = toasts.show(() => failed
        ? t(msg('player.trackDisabledFrameUpdatesHaveStoppedPlease', '轨道 {p0} 已停用 · 画面已停止更新。{p1} 请重新载入此片源。'), { p0: track.slot, p1: track.failure!.message })
        : t(msg('player.trackFrameNotSynchronizedOtherTracksContinue', '轨道 {p0} {p1} · 当前画面暂未同步，其他轨道继续播放。'), { p0: track.slot, p1: track.syncState === 'index-wait'
          ? t(msg('player.waitingForIndexData', '等待索引数据'))
          : t(msg('player.catchingUpToPlayback2', '正在追赶播放位置')) }), {
        kind: failed ? 'warning' : 'info', durationMs: 0,
        ...(failed ? { action: { label: () => t(msg('shell.logs', '日志')), onClick: openLogs } } : {}),
      });
      notices.set(track.slot, { signature, dismiss });
    }
  };
}
