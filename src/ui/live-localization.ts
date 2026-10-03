import { onLanguageChange } from '../i18n.ts';
import { createLocalizedFragment } from './localized-shell.ts';

export type LocalizedValue = string | (() => string);
// Detached rows and their data can be collected without a locale change. No
// observer, timer or media/measurement callback is installed by this registry.
const bindings = new WeakMap<HTMLElement, Map<string, () => void>>();
function register(node: HTMLElement, key: string, update: () => void) {
  let entries = bindings.get(node);
  if (!entries) { entries = new Map(); bindings.set(node, entries); }
  entries.set(key, update); node.dataset.liveLocale = ''; update();
}
export function localizedText(node: HTMLElement, value: LocalizedValue) {
  const update = () => { const next = typeof value === 'function' ? value() : value; if (node.textContent !== next) node.textContent = next; };
  if (typeof value === 'function') register(node, 'text', update);
  else { bindings.get(node)?.delete('text'); update(); }
}
export function localizedAttribute(node: HTMLElement, attribute: string, value: () => string) {
  register(node, attribute, () => { const next = value(); if (node.getAttribute(attribute) !== next) node.setAttribute(attribute, next); });
}
export function localizedFragment(node: HTMLElement, shell: () => string) {
  register(node, 'fragment', createLocalizedFragment(node, shell));
}
export function installLiveLocalization(root: HTMLElement, signal: AbortSignal) {
  return onLanguageChange(() => {
    for (const node of [root, ...root.querySelectorAll<HTMLElement>('[data-live-locale]')]) {
      for (const update of bindings.get(node)?.values() ?? []) update();
    }
  }, signal);
}
