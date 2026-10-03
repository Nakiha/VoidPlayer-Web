import { t, msg } from '../i18n.ts';
import { localizedText, type LocalizedValue } from '../ui/live-localization.ts';
/** Bind copy to existing nodes; server-provided values always remain text. */
export function emptyState(title: LocalizedValue, description: LocalizedValue, player = false) {
  const box = document.createElement('div'); box.className = 'admin-empty';
  const heading = document.createElement('strong'); localizedText(heading, title);
  const detail = document.createElement('p'); localizedText(detail, description);
  box.append(heading, detail);
  if (player) { const link = document.createElement('a'); link.href = '/'; link.className = 'admin-link-button'; localizedText(link, () => t(msg("admin.openInPlayer", "打开播放器"))); box.append(link); }
  return box;
}
export function properties(target: HTMLElement, values: () => [string, string][]) {
  target.replaceChildren(...values().map((_, index) => {
    const row = document.createElement('div'), term = document.createElement('dt'), detail = document.createElement('dd');
    localizedText(term, () => values()[index][0]); localizedText(detail, () => values()[index][1]); row.append(term, detail); return row;
  }));
}
