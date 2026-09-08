/** Shared empty and property views; server-provided strings always remain text. */
export function emptyState(title: string, description: string, player = false) {
  const box = document.createElement('div'); box.className = 'admin-empty';
  const heading = document.createElement('strong'); heading.textContent = title;
  const detail = document.createElement('p'); detail.textContent = description;
  box.append(heading, detail);
  if (player) { const link = document.createElement('a'); link.href = '/'; link.className = 'admin-link-button'; link.textContent = '打开播放器'; box.append(link); }
  return box;
}
export function properties(target: HTMLElement, values: [string, string][]) {
  target.replaceChildren(...values.map(([label, value]) => {
    const row = document.createElement('div'), term = document.createElement('dt'), detail = document.createElement('dd');
    term.textContent = label; detail.textContent = value; row.append(term, detail); return row;
  }));
}
