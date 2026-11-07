import { createSplitter } from './splitter.ts';
import { installSourceScrollbar } from './source-scrollbar.ts';
import { onLanguageChange, t, msg } from '../i18n.ts';

const defaultWidth = 280, minWidth = 160, maxWidth = 960;
const preferenceKey = 'voidplayer.admin.library-column-widths.v1';
const clampWidth = (width: number) => Math.round(Math.max(minWidth, Math.min(maxWidth, width)));
type Drag = { pointer: number; target: HTMLElement; x: number; size: number; index: number; previous?: number };

/** Column width belongs to its depth, not the directory occupying it. */
export function installLibraryColumnLayout(viewport: HTMLElement, host: HTMLElement, signal: AbortSignal, changed: () => void) {
  let preferred: number[] = [];
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(preferenceKey) ?? '[]');
    if (Array.isArray(saved)) preferred = saved.slice(0,128).map(width => Number.isFinite(width) ? clampWidth(width) : defaultWidth);
  } catch { /* Optional local preferences. */ }
  const save = () => {try {localStorage.setItem(preferenceKey,JSON.stringify(preferred));} catch { /* Keep the live width. */ }};
  const separators = new Map<number, HTMLElement>();
  let columns: HTMLElement[] = [], enabled = false, drag: Drag | undefined, frame = 0;
  const rail = document.createElement('div'); rail.className = 'source-scrollbar library-horizontal-scrollbar'; rail.tabIndex = 0; rail.hidden = true;
  rail.setAttribute('role','scrollbar'); rail.setAttribute('aria-orientation','horizontal'); rail.setAttribute('aria-controls',viewport.id);
  rail.setAttribute('aria-valuemin','0'); rail.dataset.tooltipSuppressed = '';
  const thumb = document.createElement('span'); rail.append(thumb); viewport.after(rail);
  const scrollbar=installSourceScrollbar(viewport,rail,thumb,signal,{axis:'horizontal',enabled:() => enabled});
  const updateScrollbar=scrollbar.update;
  function refresh() {
    const available = Math.max(minWidth,viewport.clientWidth);
    columns.forEach((column,index) => {
      const width = Math.min(available,preferred[index] ?? defaultWidth), separator = separators.get(index)!;
      column.style.setProperty('--library-column-width',`${width}px`);
      separator.setAttribute('aria-valuenow',String(width));
      separator.setAttribute('aria-valuetext',t(msg('ui.pixelWidth','{width} 像素'),{width}));
    });
    updateScrollbar();
    changed();
  }
  function schedule() {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {if (!signal.aborted) refresh();});
  }
  function finish(cancel: boolean) {
    if (!drag) return;
    const previous = drag; drag = undefined;
    if (previous.target.hasPointerCapture(previous.pointer)) previous.target.releasePointerCapture(previous.pointer);
    previous.target.classList.remove('resizing'); host.classList.remove('library-columns-resizing');
    if (cancel) {
      if (previous.previous === undefined) delete preferred[previous.index]; else preferred[previous.index] = previous.previous;
      refresh();
    } else save();
  }
  function start(event: PointerEvent) {
    if (!enabled || event.button!==0 || drag) return;
    const target = (event.target as HTMLElement).closest<HTMLElement>('.library-column-splitter');
    if (!target) return;
    event.preventDefault(); event.stopPropagation(); target.focus({preventScroll:true});
    const index = Number(target.dataset.columnIndex), column = columns[index];
    if (!column) return;
    drag = {pointer:event.pointerId,target,x:event.clientX,size:column.getBoundingClientRect().width,index,previous:preferred[index]};
    host.classList.add('library-columns-resizing');
    target.classList.add('resizing'); target.setPointerCapture(event.pointerId); updateScrollbar();
  }
  function move(event: PointerEvent) {
    if (!drag || event.pointerId!==drag.pointer) return;
    preferred[drag.index] = clampWidth(drag.size+event.clientX-drag.x); refresh();
  }
  function keydown(event: KeyboardEvent) {
    if (event.key==='Escape' && drag) {event.preventDefault();event.stopPropagation();finish(true);return;}
    const target = (event.target as HTMLElement).closest<HTMLElement>('.library-column-splitter');
    if (!target || !['ArrowLeft','ArrowRight','Home','End','PageUp','PageDown'].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    const direction = event.key==='ArrowLeft'||event.key==='PageUp'?-1:1;
    const index = Number(target.dataset.columnIndex);
    preferred[index] = clampWidth(event.key==='Home'?minWidth:event.key==='End'?maxWidth:columns[index].getBoundingClientRect().width+direction*16);
    refresh(); save();
  }
  const surface = viewport.parentElement!;
  surface.addEventListener('pointerdown',start,{signal});
  surface.addEventListener('pointermove',move,{signal});
  surface.addEventListener('pointerup',() => finish(false),{signal});
  surface.addEventListener('pointercancel',() => finish(true),{signal});
  surface.addEventListener('lostpointercapture',() => finish(true),{signal});
  surface.addEventListener('keydown',keydown,{signal});
  window.addEventListener('blur',() => finish(true),{signal});
  host.addEventListener('dblclick',event => {
    const target = (event.target as HTMLElement).closest<HTMLElement>('.library-column-splitter');
    if (!target) return;
    preferred[Number(target.dataset.columnIndex)] = defaultWidth; refresh(); save();
  },{signal});
  viewport.addEventListener('wheel',event => {
    if (!enabled || event.ctrlKey) return;
    const x = event.shiftKey && !event.deltaX ? event.deltaY : event.deltaX;
    if (!x || !event.shiftKey && Math.abs(event.deltaX)<=Math.abs(event.deltaY)) return;
    event.preventDefault();
    viewport.scrollLeft += x*(event.deltaMode===1?16:event.deltaMode===2?viewport.clientWidth:1);
  },{signal,capture:true,passive:false});
  const resize = new ResizeObserver(schedule); resize.observe(viewport); resize.observe(host);
  function localize() {
    rail.setAttribute('aria-label',t(msg('libraryColumns.scroll','横向滚动分栏')));
    for (const [index,separator] of separators) separator.setAttribute('aria-label',t(msg('libraryColumns.resize','调整第 {index} 列宽度'),{index:index+1}));
    refresh();
  }
  onLanguageChange(localize,signal);
  signal.addEventListener('abort',() => {finish(true);cancelAnimationFrame(frame);resize.disconnect();rail.remove();},{once:true});
  rail.setAttribute('aria-label',t(msg('libraryColumns.scroll','横向滚动分栏')));
  return {updateScrollbar, render(value: HTMLElement[]) {
    if (drag?.index!==undefined && columns[drag.index]!==value[drag.index]) finish(true);
    columns = value;
    for (const [index,separator] of separators) if (index>=columns.length) {separator.remove();separators.delete(index);}
    columns.forEach((column,index) => {
      let separator = separators.get(index);
      if (!separator) {
        separator = createSplitter('vertical',t(msg('libraryColumns.resize','调整第 {index} 列宽度'),{index:index+1}),'library-column-splitter',{divider:true});
        separator.dataset.columnIndex = String(index); separator.dataset.tooltipSuppressed = '';
        separator.setAttribute('aria-valuemin',String(minWidth)); separator.setAttribute('aria-valuemax',String(maxWidth));
        separators.set(index,separator);
      }
      column.id = `library-column-${index}`; separator.setAttribute('aria-controls',column.id);
      for (const [offset,element] of [column,separator].entries()) if (host.children[index*2+offset]!==element) host.insertBefore(element,host.children[index*2+offset]??null);
    });
    refresh();
  }, setEnabled(value: boolean) {
    if (!value) finish(true);
    enabled = value; refresh();
  }};
}
