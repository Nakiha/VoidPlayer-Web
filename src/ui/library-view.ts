import { createMiddleFilename } from './middle-filename.ts';
import { formatRecentDate, t, msg } from '../i18n.ts';
import type { LibraryPage, LibraryRoot } from '../services/library.ts';
import type { SourceItem } from './source-catalog.ts';
import { icon } from './icons.ts';
import { createIconButton } from './controls.ts';

/** Shared browser DOM for the player and administration library surfaces. */
export type LibraryFileView = {
  slots?: string[]; loading?: string | null; failed?: string | null; home: boolean; offline?: boolean;
  tooltip: string; label?: string; blocked?: boolean; removeDisabled?: boolean; readOnly?: boolean; needsReselect?: boolean;
  open(): void; remove?(): void;
};
export const sizeText = (n: number) => n >= 2 ** 40 ? `${(n / 2 ** 40).toFixed(1)} TB` : n >= 2 ** 30 ? `${(n / 2 ** 30).toFixed(1)} GB` : `${(n / 2 ** 20).toFixed(1)} MB`;
export const storageText = (root?: LibraryRoot) => root?.state === 'offline' ? t(msg('sources.storageOffline', '存储离线'))
  : root?.availableBytes != null && root.totalBytes != null
    ? t(msg('sources.storageSpace', '{available} 可用 / 共 {total}'), { available: sizeText(root.availableBytes), total: sizeText(root.totalBytes) })
    : t(msg('sources.storageSpaceUnavailable', '空间信息不可用'));
const text = (tag: string, value: string, className = '') => {
  const el = document.createElement(tag); el.textContent = value; el.className = className; return el;
};

function openedTime(value: number | undefined, recent: boolean) {
  if (typeof value !== 'number') return;
  const date = new Date(value), now = Date.now();
  if (!Number.isFinite(date.getTime())) return;
  const opened = formatRecentDate(value, now);
  const time = text('time', opened, 'source-meta-time');
  time.setAttribute('datetime', date.toISOString());
  if (recent) {
    time.dataset.tooltip = opened;
    time.setAttribute('aria-label', opened);
    time.replaceChildren(text('span', opened, 'recent-time-full'),
      text('span', formatRecentDate(value, now, 'minutes'), 'recent-time-minutes'),
      text('span', formatRecentDate(value, now, 'short'), 'recent-time-short'));
  }
  return time;
}

function renderStorage(meta: Element, root?: LibraryRoot) {
  const ready = root?.state !== 'offline' && root?.availableBytes != null && root.totalBytes != null;
  meta.classList.toggle('source-storage',ready);
  if (!ready) {
    const value = storageText(root);
    if (meta.textContent !== value) meta.textContent = value;
    return;
  }
  let available = meta.querySelector('.source-storage-available'), total = meta.querySelector('.source-storage-total');
  if (!available || !total) {
    available = text('span','','source-storage-available'); total = text('span','','source-storage-total');
    meta.replaceChildren(available,document.createTextNode(' '),total);
  }
  const free = t(msg('sources.storageAvailable','{available} 可用'),{available:sizeText(root.availableBytes!)});
  const capacity = t(msg('sources.storageTotal','/ 共 {total}'),{total:sizeText(root.totalBytes!)});
  if (available.textContent !== free) available.textContent = free;
  if (total.textContent !== capacity) total.textContent = capacity;
}

function sourceDisplayName(name: string) {
  const base = name.split('/').pop() ?? name;
  return { base, dir: name.includes('/') ? name.slice(0, name.lastIndexOf('/')) : '' };
}

/** Keep decoded pixels when only row controls/status change, never across media versions. */
export function preserveLibraryThumbnail(previous: HTMLElement | undefined, next: HTMLElement) {
  if (!previous || previous === next || !next.dataset.thumbnailKey) return next;
  const cover = previous.querySelector<HTMLElement>(':scope > .source-thumb');
  const image = cover?.querySelector<HTMLImageElement>('img');
  if (!cover || !image?.naturalWidth || image.dataset.thumbDecoded !== 'true' || image.dataset.thumbKey !== next.dataset.thumbnailKey) return next;
  const replacement = next.querySelector(':scope > .source-thumb');
  if (replacement) replacement.replaceWith(cover); else next.prepend(cover);
  return next;
}

