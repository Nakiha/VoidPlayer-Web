import { installTimeInput, parseTimeInput } from '../time-input.ts';
import { installResizeGesture } from './resize-gesture.ts';
import { installPanelMotion, animatePanelLayout } from './panel-motion.ts';
import { installPanelResize } from './panel-resize.ts';
import { SLOTS } from '../model.ts';
import { createIconButton } from './controls.ts';
import type { ReviewSession } from '../session.ts';
import type { Slot } from '../model.ts';
import { formatTime } from '../model.ts';
import { colorLabel, rangeLabel } from '../media-metadata.ts';
import { markSymbol, identifyMark, bindMarkHover } from './mark-symbol.ts';
import { fetchLibrary, openLibraryItem } from '../library.ts';
import { openMedia } from '../media.ts';
import { seekTarget, showSeekPreview } from './seek-preview.ts';
import { installAnnotationPanel } from './annotation-panel.ts';
import { WorkspaceState, marksForTrack, trackTiming } from './workspace-state.ts';
import type { Panel, ReviewTrack } from './workspace-state.ts';
import { SourceCatalog, sourceInUse } from './source-catalog.ts';
import type { SourceItem } from './source-catalog.ts';

type State = ReturnType<ReviewSession['getState']>;
type Action = (action: () => unknown | Promise<unknown>, name?: string, data?: unknown) => Promise<void>;
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const HISTORY_KEY = 'voidplayer.sources.v1';
const sizeText = (n: number) => n >= 2 ** 30 ? `${(n / 2 ** 30).toFixed(1)} GB` : `${(n / 2 ** 20).toFixed(1)} MB`;
const text = (tag: string, value: string, className = '') => {
  const el = document.createElement(tag); el.textContent = value; el.className = className; return el;
};
function readHistory() { try { return JSON.parse(localStorage.getItem(HISTORY_KEY) ?? '[]'); } catch { return []; } }

