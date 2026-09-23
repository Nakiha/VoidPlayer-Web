/** Shared keyboard bindings and platform labels for handlers, help, and tooltips. */
const mac = /Mac|iPhone|iPad|iPod/.test(navigator.platform);
type Binding = { code: string; label: string; primary?: boolean; ctrl?: boolean; shift?: boolean };
export const SHORTCUTS = {
  play: { code: 'Space', label: 'Space' },
  previous: { code: 'ArrowLeft', label: '←' },
  next: { code: 'ArrowRight', label: '→' },
  layout: { code: 'KeyM', label: 'M' },
  panelInspector: { code: 'Backquote', label: '·', ctrl: true },
  panelAnalysis: { code: 'Digit1', label: '1', ctrl: true },
  panelSubtracks: { code: 'Digit2', label: '2', ctrl: true },
  panelSources: { code: 'Digit3', label: '3', ctrl: true },
  settings: { code: 'Comma', label: ',', primary: true },
  annotate: { code: 'KeyN', label: 'N' },
  select: { code: 'KeyV', label: 'V' },
  pen: { code: 'KeyP', label: 'P' },
  rect: { code: 'KeyR', label: 'R' },
  ellipse: { code: 'KeyO', label: 'O' },
  line: { code: 'KeyL', label: 'L' },
  text: { code: 'KeyT', label: 'T' },
  eraser: { code: 'KeyE', label: 'E' },
  undo: { code: 'KeyZ', label: 'Z', primary: true },
  redo: { code: 'KeyZ', label: 'Z', primary: true, shift: true },
  delete: { code: 'Delete', label: 'Delete' },
  close: { code: 'Escape', label: 'Esc' },
} as const satisfies Record<string, Binding>;
export type Shortcut = keyof typeof SHORTCUTS;
export const PANEL_SHORTCUTS = {
  inspector: 'panelInspector', analysis: 'panelAnalysis', subtracks: 'panelSubtracks', sources: 'panelSources',
} as const satisfies Record<string, Shortcut>;
export function shortcutLabel(id: Shortcut) {
  const binding: Binding = SHORTCUTS[id];
  return [binding.ctrl ? 'Ctrl' : binding.primary ? mac ? '⌘' : 'Ctrl' : '', binding.shift ? '⇧' : '', binding.label].filter(Boolean).join(' + ');
}
export function shortcutTooltip(label: string, id: Shortcut) { return `${label} (${shortcutLabel(id)})`; }
export function matchesShortcut(event: KeyboardEvent, id: Shortcut) {
  const binding: Binding = SHORTCUTS[id];
  return event.code === binding.code && (binding.shift ? event.shiftKey : !event.shiftKey) &&
    (binding.ctrl ? event.ctrlKey && !event.metaKey : binding.primary ? (event.metaKey || event.ctrlKey) : !event.metaKey && !event.ctrlKey) && !event.altKey;
}
