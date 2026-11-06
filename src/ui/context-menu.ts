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
  focusTarget?(target: HTMLElement): HTMLElement;
}) {
  const menu = document.createElement('div');
  menu.id = options.id; menu.className = 'context-menu action-menu';
  document.body.append(menu);
  let target: HTMLElement | undefined;
  const scrollPositions = new Map<EventTarget, [number, number]>();
  let anchor = new DOMRect();
  const surface = installMenu(host, menu, { trigger: 'manual', invoker: () => target && (options.focusTarget?.(target) ?? target), anchor: () => anchor });
  menu.popover = options.popover ?? 'auto';
  const events = { signal: options.signal };
  let swallowClick = false, touchOpenedRow: HTMLElement | undefined;
  let hold: {id:number; row:HTMLElement; x:number; y:number; timer:ReturnType<typeof setTimeout>; fired:boolean} | undefined;
  const cancelHold = () => { if (hold) clearTimeout(hold.timer); hold = undefined; };
  document.addEventListener('click', event => {
    if (!swallowClick || !event.detail) return;
    swallowClick = false; event.preventDefault(); event.stopImmediatePropagation();
  }, { ...events, capture:true });
  if (options.popover === 'manual') {
    // WebKit light-dismisses an auto popover opened by right-clicking a button
    // on pointer release. Retain the menu, with explicit outside dismissal.
    document.addEventListener('pointerdown', event => {
      swallowClick = false;
      if (!menu.matches(':popover-open') || menu.contains(event.target as Node)) return;
      surface.close();
      if (event.button === 0) {
        swallowClick = true; event.preventDefault(); event.stopImmediatePropagation();
      }
    }, { ...events, capture: true });
    document.addEventListener('beforetoggle', event => {
      if (event.target !== menu && (event as ToggleEvent).newState === 'open'
        && (event.target as Element).matches?.('.popup-menu:not([data-menu-exit-for])')) surface.close();
    }, { ...events, capture: true });
  }
  const present = (row: HTMLElement, event: {clientX:number; clientY:number} | KeyboardEvent) => {
    const actions = options.actions(row);
    if (!actions.length) return false;
    surface.close();
    target = row;
    const rect = row.getBoundingClientRect();
    anchor = 'clientX' in event && (event.clientX || event.clientY)
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
    return true;
  };
  const open = (event: MouseEvent | KeyboardEvent) => {
    const row = (event.target as Element)?.closest<HTMLElement>(options.selector);
    if (!row || !host.contains(row) || !options.actions(row).length) return;
    event.preventDefault(); event.stopPropagation();
    if (touchOpenedRow === row && menu.matches(':popover-open')) return;
    if (hold?.row === row) { clearTimeout(hold.timer); hold.fired = true; touchOpenedRow = row; swallowClick = true; }
    present(row, event);
  };
  host.addEventListener('pointerdown', event => {
    if (event.pointerType !== 'touch' && event.pointerType !== 'pen') {touchOpenedRow = undefined; return;}
    const row = (event.target as Element)?.closest<HTMLElement>(options.selector);
    if (!row || !host.contains(row) || !options.actions(row).length) return;
    cancelHold(); touchOpenedRow = undefined;
    const timer = setTimeout(() => {
      if (!hold || !row.isConnected) return;
      hold.fired = present(row, {clientX:hold.x, clientY:hold.y});
      if (hold.fired) {touchOpenedRow = row; swallowClick = true;}
    }, 500);
    hold = {id:event.pointerId, row, x:event.clientX, y:event.clientY, timer, fired:false};
  }, events);
  document.addEventListener('pointermove', event => {
    if (hold?.id === event.pointerId && !hold.fired && Math.hypot(event.clientX-hold.x,event.clientY-hold.y)>10) cancelHold();
  }, { ...events, capture:true });
  document.addEventListener('pointerup', event => {
    if (hold?.id !== event.pointerId) return;
    if (hold.fired) {swallowClick = true; event.preventDefault(); event.stopPropagation();}
    cancelHold();
  }, { ...events, capture:true });
  document.addEventListener('pointercancel', cancelHold, { ...events, capture:true });
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
  options.signal.addEventListener('abort', () => { cancelHold(); observer.disconnect(); surface.dispose(); menu.remove(); }, { once: true });
  return { close: surface.close };
}