export function createLibraryFileRow(item: SourceItem, state: LibraryFileView) {
  const row = document.createElement('div'); row.className = 'source-row source-file';
  const open = document.createElement(state.readOnly ? 'div' : 'button'); open.className = 'source-open';
  if (open instanceof HTMLButtonElement) open.type = 'button';
  const slots = state.slots ?? [];
  const used = slots.length > 0;
  const loading = state.loading;
  const failed = state.failed;
  row.setAttribute('aria-busy', String(!!loading));
  row.classList.toggle('in-use', used);
  const info = document.createElement('div'); info.className = 'source-info';
  const { base, dir } = sourceDisplayName(item.name);
  const name = createMiddleFilename(base);
  const origin = item.library ? state.home ? [item.library.root, dir].filter(Boolean).join(' / ') : ''
    : item.libraryId ? (state.home ? t(msg('sources.startMetaLibrary', '媒体库')) : '') : t(msg('sources.localTag', '(本地)'))
      + (state.needsReselect ? t(msg('sources.reselectNeeded', ' · 需重新选择')) : '');
  // Full path lives in the tooltip; the visible name stays a basename.
  row.dataset.tooltip = state.tooltip;
  const pending = item.library?.state === 'pending';
  const offline = state.offline;
  const stateLabel = loading ?? (failed ? t(msg("sources.loadFailedWith", "载入失败：{reason}"), { reason: failed }) : offline ? t(msg("sources.storageOffline", "存储离线")) : pending ? t(msg('sources.waitingForStableFile', '等待文件稳定')) : '');
  const status = text('span', '', 'source-meta source-meta-columns');
  if (state.home) info.classList.add('source-recent-info');
  const size = text('span', '', 'source-meta-size');
  const originText = text('span', [stateLabel, origin].filter(Boolean).join(' · '), 'source-meta-origin');
  status.dataset.tooltip = row.dataset.tooltip;
  if (loading || failed) { status.setAttribute('role', 'status'); }
  const titleLine = document.createElement('span'); titleLine.className = 'source-title';
  if (slots.length) {
    const badges = document.createElement('span'); badges.className = 'source-track-badges';
    badges.setAttribute('aria-label', t(msg('sources.loadedTracks', '已上屏轨道：{slots}'), { slots: slots.join(', ') }));
    for (const slot of slots) { const badge = text('span', slot, `slot slot-${slot}`); badge.setAttribute('aria-hidden', 'true'); badges.append(badge); }
    if (state.home) status.append(badges); else size.append(badges);
  }
  size.prepend(text('span', sizeText(item.size), 'source-size-value'));
  status.prepend(size);
  if (originText.textContent) size.after(originText);
  const time = openedTime(item.openedAt, state.home);
  if (time) status.append(time);
  titleLine.append(name);
  name.dataset.tooltip = row.dataset.tooltip;
  info.append(titleLine, status);
  row.setAttribute('aria-label', state.label ?? (used ? t(msg('sources.alreadyInViewName', '已在视图中：{name}'), { name: item.name })
    : loading ? t(msg('sources.loadingName', '正在载入：{name}'), { name: item.name })
    : item.library || item.file ? t(msg('sources.addToViewName', '添加到视图：{name}'), { name: item.name })
    : t(msg('sources.reselectName', '重新选择 {name}'), { name: item.name })));
  const blocked = state.blocked ?? (!!loading || !!pending || !!offline || !!item.libraryId && !item.library);
  row.setAttribute('aria-disabled', String(!used && blocked));
  open.dataset.tooltip = row.dataset.tooltip;
  open.setAttribute('aria-label', row.getAttribute('aria-label')!); open.setAttribute('aria-disabled', String(used || blocked));
  row.onclick = () => { if (row.getAttribute('aria-disabled') !== 'true') state.open(); };
  open.append(info); row.append(open);
  if (used) {
    const remove = createIconButton({glyph:'close', label:t(msg('sources.takeOffName', '下屏：{name}'), {name:item.name}), className:'source-remove remove-track'});
    remove.setAttribute('aria-disabled', String(!!state.removeDisabled));
    remove.onclick = event => {event.stopPropagation(); state.remove?.();}; row.append(remove);
  }
  row.dataset.sourceKey = item.key;
  if (item.library?.rootId) {
    row.dataset.rootId=item.library.rootId; row.dataset.libraryPath=item.library.name;
    row.dataset.libraryKind='file'; row.dataset.libraryVersion=item.library.version;
  }
  return row;
}

