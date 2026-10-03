import { indexProgressLabel } from './index-progress.ts';
import { getLocale, onLanguageChange, t, msg , th } from '../i18n.ts';
import { loadStageLabel } from './media-progress.ts';
import type { ReviewSession } from '../session.ts';

/** One persistent view of the shared session's load, including Agent loads. */
export function installSourceActivity(session: ReviewSession, signal: AbortSignal) {
  const panel = document.getElementById('source-activity')!;
  const stage = document.getElementById('source-activity-stage')!;
  const name = document.getElementById('source-activity-name')!;
  const elapsed = document.getElementById('source-activity-time')!;
  const hint = document.getElementById('source-activity-hint')!;
  const cancel = document.getElementById('source-activity-cancel')!;
  let status = session.getState().mediaLoad;
  const progress = document.createElement('progress'); progress.max = 1; progress.hidden = true; progress.setAttribute('aria-label', t(msg("activity.scanProgress", "帧索引扫描进度"))); panel.append(progress);
  let timer: ReturnType<typeof setInterval> | undefined;
  function clock() {
    if (!status) { elapsed.textContent = ''; hint.textContent = ''; return; }
    const seconds = Math.max(0, Math.floor(((status.finishedAt ?? Date.now()) - status.startedAt) / 1000));
    const duration = seconds >= 60 ? t(msg("activity.durationMinutesSeconds", "{m} 分 {s} 秒"), { m: Math.floor(seconds / 60), s: seconds % 60 }) : t(msg("activity.durationSeconds", "{s} 秒"), { s: seconds });
    elapsed.textContent = `${t(status.state === 'loading' ? msg("activity.elapsedWaiting", "已等待") : msg("activity.elapsedSpent", "用时"))} ${duration}`;
    hint.textContent = status.state === 'error' ? t(msg("activity.loadFailedAtStage", "{stage}时失败：{error}"), { stage: loadStageLabel(status.stage), error: status.error ?? t(msg("activity.retryOrPickAnother", "请重试或选择其他片源")) }) : status.state === 'loading' && seconds >= 10 ? t(msg("activity.stillWorking", "仍在处理，可取消或选择其他视频")) : '';
    if (status.state === 'loading' && status.targetPtsUs !== undefined && ['index', 'synchronize'].includes(status.stage)) {
      // Index progress lives in the progress bar; keep the hint line empty so
      // the panel height stays put while it advances.
      hint.textContent = '';
    }
  }
  function render() {
    status = session.getState().mediaLoad;
    const active = status?.state === 'loading';
    panel.dataset.state = status?.state ?? 'idle';
    // The meter is overlaid (no layout shift), so loading visuals appear immediately.
    panel.classList.toggle('show-loading', active);
    let label = !status ? t(msg("activity.waitingForSource", "等待添加片源")) : active ? loadStageLabel(status.stage) : { complete: t(msg("activity.presented", "已上屏")), cancelled: t(msg("activity.loadCancelled", "已取消载入")), error: t(msg("activity.loadFailedState", "载入失败")), loading: '' }[status.state];
    const building = session.getState().tracks.filter(t => !t.failure && t.indexState === 'building');
    progress.hidden = active ? !status?.indexProgress : !building.length;
    if (active && status?.indexProgress) {
      const p = status.indexProgress; progress.value = p.totalBytes > 0 ? p.scannedBytes / p.totalBytes : 0;
      label += ` · ${(progress.value * 100).toFixed(1)}%`;
    } else if (!progress.hidden) {
      label = t(msg("activity.buildingIndexes", "已上屏 · {count} 条轨道正在建立索引"), { count: building.length });
      const scanned = building.reduce((n, t) => n + (t.indexProgress?.scannedBytes ?? 0), 0);
      const total = building.reduce((n, t) => n + (t.indexProgress?.totalBytes ?? t.size), 0);
      progress.value = total > 0 ? scanned / total : 0;
    }
    // Do not re-announce elapsed time or unrelated session updates to screen readers.
    if (stage.textContent !== label) stage.textContent = label;
    name.textContent = status ? t(msg("activity.sourceTrack", "{name} · 轨道 {slot}"), { name: status.name, slot: status.slot }) : '';
    name.hidden = !status;
    name.title = status?.name ?? '';
    cancel.hidden = !active;
    clock();
    if (!active && building.length) hint.textContent = building.map(track => t(msg("activity.trackIndexProgress", "轨道 {slot}：{progress}"), { slot: track.slot, progress: indexProgressLabel(track) })).join(getLocale() === 'en' ? '; ' : '；');
    if (active && !timer) timer = setInterval(clock, 1000);
    else if (!active && timer) { clearInterval(timer); timer = undefined; }
  }
  cancel.addEventListener('click', () => session.cancelLoad(), { signal });
  const unsubscribe = session.subscribe(render);
  const stopLanguage = onLanguageChange(() => { progress.setAttribute('aria-label', t(msg("activity.scanProgress", "帧索引扫描进度"))); render(); }, signal);
  // The foot (local files + activity) floats over the panel bottom; its
  // height varies, so reserve exactly its measured height for the list above.
  // The reserve resizes the observed list, so it must not land synchronously
  // inside delivery: coalesce to rAF or WebKit reports the undeliverable
  // follow-up notification as a page error.
  const foot = document.getElementById('source-foot')!;
  let reserveQueued = false;
  const reserve = () => {
    if (reserveQueued) return;
    reserveQueued = true;
    requestAnimationFrame(() => {
      reserveQueued = false;
      foot.parentElement?.style.setProperty('--foot-h', `${foot.offsetHeight}px`);
    });
  };
  const observer = new ResizeObserver(reserve); observer.observe(foot); reserve();
  signal.addEventListener('abort', () => { stopLanguage(); unsubscribe(); clearInterval(timer); observer.disconnect(); progress.remove(); }, { once: true });
  render();
}
