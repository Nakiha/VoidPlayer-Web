import type { Mark, Slot } from '../model.ts';
import { formatTime } from '../model.ts';
import { annotationThumbnails } from './annotation-thumbnails.ts';
import { createIconButton } from './controls.ts';
import { icon } from './icons.ts';
import { markSymbol, identifyMark, bindMarkHover } from './mark-symbol.ts';

type AnnotationEntry = { mark: Mark; slot: Slot; offsetUs: number };

/** Both strip cards and hover cards share content and actions. */
function markContent(mark: Mark, slot: Slot) {
  const content = document.createElement('span'); content.className = 'mark-content';
  const meta = document.createElement('span'); meta.className = 'mark-meta';
  const time = document.createElement('time'); time.textContent = `${slot} · ${formatTime(mark.frame.ptsUs)}`;
  meta.append(markSymbol(mark.id), time); content.append(meta);
  const thumbnail = document.createElement('span'); thumbnail.className = 'mark-thumbnail'; thumbnail.dataset.markThumbnail = mark.id;
  const preview = annotationThumbnails.get(mark.id);
  if (preview) {
    const image = document.createElement('img'); image.src = preview.url; image.width = preview.width; image.height = preview.height; image.alt = '标注画面'; image.loading = 'lazy'; image.onerror = () => { image.hidden=true; }; thumbnail.append(image);
  } else { thumbnail.textContent = mark.text || '暂无预览'; }
  content.append(thumbnail);
  const footer = document.createElement('span'); footer.className = 'mark-footer';
  const note = document.createElement('span'); note.className = 'mark-note'; note.textContent = mark.text; note.title = mark.text;
  const author = document.createElement('span'); author.className = 'mark-author'; author.textContent = mark.author?.name || '未署名';
  footer.append(note, author); content.append(footer); return content;
}

