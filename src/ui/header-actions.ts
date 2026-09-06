import { bindMenuTrigger } from './menu.ts';
import { SLOTS } from '../model.ts';

/** Move the same controls into the top layer when a four-column caption is narrow. */
export function installHeaderActions() {
  const lifecycle = new AbortController();
  const events = { signal: lifecycle.signal };
  const observers: ResizeObserver[] = [];
  for (const slot of SLOTS) {
    const panel = document.getElementById(`header-actions-${slot}`)!;
    const more = document.getElementById(`header-more-${slot}`)!;
    const heading = panel.closest<HTMLElement>('.card-heading')!;
    const close = () => { if (panel.matches(':popover-open')) panel.hidePopover(); more.setAttribute('aria-expanded', 'false'); };
    const open = (last = false) => {
      if (!panel.hasAttribute('popover')) return;
      more.setAttribute('aria-expanded', 'true');
      panel.showPopover();
      const rect = more.getBoundingClientRect();
      panel.style.left = `${Math.max(4, Math.min(window.innerWidth - panel.offsetWidth - 4, rect.right - panel.offsetWidth))}px`;
      const below = rect.bottom + 4;
      const top = heading.closest('.bottom-heading') || below + panel.offsetHeight > window.innerHeight - 4 ? rect.top - panel.offsetHeight - 4 : below;
      panel.style.top = `${Math.max(4, top)}px`;
      const items = [...panel.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
      (last ? items.at(-1) : items[0])?.focus();
    };
    bindMenuTrigger(more, panel, open, close, lifecycle.signal);
    panel.addEventListener('toggle', () => more.setAttribute('aria-expanded', String(panel.matches(':popover-open'))), events);
    panel.addEventListener('click', e => { if ((e.target as Element).closest('button')) close(); }, events);
    panel.addEventListener('keydown', e => { if (e.key === 'Escape') { e.preventDefault(); close(); more.focus(); } }, events);
    const observer = new ResizeObserver(() => {
      const compact = heading.clientWidth < Number.parseFloat(getComputedStyle(heading).getPropertyValue('--header-actions-breakpoint'));
      if (compact === heading.classList.contains('compact-heading')) return;
      close();
      heading.classList.toggle('compact-heading', compact);
      more.hidden = !compact;
      if (compact) panel.setAttribute('popover', 'auto');
      else { panel.removeAttribute('popover'); panel.style.removeProperty('left'); panel.style.removeProperty('top'); }
    });
    observer.observe(heading); observers.push(observer);
  }
  return () => { lifecycle.abort(); observers.forEach(observer => observer.disconnect()); };
}
