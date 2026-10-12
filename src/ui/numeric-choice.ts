import { onLanguageChange } from '../i18n.ts';
import { installChoiceMenu } from './choice-menu.ts';
import type { icon } from './icons.ts';

/** One unchanged control surface, with independent preset and value targets. */
export function installNumericChoice(id: string, options: {
  glyph: Parameters<typeof icon>[0]; presets: number[]; suffix: string;
  min: number; max: number; editLabel(): string; choose(value: number): void;
}) {
  const trigger = document.getElementById(id) as HTMLButtonElement;
  const wrapper = document.createElement('span'); wrapper.id = `${id}-control`;
  wrapper.className = `${trigger.className} numeric-choice`;
  trigger.before(wrapper); wrapper.append(trigger); trigger.className = 'numeric-choice-trigger';
  const valueButton = document.createElement('button'); valueButton.type = 'button';
  valueButton.id = `${id}-value`; valueButton.className = 'numeric-choice-value';
  const input = document.createElement('input'); input.id = `${id}-input`;
  input.className = 'numeric-choice-input'; input.type = 'text'; input.inputMode = 'decimal';
  input.autocomplete = 'off'; input.hidden = true;
  wrapper.append(valueButton, input);
  const life = new AbortController(); let value = options.min, editing = false;
  const menu = installChoiceMenu(id, options.presets.map(n => ({ value: String(n), label: `${n}${options.suffix}` })),
    next => options.choose(Number(next)), options.glyph, undefined, () => wrapper.getBoundingClientRect());
  function localize() {
    const label = options.editLabel(); input.setAttribute('aria-label', label);
    valueButton.setAttribute('aria-label', `${label} · ${valueButton.textContent ?? ''}`); valueButton.title = label;
  }
  function finish(commit: boolean, focus: boolean) {
    if (!editing) return true;
    const raw = input.value.trim().replace(/[×%]$/, '').trim().replace(',', '.');
    const next = Number(raw);
    if (commit && (!raw || !Number.isFinite(next) || next < options.min || next > options.max)) {
      input.setAttribute('aria-invalid', 'true'); return false;
    }
    editing = false; input.hidden = true; valueButton.hidden = false; input.removeAttribute('aria-invalid');
    if (commit) options.choose(next);
    if (focus && !valueButton.disabled) valueButton.focus();
    return true;
  }
  valueButton.addEventListener('click', () => {
    menu.close(); editing = true; valueButton.hidden = true; input.hidden = false;
    input.value = String(value); input.removeAttribute('aria-invalid'); input.focus(); input.select();
  }, { signal: life.signal });
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); finish(event.key === 'Enter', true); }
  }, { signal: life.signal });
  input.addEventListener('blur', () => { if (!finish(true, false)) finish(false, false); }, { signal: life.signal });
  input.addEventListener('input', () => input.removeAttribute('aria-invalid'), { signal: life.signal });
  onLanguageChange(localize, life.signal); localize();
  return {
    close() { menu.close(); finish(false, false); },
    sync(next: string, text: string, enabled: boolean) {
      value = Number(next); menu.sync(next, text, enabled); valueButton.textContent = text;
      valueButton.disabled = !enabled; wrapper.dataset.disabled = String(!enabled);
      if (!enabled) finish(false, false); localize();
    },
    dispose() { life.abort(); menu.dispose(); },
  };
}
