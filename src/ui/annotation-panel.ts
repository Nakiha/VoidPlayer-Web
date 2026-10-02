import type { Mark, Slot } from '../model.ts';
import { formatTime } from '../model.ts';
import { annotationThumbnails } from './annotation-thumbnails.ts';
import { createIconButton } from './controls.ts';
import { icon } from './icons.ts';
import { markSymbol, identifyMark, bindMarkHover } from './mark-symbol.ts';
import type { ReviewSession } from '../session.ts';

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
    const image = document.createElement('img'); image.src = preview.url; image.width = preview.width; image.height = preview.height; image.alt = '标注画面'; image.loading = 'lazy'; image.onerror = () => { image.hidden=true; }; thumbnail.append(image);
  } else { thumbnail.textContent = mark.text || '暂无预览'; }
  content.append(thumbnail);
  const footer = document.createElement('span'); footer.className = 'mark-footer';
  const note = document.createElement('span'); note.className = 'mark-note'; note.textContent = mark.text; note.title = mark.text;
  const author = document.createElement('span'); author.className = 'mark-author'; author.textContent = mark.author?.name || '未署名';
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
  preview.role = 'dialog'; preview.setAttribute('aria-label', '标注'); preview.hidden = true; document.body.append(preview);
  const lifecycle = new AbortController();
  const discussion = document.createElement('dialog'); discussion.id='annotation-discussion'; discussion.className='annotation-discussion glass'; discussion.setAttribute('aria-labelledby','annotation-discussion-title');
  discussion.innerHTML=`<header class="dialog-heading"><h2 id="annotation-discussion-title">批注讨论</h2><button type="button" class="icon-button" aria-label="关闭讨论">${icon('close')}</button></header><p class="discussion-note"></p><div class="discussion-replies" aria-label="回复"></div><form><label>回复<textarea name="reply" maxlength="2000" required aria-label="回复内容" placeholder="说说你的看法…"></textarea></label><p class="discussion-message" role="status"></p><div class="workspace-actions"><button type="submit">发送回复</button><button type="button" class="discussion-resolve">标记已解决</button></div></form>`;
  document.body.append(discussion);
  let discussedId: string | undefined;
  const discussionNote=discussion.querySelector<HTMLElement>('.discussion-note')!;
  const discussionReplies=discussion.querySelector<HTMLElement>('.discussion-replies')!;
  const discussionMessage=discussion.querySelector<HTMLElement>('.discussion-message')!;
  const reply=discussion.querySelector<HTMLTextAreaElement>('textarea')!;
  const resolveButton=discussion.querySelector<HTMLButtonElement>('.discussion-resolve')!;
  function refreshDiscussion() {
    if (!discussion.open || !discussedId) return;
    const mark=session.getState().marks.find(mark=>mark.id===discussedId);
    if(!mark){discussionMessage.textContent='这条批注已删除或不在当前评审中。';reply.disabled=true;resolveButton.disabled=true;discussion.querySelector<HTMLButtonElement>('[type=submit]')!.disabled=true;return;}
    reply.disabled=false;resolveButton.disabled=false;discussion.querySelector<HTMLButtonElement>('[type=submit]')!.disabled=false;
    discussionNote.textContent=`${mark.author?.name || '未署名'} · ${mark.text || '画面批注'}`;
    resolveButton.textContent=mark.resolved?'重新打开':'标记已解决';
    discussionReplies.replaceChildren(...(mark.replies??[]).map(item=>{
      const row=document.createElement('article'),meta=document.createElement('small'),text=document.createElement('p');
      meta.textContent=`${item.author.name} · ${new Date(item.createdAt).toLocaleString()}`;text.textContent=item.text;row.append(meta,text);return row;
    }));
  }
  discussion.querySelector<HTMLButtonElement>('.icon-button')!.onclick=()=>discussion.close();
  discussion.addEventListener('close',()=>{discussedId=undefined;toggle.focus();});
  discussion.querySelector('form')!.onsubmit=event=>{
    event.preventDefault();if(!discussedId)return;
    try { session.updateMark(discussedId,{reply:reply.value});reply.value='';discussionMessage.textContent='回复已加入，保存状态见播放器。';refreshDiscussion(); }
    catch(error){discussionMessage.textContent=(error as Error).message;}
  };
  resolveButton.onclick=()=>{
    const mark=session.getState().marks.find(mark=>mark.id===discussedId);if(!mark)return;
    try{session.updateMark(mark.id,{resolved:!mark.resolved});discussionMessage.textContent=mark.resolved?'已重新打开':'已标记解决';refreshDiscussion();}
    catch(error){discussionMessage.textContent=(error as Error).message;}
  };
  const unsubscribeDiscussion=session.subscribe(refreshDiscussion);
  const resolvedToggle=document.createElement('button');resolvedToggle.id='annotation-show-resolved';resolvedToggle.textContent='显示已解决';resolvedToggle.setAttribute('aria-pressed','false');
  document.querySelector('.annotation-strip-tools')!.append(resolvedToggle);
  let showResolved=false, lastEntries:AnnotationEntry[]=[];
  resolvedToggle.onclick=()=>{showResolved=!showResolved;resolvedToggle.setAttribute('aria-pressed',String(showResolved));resolvedToggle.textContent=showResolved?'隐藏已解决':'显示已解决';renderEntries(lastEntries);};
  let expanded = false;
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
    const removeButton = createIconButton({ glyph: 'trash', className: 'annotation-remove', label: `删除标注 ${mark.text || formatTime(mark.frame.ptsUs)}`, tooltip: '删除标注' });
    removeButton.onclick = e => {
      e.stopPropagation();
      const confirmation = document.createElement('div'); confirmation.className = 'annotation-confirm';
      const label = document.createElement('span'); label.textContent = '删除这条标注？';
      const cancel = document.createElement('button'); cancel.textContent = '取消';
      const accept = document.createElement('button'); accept.textContent = '删除'; accept.className = 'annotation-delete-confirm';
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
    const discuss=document.createElement('button');discuss.className='annotation-discuss';discuss.dataset.discussMark=mark.id;discuss.textContent=`${mark.resolved?'已解决 · ':''}讨论${mark.replies?.length?` ${mark.replies.length}`:''}`;discuss.setAttribute('aria-label',`讨论批注 ${mark.text || formatTime(mark.frame.ptsUs)}`);
    discuss.onclick=()=>{hidePreview();discussedId=mark.id;reply.value='';discussionMessage.textContent='';discussion.showModal();refreshDiscussion();reply.focus();};row.append(discuss);
    row.dataset.resolved=String(!!mark.resolved);
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
  function renderEntries(entries: AnnotationEntry[]) {
      lastEntries=entries;
      entries=entries.filter(entry=>showResolved || !entry.mark.resolved);
      const scrollLeft = list.scrollLeft;
      dock.classList.toggle('annotations-empty', !entries.length);
      hidePreview(); list.replaceChildren();
      if (!entries.length) {
        const empty = document.createElement('span'); empty.className = 'marks-empty';
        const hint = document.createElement('span'); hint.className = 'marks-empty-hint'; hint.textContent = lastEntries.some(entry=>entry.mark.resolved)?'可显示已解决批注':'点击 + 添加';
        empty.append('暂无标注', hint); list.append(empty);
      }
      for (const { mark: savedMark, slot, offsetUs } of entries) {
        const mark = { ...savedMark, frame: { ...savedMark.frame, ptsUs: savedMark.frame.ptsUs + offsetUs } };
        const { row, entry: button } = markRow(mark, slot);
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
        list.append(row);
      }
      list.scrollLeft = scrollLeft;
  }
  return {
    expanded: () => expanded, setExpanded, hidePreview, render: renderEntries,
    dispose() { hidePreview(); lifecycle.abort(); unsubscribeDiscussion(); discussion.remove(); resolvedToggle.remove(); preview.remove(); toggle.onclick = null; },
  };
}
