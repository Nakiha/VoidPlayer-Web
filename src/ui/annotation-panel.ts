import type { Mark, Slot } from '../model.ts';
import { formatTime } from '../model.ts';
import { annotationThumbnails } from './annotation-thumbnails.ts';
import { createIconButton } from './controls.ts';
import { icon } from './icons.ts';
import { markSymbol, identifyMark, bindMarkHover } from './mark-symbol.ts';
import type { ReviewSession } from '../session.ts';
import { onLanguageChange, t, msg , th } from '../i18n.ts';

type AnnotationEntry = { mark: Mark; slot: Slot; offsetUs: number };

/** Both strip cards and hover cards share content and actions. */
function markContent(mark: Mark, slot: Slot, actions?: HTMLElement, session?: ReviewSession) {
  const content = document.createElement('span'); content.className = 'mark-content';
  const meta = document.createElement('span'); meta.className = 'mark-meta';
  const time = document.createElement('time'); time.textContent = `${slot} · ${formatTime(mark.frame.ptsUs)}`;
  meta.append(markSymbol(mark.id), time);
  if (session) {
    const frame = document.createElement('span'); frame.className = 'mark-frame-number'; frame.textContent = '· #…';
    meta.append(frame);
    void session.rankAnalysisFrame(slot, mark.frame.ptsUs).then(result => {
      if (frame.isConnected) frame.textContent = 'rank' in result ? `· #${result.rank}${result.complete ? '' : '~'}` : '· —';
    });
  }
  if (actions) meta.append(actions);
  content.append(meta);
  const thumbnail = document.createElement('span'); thumbnail.className = 'mark-thumbnail'; thumbnail.dataset.markThumbnail = mark.id;
  const preview = annotationThumbnails.get(mark.id);
  if (preview) {
    const image = document.createElement('img'); image.src = preview.url; image.width = preview.width; image.height = preview.height; image.alt = t(msg("marks.previewImage", "标注画面")); image.loading = 'lazy'; image.onerror = () => { image.hidden=true; }; thumbnail.append(image);
  } else { thumbnail.textContent = mark.text || t(msg("marks.noPreview", "暂无预览")); }
  content.append(thumbnail);
  const footer = document.createElement('span'); footer.className = 'mark-footer';
  const note = document.createElement('span'); note.className = 'mark-note'; note.textContent = mark.text; note.title = mark.text;
  const author = document.createElement('span'); author.className = 'mark-author'; author.textContent = mark.author?.name || t(msg("marks.anonymous", "未署名"));
  footer.append(note, author); content.append(footer); return content;
}

