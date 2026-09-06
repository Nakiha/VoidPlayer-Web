import { installResizeGesture } from './resize-gesture.ts';
import type { Mark, Slot } from '../model.ts';
import { formatTime } from '../model.ts';
import { annotationThumbnails } from './annotation-thumbnails.ts';
import { icon } from './icons.ts';
import { markSymbol, identifyMark, bindMarkHover } from './mark-symbol.ts';

/** One content template for the compact rail's popover and expanded list. */
function markContent(mark: Mark) {
  const content = document.createElement('span'); content.className = 'mark-content'; content.dataset.markContent = mark.id;
  const preview = annotationThumbnails.get(mark.id);
  if (preview) { const image = document.createElement('img'); image.src = preview.url; image.width = preview.width; image.height = preview.height; image.alt = '标注画面'; content.append(image); }
  const time = document.createElement('time'); time.textContent = formatTime(mark.frame.ptsUs);
  const note = document.createElement('span'); note.className = 'mark-note'; note.textContent = mark.text;
  content.prepend(time); if (mark.text.trim()) time.after(note);
  if (mark.author) { const author = document.createElement('span'); author.className = 'mark-author'; author.textContent = mark.author.name; content.append(author); } return content;
}

export function installAnnotationPanel(seek: (ptsUs: number) => void, remove: (id: string) => void, edit: (id: string, ptsUs: number) => void) {
  const dock = document.getElementById('subtracks-panel')!;
  const list = document.getElementById('selected-marks')!;
  const toggle = document.getElementById('toggle-marks')!;
  const preview = document.createElement('div');
  preview.id = 'annotation-preview'; preview.className = 'annotation-preview';
  preview.role = 'tooltip'; preview.hidden = true; document.body.append(preview);
  const lifecycle = new AbortController();
  let expanded = false;
  let anchor: HTMLElement | null = null;
  let dismiss: ReturnType<typeof setTimeout> | undefined;
  const cancelDismiss = () => { clearTimeout(dismiss); };
  function hidePreview() {
    cancelDismiss(); preview.hidden = true; anchor?.removeAttribute('aria-describedby'); anchor = null;
  }
  const deferHide = () => { cancelDismiss(); dismiss = setTimeout(hidePreview, 150); };
  function showPreview(button: HTMLElement, mark: Mark) {
    if (expanded) return;
    hidePreview(); anchor = button;
    button.setAttribute('aria-describedby', preview.id);
    identifyMark(preview, mark.id); preview.replaceChildren(markSymbol(mark.id), markContent(mark)); preview.hidden = false;
    const rect = button.getBoundingClientRect();
    const box = preview.getBoundingClientRect();
    preview.style.left = `${Math.max(8, Math.min(rect.right + 8, innerWidth - box.width - 8))}px`;
    preview.style.top = `${Math.max(8, Math.min(rect.top, innerHeight - box.height - 8))}px`;
  }
  function setExpanded(open:boolean) {
    expanded = open; hidePreview();
    resizeHandle.hidden = !expanded;
    dock.classList.toggle('marks-collapsed', !expanded);
    toggle.setAttribute('aria-expanded', String(expanded));
    const label = expanded ? '收起标注面板' : '展开标注面板';
    toggle.setAttribute('aria-label', label); toggle.title = label;
  };
  toggle.onclick = () => setExpanded(!expanded);
  const resizeHandle = document.getElementById('marks-resize')!;
  const tools = dock.querySelector<HTMLElement>('.subtrack-tools')!;
  const token = (name:string) => Number.parseFloat(getComputedStyle(dock).getPropertyValue(name));
  let preferredWidth = token('--dock-tools-width');
  const bounds = () => { const max = Math.max(1,Math.min(token('--marks-max-width'),(dock.clientWidth || document.getElementById('workspace')!.clientWidth)-token('--marks-timeline-min-width'))); return {min:Math.min(token('--marks-min-width'),max),max}; };
  function resize(value:number) {
    const b = bounds(); preferredWidth = Math.max(b.min,Math.min(b.max,value));
    dock.style.setProperty('--marks-user-width',`${preferredWidth}px`);
    resizeHandle.setAttribute('aria-valuemin',String(b.min)); resizeHandle.setAttribute('aria-valuemax',String(b.max));
    resizeHandle.setAttribute('aria-valuenow',String(preferredWidth)); resizeHandle.setAttribute('aria-valuetext',`${preferredWidth} 像素`);
  }
  installResizeGesture(resizeHandle, {
    axis:'x',direction:1,size:()=>preferredWidth,bounds,resize,
    threshold:()=>token('--panel-collapse-distance'),reset:()=>token('--dock-tools-width'),
    dragging(active) { dock.classList.toggle('marks-resizing',active); tools.classList.toggle('panel-pushing',active); },
    preview(push,veil) { dock.style.setProperty('--marks-push-space',`${Math.abs(push)}px`); tools.style.setProperty('--panel-push',`${push}px`); tools.style.setProperty('--panel-veil-opacity',String(veil)); resizeHandle.style.setProperty('--panel-push',`${push}px`); },
    collapse() { setExpanded(false); toggle.focus(); },
  },lifecycle.signal);
  window.addEventListener('resize',()=>resize(preferredWidth),{signal:lifecycle.signal});
  resize(preferredWidth);
  preview.onpointerenter = cancelDismiss;
  preview.onpointerleave = deferHide;
  window.addEventListener('resize', hidePreview, { signal: lifecycle.signal });
  document.addEventListener('scroll', event => {
    if (!preview.contains(event.target as Node)) hidePreview();
  }, { capture: true, signal: lifecycle.signal });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !preview.hidden) { hidePreview(); event.stopPropagation(); }
  }, { capture: true, signal: lifecycle.signal });
  return {
    expanded: () => expanded,
    hidePreview,
    render(marks: Mark[], slot?: Slot, offsetUs=0) {
      hidePreview(); list.replaceChildren();
      document.getElementById('selected-mark-label')!.textContent = slot ? `标注 · ${slot} · ${marks.length}` : '标注';
      if (!marks.length) {
        const empty = document.createElement('span'); empty.className = 'marks-empty';
        const label = document.createElement('span'); label.textContent = '暂无标注'; empty.append(label); list.append(empty);
      }
      for (const savedMark of marks) {
        const mark={...savedMark,frame:{...savedMark.frame,ptsUs:savedMark.frame.ptsUs+offsetUs}};
        const button = document.createElement('button'); button.className = 'mark-entry';
        identifyMark(button, mark.id); bindMarkHover(button, mark.id);
        button.append(markSymbol(mark.id), markContent(mark));
        button.setAttribute('aria-label', `标注 ${formatTime(mark.frame.ptsUs)} ${mark.text}`);
        button.disabled=mark.frame.ptsUs<0;
        button.onclick = () => seek(Math.max(0,mark.frame.ptsUs));
        button.onpointerenter = () => showPreview(button, mark);
        button.onpointerleave = deferHide;
        button.onfocus = () => showPreview(button, mark);
        button.onblur = hidePreview;
        const row = document.createElement('div'); row.className = 'annotation-row'; identifyMark(row, mark.id);
        const removeButton = document.createElement('button'); removeButton.className = 'annotation-remove icon-button'; removeButton.innerHTML = icon('close');
        removeButton.setAttribute('aria-label', `删除标注 ${mark.text || formatTime(mark.frame.ptsUs)}`); removeButton.title = '删除标注'; removeButton.onclick = () => remove(mark.id);
        const editButton = document.createElement('button'); editButton.className = 'annotation-edit icon-button'; editButton.innerHTML = icon('pen'); editButton.setAttribute('aria-label', '编辑标注'); editButton.title = '编辑标注'; editButton.disabled = mark.frame.ptsUs < 0; editButton.onclick = () => edit(mark.id, Math.max(0, mark.frame.ptsUs));
        button.ondblclick = () => edit(mark.id, Math.max(0, mark.frame.ptsUs));
        const actions = document.createElement('div'); actions.className = 'annotation-card-actions';
        actions.append(editButton, removeButton); row.append(button, actions); list.append(row);
      }
    },
    dispose() { hidePreview(); lifecycle.abort(); preview.remove(); toggle.onclick = null; },
  };
}
