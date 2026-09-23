import { icon } from './icons.ts';

export type ToastKind = 'info' | 'warning' | 'error';

export type ToastAction = { label: string; onClick: () => void };

export type ToastOptions = {
  /** 'info' auto-dismisses; 'warning' and 'error' stay until closed unless durationMs is set. */
  kind?: ToastKind;
  /** Auto-dismiss delay. 0 or negative disables it. Defaults: info 5000, warning/error 0. */
  durationMs?: number;
  action?: ToastAction;
};

const DEFAULT_DURATION: Record<ToastKind, number> = { info: 5000, warning: 0, error: 0 };

const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const exitDuration = (stack: HTMLElement) =>
  reducedMotion() ? 0 : Number.parseFloat(getComputedStyle(stack).getPropertyValue('--toast-exit-duration')) || 0;

/** Shared toast stack handle (owned once, reused by notifiers). */
export type ToastStack = Pick<ReturnType<typeof installToasts>, 'show' | 'stack'>;

/** Liquid-glass toast stack. Vertical layout, never overlapping; fast enter,
 *  animated exit. Returns a controller; each show() returns its dismiss. */
export function installToasts(signal?: AbortSignal) {
  const stack = document.createElement('div');
  stack.className = 'toast-stack';
  stack.popover = 'manual';
  stack.setAttribute('aria-live', 'polite');
  document.body.append(stack);
  let disposed = false;
  // A top-layer popover escapes the dialog backdrop. It must also belong to
  // the active modal so its buttons are not made inert by showModal().
  function raise() {
    if (disposed) return;
    const modal = [...document.querySelectorAll<HTMLDialogElement>('dialog:modal')].filter(dialog => dialog.open).at(-1);
    const parent = modal ?? document.body;
    const focused = stack.contains(document.activeElement) ? document.activeElement as HTMLElement : null;
    if (stack.matches(':popover-open')) stack.hidePopover();
    if (stack.parentElement !== parent) parent.append(stack);
    if (stack.childElementCount) stack.showPopover();
    focused?.focus({ preventScroll: true });
  }
  const dialogs = new MutationObserver(records => {
    if (records.some(record => record.target instanceof HTMLDialogElement)) raise();
  });
  dialogs.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['open'] });
  const onToggle = (event: Event) => {
    // Closing a modal can dismiss its descendant popovers in a later task,
    // even after the stack has moved back to body. Restore pending notices.
    if (event.target === stack && stack.childElementCount && !stack.matches(':popover-open')) raise();
    if (event.target !== stack && event.target instanceof HTMLElement && event.target.matches(':popover-open')) raise();
  };
  document.addEventListener('toggle', onToggle, true);
  const onClose = (event: Event) => { if (event.target instanceof HTMLDialogElement) raise(); };
  document.addEventListener('close', onClose, true);
  function remove(el: HTMLElement) {
    el.remove();
    if (!stack.childElementCount && stack.matches(':popover-open')) stack.hidePopover();
  }

  function dismiss(el: HTMLElement, timer: ReturnType<typeof setTimeout> | undefined) {
    if (disposed || el.dataset.leaving) return;
    el.dataset.leaving = '';
    clearTimeout(timer);
    const ms = exitDuration(stack);
    el.classList.add('toast-leaving');
    if (!ms) { remove(el); return; }
    setTimeout(() => remove(el), ms);
  }

  function show(message: string, options: ToastOptions = {}) {
    const kind = options.kind ?? 'info';
    const duration = options.durationMs ?? DEFAULT_DURATION[kind];
    const el = document.createElement('div');
    el.className = `toast${kind === 'info' ? '' : ` toast-${kind}`} toast-enter`;
    el.setAttribute('role', kind === 'info' ? 'status' : 'alert');
    const label = document.createElement('span');
    label.className = 'toast-message';
    label.textContent = message;
    el.append(label);
    if (options.action) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'toast-action';
      button.textContent = options.action.label;
      button.onclick = () => { options.action!.onClick(); dismiss(el, timer); };
      el.append(button);
    }
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'toast-close icon-button remove-track';
    close.setAttribute('aria-label', '关闭通知');
    close.innerHTML = icon('close');
    close.onclick = () => dismiss(el, timer);
    el.append(close);
    // Fast enter: mount hidden, then release in the next frame.
    stack.append(el);
    raise();
    requestAnimationFrame(() => requestAnimationFrame(() => el.classList.remove('toast-enter')));
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (duration > 0) {
      timer = setTimeout(() => dismiss(el, timer), duration);
      el.addEventListener('pointerenter', () => clearTimeout(timer));
      el.addEventListener('pointerleave', () => {
        clearTimeout(timer);
        timer = setTimeout(() => dismiss(el, timer), duration);
      });
    }
    return () => dismiss(el, timer);
  }

  signal?.addEventListener('abort', dispose, { once: true });
  function dispose() {
    disposed = true;
    dialogs.disconnect();
    document.removeEventListener('toggle', onToggle, true);
    document.removeEventListener('close', onClose, true);
    stack.remove();
  }
  return { show, dispose, stack };
}
