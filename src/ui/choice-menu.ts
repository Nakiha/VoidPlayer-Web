import { onLanguageChange } from '../i18n.ts';
import { icon } from './icons.ts';
import { installMenu } from './menu.ts';

type Choice = { value: string; label: string; action?: boolean };

/** Theme-owned radio menu in the popover top layer, with keyboard selection and focus return. */
export function installChoiceMenu(id:string, choices:Choice[] | (() => Choice[]), choose:(value:string)=>void, glyph?: Parameters<typeof icon>[0], preview?: (value:string)=>HTMLElement, anchor?: () => DOMRect, canOpen?: () => boolean) {
  let options = typeof choices === 'function' ? choices() : choices;
  const button = document.getElementById(id) as HTMLButtonElement;
  const menu = document.createElement('div'); menu.id = `${id}-menu`; menu.className = 'choice-menu';
  menu.setAttribute('popover','auto'); menu.setAttribute('role','menu'); menu.setAttribute('aria-label',button.getAttribute('aria-label')!);
  button.setAttribute('aria-controls',menu.id); button.setAttribute('aria-haspopup','menu');
  const dialog = button.closest('dialog');
  // A body sibling would be inert while the settings dialog is modal.
  (dialog ?? document.body).append(menu);
  const label = document.createElement('span');
  if (glyph) button.innerHTML = icon(glyph); else button.replaceChildren();
  const sample = options.length ? preview?.(options[0].value) : undefined; if (sample) button.append(sample);
  button.append(label); button.insertAdjacentHTML('beforeend',icon('down'));
  let value = options[0]?.value ?? '';
  let buttons: HTMLButtonElement[] = [];
  function renderOptions() {
    menu.replaceChildren();
    buttons = options.map(option => {
      const item = document.createElement('button'); item.type = 'button'; item.setAttribute('aria-label', option.label);
      if (preview) item.append(preview(option.value)); else item.textContent = option.label;
      item.setAttribute('role',option.action?'menuitem':'menuitemradio'); if(!option.action)item.setAttribute('aria-checked', String(option.value === value)); item.dataset.value = option.value; item.onclick = () => choose(option.value);
      menu.append(item); return item;
    });
  }
  function updateOptions(next: Choice[]) {
    if(next.length===options.length && next.every((option,i)=>option.value===options[i].value&&option.action===options[i].action)) {
      options=next;buttons.forEach((button,i)=>{button.setAttribute('aria-label',options[i].label);if(!preview)button.textContent=options[i].label;});
    }else {controller.close();options=next;renderOptions();}
  }
  renderOptions();
  const controller = installMenu(button, menu, { anchor, canOpen, selected: () => buttons[options.findIndex(o => o.value === value)], bounds: () => button.closest('.annotation-toolbar')?.parentElement?.getBoundingClientRect() });
  const stopLanguage = onLanguageChange(() => {
    menu.setAttribute('aria-label', button.getAttribute('aria-label') ?? '');
    if (typeof choices === 'function') { updateOptions(choices()); }
  });
  dialog?.addEventListener('close', controller.close);
  dialog?.addEventListener('settings-pane-change', controller.close);
  return {
    setOptions(next: Choice[] | (() => Choice[])) { choices = next; updateOptions(typeof next === 'function' ? next() : next); },
    sync(next:string,text:string,enabled:boolean) { menu.setAttribute('aria-label',button.getAttribute('aria-label') ?? ''); value=next;label.textContent=text; if (sample && next) { const current = preview!(next); sample.replaceChildren(...current.childNodes); sample.style.cssText = current.style.cssText; }button.disabled=!enabled; if(!enabled)controller.close();buttons.forEach((b,i)=>{if(!options[i].action)b.setAttribute('aria-checked',String(options[i].value===value));}); },
    dispose() { stopLanguage(); dialog?.removeEventListener('close', controller.close); dialog?.removeEventListener('settings-pane-change', controller.close); controller.dispose(); menu.remove(); },
  };
}

/** A real screen-pixel stroke, shared by the trigger and every width choice. */
export function strokePreview(value: string) {
  const line = document.createElement('span'); line.className = 'stroke-sample';
  line.setAttribute('aria-hidden', 'true'); line.style.height = `${Number(value)}px`;
  return line;
}
