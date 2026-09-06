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
    button.setAttribute('aria-label', focused ? '显示标题和播放控件' : '隐藏标题和播放控件');
    button.dataset.tooltip = focused ? '退出专注观察：恢复标题和控制栏' : '专注观察：隐藏标题、控制栏和提示';
  }
  button.onclick = () => setFocused(!focused);
  return {
    setFocused,
    update(loaded: boolean) { button.hidden = !loaded; if (!loaded && focused) setFocused(false); },
  };
}
