import { t, msg } from '../i18n.ts';
import { icon } from './icons.ts';
import { shortcutTooltip } from './shortcuts.ts';

/** Coordinates focus-mode controls and the toolbar with the current panel layout. */
export function installViewportChrome(root: HTMLElement, button: HTMLButtonElement, topbar: HTMLElement, refit: () => void) {
  const lifecycle = new AbortController(), events = { signal: lifecycle.signal };
  const titlebarOverlay = matchMedia('(display-mode: window-controls-overlay)');
  let focused = false;
  let panelOpen = false;
  let idleTimer: number | undefined;
  function scheduleHide() {
    window.clearTimeout(idleTimer);
    if (!focused) return;
    idleTimer = window.setTimeout(() => {
      if (document.activeElement === button && document.documentElement.hasAttribute('data-keyboard-navigation')) return;
      button.setAttribute('data-tooltip-suppressed', '');
    }, 2000);
  }
  function reveal() {
    button.removeAttribute('data-tooltip-suppressed');
    scheduleHide();
  }
  function syncTopbar(animate: boolean) {
    // The native title bar already changes the content bounds. Sliding the app
    // toolbar during that switch would move the viewport a second time.
    if (!animate) topbar.classList.remove('topbar-slide');
    const collapsed = focused && !panelOpen && !titlebarOverlay.matches;
    if (topbar.inert === collapsed) return;
    if (collapsed) {
      let returnFocus = topbar.contains(document.activeElement);
      for (const trigger of topbar.querySelectorAll('[aria-haspopup="menu"][aria-controls]')) {
        const menu = document.getElementById(trigger.getAttribute('aria-controls')!);
        if (!menu?.matches(':popover-open')) continue;
        returnFocus ||= menu.contains(document.activeElement);
        menu.hidePopover();
      }
      if (returnFocus) button.focus({ preventScroll: true });
    }
    if (animate) topbar.classList.add('topbar-slide');
    topbar.inert = collapsed;
    topbar.classList.toggle('topbar-collapsed', collapsed);
  }
  function setFocused(next: boolean) {
    focused = next;
    root.classList.toggle('chrome-hidden', focused);
    for (const el of root.querySelectorAll<HTMLElement>('.card-heading, .transport')) el.inert = focused;
    if (focused) {
      for (const menu of root.querySelectorAll<HTMLElement>('[popover]:popover-open')) menu.hidePopover();
    }
    button.innerHTML = icon('focus');
    button.setAttribute('aria-pressed', String(focused));
    button.setAttribute('aria-label', t(msg("shell.focusMode", "专注模式")));
    button.dataset.tooltip = shortcutTooltip(t(msg("shell.focusMode", "专注模式")), 'focusMode');
    syncTopbar(true);
    reveal();
  }
  const pointerActivity = () => { if (focused) reveal(); };
  root.addEventListener('pointerenter', pointerActivity, events);
  root.addEventListener('pointermove', pointerActivity, { ...events, capture: true });
  root.addEventListener('pointerleave', scheduleHide, events);
  button.addEventListener('click', () => setFocused(!focused), events);
  button.addEventListener('focusin', reveal, events);
  button.addEventListener('keydown', reveal, events);
  button.addEventListener('focusout', scheduleHide, events);
  titlebarOverlay.addEventListener('change', () => {
    syncTopbar(false);
    // Use the new viewport bounds before the resize observer schedules its next frame.
    refit();
  }, events);
  return {
    setFocused,
    setPanelOpen(open: boolean) { panelOpen = open; syncTopbar(true); },
    update(loaded: boolean) { button.hidden = !loaded; if (!loaded && focused) setFocused(false); },
    dispose() {
      window.clearTimeout(idleTimer);
      lifecycle.abort();
      button.removeAttribute('data-tooltip-suppressed');
      topbar.inert = false;
      topbar.classList.remove('topbar-collapsed', 'topbar-slide');
    },
  };
}
