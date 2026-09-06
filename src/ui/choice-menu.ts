import { icon } from './icons.ts';
import { installMenu } from './menu.ts';

/** Theme-owned radio menu in the popover top layer, with keyboard selection and focus return. */
export function installChoiceMenu(id:string, options:{value:string;label:string}[], choose:(value:string)=>void, glyph?: Parameters<typeof icon>[0], preview?: (value:string)=>HTMLElement) {
  const button = document.getElementById(id) as HTMLButtonElement;
  const menu = document.createElement('div'); menu.id = `${id}-menu`; menu.className = 'choice-menu';
  menu.setAttribute('popover','auto'); menu.setAttribute('role','menu'); menu.setAttribute('aria-label',button.getAttribute('aria-label')!);
  button.setAttribute('aria-controls',menu.id); button.setAttribute('aria-haspopup','menu');
  document.body.append(menu);
  const label = document.createElement('span');
  if (glyph) button.innerHTML = icon(glyph); else button.replaceChildren();
  const sample = preview?.(options[0].value); if (sample) button.append(sample);
  button.append(label); button.insertAdjacentHTML('beforeend',icon('down'));
  let value = options[0].value;
  const buttons = options.map(option => {
    const item = document.createElement('button'); item.type = 'button'; item.setAttribute('aria-label', option.label);
    if (preview) item.append(preview(option.value)); else item.textContent = option.label;
    item.setAttribute('role','menuitemradio'); item.onclick = () => choose(option.value);
    menu.append(item); return item;
  });
  const controller = installMenu(button, menu, { selected: () => buttons[options.findIndex(o => o.value === value)], bounds: () => button.closest('.annotation-toolbar')?.parentElement?.getBoundingClientRect() });
  return {
    sync(next:string,text:string,enabled:boolean) { value=next;label.textContent=text; if (sample && next) { const current = preview!(next); sample.replaceChildren(...current.childNodes); sample.style.cssText = current.style.cssText; }button.disabled=!enabled; if(!enabled)controller.close();buttons.forEach((b,i)=>b.setAttribute('aria-checked',String(options[i].value===value))); },
    dispose() { controller.dispose(); menu.remove(); },
  };
}

/** A real screen-pixel stroke, shared by the trigger and every width choice. */
export function strokePreview(value: string) {
  const line = document.createElement('span'); line.className = 'stroke-sample';
  line.setAttribute('aria-hidden', 'true'); line.style.height = `${Number(value)}px`;
  return line;
}