export function installLibraryListing(list: HTMLElement, options: {
  fileRow(item: SourceItem): HTMLElement;
  navigate(root: string, directory: string): void;
  registerMount(row: HTMLElement, root: string): void;
  idPrefix?: string;
  collapsible?: boolean;
  recent?: boolean;
}) {
  const branchArrow = () => {
    const arrow = document.createElement('span'); arrow.className='library-branch-arrow'; arrow.setAttribute('aria-hidden','true');
    arrow.innerHTML=icon('caretRight'); return arrow;
  };
  const group = (id: string, label: string) => {
    const section = document.createElement('details'); section.className = 'library-root-group'; section.id = `${options.idPrefix ?? ''}${id}`; section.open = true;
    const summary = document.createElement('summary'); summary.innerHTML = icon('caretRight');
    summary.append(text('span', label, 'source-group-label'));
    const body = document.createElement('div'); body.className = 'source-group-items'; section.append(summary, body);
    return { section, body };
  };
  const mountsGroup = options.collapsible === false ? (() => {
    const section = document.createElement('section'); section.className='library-root-group'; section.id=`${options.idPrefix ?? ''}library-mounts`;
    const body = document.createElement('div'); body.className='source-group-items'; section.append(body); return {section,body};
  })() : group('library-mounts', t(msg('sources.mountList', '库列表')));
  const recentGroup = group('library-recents', t(msg('shell.recentlyOpened', '最近打开')));

  function render({home,query,page,items,fingerprint}: {
    home: boolean; query: string; page: LibraryPage | null; items: SourceItem[]; fingerprint(item: SourceItem): string;
  }) {
    const folders = home ? [] : page?.directories ?? [];
    const mounts = home ? (page?.roots ?? []).filter(root => root.name.toLocaleLowerCase().includes(query)) : [];
    const existing = new Map([...list.querySelectorAll<HTMLElement>('[data-source-key]')].map(node => [node.dataset.sourceKey, node]));
    const rows: HTMLElement[] = [];
    const reuse = (key: string, fingerprint: string, create: () => HTMLElement, target = rows) => {
      const old = existing.get(key);
      const row = old?.dataset.fingerprint === fingerprint ? old : preserveLibraryThumbnail(old,create());
      row.dataset.sourceKey = key; row.dataset.fingerprint = fingerprint; target.push(row);
    };
    for (const folder of folders) {
      reuse(`folder:${folder.rootId}/${folder.path}`, JSON.stringify(folder), () => {
        const row = document.createElement('button'); row.className = 'source-row library-folder';
        const glyph = text('span', '', 'source-thumb library-folder-icon'); glyph.innerHTML = icon('open');
        const info = text('span', '', 'source-info');
        info.append(text('span', folder.name, 'filename'));
        row.dataset.rootId = folder.rootId;
        row.dataset.libraryPath=folder.path; row.dataset.libraryKind='directory';
        row.setAttribute('aria-haspopup', 'menu');
        row.setAttribute('aria-label', t(msg("sources.openFolder", "打开目录：{name}"), { name: folder.name })); row.append(glyph, info, branchArrow()); row.onclick = () => options.navigate(folder.rootId, folder.path); return row;
      });
    }
    const reconcile = (container: HTMLElement, children: HTMLElement[]) => {
      children.forEach((row, index) => { row.classList.toggle('source-striped', index % 2 === 1); if (container.children[index] !== row) container.insertBefore(row, container.children[index] ?? null); });
      while (container.children.length > children.length) container.lastElementChild!.remove();
    };
    if (home) {
      const mountsRows: HTMLElement[] = [], recentRows: HTMLElement[] = [];
      for (const mount of mounts) reuse(`mount:${mount.id}`, JSON.stringify([mount.id, mount.name, mount.state, storageText(mount)]), () => {
        const row = document.createElement('button'); row.type = 'button'; row.className = 'source-row library-folder library-mount';
        row.dataset.rootId = mount.id; row.setAttribute('aria-label', t(msg('libraryBrowser.openMount', '打开媒体库：{name}'), { name: mount.name }));
        row.dataset.libraryKind='mount'; row.dataset.libraryPath='';
        const glyph = text('span', '', 'source-thumb library-folder-icon'); glyph.innerHTML = icon('libraryVolume');
        const info = text('span', '', 'source-info'); info.append(text('span', mount.name, 'filename'));
        const meta = text('span','','source-meta'); renderStorage(meta,mount); info.append(meta);
        row.append(glyph, info, branchArrow()); row.onclick = () => options.navigate(mount.id, '');
        options.registerMount(row, mount.id); return row;
      }, mountsRows);
      if (!mounts.length) reuse('mounts-empty', query, () => text('p', query ? t(msg('sources.noMatch', '没有匹配的片源'))
        : t(msg('libraryBrowser.noMounts', '暂无挂载的媒体库')), 'panel-empty'), mountsRows);
      if (options.recent !== false) for (const item of items) reuse(item.key, fingerprint(item), () => options.fileRow(item), recentRows);
      if (options.recent !== false && !items.length) reuse('recent-empty', query, () => text('p', query ? t(msg('sources.noMatch', '没有匹配的片源'))
        : t(msg('sources.noRecentShort', '暂无最近片源')), 'panel-empty'), recentRows);
      reconcile(mountsGroup.body, mountsRows); reconcile(recentGroup.body, recentRows);
      rows.push(mountsGroup.section);
      if (options.recent !== false) rows.push(recentGroup.section);
    } else {
      for (const item of items) reuse(item.key, fingerprint(item), () => options.fileRow(item));
      if (!items.length && !folders.length) reuse('empty', query, () => text('p', query ? t(msg('sources.noMatch', '没有匹配的片源'))
        : t(msg('sources.emptyDirectory', '当前目录没有片源')), 'panel-empty'));
    }
    reconcile(list, rows);
  }
  function localize(page: LibraryPage | null, home: boolean, query: string) {
    const label = mountsGroup.section.querySelector('.source-group-label');
    if (label) label.textContent = t(msg('sources.mountList', '库列表'));
    recentGroup.section.querySelector('.source-group-label')!.textContent = t(msg('shell.recentlyOpened', '最近打开'));
    for (const empty of list.querySelectorAll<HTMLElement>('.panel-empty')) {
      empty.textContent = query ? t(msg('sources.noMatch', '没有匹配的片源'))
        : empty.dataset.sourceKey === 'mounts-empty' ? t(msg('libraryBrowser.noMounts', '暂无挂载的媒体库'))
        : home ? t(msg('sources.noRecentShort', '暂无最近片源')) : t(msg('sources.emptyDirectory', '当前目录没有片源'));
    }
    for (const row of list.querySelectorAll<HTMLElement>('.library-folder')) {
      const name = row.querySelector('.filename')?.textContent ?? '';
      row.setAttribute('aria-label', row.classList.contains('library-mount') ? t(msg('libraryBrowser.openMount', '打开媒体库：{name}'), {name})
        : t(msg('sources.openFolder', '打开目录：{name}'), {name}));
      const meta = row.querySelector('.source-meta');
      if (meta && row.classList.contains('library-mount')) renderStorage(meta,page?.roots.find(root => root.id === row.dataset.rootId));
    }
  }
  return {render,localize,recentGroup:recentGroup.section};
}

