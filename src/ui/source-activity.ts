import type { ReviewSession } from '../session.ts';
import { loadStages } from '../media-progress.ts';

/** One persistent view of the shared session's load, including Agent loads. */
export function installSourceActivity(session: ReviewSession, signal: AbortSignal) {
  const panel = document.getElementById('source-activity')!;
  const stage = document.getElementById('source-activity-stage')!;
  const name = document.getElementById('source-activity-name')!;
  const elapsed = document.getElementById('source-activity-time')!;
  const hint = document.getElementById('source-activity-hint')!;
  const cancel = document.getElementById('source-activity-cancel')!;
  let status = session.getState().mediaLoad;
  let timer: ReturnType<typeof setInterval> | undefined;
  function clock() {
    if (!status) { elapsed.textContent = ''; hint.textContent = ''; return; }
    const seconds = Math.max(0, Math.floor(((status.finishedAt ?? Date.now()) - status.startedAt) / 1000));
    const duration = seconds >= 60 ? `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒` : `${seconds} 秒`;
    elapsed.textContent = `${status.state === 'loading' ? '已等待' : '用时'} ${duration}`;
    hint.textContent = status.state === 'error' ? `${loadStages[status.stage].replace('正在', '')}时失败：${status.error ?? '请重试或选择其他片源'}` : status.state === 'loading' && seconds >= 10 ? '仍在处理，可取消或选择其他视频' : '';
  }
  function render() {
    status = session.getState().mediaLoad;
    const active = status?.state === 'loading';
    panel.dataset.state = status?.state ?? 'idle';
    const label = !status ? '等待添加片源' : active ? loadStages[status.stage] : { complete: '已上屏', cancelled: '已取消载入', error: '载入失败', loading: '' }[status.state];
    // Do not re-announce elapsed time or unrelated session updates to screen readers.
    if (stage.textContent !== label) stage.textContent = label;
    name.textContent = status ? `${status.name} · 轨道 ${status.slot}` : '点击片源旁的 + 添加到视图';
    name.title = status?.name ?? '';
    cancel.hidden = !active;
    clock();
    if (active && !timer) timer = setInterval(clock, 1000);
    else if (!active && timer) { clearInterval(timer); timer = undefined; }
  }
  cancel.addEventListener('click', () => session.pause(), { signal });
  const unsubscribe = session.subscribe(render);
  signal.addEventListener('abort', () => { unsubscribe(); clearInterval(timer); }, { once: true });
  render();
}