export function installWorkbench(session: ReviewSession, act: Action, addMark: (slot: Slot, markId?: string) => void) {
  const view = new WorkspaceState();
  const catalog = new SourceCatalog(readHistory());
  let sourceTab = 'available';
  let startTab = 'available';
  let libraryStatus = '';
  let refreshing: Promise<void> | undefined;
  let libraryChecked = false;
  let disposed = false;
  let trackSignature = '';
  let dockSignature = '';
  let annotationSignature = '';
  let currentIds = '';

  const lifecyle = new AbortController();
  const workspace = $('workspace');
  const panelMotion = installPanelMotion(workspace, lifecyle.signal);
  const panelResize = installPanelResize(workspace, lifecyle.signal, panel => {
    setPanel(panel, false); $(`toggle-${panel}`).focus();
  });
  const annotations = installAnnotationPanel(ptsUs => void act(() => session.seek(ptsUs), 'ui.mark-seek'), id => void act(() => session.deleteMark(id), 'ui.mark-delete'), (id, ptsUs) => void act(async () => { await session.seek(ptsUs); addMark(view.selected, id); }, 'ui.mark-edit'));
  let dockHeight = Number.parseFloat(getComputedStyle(workspace).getPropertyValue('--dock-default-height')) || 180;
  const save = () => { try { localStorage.setItem(HISTORY_KEY, JSON.stringify(catalog.serializable())); } catch { /* Session access still works when storage is disabled/full. */ } };

  function select(slot: Slot) {
    view.selected = slot;
    trackSignature = '';
    render(session.getState());
  }
  function syncPanels() {
    for (const panel of ['inspector', 'subtracks', 'sources'] as Panel[]) {
      const open = view.panels[panel];
      panelMotion.set(panel, open);
      $(`toggle-${panel}`).setAttribute('aria-expanded', String(open));
      $(`toggle-${panel}`).title = `${open ? '收起' : '展开'}${{ inspector: '轨道检查', subtracks: '子轨道', sources: '片源' }[panel]}`;

    }
  }
  function setPanel(panel: Panel, open: boolean) {
    view.setPanel(panel, open, window.innerWidth);
    syncPanels();
    panelResize.refresh();
    if (!open) { $('subtrack-preview').hidden = true; annotations.hidePreview(); }
    render(session.getState());
    if (panel === 'sources' && open) {
      renderSources();
      if (!libraryChecked) void refreshLibrary();
    }
  }
  for (const panel of ['inspector', 'subtracks', 'sources'] as Panel[]) {
    $(`toggle-${panel}`).onclick = () => setPanel(panel, !view.panels[panel]);
  }
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-close-panel]')) {
    button.onclick = () => {
      const panel = button.dataset.closePanel as Panel;
      setPanel(panel, false); $(`toggle-${panel}`).focus();
    };
  }
  function inspect(slot:Slot) {
    const close = view.panels.inspector && view.selected === slot;
    select(slot); setPanel('inspector', !close);
  }
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-inspect]')) button.onclick = () => inspect(button.dataset.inspect as Slot);
  $('subtrack-add-mark').onclick = () => { if (!session.getState().busy) addMark(view.selected); };

  function propertyRows(track: ReviewTrack) {
    const color = track.color;
    const hdr = color?.transfer === 'pq' || color?.transfer === 'hlg';
    return [
      ['编码', track.codec], ['尺寸', `${track.width} × ${track.height}`],
      ['时长', formatTime(track.durationUs)], ['解码', track.decoder === 'webcodecs' ? 'WebCodecs' : 'FFmpeg WASM'],
      [track.pixelFormat ? '像素格式' : '解码像素格式', track.pixelFormat || track.decodedPixelFormat || '未提供'],
      ['色域原色', colorLabel(color?.primaries)],
      ['传递特性', colorLabel(color?.transfer)],
      ['矩阵系数', colorLabel(color?.matrix)],
      ['范围', rangeLabel(color?.fullRange)],
      ...(hdr ? [['HDR 源', track.decoder === 'ffmpeg-wasm' ? 'SDR 兜底显示' : '浏览器输出未验证']] : []),
    ];
  }
  function renderInspector(state: State) {
    const selected = state.tracks.find(t => t.slot === view.selected);
    const signature = state.tracks.map(t => `${t.slot}:${t.id}`).join('/') + view.selected;
    if (signature !== trackSignature) {
      trackSignature = signature;
      const list = $('track-selector'); list.replaceChildren();
      for (const track of state.tracks) {
        const button = document.createElement('button'); button.className = 'track-choice';
        button.setAttribute('aria-label', `选择轨道 ${track.slot}`);
        button.setAttribute('aria-pressed', String(track.slot === view.selected));
        button.append(text('span', track.slot, `slot slot-${track.slot}`), text('span', track.name, 'filename'));
        button.dataset.tooltip = '查看轨道详情'; button.onclick = () => select(track.slot); list.append(button);
      }
      const properties = $('track-properties'); properties.replaceChildren();
      if (!selected) properties.append(text('p', '尚未载入轨道', 'panel-empty'));
      else {
        properties.append(text('h3', `轨道 ${selected.slot}`));
        const dl = document.createElement('dl');
        for (const [label, value] of propertyRows(selected)) {
          const dd = text('dd', value);
          if (label === '解码像素格式') dd.title = '浏览器解码输出的内存格式，可能与源视频的像素格式不同';
          if (['色域原色','传递特性','矩阵系数','范围'].includes(label) && selected.colorSource) dd.title = selected.colorSource === 'container' ? '来源：封装标记' : '来源：解码器读取的码流元数据';
          dl.append(text('dt', label), dd);
        }
        properties.append(dl, text('h3', '当前帧'));
        const timing = document.createElement('dl');
        for (const [label, id] of [['片内 PTS', 'inspect-pts'], ['源 PTS', 'inspect-source-pts'], ['帧时长', 'inspect-frame-duration'], ['相对游标', 'inspect-frame-delta']]) {
          const dd = text('dd', '—'); dd.id = id; timing.append(text('dt', label), dd);
        }
        properties.append(timing);
      }
    }
    if (selected) {
      $('inspect-pts').textContent = selected.frame ? formatTime(selected.frame.ptsUs) : '—';
      $('inspect-source-pts').textContent = selected.frame ? `${selected.frame.sourcePtsUs / 1e6} s` : '—';
      $('inspect-frame-duration').textContent = selected.frame ? `${+(selected.frame.durationUs / 1000).toFixed(3)} ms` : '—';
      const delta = trackTiming(selected, state.positionUs).frameDeltaUs;
      $('inspect-frame-delta').textContent = delta == null ? '—' : `${delta > 0 ? '+' : ''}${+(delta / 1000).toFixed(3)} ms`;
    }
  }
  function renderDock(state: State) {
    const signature = state.tracks.map(t => `${t.slot}:${t.id}:${t.offsetUs}`).join('/') + JSON.stringify(state.marks);
    if (signature !== dockSignature) {
      dockSignature = signature;
      $('subtrack-count').textContent = String(state.tracks.length);
      const list = $('subtrack-list'); list.replaceChildren();
      const maxDuration = Math.max(1, ...state.tracks.map(t => t.durationUs+t.offsetUs));
      const ruler = $('subtrack-ruler'); ruler.replaceChildren();
      for (let i = 0; i <= 4; i++) {
        const tick = text('span', formatTime(Math.round(maxDuration * i / 4)));
        tick.style.left = `${i * 25}%`; ruler.append(tick);
      }
      for (const track of state.tracks) {
        const row = document.createElement('div'); row.className = 'subtrack-row'; row.dataset.trackDrag = track.slot;
        row.classList.toggle('selected', track.slot === view.selected);
        const label = document.createElement('div'); label.className = 'subtrack-label';

        const name = document.createElement('button'); name.className = 'subtrack-name track-identity'; name.dataset.dragSurface = track.slot;
        name.setAttribute('aria-label', `检视子轨道 ${track.slot}`);
        name.setAttribute('aria-pressed', String(track.slot === view.selected));
        name.append(text('span', track.slot, `slot slot-${track.slot}`), text('span', track.name, 'filename'));
        name.onclick = () => inspect(track.slot);
        const lane = document.createElement('div'); lane.className = 'track-lane';
        const seek = document.createElement('button'); seek.className = 'track-duration';
        seek.style.left = `${Math.max(0,track.offsetUs) / maxDuration * 100}%`;
        seek.style.width = `${Math.max(0,track.durationUs+Math.min(0,track.offsetUs)) / maxDuration * 100}%`;
        seek.textContent = formatTime(track.durationUs); seek.title = `轨道 ${track.slot} 时长 ${formatTime(track.durationUs)}；点击定位`;
        seek.setAttribute('aria-label', `定位轨道 ${track.slot}`);
        const trackMarks = marksForTrack(track, state.marks).map(m=>({...m,frame:{...m.frame,ptsUs:m.frame.ptsUs+track.offsetUs}})).filter(m=>m.frame.ptsUs>=0);
        const preview = $('subtrack-preview'); preview.hidden = true;
        const targetAt = (x: number) => { const r = lane.getBoundingClientRect(); const target = seekTarget(x - r.left, r.width, maxDuration, trackMarks.filter(m => m.frame.ptsUs < session.getState().durationUs)); return { ...target, ptsUs: Math.min(target.ptsUs, session.getState().durationUs - 1) }; };
        seek.onpointermove = e => { const target = targetAt(e.clientX); showSeekPreview(preview, e.clientX - lane.getBoundingClientRect().left, target.ptsUs, target.nearby, lane); };
        lane.onpointerleave = () => { preview.hidden = true; };
        seek.onblur = () => { preview.hidden = true; };
        seek.onclick = e => {
          const ptsUs = e.detail === 0 ? session.getState().positionUs : targetAt(e.clientX).ptsUs;
          void act(() => session.seek(ptsUs), 'ui.subtrack-seek', { slot: track.slot, ptsUs });
        };
        lane.append(seek);
        for (const mark of trackMarks) {
          const marker = document.createElement('button'); marker.className = 'track-marker'; marker.append(markSymbol(mark.id));
          identifyMark(marker, mark.id); bindMarkHover(marker, mark.id);
          marker.style.left = `${Math.max(0, Math.min(100, mark.frame.ptsUs / maxDuration * 100))}%`;
          marker.title = `${formatTime(mark.frame.ptsUs)} · ${mark.text}`;
          marker.setAttribute('aria-label', `标记 ${track.slot} ${formatTime(mark.frame.ptsUs)} ${mark.text}`);
          marker.onpointerenter = () => showSeekPreview(preview, mark.frame.ptsUs / maxDuration * lane.clientWidth, mark.frame.ptsUs, trackMarks.filter(m => m.frame.ptsUs === mark.frame.ptsUs), lane);
          marker.onfocus = () => showSeekPreview(preview, mark.frame.ptsUs / maxDuration * lane.clientWidth, mark.frame.ptsUs, [mark], lane);
          marker.onblur = () => { preview.hidden = true; };
          marker.onclick = () => void act(() => session.seek(mark.frame.ptsUs), 'ui.subtrack-mark', { id: mark.id });
          lane.append(marker);
        }
        const cursor = document.createElement('span'); cursor.className = 'track-playhead'; cursor.id = `subtrack-playhead-${track.slot}`; lane.append(cursor);
        const offset = document.createElement('input'); offset.type='text';offset.className='track-offset offset-input';
        offset.setAttribute('aria-label',`轨道 ${track.slot} 偏移，毫秒`);offset.dataset.tooltip='同步偏移：正值延后，负值提前（毫秒）';
        installTimeInput(offset,{
          read:()=>session.getState().tracks.find(t=>t.slot===track.slot)?.offsetUs??0,
          format:value=>`${+(value/1000).toFixed(3)} ms`,parse:value=>parseTimeInput(value,'ms',true),begin:()=>session.pause(),
          commit:offsetUs=>act(()=>session.setTrackOffset(track.slot,offsetUs),'ui.track-offset',{slot:track.slot,offsetUs}),
        });
        const remove = createIconButton({glyph:'close',label:`移除子轨道 ${track.slot}`,tooltip:'移除轨道',className:'remove-track'});
        remove.onclick=()=>void act(()=>session.removeTrack(track.slot),'ui.remove-track',{slot:track.slot});
        label.append(name); row.append(label, offset, lane, remove); list.append(row);
      }
      if (!state.tracks.length) list.append(text('p', '载入视频后查看轨道与标记', 'panel-empty'));
    }
    // Selection changes state in place; keep row, offset input and seek nodes.
    for (const row of $('subtrack-list').querySelectorAll<HTMLElement>('.subtrack-row')) {
      const selected = row.dataset.trackDrag === view.selected;
      row.classList.toggle('selected', selected);
      row.querySelector('.subtrack-name')!.setAttribute('aria-pressed', String(selected));
    }
    const selected = state.tracks.find(t => t.slot === view.selected);
    const nextAnnotationSignature = `${dockSignature}/${view.selected}`;
    if (nextAnnotationSignature !== annotationSignature) {
      annotationSignature = nextAnnotationSignature;
      annotations.render(selected ? marksForTrack(selected, state.marks) : [], selected?.slot, selected?.offsetUs ?? 0);
    }
    renderProgress(state.positionUs, state.durationUs);
  }
  function renderProgress(positionUs: number, durationUs: number) {
    if (!view.panels.subtracks) return;
    const left = `${Math.min(100, positionUs / Math.max(1, durationUs) * 100)}%`;
    for (const cursor of $('subtrack-list').querySelectorAll<HTMLElement>('.track-playhead')) cursor.style.left = left;
  }
  function render(state: State) {
    view.reconcile(state.tracks);
    if (!state.tracks.length && view.panels.subtracks) { view.panels.subtracks = false; syncPanels(); }
    if (view.panels.inspector) renderInspector(state);
    if (view.panels.subtracks) renderDock(state);
    const addMarkButton = $<HTMLButtonElement>('subtrack-add-mark');
    addMarkButton.disabled = !state.tracks.length;
    addMarkButton.setAttribute('aria-disabled', String(!state.tracks.length || state.busy));
    const ids = state.tracks.map(t => `${t.slot}:${t.id}`).join('/');
    if (ids !== currentIds) {
      currentIds = ids;
      for (const track of state.tracks) catalog.remember(track, track.source?.id);
      save();
      if (view.panels.sources) renderSources();
      else renderStartLibrary();
    }
  }
  async function load(item: SourceItem, slot: Slot) {
    if ((!item.file && !item.library) || sourceInUse(item, session.getState().tracks)) return;
    await act(async () => {
      await session.load(slot, () => item.file ? openMedia(item.file) : openLibraryItem(item.library!));
      catalog.remember(item, item.library?.id); save(); renderSources();
    }, 'ui.source-load', { name: item.name, slot });
  }
  function sourceRow(item: SourceItem) {
      const row = document.createElement('div'); row.className = 'source-row';
      const used = sourceInUse(item, session.getState().tracks);
      row.classList.toggle('in-use', used);
      const info = document.createElement('div'); info.className = 'source-info';
      const name = text('span', item.name, 'filename');
      const origin = item.library ? ` · ${item.library.root}` : '';
      info.append(name, text('span', `${sizeText(item.size)} · ${used ? '使用中' : item.library ? '媒体库' : item.file ? '本次添加' : '需重新选择'}${origin}`, 'source-meta'));
      const actions = document.createElement('div'); actions.className = 'source-actions';
      if (used) { /* Keep active sources visible, without a redundant add action. */ }
      else if (item.library || item.file) {
        const button = createIconButton({ glyph: 'plus', label: '添加到视图' });
        button.title = '添加到视图'; button.setAttribute('aria-label', `添加到视图：${item.name}`);
        button.onclick = () => {
          const tracks = session.getState().tracks;
          if (sourceInUse(item, tracks)) return;
          const empty = SLOTS.find(slot => !tracks.some(t => t.slot === slot));
          if (empty) { void load(item, empty); return; }
          const dialog = $<HTMLDialogElement>('replace-source-dialog');
          $('replace-source-name').textContent = item.name;
          const targets = $('replace-source-targets'); targets.replaceChildren();
          for (const track of tracks) {
            const choose = document.createElement('button'); choose.textContent = track.name; choose.dataset.tooltip = '替换当前轨道';
            choose.onclick = () => { dialog.close(); void load(item, track.slot); }; targets.append(choose);
          }
          dialog.showModal();
        }; actions.append(button);
      } else {
        const button = createIconButton({ glyph: 'filePlus', label: '重新选择本地文件' }); button.title = '重新选择本地文件';
        button.setAttribute('aria-label', `重新选择 ${item.name}`); button.onclick = () => $<HTMLInputElement>('source-files').click(); actions.append(button);
      }
      row.append(info, actions); return row;
  }
  function renderStartLibrary() {
    const list = $('start-library-list'); list.replaceChildren();
    const items = startTab === 'recent' ? catalog.recent() : catalog.available();
    for (const item of items.slice(0, 8)) list.append(sourceRow(item));
    $('start-library-status').textContent = items.length ? '' : libraryStatus || (startTab === 'recent' ? '暂无最近片源' : '添加文件以开始对比');
  }
  function renderSources() {
    const query = $<HTMLInputElement>('source-search').value.trim().toLocaleLowerCase();
    const items = (sourceTab === 'recent' ? catalog.recent() : catalog.available()).filter(item => item.name.toLocaleLowerCase().includes(query));
    $('source-status').textContent = libraryStatus;
    $('source-status').hidden = !libraryStatus;
    const list = $('source-list'); list.replaceChildren();
    for (const item of items) list.append(sourceRow(item));
    renderStartLibrary();
    if (!items.length) list.append(text('p', query ? '没有匹配的片源' : sourceTab === 'recent' ? '暂无最近片源' : '添加文件，或刷新媒体库', 'panel-empty'));
  }
  function refreshLibrary(force = false) {
    if (refreshing) return refreshing;
    libraryStatus = '正在刷新…'; renderSources();
    refreshing = (async () => {
      const listing = await fetchLibrary(force);
      if (disposed) return;
      libraryChecked = true;
      catalog.setLibrary(listing?.entries ?? []);
      libraryStatus = listing ? listing.truncated ? '仅显示部分媒体库文件' : '' : '媒体库未连接，仍可添加本地文件';
      renderSources();
    })().finally(() => { refreshing = undefined; });
    return refreshing;
  }
  $('start-library-more').onclick = () => setPanel('sources', true);
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-start-tab]')) button.onclick = () => {
    startTab = button.dataset.startTab!;
    for (const tab of document.querySelectorAll<HTMLElement>('[data-start-tab]')) tab.setAttribute('aria-pressed', String(tab.dataset.startTab === startTab));
    renderStartLibrary();
  };
  $('replace-source-close').onclick = () => $<HTMLDialogElement>('replace-source-dialog').close();
  $('sources-refresh').onclick = () => void refreshLibrary(true);
  $('source-search').oninput = renderSources;
  $('sources-import').onclick = () => $<HTMLInputElement>('source-files').click();
  $('source-files').onchange = () => {
    const input = $<HTMLInputElement>('source-files');
    for (const file of input.files ?? []) catalog.addFile(file);
    input.value = ''; save(); renderSources();
  };
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-source-tab]')) button.onclick = () => {
    sourceTab = button.dataset.sourceTab!;
    for (const tab of document.querySelectorAll('[data-source-tab]')) tab.setAttribute('aria-pressed', String((tab as HTMLElement).dataset.sourceTab === sourceTab));
    renderSources();
  };
  const resizer = $('dock-resize');
  const resize = (value: number) => {
    dockHeight = Math.round(Math.max(128, Math.min(Math.min(420, window.innerHeight * .55), value)));
    workspace.style.setProperty('--dock-height', `${dockHeight}px`);
    resizer.setAttribute('aria-valuenow', String(dockHeight));
    resizer.setAttribute('aria-valuetext', `${dockHeight} 像素`);
    resizer.setAttribute('aria-valuemax', String(Math.round(Math.min(420, window.innerHeight * .55))));
  };
  const dock = $('subtracks-panel');
  const dockBounds = () => ({min:128,max:Math.min(420,window.innerHeight*.55)});
  installResizeGesture(resizer, {
    axis:'y',direction:-1,size:()=>dockHeight,bounds:dockBounds,resize,
    threshold:()=>Number.parseFloat(getComputedStyle(workspace).getPropertyValue('--panel-collapse-distance')),
    reset:()=>Number.parseFloat(getComputedStyle(workspace).getPropertyValue('--dock-default-height')),
    dragging(active) { workspace.classList.toggle('panel-dragging',active); dock.classList.toggle('panel-pushing',active); if(!active) animatePanelLayout(workspace); },
    preview(push,veil) { workspace.style.setProperty('--dock-push-space',`${push}px`); dock.style.setProperty('--panel-push',`${push}px`); dock.style.setProperty('--panel-veil-opacity',String(veil)); },
    collapse() { setPanel('subtracks',false); $('toggle-subtracks').focus(); },
  },lifecyle.signal);
  window.addEventListener('resize', () => {
    resize(dockHeight);
  }, { signal: lifecyle.signal });
  resize(dockHeight); syncPanels();
  void refreshLibrary();
  return {
    render, renderProgress, refreshLibrary, selected: () => view.selected,
    rememberFile(file: File) { catalog.addFile(file); save(); if (view.panels.sources) renderSources(); },
    getState: () => ({ panels: { ...view.panels }, selected: view.selected, dockHeight, marksExpanded: annotations.expanded() }),
    dispose() { disposed = true; annotations.dispose(); lifecyle.abort(); },
  };
}
