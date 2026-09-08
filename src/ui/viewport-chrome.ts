import { icon } from './icons.ts';

/** UI-only visibility: never resize stages, change playback or discard panel state. */
export function installViewportChrome(root: HTMLElement, button: HTMLButtonElement) {
  let focused = false;
  function setFocused(next: boolean) {
    focused = next;
    root.classList.toggle('chrome-hidden', focused);
    for (const el of root.querySelectorAll<HTMLElement>('.card-heading, .transport')) el.inert = focused;
    if (focused) {
      for (const menu of root.querySelectorAll<HTMLElement>('[popover]:popover-open')) menu.hidePopover();
    }
    button.innerHTML = icon(focused ? 'eyeClosed' : 'eye');
    button.setAttribute('aria-pressed', String(focused));
    button.setAttribute('aria-label', '专注模式');
    button.dataset.tooltip = '专注模式';
  }
  button.onclick = () => setFocused(!focused);
  return {
    setFocused,
    update(loaded: boolean) { button.hidden = !loaded; if (!loaded && focused) setFocused(false); },
  };
}
