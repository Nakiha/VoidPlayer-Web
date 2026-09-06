/** One delegated tooltip for static and dynamically created controls, including dialogs. */
export function installTooltips() {
  const lifecycle = new AbortController();
  const options = { capture: true, signal: lifecycle.signal };
  const selector = 'button, summary, select, label[for], [role="separator"], [data-tooltip]';
  // These controls already expose a richer frame/annotation preview.
  const rich = '.mark-entry, .track-marker, .track-duration, #timeline, #more-actions, [role="separator"]';
  const popup = document.createElement('div');
  popup.id = 'control-tooltip'; popup.className = 'ui-tooltip'; popup.role = 'tooltip';
  popup.setAttribute('popover', 'manual'); popup.hidden = true; document.body.append(popup);
  let anchor: HTMLElement | null = null;
  let dismissed: HTMLElement | null = null;
  let pointerFocus = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let leaving: ReturnType<typeof setTimeout> | undefined;
  const delay = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--tooltip-delay')) || 350;
  function migrate(root: Element) {
    const elements = root.matches('[title]') ? [root, ...root.querySelectorAll('[title]')] : [...root.querySelectorAll('[title]')];
    for (const el of elements) {
      const title = el.getAttribute('title');
      if (title && el.matches('button, summary, select, label[for], [role="separator"]') && title !== el.textContent?.trim()) (el as HTMLElement).dataset.tooltip = title;
      el.removeAttribute('title');
    }
  }
  migrate(document.body);
  function hide() {
    clearTimeout(timer); clearTimeout(leaving);
    if (anchor) {
      const ids = (anchor.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(id => id && id !== popup.id);
      if (ids.length) anchor.setAttribute('aria-describedby', ids.join(' ')); else anchor.removeAttribute('aria-describedby');
    }
    anchor = null;
    if (popup.matches(':popover-open')) popup.hidePopover();
    popup.hidden = true;
  }
  const menuOpen = () => !!document.querySelector('.popup-menu:popover-open, .header-actions[popover]:popover-open');
  function show() {
    if (menuOpen() || !anchor?.isConnected || !anchor.getClientRects().length || document.body.classList.contains('sorting-tracks')) { hide(); return; }
    // Visible content is not an instruction. Never echo filenames, field values,
    // or complete accessible names of data rows into a generic tooltip.
    const text = anchor.dataset.tooltip || (!anchor.textContent?.trim() ? anchor.getAttribute('aria-label') : null);
    if (!text) { hide(); return; }
    if (popup.matches(':popover-open') && popup.textContent === text) return;
    if (popup.textContent !== text) popup.textContent = text;
    popup.hidden = false;
    if (popup.showPopover && !popup.matches(':popover-open')) popup.showPopover();
    const rect = anchor.getBoundingClientRect(), box = popup.getBoundingClientRect();
    const left = Math.max(8, Math.min(rect.left + (rect.width - box.width) / 2, innerWidth - box.width - 8));
    const below = rect.bottom + 6;
    popup.style.left = `${left}px`;
    popup.style.top = `${Math.max(8, below + box.height <= innerHeight - 8 ? below : rect.top - box.height - 6)}px`;
    const ids = new Set((anchor.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean));
    ids.add(popup.id); anchor.setAttribute('aria-describedby', [...ids].join(' '));
  }
  function enter(event: Event) {
    if (menuOpen()) { hide(); return; }
    if (!(event.target instanceof Element) || popup.contains(event.target)) return;
    const control = event.target.closest<HTMLElement>(selector);
    if (!control || control.matches(rich) || control.closest('.track-drag-preview')) { hide(); return; }
    if (event.type === 'focusin' && pointerFocus) return;
    if (control === dismissed) return;
    if (event.type === 'pointerover') dismissed = null;
    if (control === anchor) { clearTimeout(leaving); return; }
    hide(); anchor = control;
    // Focus can be dispatched inside another popover's show operation.
    timer = setTimeout(show, event.type === 'focusin' ? 0 : delay);
  }
  const observer = new MutationObserver(records => {
    for (const record of records) {
      if (record.type === 'attributes' && record.target instanceof Element && record.target.hasAttribute('title')) migrate(record.target);
      for (const node of record.addedNodes) if (node instanceof Element && node !== popup && !popup.contains(node)) migrate(node);
    }
    if (anchor && !anchor.isConnected) hide();
    else if (anchor && !popup.hidden && records.some(record => record.type === 'attributes' && record.target === anchor)) show();
  });
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['title', 'data-tooltip', 'aria-label'] });
  document.addEventListener('beforetoggle', event => {
    if ((event.target as Element)?.matches?.('.popup-menu, .header-actions[popover]')) hide();
  }, options);
  document.addEventListener('pointerover', enter, options);
  document.addEventListener('focusin', enter, options);
  document.addEventListener('pointerout', event => {
    if (dismissed?.contains(event.target as Node) && !dismissed.contains(event.relatedTarget as Node)) dismissed = null;
    if (anchor?.contains(event.target as Node) && !anchor.contains(event.relatedTarget as Node) && !popup.contains(event.relatedTarget as Node)) {
      leaving = setTimeout(hide, 120);
    }
  }, options);
  popup.addEventListener('pointerenter', () => clearTimeout(leaving));
  popup.addEventListener('pointerleave', hide);
  document.addEventListener('focusout', hide, options);
  document.addEventListener('pointerdown', event => {
    pointerFocus = true;
    dismissed = event.target instanceof Element ? event.target.closest<HTMLElement>(selector) : null;
    hide();
  }, options);
  document.addEventListener('keydown', event => {
    pointerFocus = false;
    if (event.key === 'Tab') dismissed = null;
    if (event.key === 'Escape' || event.key === 'Enter' || event.code === 'Space') {
      dismissed = event.target instanceof Element ? event.target.closest<HTMLElement>(selector) : null;
      hide();
    }
  }, options);
  document.addEventListener('scroll', hide, options);
  window.addEventListener('resize', hide, { signal: lifecycle.signal });
  window.addEventListener('blur', hide, { signal: lifecycle.signal });
  return () => { hide(); observer.disconnect(); lifecycle.abort(); popup.remove(); };
}
