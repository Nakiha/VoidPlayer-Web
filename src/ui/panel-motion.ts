import type { Panel } from './workspace-state.ts';

const layoutTimers = new WeakMap<HTMLElement, ReturnType<typeof setTimeout>>();
export function animatePanelLayout(workspace:HTMLElement) {
  clearTimeout(layoutTimers.get(workspace));
  workspace.classList.add('panel-motion');
  const ms = matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : Number.parseFloat(getComputedStyle(workspace).getPropertyValue('--panel-motion-duration'));
  const timer = setTimeout(()=>workspace.classList.remove('panel-motion'),ms);
  layoutTimers.set(workspace,timer); return timer;
}

/** Keep exiting panels mounted until the motion ends; interrupted toggles retain their current pose. */
export function installPanelMotion(workspace: HTMLElement, signal: AbortSignal) {
  const states = new Map<Panel, boolean>();
  const timers = new Map<Panel, ReturnType<typeof setTimeout>>();
  let layoutTimer: ReturnType<typeof setTimeout> | undefined;
  const duration = () => matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 :
    Number.parseFloat(getComputedStyle(workspace).getPropertyValue('--panel-motion-duration'));
  function set(panel: Panel, open: boolean) {
    if (states.get(panel) === open) return;
    states.set(panel, open);
    const el = document.getElementById(`${panel}-panel`)!;
    clearTimeout(timers.get(panel));
    const ms = duration();
    const wasHidden = el.hidden;
    if (!open && wasHidden) { el.classList.add('panel-closed'); return; }
    // Exit at the current fixed size, even if preferred width is restored after a push-to-close.
    if (!open) {
      if (panel === 'subtracks') el.style.height = `${el.getBoundingClientRect().height}px`;
      else el.style.width = `${el.getBoundingClientRect().width}px`;
    } else {
      el.style.removeProperty('width'); el.style.removeProperty('height');
      if (wasHidden) { el.classList.add('panel-closed'); el.hidden = false; void el.offsetWidth; }
    }
    el.inert = !open;
    layoutTimer = animatePanelLayout(workspace);
    el.classList.toggle('panel-closed', !open);
    workspace.classList.toggle(`has-${panel}`, open);
    const finish = () => {
      if (!open) el.hidden = true;
      el.style.removeProperty('width'); el.style.removeProperty('height');
      timers.delete(panel);
    };
    if (ms) timers.set(panel, setTimeout(finish, ms)); else finish();
  }
  signal.addEventListener('abort', () => { timers.forEach(clearTimeout); clearTimeout(layoutTimer); }, {once:true});
  return { set };
}