export function installAnnotationPanel(
  session: ReviewSession,
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
  preview.role = 'dialog'; preview.setAttribute('aria-label', t(msg("marks.previewDialog", "标注"))); preview.hidden = true; document.body.append(preview);
  const lifecycle = new AbortController();
  // Re-render rows on language change; the closure only runs after install.
  const stopLanguage = onLanguageChange(() => localize(), lifecycle.signal);
  let expanded = false;
  let lastEntries: AnnotationEntry[] = [];
  let anchor: HTMLElement | null = null;
  let dismiss: ReturnType<typeof setTimeout> | undefined;
  const cancelDismiss = () => { clearTimeout(dismiss); };
  function hidePreview() {
    cancelDismiss(); preview.hidden = true; preview.replaceChildren(); anchor?.setAttribute('aria-expanded', 'false'); anchor = null;
  }
  const deferHide = () => { cancelDismiss(); dismiss = setTimeout(() => {
    if (!preview.contains(document.activeElement)) hidePreview();
  }, 150); };
  function actions(mark: Mark, _slot: Slot, container: HTMLElement) {    const actions = document.createElement('div'); actions.className = 'annotation-card-actions';
    const removeButton = createIconButton({ glyph: 'trash', className: 'annotation-remove', label: t(msg("marks.deleteMarkName", "删除标注 {label}"), { label: mark.text || formatTime(mark.frame.ptsUs) }), tooltip: t(msg("marks.deleteMark", "删除标注")) });
    removeButton.onclick = e => {
      e.stopPropagation();
      const confirmation = document.createElement('div'); confirmation.className = 'annotation-confirm';
      const label = document.createElement('span'); label.textContent = t(msg("marks.deleteConfirm", "删除这条标注？"));
      const cancel = document.createElement('button'); cancel.textContent = t(msg("marks.cancel", "取消"));
      const accept = document.createElement('button'); accept.textContent = t(msg("marks.delete", "删除")); accept.className = 'annotation-delete-confirm';
      cancel.onclick = () => { confirmation.remove(); removeButton.focus(); };
      accept.onclick = () => { hidePreview(); remove(mark.id); toggle.focus(); };
      confirmation.append(label, cancel, accept); container.append(confirmation); cancel.focus();
    };
    actions.append(removeButton); return actions;
  }
  // Strip cards and the hover preview share one layout; only the wrapper
  // differs (a seeking button in the strip, inert content in the dialog).
  function markRow(mark: Mark, slot: Slot, entryTag: 'button' | 'span' = 'button') {
    const row = document.createElement('div'); row.className = 'annotation-row'; row.dataset.slot = slot; identifyMark(row, mark.id);
    const entry = document.createElement(entryTag); entry.className = 'mark-entry';
    identifyMark(entry, mark.id); bindMarkHover(entry, mark.id);
    entry.append(markContent(mark, slot, actions(mark, slot, row), session)); row.append(entry);
    return { row, entry };
  }
  function showPreview(button: HTMLElement, mark: Mark, slot: Slot) {
    if (expanded || anchor === button) return;
    hidePreview(); anchor = button; button.setAttribute('aria-expanded', 'true');
    identifyMark(preview, mark.id);
    preview.replaceChildren(markRow(mark, slot, 'span').row); preview.hidden = false;
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
    const label = t(expanded ? msg("marks.showSymbols", "显示标注符号") : msg("marks.showCards", "显示标注卡片"));
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
  function renderEntries(entries: AnnotationEntry[]) {
    lastEntries = entries;
      const scrollLeft = list.scrollLeft;
      dock.classList.toggle('annotations-empty', !entries.length);
      hidePreview(); list.replaceChildren();
      if (!entries.length) {
        const empty = document.createElement('span'); empty.className = 'marks-empty';
        const hint = document.createElement('span'); hint.className = 'marks-empty-hint'; hint.textContent = t(msg("marks.addHint", "点击 + 添加"));
        empty.append(t(msg("admin.noMarksAdmin", "暂无标注")), hint); list.append(empty);
      }
      for (const { mark: savedMark, slot, offsetUs } of entries) {
        const mark = { ...savedMark, frame: { ...savedMark.frame, ptsUs: savedMark.frame.ptsUs + offsetUs } };
        const { row, entry: button } = markRow(mark, slot);
        button.setAttribute('aria-label', t(msg("marks.entryLabel", "轨道 {slot} 标注 {time} {text}"), { slot, time: formatTime(mark.frame.ptsUs), text: mark.text }));
        button.setAttribute('aria-haspopup', expanded ? 'false' : 'dialog');
        button.setAttribute('aria-controls', preview.id);
        button.onclick = () => { if (mark.frame.ptsUs >= 0) seek(mark.frame.ptsUs); };
        button.onpointerenter = () => showPreview(button, mark, slot); button.onpointerleave = deferHide;
        button.onfocus = () => showPreview(button, mark, slot); button.onblur = deferHide;
        button.onkeydown = event => {
          if (!expanded && event.key === 'ArrowUp') { event.preventDefault(); showPreview(button, mark, slot); preview.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus(); }
        };
        button.ondblclick = () => { if (mark.frame.ptsUs >= 0) { hidePreview(); edit(mark.id, mark.frame.ptsUs, slot); } };
        list.append(row);
      }
      list.scrollLeft = scrollLeft;
  }
  function localize() {
    for(const image of document.querySelectorAll<HTMLImageElement>('[data-mark-thumbnail] img, .seek-preview-thumbnail'))image.alt=t(msg('annotation.framePreview', '标注画面'));
    const toggleLabel=t(expanded?msg('marks.showSymbols','显示标注符号'):msg('marks.showCards','显示标注卡片'));
    toggle.setAttribute('aria-label',toggleLabel);toggle.title=toggleLabel;
    preview.setAttribute('aria-label',t(msg('marks.previewDialog','标注')));
    const empty=list.querySelector('.marks-empty');if(empty){empty.firstChild!.textContent=t(msg('admin.noMarksAdmin','暂无标注'));empty.querySelector('.marks-empty-hint')!.textContent=t(msg('marks.addHint','点击 + 添加'));}
    for(const root of [list,preview]) {
      for(const row of root.querySelectorAll<HTMLElement>('.annotation-row')) {
        const saved=lastEntries.find(entry=>entry.mark.id===row.dataset.markId);if(!saved)continue;
        const mark=saved.mark;
        const author=row.querySelector('.mark-author');if(author&&!mark.author?.name)author.textContent=t(msg('marks.anonymous','未署名'));
        const remove=row.querySelector<HTMLElement>('.annotation-remove');if(remove){remove.setAttribute('aria-label',t(msg('marks.deleteMarkName','删除标注 {label}'),{label:mark.text||formatTime(mark.frame.ptsUs)}));remove.dataset.tooltip=t(msg('marks.deleteMark','删除标注'));}
        for(const confirm of row.querySelectorAll('.annotation-confirm')){confirm.querySelector('span')!.textContent=t(msg('marks.deleteConfirm','删除这条标注？'));const buttons=confirm.querySelectorAll('button');buttons[0].textContent=t(msg('marks.cancel','取消'));buttons[1].textContent=t(msg('marks.delete','删除'));}
      }
    }
    for (const button of list.querySelectorAll<HTMLElement>('.mark-entry')) {
      const entry = lastEntries.find(entry => entry.mark.id === button.dataset.markId);
      if(entry) button.setAttribute('aria-label', t(msg('marks.entryLabel', '轨道 {slot} 标注 {time} {text}'), {slot:entry.slot,time:formatTime(entry.mark.frame.ptsUs+entry.offsetUs),text:entry.mark.text}));
    }
  }
  return {
    expanded: () => expanded, setExpanded, hidePreview, render: renderEntries,
    dispose() { stopLanguage(); hidePreview(); lifecycle.abort(); preview.remove(); toggle.onclick = null; },
  };

}