export function installAnnotationPanel(
  seek: (ptsUs: number) => void,
  remove: (id: string) => void,
  edit: (id: string, ptsUs: number, slot: Slot) => void,
  modeChanged: (expanded: boolean) => void,
) {
  const dock = document.getElementById('subtracks-panel')!;
  const list = document.getElementById('selected-marks')!;
  const toggle = document.getElementById('toggle-marks')!;
  const preview = document.createElement('div');
  preview.id = 'annotation-preview'; preview.className = 'annotation-preview';
  preview.role = 'dialog'; preview.setAttribute('aria-label', '标注'); preview.hidden = true; document.body.append(preview);
  const lifecycle = new AbortController();
  let expanded = false;
  let anchor: HTMLElement | null = null;
  let dismiss: ReturnType<typeof setTimeout> | undefined;
  const cancelDismiss = () => { clearTimeout(dismiss); };
  function hidePreview() {
    cancelDismiss(); preview.hidden = true; anchor?.setAttribute('aria-expanded', 'false'); anchor = null;
  }
  const deferHide = () => { cancelDismiss(); dismiss = setTimeout(() => {
    if (!preview.contains(document.activeElement)) hidePreview();
  }, 150); };
  function actions(mark: Mark, slot: Slot, container: HTMLElement) {
    const actions = document.createElement('div'); actions.className = 'annotation-card-actions';
    const editButton = createIconButton({ glyph: 'note', label: '编辑标注', tooltip: '编辑标注' });
    editButton.disabled = mark.frame.ptsUs < 0;
    editButton.onclick = () => { hidePreview(); edit(mark.id, mark.frame.ptsUs, slot); };
    const removeButton = createIconButton({ glyph: 'trash', className: 'annotation-remove', label: `删除标注 ${mark.text || formatTime(mark.frame.ptsUs)}`, tooltip: '删除标注' });
    removeButton.onclick = () => {
      const confirmation = document.createElement('div'); confirmation.className = 'annotation-confirm';
      const label = document.createElement('span'); label.textContent = '删除这条标注？';
      const cancel = document.createElement('button'); cancel.textContent = '取消';
      const accept = document.createElement('button'); accept.textContent = '删除'; accept.className = 'annotation-delete-confirm';
      cancel.onclick = () => { confirmation.remove(); removeButton.focus(); };
      accept.onclick = () => { hidePreview(); remove(mark.id); toggle.focus(); };
      confirmation.append(label, cancel, accept); container.append(confirmation); cancel.focus();
    };
    actions.append(editButton, removeButton); return actions;
  }
  function showPreview(button: HTMLElement, mark: Mark, slot: Slot) {
    if (expanded || anchor === button) return;
    hidePreview(); anchor = button; button.setAttribute('aria-expanded', 'true');
    identifyMark(preview, mark.id); preview.replaceChildren(markContent(mark, slot), actions(mark, slot, preview)); preview.hidden = false;
    const rect = button.getBoundingClientRect();
    const box = preview.getBoundingClientRect();
    preview.style.left = `${Math.max(8, Math.min(rect.left, innerWidth - box.width - 8))}px`;
    const stripTop = dock.querySelector('.annotation-strip')!.getBoundingClientRect().top;
    preview.style.top = `${Math.max(8, stripTop - box.height - 8)}px`;
  }
  function setExpanded(open: boolean) {
    expanded = open; hidePreview();
    list.querySelectorAll('.annotation-confirm').forEach(confirmation => confirmation.remove());
    dock.classList.toggle('marks-collapsed', !expanded);
    toggle.setAttribute('aria-expanded', String(expanded));
    const label = expanded ? '显示标注符号' : '显示标注卡片';
    toggle.setAttribute('aria-label', label); toggle.title = label;
    toggle.innerHTML = icon(expanded ? 'marker' : 'grid');
    for (const button of list.querySelectorAll('.mark-entry')) button.setAttribute('aria-haspopup', expanded ? 'false' : 'dialog');
  }
  toggle.onclick = () => { setExpanded(!expanded); modeChanged(expanded); };
  preview.onpointerenter = cancelDismiss; preview.onpointerleave = deferHide;
  preview.addEventListener('focusin', cancelDismiss); preview.addEventListener('focusout', deferHide);
  window.addEventListener('resize', hidePreview, { signal: lifecycle.signal });
  document.addEventListener('scroll', event => {
    if (!preview.contains(event.target as Node)) hidePreview();
  }, { capture: true, signal: lifecycle.signal });
  document.addEventListener('pointerdown', event => {
    if (!preview.contains(event.target as Node) && !anchor?.contains(event.target as Node)) hidePreview();
  }, { signal: lifecycle.signal });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !preview.hidden) {
      const button = anchor; hidePreview(); button?.focus(); hidePreview(); event.stopPropagation();
    }
  }, { capture: true, signal: lifecycle.signal });
  return {
    expanded: () => expanded, setExpanded, hidePreview,
    render(entries: AnnotationEntry[]) {
      const scrollLeft = list.scrollLeft;
      hidePreview(); list.replaceChildren();
      if (!entries.length) {
        const empty = document.createElement('span'); empty.className = 'marks-empty'; empty.textContent = '暂无标注'; list.append(empty);
      }
      for (const { mark: savedMark, slot, offsetUs } of entries) {
        const mark = { ...savedMark, frame: { ...savedMark.frame, ptsUs: savedMark.frame.ptsUs + offsetUs } };
        const button = document.createElement('button'); button.className = 'mark-entry';
        identifyMark(button, mark.id); bindMarkHover(button, mark.id);
        button.append(markContent(mark, slot));
        button.setAttribute('aria-label', `轨道 ${slot} 标注 ${formatTime(mark.frame.ptsUs)} ${mark.text}`);
        button.setAttribute('aria-haspopup', expanded ? 'false' : 'dialog');
        button.setAttribute('aria-controls', preview.id);
        button.onclick = () => { if (mark.frame.ptsUs >= 0) seek(mark.frame.ptsUs); };
        button.onpointerenter = () => showPreview(button, mark, slot); button.onpointerleave = deferHide;
        button.onfocus = () => showPreview(button, mark, slot); button.onblur = deferHide;
        button.onkeydown = event => {
          if (!expanded && event.key === 'ArrowUp') { event.preventDefault(); showPreview(button, mark, slot); preview.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus(); }
        };
        button.ondblclick = () => { if (mark.frame.ptsUs >= 0) { hidePreview(); edit(mark.id, mark.frame.ptsUs, slot); } };
        const row = document.createElement('div'); row.className = 'annotation-row'; row.dataset.slot = slot; identifyMark(row, mark.id);
        row.append(button, actions(mark, slot, row)); list.append(row);
      }
      list.scrollLeft = scrollLeft;
    },
    dispose() { hidePreview(); lifecycle.abort(); preview.remove(); toggle.onclick = null; },
  };
}
