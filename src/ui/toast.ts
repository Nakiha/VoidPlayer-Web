import { icon } from './icons.ts';

export type ToastKind = 'info' | 'error';

export type ToastAction = { label: string; onClick: () => void };

export type ToastOptions = {
  /** 'info' auto-dismisses; 'error' stays until closed unless durationMs is set. */
  kind?: ToastKind;
  /** Auto-dismiss delay. 0 or negative disables it. Defaults: info 5000, error 0. */
  durationMs?: number;
  action?: ToastAction;
};

const DEFAULT_DURATION: Record<ToastKind, number> = { info: 5000, error: 0 };

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
  stack.setAttribute('aria-live', 'polite');
  document.body.append(stack);
  let disposed = false;

  function dismiss(el: HTMLElement, timer: ReturnType<typeof setTimeout> | undefined) {
    if (disposed || el.dataset.leaving) return;
    el.dataset.leaving = '';
    clearTimeout(timer);
    const ms = exitDuration(stack);
    el.classList.add('toast-leaving');
    if (!ms) { el.remove(); return; }
    setTimeout(() => el.remove(), ms);
  }

  function show(message: string, options: ToastOptions = {}) {
    const kind = options.kind ?? 'info';
    const duration = options.durationMs ?? DEFAULT_DURATION[kind];
    const el = document.createElement('div');
    el.className = `toast${kind === 'error' ? ' toast-error' : ''} toast-enter`;
    el.setAttribute('role', kind === 'error' ? 'alert' : 'status');
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
    stack.remove();
  }
  return { show, dispose, stack };
}