/** One structural surface; hosts supply their own optional footer content. */
export function librarySurfaceShell(footer = '') {
  return `<div class="source-tools" id="source-tools"></div>
    <div id="source-list" class="source-list"></div>
    <div id="source-scrollbar" class="source-scrollbar" aria-hidden="true"><span id="source-scrollbar-thumb"></span></div>
    <div class="source-foot" id="source-foot">${footer}</div>`;
}

export function patchLibraryRow(row: HTMLElement, fresh: HTMLElement) {
  const attrs = ['aria-label', 'title', 'data-tooltip', 'aria-disabled'];
  for (const attr of attrs) if (fresh.hasAttribute(attr)) row.setAttribute(attr, fresh.getAttribute(attr)!);
  const remove = row.querySelector('.source-remove'), translatedRemove = fresh.querySelector('.source-remove');
  if (remove && translatedRemove) remove.setAttribute('aria-label', translatedRemove.getAttribute('aria-label')!);
  const opener = row.querySelector('.source-open');
  if (opener && fresh.querySelector('.source-open')) for (const attr of ['aria-label','data-tooltip']) opener.setAttribute(attr, fresh.querySelector('.source-open')!.getAttribute(attr)!);
  for (const selector of ['.source-meta:not(.source-meta-columns)', '.source-meta-origin', '.source-meta-time', '.source-size-value', '.filename']) {
    const translated = fresh.querySelectorAll<HTMLElement>(selector);
    row.querySelectorAll<HTMLElement>(selector).forEach((node,index) => {
      const copy = translated[index]; if (!copy) return;
      for (const attr of attrs) if (copy.hasAttribute(attr)) node.setAttribute(attr,copy.getAttribute(attr)!);
      if (copy.children.length) node.replaceChildren(...copy.childNodes);
      else if (node.textContent !== copy.textContent) node.textContent = copy.textContent;
    });
  }
}
