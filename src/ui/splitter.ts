/** Shared separator surface; each host retains its own sizing/collapse policy. */
type SplitterOptions = { divider?: boolean };
export function configureSplitter(handle: HTMLElement, orientation: 'vertical' | 'horizontal', options: SplitterOptions = {}) {
  handle.classList.add('panel-splitter');
  handle.setAttribute('role','separator');
  handle.setAttribute('aria-orientation',orientation);
  handle.tabIndex = 0;
  handle.dataset.tooltipSuppressed = '';
  handle.toggleAttribute('data-divider',!!options.divider);
  return handle;
}

export function createSplitter(orientation: 'vertical' | 'horizontal', label: string, className = '', options: SplitterOptions = {}) {
  const handle = document.createElement('div');
  handle.className = className;
  handle.setAttribute('aria-label',label);
  return configureSplitter(handle,orientation,options);
}
