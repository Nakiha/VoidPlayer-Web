import { indexProgressLabel } from './index-progress.ts';
import { onLanguageChange, t, msg } from '../i18n.ts';
import { loadStageLabel } from './media-progress.ts';
import { icon } from './icons.ts';
import { progressRingMarkup } from './progress-ring.ts';
import type { MediaLoadStatus } from '../media-progress.ts';
import type { ReviewSession } from '../session.ts';

/** One persistent view of the shared session's load, including Agent loads. */
export function installSourceActivity(session: ReviewSession, signal: AbortSignal, locate: (slot: string) => void = () => {}) {
  const panel = document.getElementById('source-activity')!;
  const stage = document.getElementById('source-activity-stage')!;
  const name = document.getElementById('source-activity-name')!;
  const elapsed = document.getElementById('source-activity-time')!;
  const hint = document.getElementById('source-activity-hint')!;
  const cancel = document.getElementById('source-activity-cancel')!;
  const tabs = document.getElementById('source-activity-tracks')!;
  const details = document.getElementById('source-activity-details')!;
  const size = document.getElementById('source-activity-size')!;
  const stateIcon = document.getElementById('source-activity-state-icon')!;
  const toggle = document.getElementById('source-activity-toggle')!;
  const loads = new Map<string, { status: MediaLoadStatus; mediaId?: string; sourceGen?: number }>();
  let selected = '', latest = '', tabsSignature = '';
  let expanded = false, iconName = '';
  let status: MediaLoadStatus | null = null, trackFailure = '';
  elapsed.innerHTML = icon('clock');
  const durationText = document.createTextNode(''); elapsed.append(durationText);
  let timer: ReturnType<typeof setInterval> | undefined;
  function clock() {
    elapsed.hidden = !status;
    if (!status) { durationText.textContent = ''; hint.textContent = trackFailure; hint.hidden = !trackFailure; return; }
    const seconds = Math.max(0, Math.floor(((status.finishedAt ?? Date.now()) - status.startedAt) / 1000));
    const duration = seconds >= 60 ? t(msg("activity.durationMinutesSeconds", "{m} 分 {s} 秒"), { m: Math.floor(seconds / 60), s: seconds % 60 }) : t(msg("activity.durationSeconds", "{s} 秒"), { s: seconds });
    durationText.textContent = duration;
    elapsed.title = t(status.state === 'loading' ? msg("activity.elapsedWaiting", "已等待") : msg("activity.elapsedSpent", "用时"));
    hint.textContent = status.state === 'error' ? t(msg("activity.loadFailedAtStage", "{stage}时失败：{error}"), { stage: loadStageLabel(status.stage), error: status.error ?? t(msg("activity.retryOrPickAnother", "请重试或选择其他片源")) }) : status.state === 'loading' && seconds >= 10 ? t(msg("activity.stillWorking", "仍在处理，可取消或选择其他视频")) : '';
    if (status.state === 'loading' && status.targetPtsUs !== undefined && ['index', 'synchronize'].includes(status.stage)) {
      // Index progress lives in the track circle; keep the hint line empty so
      // the panel height stays put while it advances.
      hint.textContent = '';
    }
    if (trackFailure) hint.textContent = trackFailure;
    hint.hidden = !hint.textContent && status.state !== 'loading';
  }
  function revealSelected() {
    const button = document.getElementById(`source-activity-track-${selected}`);
    if (!button) return;
    // Scroll only the horizontal list; never move the surrounding media pane.
    const left = button.offsetLeft, right = left + button.offsetWidth;
    if (left < tabs.scrollLeft) tabs.scrollLeft = left;
    else if (right > tabs.scrollLeft + tabs.clientWidth) tabs.scrollLeft = right - tabs.clientWidth;
  }
  function render() {
    const state = session.getState(), incoming = state.mediaLoad;
    const bySlot = new Map(state.tracks.map(track => [track.slot as string, track]));
    let reveal = false;
    if (incoming) {
      const key = `${incoming.slot}:${incoming.startedAt}`;
      if (key !== latest) { latest = key; selected = incoming.slot; loads.set(incoming.slot, { status: incoming }); reveal = true; }
      const record = loads.get(incoming.slot);
      if (record) {
        record.status = incoming;
        if (incoming.state === 'complete') {
          const track = bySlot.get(incoming.slot);
          // A replacement or restored scene must not inherit another source's timing.
          if (!record.mediaId && track) { record.mediaId = track.id; record.sourceGen = track.sourceGen; }
        }
      }
    }
    for (const [slot, record] of loads) {
      const track = bySlot.get(slot);
      if ((!track && (slot !== incoming?.slot || record.status.state === 'complete'))
        || (record.status.state === 'complete' && track && (record.mediaId !== track.id || record.sourceGen !== track.sourceGen))) loads.delete(slot);
    }
    const slots: string[] = state.tracks.map(track => track.slot);
    if (incoming && incoming.state !== 'complete' && !slots.includes(incoming.slot)) slots.push(incoming.slot);
    if (!slots.includes(selected)) selected = slots[0] ?? '';
    const signature = slots.join(',');
    const tracksChanged = signature !== tabsSignature;
    if (tracksChanged) {
      tabsSignature = signature;
      tabs.replaceChildren(...slots.map(slot => {
        const button = document.createElement('button'); button.type = 'button';
        button.id = `source-activity-track-${slot}`; button.className = 'source-activity-track';
        button.dataset.slot = slot; button.setAttribute('role', 'tab'); button.setAttribute('aria-controls', details.id);
        const badge = document.createElement('span'); badge.className = `slot slot-${slot}`; badge.textContent = slot; button.append(badge);
        const progress = document.createElement('span'); progress.className = 'source-activity-track-progress analysis-track-progress';
        progress.setAttribute('role', 'progressbar'); progress.setAttribute('aria-valuemin', '0'); progress.setAttribute('aria-valuemax', '100');
        progress.innerHTML = progressRingMarkup; button.append(progress);
        progress.addEventListener('transitionend', event => { if (event.propertyName === 'width' && selected === slot) revealSelected(); }, { signal });
        button.addEventListener('click', () => { selected = slot; render(); revealSelected(); locate(slot); }, { signal });
        button.addEventListener('keydown', event => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
          event.preventDefault();
          const index = event.key === 'Home' ? 0 : event.key === 'End' ? slots.length - 1 : (slots.indexOf(slot) + (event.key === 'ArrowLeft' ? -1 : 1) + slots.length) % slots.length;
          selected = slots[index]; render(); revealSelected(); document.getElementById(`source-activity-track-${selected}`)?.focus({ preventScroll: true });
        }, { signal });
        return button;
      }));
    }
    for (const button of tabs.querySelectorAll<HTMLButtonElement>('button')) {
      const slot = button.dataset.slot!, on = selected === slot, record = loads.get(slot), track = bySlot.get(slot);
      const loading = record?.status.state === 'loading';
      const building = !!track && !track.failure && (!record || record.status.state === 'complete') && track.indexState === 'building';
      const pending = loading || building;
      const p = loading ? record!.status.indexProgress : building ? track!.indexProgress : undefined;
      const percent = p && p.totalBytes > 0 ? Math.min(100, Math.max(0, p.scannedBytes / p.totalBytes * 100)) : null;
      const label = loading ? loadStageLabel(record!.status.stage) : building ? indexProgressLabel(track!) : record?.status.state === 'error' || track?.failure ? t(msg('activity.presentationFailed', '上屏失败')) : record?.status.state === 'cancelled' ? t(msg('activity.loadCancelled', '已取消载入')) : t(msg('activity.presented', '已上屏'));
      button.setAttribute('aria-selected', String(on)); button.tabIndex = on ? 0 : -1;
      button.setAttribute('aria-label', t(msg('activity.trackDetails', '查看轨道 {slot} 的上屏信息'), { slot }));
      button.title = `${track?.name ?? record?.status.name ?? ''} · ${label}`;
      button.setAttribute('aria-description', label);
      button.dataset.state = pending ? 'pending' : record?.status.state === 'error' || track?.failure ? 'error' : 'ready';
      const progress = button.querySelector<HTMLElement>('.source-activity-track-progress')!;
      progress.setAttribute('aria-label', label); progress.setAttribute('aria-hidden', String(!pending));
      if (percent === null) progress.removeAttribute('aria-valuenow'); else progress.setAttribute('aria-valuenow', String(percent));
      progress.style.setProperty('--inspection-progress', String(100 - (percent ?? 0)));
      progress.classList.toggle('is-waiting', percent === null);
    }
    tabs.hidden = !slots.length;
    panel.hidden = !slots.length;
    toggle.hidden = !slots.length;
    toggle.setAttribute('aria-expanded', String(expanded));
    toggle.setAttribute('aria-label', t(expanded ? msg('activity.collapseDetails', '折叠上屏详情') : msg('activity.expandDetails', '展开上屏详情')));
    panel.dataset.expanded = String(expanded);
    details.setAttribute('aria-hidden', String(!expanded));
    details.inert = !expanded;
    if (selected) details.setAttribute('aria-labelledby', `source-activity-track-${selected}`); else details.removeAttribute('aria-labelledby');
    const track = bySlot.get(selected);
    status = loads.get(selected)?.status ?? null;
    const active = status?.state === 'loading';
    panel.dataset.state = status?.state ?? (track ? 'complete' : 'idle');
    let label = status ? active ? loadStageLabel(status.stage) : { complete: t(msg("activity.presented", "已上屏")), cancelled: t(msg("activity.loadCancelled", "已取消载入")), error: t(msg("activity.loadFailedState", "载入失败")), loading: '' }[status.state] : track ? t(msg("activity.presented", "已上屏")) : t(msg("activity.waitingForSource", "等待添加片源"));
    const shown = !!track && (!status || status.state === 'complete');
    trackFailure = shown ? track.failure?.message ?? '' : '';
    if (shown && track.failure) { label = t(msg('activity.presentationFailed', '上屏失败')); panel.dataset.state = 'error'; }
    else if (shown && track.visible === false) label = t(msg('activity.trackHidden', '已隐藏'));
    const building = shown && !track.failure && track.indexState === 'building';
    if (active && status?.indexProgress) {
      const p = status.indexProgress;
      if (p.totalBytes > 0) label += ` · ${Math.min(100, Math.max(0, p.scannedBytes / p.totalBytes * 100)).toFixed(1)}%`;
    } else if (building) label = indexProgressLabel(track!);
    // Do not re-announce elapsed time or unrelated session updates to screen readers.
    if (stage.textContent !== label) stage.textContent = label;
    stage.title = label;
    const nextIcon = panel.dataset.state === 'error' ? 'close' : active || building ? 'refresh' : shown && track.visible === false ? 'eyeClosed' : shown ? 'check' : 'info';
    if (iconName !== nextIcon) { iconName = nextIcon; stateIcon.innerHTML = icon(nextIcon); }
    name.textContent = status?.name ?? track?.name ?? ''; name.hidden = !name.textContent; name.title = name.textContent;
    size.hidden = !shown || !!track.failure;
    size.innerHTML = icon('monitor');
    if (shown) size.append(document.createTextNode(`${track.output?.displayWidth ?? track.width}×${track.output?.displayHeight ?? track.height}`));
    cancel.hidden = incoming?.state !== 'loading';
    cancel.setAttribute('aria-label', t(msg('activity.cancelTrack', '取消载入轨道 {slot}'), { slot: incoming?.slot ?? '' }));
    cancel.title = cancel.getAttribute('aria-label')!;
    clock();
    if (reveal || tracksChanged) requestAnimationFrame(revealSelected);
    if (incoming?.state === 'loading' && !timer) timer = setInterval(clock, 1000);
    else if (incoming?.state !== 'loading' && timer) { clearInterval(timer); timer = undefined; }
  }
  cancel.addEventListener('click', () => session.cancelLoad(), { signal });
  toggle.addEventListener('click', () => { expanded = !expanded; render(); }, { signal });
  const unsubscribe = session.subscribe(render);
  const stopLanguage = onLanguageChange(render, signal);
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
  signal.addEventListener('abort', () => { stopLanguage(); unsubscribe(); clearInterval(timer); observer.disconnect(); }, { once: true });
  render();
}
