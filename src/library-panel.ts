import type { Slot } from './model.ts';
import { fetchLibrary } from './library.ts';
import type { LibraryEntry } from './library.ts';

// Media library dialog: lists the whitelisted folders served by the optional
// browser/server process. Absence of the service degrades to a hint; local
// file opening keeps working either way.

const formatSize = (bytes: number) =>
  bytes >= 1 << 30 ? `${(bytes / (1 << 30)).toFixed(1)} GB` : bytes >= 1 << 20 ? `${(bytes / (1 << 20)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

export function installLibraryPanel(openButton: HTMLElement, onLoad: (entry: LibraryEntry, slot: Slot) => void) {
  const dialog = document.createElement('dialog');
  dialog.className = 'library-panel';
  dialog.innerHTML = `<h2>媒体库</h2><p class="library-status" role="status">正在连接媒体库服务…</p><div class="library-list"></div><div class="log-actions"><button data-action="refresh">刷新</button><button data-action="close">关闭</button></div>`;
  document.body.append(dialog);
  const status = dialog.querySelector<HTMLElement>('.library-status')!;
  const list = dialog.querySelector<HTMLElement>('.library-list')!;

  async function refresh() {
    status.textContent = '正在连接媒体库服务…';
    list.replaceChildren();
    const library = await fetchLibrary();
    if (!library) {
      status.textContent = '未检测到媒体库服务。用 npm run serve -- --folder <目录> 启动后刷新。';
      return;
    }
    if (!library.entries.length) {
      status.textContent = `服务已连接（${library.roots.join('、') || '空'}），但未找到媒体文件。`;
      return;
    }
    status.textContent = `${library.entries.length} 个文件 · 目录：${library.roots.join('、')}${library.truncated ? ' · 结果过多已截断' : ''}`;
    for (const entry of library.entries) {
      const row = document.createElement('div');
      row.className = 'library-row';
      const name = document.createElement('span');
      name.className = 'library-name';
      name.textContent = entry.name;
      name.title = `${entry.root}/${entry.name}`;
      const size = document.createElement('span');
      size.className = 'library-size';
      size.textContent = formatSize(entry.size);
      row.append(name, size);
      for (const slot of ['A', 'B'] as Slot[]) {
        const button = document.createElement('button');
        button.textContent = `载入 ${slot}`;
        button.onclick = () => { onLoad(entry, slot); dialog.close(); };
        row.append(button);
      }
      list.append(row);
    }
  }

  openButton.addEventListener('click', () => { dialog.showModal(); void refresh(); });
  dialog.querySelector('[data-action="refresh"]')!.addEventListener('click', () => void refresh());
  dialog.querySelector('[data-action="close"]')!.addEventListener('click', () => dialog.close());
  return () => dialog.remove();
}
