import { icon } from './icons.ts';

type IconButton = {
  glyph: Parameters<typeof icon>[0]; label: string; tooltip?: string;
  className?: string; iconClass?: string; attributes?: Record<string, string>;
};
const escape = (value: string) => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

/** Shared markup and sizing class for shell and dynamically created tool buttons. */
export function iconButton({ glyph, label, tooltip = label, className = '', iconClass = '', attributes = {} }: IconButton) {
  const attrs = Object.entries(attributes).map(([key, value]) => `${key}="${escape(value)}"`).join(' ');
  return `<button type="button" class="icon-button ${escape(className)}" aria-label="${escape(label)}" data-tooltip="${escape(tooltip)}" ${attrs}>${icon(glyph, iconClass)}</button>`;
}
export function createIconButton(options: IconButton): HTMLButtonElement {
  const template = document.createElement('template'); template.innerHTML = iconButton(options);
  return template.content.firstElementChild as HTMLButtonElement;
}
