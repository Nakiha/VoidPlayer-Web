/** Shared top-layer menu behavior for choices and actions. */
export function installMenu(button: HTMLButtonElement, menu: HTMLElement, options: {
  align?: 'start' | 'end';
  selected?: () => HTMLButtonElement | undefined;
} = {}) {
  const lifecycle = new AbortController();
  const events = { signal: lifecycle.signal };
  menu.classList.add('popup-menu');
  menu.setAttribute('popover', 'auto');
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', button.getAttribute('aria-label') ?? '操作');
  button.setAttribute('aria-controls', menu.id);
  button.setAttribute('aria-haspopup', 'menu');
  button.setAttribute('aria-expanded', 'false');
  const items = () => [...menu.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
  const close = () => { if (menu.matches(':popover-open')) menu.hidePopover(); };
  const open = (last = false) => {
    if (button.disabled) return;
    menu.showPopover();
    const rect = button.getBoundingClientRect();
    const left = options.align === 'end' ? rect.right - menu.offsetWidth : rect.left;
    menu.style.left = `${Math.max(4, Math.min(innerWidth - menu.offsetWidth - 4, left))}px`;
    menu.style.top = `${Math.max(4, Math.min(rect.bottom + 4, innerHeight - menu.offsetHeight - 4))}px`;
    const enabled = items();
    (last ? enabled.at(-1) : options.selected?.() ?? enabled[0])?.focus();
  };
  button.addEventListener('click', () => menu.matches(':popover-open') ? close() : open(), events);
  button.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); open(e.key === 'ArrowUp'); }
  }, events);
  menu.addEventListener('keydown', e => {
    const enabled = items();
    const index = enabled.indexOf(document.activeElement as HTMLButtonElement);
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
      e.preventDefault();
      const next = e.key === 'Home' ? 0 : e.key === 'End' ? enabled.length - 1 : (index + (e.key === 'ArrowDown' ? 1 : -1) + enabled.length) % enabled.length;
      enabled[next]?.focus();
    } else if (e.key === 'Escape' || e.key === 'Tab') {
      if (e.key === 'Escape') e.preventDefault();
      close(); button.focus();
    }
  }, events);
  // Close before the action, so a dialog opened by the action keeps its focus.
  menu.addEventListener('click', e => {
    if ((e.target as Element).closest('button:not(:disabled)')) { close(); button.focus(); }
  }, { ...events, capture: true });
  menu.addEventListener('toggle', () => button.setAttribute('aria-expanded', String(menu.matches(':popover-open'))), events);
  window.addEventListener('resize', close, events);
  return { close, dispose() { close(); lifecycle.abort(); } };
}
