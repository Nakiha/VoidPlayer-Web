import { t, onLanguageChange, msg } from '../i18n.ts';
import { settingsPanes } from './settings-shell.ts';
import { matchesShortcut } from './shortcuts.ts';
import { installSourceScrollbar } from './source-scrollbar.ts';

/** One persistent window, with independent scrolling panes and one close/focus lifecycle. */
export function installSettings() {
  const dialog = document.getElementById('settings') as HTMLDialogElement;
  const trigger = document.getElementById('settings-open') as HTMLButtonElement;
  const close = document.getElementById('settings-close') as HTMLButtonElement;
  const tabs = [...dialog.querySelectorAll<HTMLButtonElement>('[data-settings-pane]')];
  const life = new AbortController();
  const scrollbar = installSourceScrollbar(document.getElementById('settings-pane-appearance')!, document.getElementById('settings-scrollbar')!, document.getElementById('settings-scrollbar-thumb')!, life.signal);
  const contentChanges = new MutationObserver(scrollbar.update);
  for (const pane of dialog.querySelectorAll('[role=tabpanel]')) contentChanges.observe(pane, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['hidden'] });
  life.signal.addEventListener('abort', () => contentChanges.disconnect(), { once: true });
  const narrow = matchMedia('(max-width: 600px)');
  const revealTab = () => {
    if (narrow.matches && dialog.open) dialog.querySelector('[role=tab][aria-selected=true]')!.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
  };
  const orientation = () => {
    dialog.querySelector('[role=tablist]')!.setAttribute('aria-orientation', narrow.matches ? 'horizontal' : 'vertical');
    revealTab();
  };
  narrow.addEventListener('change', orientation, { signal: life.signal }); orientation();
  let selected = 'appearance'; let returnFocus: HTMLElement | null = null;
  let closeEpoch = 0; let outsidePointer: number | null = null;
  function select(id: string) {
    selected = id;
    document.getElementById('settings-current-title')!.textContent = settingsPanes().find(([key]) => key === id)![1];
    for (const [key] of settingsPanes()) {
      const active = key === id;
      const tab = document.getElementById(`settings-tab-${key}`)!;
      tab.setAttribute('aria-selected', String(active)); tab.tabIndex = active ? 0 : -1;
      document.getElementById(`settings-pane-${key}`)!.hidden = !active;
    }
    scrollbar.setTarget(document.getElementById(`settings-pane-${id}`)!);
    revealTab();
    dialog.dispatchEvent(new CustomEvent('settings-pane-change', { detail: selected }));
  }
  onLanguageChange(() => { document.getElementById('settings-current-title')!.textContent = settingsPanes().find(([key]) => key === selected)![1]; }, life.signal);
  function open(invoker: HTMLElement | null = trigger) {
    if (dialog.open) {
      ++closeEpoch; delete dialog.dataset.closing;
      return;
    }
    returnFocus = invoker;
    dialog.showModal(); trigger.setAttribute('aria-expanded', 'true'); select(selected);
    tabs.find(t => t.dataset.settingsPane === selected)!.focus({ preventScroll: true });
  }
  async function dismiss() {
    if (!dialog.open) return;
    const epoch = ++closeEpoch;
    dialog.dataset.closing = '';
    // Keep the modal (and backdrop) alive until the exit finishes. With reduced
    // motion there are no animations, so closing completes immediately.
    await Promise.allSettled(dialog.getAnimations().map(animation => animation.finished));
    if (epoch === closeEpoch && dialog.open) dialog.close();
  }
  const outside = (event: PointerEvent) => {
    const bounds = dialog.getBoundingClientRect();
    return event.target === dialog && (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom);
  };
  dialog.addEventListener('pointerdown', event => { outsidePointer = outside(event) ? event.pointerId : null; }, { signal: life.signal });
  dialog.addEventListener('pointerup', event => {
    if (outsidePointer === event.pointerId && outside(event)) void dismiss();
    outsidePointer = null;
  }, { signal: life.signal });
  dialog.addEventListener('pointercancel', () => { outsidePointer = null; }, { signal: life.signal });
  dialog.addEventListener('cancel', event => { event.preventDefault(); void dismiss(); }, { signal: life.signal });
  trigger.addEventListener('click', () => open(trigger), { signal: life.signal });
  close.addEventListener('click', () => void dismiss(), { signal: life.signal });
  dialog.addEventListener('close', () => { if (dialog.open) return; ++closeEpoch; delete dialog.dataset.closing; outsidePointer = null; trigger.setAttribute('aria-expanded', 'false'); (returnFocus?.isConnected ? returnFocus : trigger).focus({ preventScroll: true }); }, { signal: life.signal });
  for (const tab of tabs) {
    tab.addEventListener('click', () => select(tab.dataset.settingsPane!), { signal: life.signal });
    tab.addEventListener('keydown', event => {
      if (!['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
      event.preventDefault();
      const index = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (tabs.indexOf(tab) + (['ArrowDown','ArrowRight'].includes(event.key) ? 1 : -1) + tabs.length) % tabs.length;
      tabs[index].focus({ preventScroll: true }); tabs[index].click();
    }, { signal: life.signal });
  }
  document.addEventListener('keydown', event => {
    if (matchesShortcut(event, 'settings') && !event.isComposing) { event.preventDefault(); if (!document.querySelector('dialog[open]') || dialog.open) open(document.activeElement instanceof HTMLElement ? document.activeElement : trigger); }
  }, { signal: life.signal });
  return { openPane(id: string, invoker: HTMLElement | null = trigger) {
    if (!settingsPanes().some(([key]) => key === id)) throw new Error(t(msg("settings.unknownSettingsPage", "未知设置页面。")));
    select(id); open(invoker); tabs.find(t => t.dataset.settingsPane === id)!.focus({ preventScroll: true });
  }, close: dismiss, dispose() { ++closeEpoch; life.abort(); dialog.close(); } };
}
