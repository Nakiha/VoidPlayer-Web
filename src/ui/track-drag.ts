import { nearestTrackIndex } from './workspace-state.ts';
import type { Slot } from '../model.ts';
import type { ReviewSession } from '../session.ts';

/** Pointer sorting also works on touch devices; buttons keep their own action. */
export function installTrackDrag(session: ReviewSession) {
  const life = new AbortController();
  let drag: { slot: Slot; pointer: number; x: number; y: number; active: boolean; target?: Slot; element: HTMLElement } | null = null;
  let suppressClick = false;
  let preview: HTMLElement | null = null;
  let offset = { x: 0, y: 0 };
  const clear = () => {
    document.querySelectorAll('.track-drop-target').forEach(el => el.classList.remove('track-drop-target'));
    document.querySelectorAll('.track-drag-source').forEach(el => el.classList.remove('track-drag-source'));
    preview?.remove(); preview = null;
    if (drag && document.documentElement.hasPointerCapture(drag.pointer)) document.documentElement.releasePointerCapture(drag.pointer);
    document.body.classList.remove('sorting-tracks');
    drag = null;
  };
  document.addEventListener('pointerdown', e => {
    if (e.button !== 0 || !(e.target instanceof Element)) return;
    const container = e.target.closest<HTMLElement>('[data-track-drag]');
    if (!container || (e.target.closest('button,input,select,a,label,summary') && !e.target.closest('[data-drag-surface]'))) return;
    if (session.getState().tracks.length < 2) return;
    drag = { slot: container.dataset.trackDrag as Slot, pointer: e.pointerId, x: e.clientX, y: e.clientY, active: false, element: container };
  }, { signal: life.signal });
  document.addEventListener('pointermove', e => {
    if (!drag || drag.pointer !== e.pointerId) return;
    if (!drag.active && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 5) return;
    if (!drag.active) {
      drag.active = true;
      document.body.classList.add('sorting-tracks');
      document.documentElement.setPointerCapture(drag.pointer);
      const track = session.getState().tracks.find(t => t.slot === drag!.slot);
      if (!track) { clear(); return; }
      preview = document.createElement('div'); preview.className = 'track-drag-preview'; preview.setAttribute('aria-hidden', 'true');
      const badge = document.createElement('span'); badge.className = `slot slot-${drag.slot}`; badge.textContent = drag.slot;
      const name = document.createElement('span'); name.className = 'filename'; name.textContent = track.name;
      preview.append(badge, name); document.body.append(preview);
      const rect = drag.element.getBoundingClientRect();
      offset = { x: Math.min(Math.max(16, drag.x - rect.left), preview.offsetWidth - 16), y: Math.min(20, Math.max(4, drag.y - rect.top)) };
      document.querySelectorAll(`[data-track-drag="${drag.slot}"]`).forEach(el => el.classList.add('track-drag-source'));
    }
    preview!.style.transform = `translate3d(${e.clientX - offset.x}px, ${e.clientY - offset.y}px, 0)`;
    const hit = document.elementFromPoint(e.clientX, e.clientY);
    let target = hit?.closest<HTMLElement>('[data-track-drag]');
    const dock = hit?.closest('.subtrack-scroll');
    if (!target && dock) {
      const rows = [...dock.querySelectorAll<HTMLElement>('.subtrack-row')];
      target = rows[nearestTrackIndex(e.clientY, rows.map(row => row.getBoundingClientRect()))];
    }
    document.querySelectorAll('.track-drop-target').forEach(el => el.classList.remove('track-drop-target'));
    drag.target = target?.dataset.trackDrag as Slot | undefined;
    if (target && drag.target !== drag.slot) {
      target.classList.add('track-drop-target');
      const order = session.getState().tracks.map(t => t.slot);
      target.dataset.dropEdge = order.indexOf(drag.slot) < order.indexOf(drag.target!) ? 'after' : 'before';
    }
  }, { signal: life.signal });
  document.addEventListener('pointerup', e => {
    if (!drag || drag.pointer !== e.pointerId) return;
    const { active, slot, target } = drag;
    suppressClick = active;
    clear();
    if (active && target && target !== slot) {
      const order = session.getState().tracks.map(t => t.slot);
      const from = order.indexOf(slot), to = order.indexOf(target);
      if (from >= 0 && to >= 0) { order.splice(from, 1); order.splice(to, 0, slot); session.reorderTracks(order); }
    }
    setTimeout(() => { suppressClick = false; }, 0);
  }, { signal: life.signal });
  document.addEventListener('click', e => { if (suppressClick) { e.preventDefault(); e.stopImmediatePropagation(); } }, { capture: true, signal: life.signal });
  document.addEventListener('pointercancel', clear, { signal: life.signal });
  window.addEventListener('blur', clear, { signal: life.signal });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') { clear(); return; }
    if (!(e.target instanceof Element) || !e.target.closest('[data-drag-surface]')) return;
    if (!e.altKey || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
    e.preventDefault(); e.stopPropagation();
    const slot = (e.target.closest('[data-drag-surface]') as HTMLElement).dataset.dragSurface as Slot;
    const order = session.getState().tracks.map(t => t.slot), from = order.indexOf(slot);
    const to = Math.max(0, Math.min(order.length - 1, from + (['ArrowLeft', 'ArrowUp'].includes(e.key) ? -1 : 1)));
    if (from >= 0 && from !== to) {
      const inDock = !!e.target.closest('.subtrack-row');
      order.splice(from, 1); order.splice(to, 0, slot); session.reorderTracks(order);
      document.querySelector<HTMLElement>(`${inDock ? '.subtrack-row' : '.card-heading'} [data-drag-surface="${slot}"]`)?.focus();
    }
  }, { signal: life.signal });
  return () => { clear(); life.abort(); };
}
