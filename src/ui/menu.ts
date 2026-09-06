/** Shared top-layer menu behavior for choices and actions. */
export function installMenu(button: HTMLButtonElement, menu: HTMLElement, options: {
  align?: 'start' | 'end';
  columns?: number;
  selected?: () => HTMLButtonElement | undefined;
  bounds?: () => DOMRect | undefined;
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
  const close = () => { if (menu.matches(':popover-open')) menu.hidePopover(); button.setAttribute('aria-expanded', 'false'); };
  const open = (last = false) => {
    if (button.disabled) return;
    button.setAttribute('aria-expanded', 'true');
    menu.showPopover();
    const rect = button.getBoundingClientRect();
    const left = options.align === 'end' ? rect.right - menu.offsetWidth : rect.left;
    const bounds = options.bounds?.() ?? new DOMRect(0, 0, innerWidth, innerHeight);
    const top = rect.bottom + menu.offsetHeight + 8 <= bounds.bottom ? rect.bottom + 4 : rect.top - menu.offsetHeight - 4;
    menu.style.left = `${Math.max(bounds.left + 4, Math.min(bounds.right - menu.offsetWidth - 4, left))}px`;
    menu.style.top = `${Math.max(bounds.top + 4, Math.min(bounds.bottom - menu.offsetHeight - 4, top))}px`;
    const enabled = items();
    (last ? enabled.at(-1) : options.selected?.() ?? enabled[0])?.focus();
  };
  bindMenuTrigger(button, menu, open, close, lifecycle.signal);
  menu.addEventListener('keydown', e => {
    const enabled = items();
    const index = enabled.indexOf(document.activeElement as HTMLButtonElement);
    const columns = options.columns ?? 1;
    if (['ArrowDown', 'ArrowUp', 'Home', 'End', ...(columns > 1 ? ['ArrowLeft', 'ArrowRight'] : [])].includes(e.key)) {
      e.preventDefault();
      const next = e.key === 'Home' ? 0 : e.key === 'End' ? enabled.length - 1 : (index + (e.key === 'ArrowDown' ? columns : e.key === 'ArrowUp' ? -columns : e.key === 'ArrowRight' ? 1 : -1) + enabled.length) % enabled.length;
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

/** Also used by compact track headers, which keep their inline layout. */
export function bindMenuTrigger(button: HTMLElement, menu: HTMLElement, open: (last?: boolean) => void, close: () => void, signal: AbortSignal) {
  const events = { signal };
  let pressedOpen = false;
  // Auto popovers light-dismiss on pointer release, before click is delivered.
  // Remember the press state so clicking the invoker cannot close then reopen it.
  button.addEventListener('pointerdown', () => { pressedOpen = menu.matches(':popover-open'); }, events);
  button.addEventListener('pointercancel', () => { pressedOpen = false; }, events);
  button.addEventListener('click', e => {
    const wasOpen = (e.detail > 0 && pressedOpen) || menu.matches(':popover-open');
    pressedOpen = false;
    if (wasOpen) close(); else open();
  }, events);
  button.addEventListener('keydown', e => {
    pressedOpen = false;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); open(e.key === 'ArrowUp'); }
  }, events);
}
