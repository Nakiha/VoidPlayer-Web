import { onLanguageChange } from '../i18n.ts';
import { icon } from './icons.ts';
import { installMenu } from './menu.ts';

export type ContextMenuAction = {
  id: string;
  label: string;
  glyph: Parameters<typeof icon>[0];
  disabled?: boolean;
  run(): void;
};

/** Delegated context entry point. Surface, keyboard navigation and exit motion
 * share the same implementation as dropdown menus; no per-row listeners. */
export function installContextMenu(host: HTMLElement, options: {
  id: string;
  selector: string;
  actions(target: HTMLElement): ContextMenuAction[];
  signal: AbortSignal;
  popover?: 'auto' | 'manual';
}) {
  const menu = document.createElement('div');
  menu.id = options.id; menu.className = 'context-menu action-menu';
  document.body.append(menu);
  let target: HTMLElement | undefined;
  const scrollPositions = new Map<EventTarget, [number, number]>();
  let anchor = new DOMRect();
  const surface = installMenu(host, menu, { trigger: 'manual', invoker: () => target, anchor: () => anchor });
  menu.popover = options.popover ?? 'auto';
  const events = { signal: options.signal };
  if (options.popover === 'manual') {
    // WebKit light-dismisses an auto popover opened by right-clicking a button
    // on pointer release. Retain the menu, with explicit outside dismissal.
    document.addEventListener('pointerdown', event => { if (!menu.contains(event.target as Node)) surface.close(); }, { ...events, capture: true });
    document.addEventListener('beforetoggle', event => {
      if (event.target !== menu && (event as ToggleEvent).newState === 'open'
        && (event.target as Element).matches?.('.popup-menu:not([data-menu-exit-for])')) surface.close();
    }, { ...events, capture: true });
  }
  const open = (event: MouseEvent | KeyboardEvent) => {
    const row = (event.target as Element)?.closest<HTMLElement>(options.selector);
    if (!row || !host.contains(row)) return;
    const actions = options.actions(row);
    if (!actions.length) return;
    event.preventDefault(); event.stopPropagation(); surface.close();
    target = row;
    const rect = row.getBoundingClientRect();
    anchor = event instanceof MouseEvent && (event.clientX || event.clientY)
      ? new DOMRect(event.clientX, event.clientY - 4, 0, 0)
      : new DOMRect(rect.left + 8, rect.top, 0, rect.height);
    menu.replaceChildren(...actions.map(action => {
      const button = document.createElement('button');
      button.type = 'button'; button.setAttribute('role', 'menuitem');
      button.dataset.action = action.id; button.disabled = !!action.disabled;
      button.innerHTML = icon(action.glyph);
      const label = document.createElement('span'); label.textContent = action.label; button.append(label);
      button.onclick = action.run;
      return button;
    }));
    if (options.popover === 'manual') for (const other of document.querySelectorAll<HTMLElement>('.popup-menu:popover-open:not([data-menu-exit-for])')) {
      if (other !== menu) other.hidePopover();
    }
    surface.open();
    // Opening from an auto-scrolled breadcrumb can deliver its already-queued
    // scroll event afterwards. Only a subsequent position change dismisses it.
    scrollPositions.clear();
    for (let node: HTMLElement | null = row; node; node = node.parentElement) {
      scrollPositions.set(node, [node.scrollLeft, node.scrollTop]);
    }
  };
  host.addEventListener('contextmenu', open, events);
  host.addEventListener('keydown', event => {
    if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) open(event);
  }, events);
  document.addEventListener('scroll', event => {
    if (menu.contains(event.target as Node)) return;
    const previous = event.target && scrollPositions.get(event.target);
    if (previous && event.target instanceof HTMLElement && event.target.scrollLeft === previous[0] && event.target.scrollTop === previous[1]) return;
    surface.close();
  }, { ...events, capture: true });
  window.addEventListener('blur', surface.close, events);
  onLanguageChange(surface.close, options.signal);
  const observer = new MutationObserver(() => { if (target && !target.isConnected) surface.close(); });
  observer.observe(host, { childList: true, subtree: true });
  options.signal.addEventListener('abort', () => { observer.disconnect(); surface.dispose(); menu.remove(); }, { once: true });
  return { close: surface.close };
}
