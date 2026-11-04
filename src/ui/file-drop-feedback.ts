import { t, msg, onLanguageChange } from '../i18n.ts';
import { icon } from './icons.ts';
import type { Slot } from '../../shared/review/model.ts';

/** A viewport sibling of the screens escapes image transforms, split clips and track headings. */
export function installFileDropFeedback(surface: HTMLElement) {
  const life = new AbortController();
  const overlay = document.createElement('div');
  overlay.id = 'file-drop-feedback'; overlay.className = 'file-drop-feedback'; overlay.hidden = true;
  overlay.setAttribute('role', 'status'); overlay.setAttribute('aria-live', 'polite'); overlay.setAttribute('aria-atomic', 'true');
  const bubble = document.createElement('span'); bubble.className = 'file-drop-bubble';
  bubble.innerHTML = icon('filePlus');
  const label = document.createElement('span'); bubble.append(label); overlay.append(bubble);
  surface.append(overlay);
  function text() {
    label.textContent = t(msg('fileDrop.release', '松开以添加视频'));
  }
  onLanguageChange(text, life.signal); text();
  return {
    show(slots: Slot[]) { overlay.hidden = !slots.length; },
    dispose() { life.abort(); overlay.remove(); },
  };
}
