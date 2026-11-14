import { onLanguageChange, t, msg } from '../i18n.ts';
import { createSplitter } from './splitter.ts';
import { installResizeGesture } from './resize-gesture.ts';

/** The floating local list owns its height; leave room for library navigation and rows. */
export function installLocalSourcesResize(panel: HTMLElement, section: HTMLElement, signal: AbortSignal) {
  const handle = createSplitter('horizontal', t(msg('sources.resizeLocalFiles', '调整本地文件列表高度')), 'local-sources-splitter');
  handle.id = 'local-sources-resize'; handle.setAttribute('aria-controls', section.id);
  section.before(handle);
  const heading = section.querySelector<HTMLElement>('.source-section')!, list = section.querySelector<HTMLElement>('#local-list')!;
  let preferred: number | undefined;
  const bounds = () => {
    const height = (selector: string) => panel.querySelector<HTMLElement>(selector)?.getBoundingClientRect().height ?? 0;
    const max = Math.max(0, panel.clientHeight - height('.source-tools') - height('.library-pathbar') - height('.source-activity') - 65);
    return { min: Math.min(max, heading.offsetHeight + 28), max };
  };
  function refresh() {
    handle.hidden = section.hidden;
    if (section.hidden || !panel.clientHeight) return;
    const { min, max } = bounds();
    const natural = Math.min(heading.offsetHeight + list.scrollHeight, panel.clientHeight * .42);
    const value = Math.round(Math.max(min, Math.min(max, preferred ?? natural)));
    section.style.height = `${value}px`;
    handle.setAttribute('aria-valuemin', String(Math.round(min)));
    handle.setAttribute('aria-valuemax', String(Math.round(max)));
    handle.setAttribute('aria-valuenow', String(value));
    handle.setAttribute('aria-valuetext', t(msg('ui.pixelWidth', '{width} 像素'), { width: value }));
  }
  installResizeGesture(handle, {
    axis: 'y', direction: -1, size: () => section.getBoundingClientRect().height, bounds,
    resize(value) { preferred = Math.round(value); refresh(); }, reset: () => Math.min(220, panel.clientHeight * .42),
    threshold: () => Infinity, dragging(active) { panel.classList.toggle('local-sources-resizing', active); }, preview() {}, collapse() {},
  }, signal);
  const size = new ResizeObserver(refresh);
  for (const element of [panel, heading, list, panel.querySelector<HTMLElement>('.source-activity')!]) size.observe(element);
  const content = new MutationObserver(refresh);
  content.observe(section, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden'] });
  onLanguageChange(() => { handle.setAttribute('aria-label', t(msg('sources.resizeLocalFiles', '调整本地文件列表高度'))); refresh(); }, signal);
  signal.addEventListener('abort', () => { size.disconnect(); content.disconnect(); handle.remove(); panel.classList.remove('local-sources-resizing'); }, { once: true });
  refresh();
  return { height: () => preferred, restore(value?: number) { preferred = value; refresh(); } };
}
