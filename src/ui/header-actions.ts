import { bindMenuTrigger } from './menu.ts';
import { SLOTS } from '../../shared/review/model.ts';

/** Move the same controls into the top layer when a four-column caption is narrow. */
export function installHeaderActions() {
  const lifecycle = new AbortController();
  const events = { signal: lifecycle.signal };
  const observers: (ResizeObserver | MutationObserver)[] = [];
  for (const slot of SLOTS) {
    const panel = document.getElementById(`header-actions-${slot}`)!;
    const more = document.getElementById(`header-more-${slot}`)!;
    const heading = panel.closest<HTMLElement>('.card-heading')!;
    const identity = heading.querySelector<HTMLElement>('.track-identity')!;
    const filename = identity.querySelector<HTMLElement>('.filename')!;
    const time = heading.querySelector<HTMLElement>('.frame-time')!;
    const close = () => { if (panel.matches(':popover-open')) panel.hidePopover(); more.setAttribute('aria-expanded', 'false'); };
    const open = (last = false) => {
      if (!panel.hasAttribute('popover')) return;
      more.setAttribute('aria-expanded', 'true');
      panel.showPopover();
      const rect = more.getBoundingClientRect();
      panel.style.left = `${Math.max(4, Math.min(window.innerWidth - panel.offsetWidth - 4, rect.right - panel.offsetWidth))}px`;
      const below = rect.bottom + 4;
      const top = heading.closest('.bottom-heading') || below + panel.offsetHeight > window.innerHeight - 4 ? rect.top - panel.offsetHeight - 4 : below;
      panel.style.top = `${Math.max(4, top)}px`;
      const items = [...panel.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
      (last ? items.at(-1) : items[0])?.focus();
    };
    bindMenuTrigger(more, panel, open, close, lifecycle.signal);
    panel.addEventListener('toggle', () => more.setAttribute('aria-expanded', String(panel.matches(':popover-open'))), events);
    panel.addEventListener('click', e => { if ((e.target as Element).closest('button')) close(); }, events);
    panel.addEventListener('keydown', e => { if (e.key === 'Escape') { e.preventDefault(); close(); more.focus(); } }, events);
    const update = () => {
      const compact = heading.clientWidth < Number.parseFloat(getComputedStyle(heading).getPropertyValue('--header-actions-breakpoint'));
      if (compact !== heading.classList.contains('compact-heading')) {
        close();
        heading.classList.toggle('compact-heading', compact);
        more.hidden = !compact;
        if (compact) panel.setAttribute('popover', 'auto');
        else { panel.removeAttribute('popover'); panel.style.removeProperty('left'); panel.style.removeProperty('top'); }
      }
      // Measure the untruncated text, so time gives way before the filename.
      time.hidden = false;
      const text = document.createRange();
      text.selectNodeContents(filename);
      const style = getComputedStyle(heading), identityStyle = getComputedStyle(identity);
      const titleWidth = text.getBoundingClientRect().width + identity.querySelector('.slot')!.getBoundingClientRect().width
        + Number.parseFloat(identityStyle.columnGap) + Number.parseFloat(identityStyle.paddingLeft) + Number.parseFloat(identityStyle.paddingRight);
      const available = heading.clientWidth - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight);
      const required = titleWidth + time.getBoundingClientRect().width + (compact ? more : panel).getBoundingClientRect().width
        + 2 * Number.parseFloat(style.columnGap);
      time.hidden = required > available;
    };
    const observer = new ResizeObserver(update);
    observer.observe(heading); observers.push(observer);
    let previousName = filename.textContent, previousTimeLength = time.textContent?.length;
    const content = new MutationObserver(() => {
      const name = filename.textContent, length = time.textContent?.length;
      // Frame time uses a monospace font; ordinary playback does not change its width.
      if (name === previousName && length === previousTimeLength) return;
      previousName = name;
      previousTimeLength = length;
      update();
    });
    content.observe(filename, { childList: true, characterData: true, subtree: true });
    content.observe(time, { childList: true, characterData: true, subtree: true });
    observers.push(content);
  }
  return () => { lifecycle.abort(); observers.forEach(observer => observer.disconnect()); };
}
