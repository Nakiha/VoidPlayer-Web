import { t, msg } from '../i18n.ts';
import { icon } from './icons.ts';
import { shortcutTooltip } from './shortcuts.ts';

/** UI-only visibility: never resize stages, change playback or discard panel state. */
export function installViewportChrome(root: HTMLElement, button: HTMLButtonElement) {
  const lifecycle = new AbortController(), events = { signal: lifecycle.signal };
  let focused = false;
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
    reveal();
  }
  button.addEventListener('click', () => setFocused(!focused), events);
  for (const event of ['pointerenter', 'pointermove', 'focusin', 'keydown']) button.addEventListener(event, reveal, events);
  for (const event of ['pointerleave', 'focusout']) button.addEventListener(event, scheduleHide, events);
  return {
    setFocused,
    update(loaded: boolean) { button.hidden = !loaded; if (!loaded && focused) setFocused(false); },
    dispose() {
      window.clearTimeout(idleTimer);
      lifecycle.abort();
      button.removeAttribute('data-tooltip-suppressed');
    },
  };
}
