import type { AnnotationEvent } from '../../shared/review/annotation-events.ts';
import { formatTime } from '../../shared/review/model.ts';
import { t, th, msg, formatDate, onLanguageChange } from '../i18n.ts';

export function annotationActivityShell() {
  return `<details id="annotation-activity" class="settings-section annotation-activity" hidden>
    <summary>${th(msg('activity.title', '评审活动'))}</summary>
    <p class="settings-caption" role="status"></p><ol></ol>
  </details>`;
}

/** A passive observer. Links only navigate after an explicit user action. */
export function installAnnotationActivity(signal: AbortSignal) {
  const root = document.getElementById('annotation-activity')!;
  let scope = 'local', events: AnnotationEvent[] = [], failed = false;
  function render() {
    root.hidden = scope === 'local';
    root.querySelector('summary')!.textContent = t(msg('activity.title', '评审活动')) + (events.length ? ` (${events.length})` : '');
    root.querySelector('p')!.textContent = failed
      ? t(msg('activity.disconnected', '活动连接中断，恢复后自动续读。'))
      : events.length ? t(msg('activity.recent', '共享评审空间的最近操作；不会改变当前播放。')) : t(msg('activity.empty', '此评审空间暂无操作记录。'));
    const list = root.querySelector('ol')!;
    const existing = new Map([...list.querySelectorAll<HTMLElement>('li')].map(row => [row.dataset.eventKey, row]));
    const rows = [...events].reverse().map(event => {
      const key = `${event.space}/${event.sequence}/${event.operationId}`;
      let row = existing.get(key);
      if (!row) {
        row = document.createElement('li'); row.dataset.eventKey = key;
        row.append(document.createElement('strong'), document.createElement('span'), document.createElement('span'), document.createElement('time'));
        if (event.action !== 'delete') row.append(document.createElement('a'));
      }
      row.dataset.operationId = event.operationId;
      const title = row.querySelector('strong')!;
      const action = t(event.action === 'delete' ? msg('activity.deleted', '删除标注') : event.action === 'restore' ? msg('activity.restored', '恢复标注') : msg('activity.saved', '保存标注'));
      const client = event.client.kind === 'agent' ? 'Agent' : event.client.kind === 'gui' ? 'GUI' : 'HTTP';
      title.textContent = `${event.actor.name} · ${client} · ${action}`;
      const target = row.querySelectorAll('span')[0]; target.textContent = `${event.target.name} · ${formatTime(event.target.frame.ptsUs)} · r${event.revision}`;
      const note = row.querySelectorAll('span')[1]; note.textContent = event.summary;
      const time = row.querySelector('time')!; time.dateTime = event.occurredAt; time.textContent = formatDate(event.occurredAt);
      if (event.action !== 'delete') {
        const open = row.querySelector('a')!;
        open.href = `/?annotation=${encodeURIComponent(event.id)}&space=${encodeURIComponent(event.space)}`;
        open.target = '_blank'; open.rel = 'noopener'; open.textContent = t(msg('activity.open', '在新窗口打开标注'));
      }
      return row;
    });
    // Keep existing nodes: replacing a link between pointerdown and click loses
    // both native activation and focus. Prepending an event does not move old rows.
    const wanted = new Set(rows);
    for (const row of existing.values()) if (!wanted.has(row) && !row.contains(document.activeElement)) row.remove();
    let next = list.firstChild;
    for (const row of rows) {
      if (row === next) next = next.nextSibling;
      else list.insertBefore(row, next);
    }
  }
  root.addEventListener('focusout', () => setTimeout(() => { if (!signal.aborted) render(); }, 0), { signal });
  onLanguageChange(render, signal);
  return {
    update(space: string, entries: AnnotationEvent[], disconnected = false) {
      const changed = scope !== space || failed !== disconnected || JSON.stringify(events) !== JSON.stringify(entries);
      scope = space; events = entries; failed = disconnected;
      if (changed) render();
    },
  };
}
