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
}) {
  const menu = document.createElement('div');
  menu.id = options.id; menu.className = 'context-menu action-menu';
  document.body.append(menu);
  let target: HTMLElement | undefined;
  let anchor = new DOMRect();
  const surface = installMenu(host, menu, { trigger: 'manual', invoker: () => target, anchor: () => anchor });
  const events = { signal: options.signal };
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
    surface.open();
  };
  host.addEventListener('contextmenu', open, events);
  host.addEventListener('keydown', event => {
    if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) open(event);
  }, events);
  document.addEventListener('scroll', event => { if (!menu.contains(event.target as Node)) surface.close(); }, { ...events, capture: true });
  window.addEventListener('blur', surface.close, events);
  onLanguageChange(surface.close, options.signal);
  const observer = new MutationObserver(() => { if (target && !target.isConnected) surface.close(); });
  observer.observe(host, { childList: true, subtree: true });
  options.signal.addEventListener('abort', () => { observer.disconnect(); surface.dispose(); menu.remove(); }, { once: true });
  return { close: surface.close };
}
