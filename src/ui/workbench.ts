import { installTrackColumnResize } from './track-column-resize.ts';
import { trackTimelineRatio } from './track-timeline.ts';
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
import { referenceVersion } from '../media-reference.ts';
import { fetchLibraryItem, openLibraryItem } from '../library.ts';
import { openMedia } from '../media.ts';
import { seekTarget, showSeekPreview } from './seek-preview.ts';
import { installAnnotationPanel } from './annotation-panel.ts';
import { WorkspaceState, marksForTrack, trackTiming } from './workspace-state.ts';
import type { Panel, ReviewTrack } from './workspace-state.ts';
import { installLibraryBrowser } from './library-browser.ts';
import { icon } from './icons.ts';
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
  let sourceSignature = '';
  let sourceBusy = false;
  let loadingSource: { key: string; status: string } | null = null;
  let sourceLoadError: { key: string; message: string } | null = null;
  let recentRevision = -1;
  let recentRequest = 0;

  const lifecyle = new AbortController();
  const libraryBrowser = installLibraryBrowser((page, status) => {
    catalog.setLibrary(page?.entries ?? []); libraryStatus = status;
    if (page && recentRevision !== page.revision) { recentRevision = page.revision; void refreshRecent(); }
    renderSources();
  }, lifecyle.signal);
  async function refreshRecent() {
    const ticket = ++recentRequest;
    const ids = [...new Set(catalog.serializable().flatMap(item => item.libraryId ? [item.libraryId] : []))];
    const entries = await Promise.all(ids.map(async id => {
      try { const entry = await fetchLibraryItem(id, AbortSignal.any([lifecyle.signal, AbortSignal.timeout(5000)])); return entry ? [id, entry] as [string, import('../library.ts').LibraryEntry] : null; } catch { return null; }
    }));
    if (disposed || ticket !== recentRequest) return;
    catalog.setRecentLibrary(entries.filter((item): item is [string, import('../library.ts').LibraryEntry] => item !== null)); save(); renderSources();
  }
  const workspace = $('workspace');
  const trackColumns = installTrackColumnResize(document.querySelector<HTMLElement>('.subtrack-scroll')!, $('track-label-resize'), lifecyle.signal);
  const cursors = new Map<Slot, { current: HTMLElement; hover: HTMLElement; startUs: number; endUs: number }>();
  function hideSeekPreview() { $('subtrack-preview').hidden = true; for (const c of cursors.values()) c.hover.hidden = true; }
  function previewPosition(ptsUs: number, durationUs: number) {
    for (const c of cursors.values()) { c.hover.style.left = `${trackTimelineRatio(ptsUs, c.startUs, c.endUs, durationUs) * 100}%`; c.hover.hidden = false; }
  }
  window.addEventListener('resize', hideSeekPreview, { signal: lifecyle.signal });
  document.querySelector('.subtrack-scroll')!.addEventListener('scroll', hideSeekPreview, { signal: lifecyle.signal });
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
    if (!open) { hideSeekPreview(); annotations.hidePreview(); }
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
      hideSeekPreview(); cursors.clear();
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
        const targetAt = (x: number) => { const r = lane.getBoundingClientRect(); const target = seekTarget(x - r.left, r.width, maxDuration, trackMarks.filter(m => m.frame.ptsUs < maxDuration)); return { ...target, ptsUs: Math.max(0, Math.min(target.ptsUs, maxDuration - 1)) }; };
        const showTarget = (target: ReturnType<typeof targetAt>) => {
          previewPosition(target.ptsUs, maxDuration);
          showSeekPreview(preview, target.ptsUs / maxDuration * lane.clientWidth, target.ptsUs, target.nearby, lane);
        };
        lane.onpointerdown = e => e.stopPropagation(); // Empty time beyond EOF is a seek surface, not a track drag.
        lane.onpointermove = e => {
          const marker = (e.target as Element).closest<HTMLElement>('.track-marker');
          const mark = marker && trackMarks.find(m => m.id === marker.dataset.markId);
          showTarget(mark ? { ptsUs: mark.frame.ptsUs, nearby: trackMarks.filter(m => m.frame.ptsUs === mark.frame.ptsUs) } : targetAt(e.clientX));
        };
        lane.onpointerleave = hideSeekPreview;
        seek.onblur = hideSeekPreview;
        lane.onclick = e => {
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
          marker.onpointerenter = () => showTarget({ ptsUs: mark.frame.ptsUs, nearby: trackMarks.filter(m => m.frame.ptsUs === mark.frame.ptsUs) });
          marker.onfocus = () => showTarget({ ptsUs: mark.frame.ptsUs, nearby: [mark] });
          marker.onblur = hideSeekPreview;
          marker.onclick = e => { e.stopPropagation(); void act(() => session.seek(mark.frame.ptsUs), 'ui.subtrack-mark', { id: mark.id }); };
          lane.append(marker);
        }
        const cursor = document.createElement('span'); cursor.className = 'track-playhead'; cursor.id = `subtrack-playhead-${track.slot}`; lane.append(cursor);
        const hover = document.createElement('span'); hover.className = 'track-playhead track-seek-preview'; hover.hidden = true; lane.append(hover);
        cursors.set(track.slot, { current: cursor, hover, startUs: Math.max(0, track.offsetUs), endUs: track.durationUs + track.offsetUs });
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
    for (const c of cursors.values()) c.current.style.left = `${trackTimelineRatio(positionUs, c.startUs, c.endUs, durationUs) * 100}%`;
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
      for (const track of state.tracks) catalog.remember(track, track.source?.id, referenceVersion(track.source?.url));
      save();
      if (view.panels.sources) renderSources();
      else renderStartLibrary();
    }
    if (sourceBusy !== state.busy) { sourceBusy = state.busy; renderSources(); }
  }
  async function load(item: SourceItem, slot: Slot) {
    if (loadingSource || session.getState().busy || (!item.file && !item.library) || sourceInUse(item, session.getState().tracks)) return;
    loadingSource = { key: item.key, status: '正在载入' }; sourceLoadError = null; renderSources();
    const progress = (stage: 'download' | 'decode') => {
      loadingSource = { key: item.key, status: stage === 'download' ? '正在下载视频' : '正在打开视频并建立索引' };
      renderSources();
    };
    try {
      await act(async () => {
        try {
          await session.load(slot, async () => {
            const source = await (item.file ? openMedia(item.file, undefined, progress) : openLibraryItem(item.library!, progress));
            loadingSource = { key: item.key, status: '正在显示首帧' }; renderSources();
            return source;
          });
          catalog.remember(item, item.library?.id, item.library?.version); save();
        } catch (error) {
          sourceLoadError = { key: item.key, message: error instanceof Error ? error.message : String(error) };
          throw error;
        }
      }, 'ui.source-load', { name: item.name, slot });
    } finally { loadingSource = null; renderSources(); }
  }
  function sourceRow(item: SourceItem) {
      const row = document.createElement('div'); row.className = 'source-row';
      const used = sourceInUse(item, session.getState().tracks);
      const loading = loadingSource?.key === item.key ? loadingSource.status : null;
      const failed = sourceLoadError?.key === item.key ? sourceLoadError.message : null;
      const blocked = !!loadingSource || session.getState().busy;
      row.setAttribute('aria-busy', String(!!loading));
      row.classList.toggle('in-use', used);
      const info = document.createElement('div'); info.className = 'source-info';
      const name = text('span', item.name, 'filename');
      const origin = item.library ? ` · ${item.library.root}` : '';
      name.title = item.name;
      const pending = item.library?.state === 'pending';
      const offline = libraryBrowser.page()?.roots.some(root => root.id === item.library?.rootId && root.state === 'offline');
      const status = text('span', `${sizeText(item.size)} · ${loading ?? (failed ? `载入失败：${failed}` : used ? '使用中' : offline ? '存储离线' : pending ? '写入中' : item.library ? '媒体库' : item.file ? '本次添加' : item.libraryId ? '内容已改变或不可用' : '需重新选择')}${origin}`, 'source-meta');
      if (loading || failed) { status.setAttribute('role', 'status'); status.dataset.tooltip = loading ?? failed!; }
      info.append(name, status);
      const actions = document.createElement('div'); actions.className = 'source-actions';
      if (used) {
        const button = createIconButton({ glyph: 'close', label: '从视图移除' });
        button.classList.add('remove-track');
        button.disabled = blocked;
        button.setAttribute('aria-label', `从视图移除：${item.name}`);
        button.onclick = () => void act(async () => {
          if (loadingSource || session.getState().busy) return;
          button.disabled = true;
          try {
            const tracks = session.getState().tracks.filter(track => sourceInUse(item, [track]));
            for (const track of tracks) {
              // Do not remove a replacement loaded into this slot while awaiting.
              if (session.getState().tracks.some(current => current.slot === track.slot && current.id === track.id)) await session.removeTrack(track.slot);
            }
          } finally { button.disabled = false; }
        }, 'ui.source-remove', { name: item.name });
        actions.append(button);
      }
      else if (item.library || item.file) {
        const button = createIconButton({ glyph: 'plus', label: '添加到视图' });
        button.disabled = blocked || !!pending || !!offline;
        button.dataset.tooltip = loading ?? (blocked ? '请等待当前载入或定位完成' : '添加到视图');
        button.title = offline ? '媒体存储离线，请等待重新连接' : pending ? '片源仍在写入，请稍后重试' : '添加到视图'; button.setAttribute('aria-label', `添加到视图：${item.name}`);
        button.onclick = () => {
          if (loadingSource || session.getState().busy) return;
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
      } else if (item.libraryId) {
        const button = createIconButton({ glyph: 'refresh', label: '检查媒体引用' });
        button.title = '内容已改变或不可用，请在媒体库中重新选择'; button.onclick = () => void refreshLibrary(); actions.append(button);
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
    libraryBrowser.visible(sourceTab === 'available');
    const page = libraryBrowser.page();
    const folders = sourceTab === 'available' ? page?.directories ?? [] : [];
    const signature = JSON.stringify([sourceTab, query, loadingSource, sourceLoadError, session.getState().busy, folders, page?.roots.map(root => [root.id, root.state]), items.map(item => [item.key, !!item.file, item.library?.version, item.library?.state, sourceInUse(item, session.getState().tracks)])]);
    const list = $('source-list');
    if (signature !== sourceSignature) {
      sourceSignature = signature; list.replaceChildren();
      for (const folder of folders) {
        const row = document.createElement('button'); row.className = 'source-row library-folder';
        const glyph = document.createElement('span'); glyph.innerHTML = icon('open');
        const info = text('span', '', 'source-info');
        info.append(text('span', folder.name, 'filename'), text('span', page?.roots.find(root => root.id === folder.rootId)?.name ?? '', 'source-meta'));
        row.setAttribute('aria-label', `打开目录：${folder.name}`); row.append(glyph, info); row.onclick = () => libraryBrowser.navigate(folder.rootId, folder.path); list.append(row);
      }
      for (const item of items) list.append(sourceRow(item));
      if (!items.length && !folders.length) list.append(text('p', query ? '没有匹配的片源' : sourceTab === 'recent' ? '暂无最近片源' : '当前目录没有片源', 'panel-empty'));
    }
    renderStartLibrary();
  }
  function refreshLibrary(force = false) {
    if (refreshing) return refreshing;
    libraryChecked = true;
    refreshing = Promise.all([force ? libraryBrowser.refresh() : libraryBrowser.load(), refreshRecent()]).then(() => {}).finally(() => { refreshing = undefined; });
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
  $('source-search').oninput = () => { if (sourceTab === 'available') libraryBrowser.search($<HTMLInputElement>('source-search').value); renderSources(); };
  $('sources-import').onclick = () => $<HTMLInputElement>('source-files').click();
  $('source-files').onchange = () => {
    const input = $<HTMLInputElement>('source-files');
    for (const file of input.files ?? []) catalog.addFile(file);
    input.value = ''; save(); renderSources();
  };
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-source-tab]')) button.onclick = () => {
    sourceTab = button.dataset.sourceTab!;
    if (sourceTab === 'available') libraryBrowser.search($<HTMLInputElement>('source-search').value);
    else void refreshRecent();
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
    getState: () => ({ panels: { ...view.panels }, selected: view.selected, dockHeight, marksExpanded: annotations.expanded(), filenameWidth: trackColumns.width(), marksWidth: annotations.width() }),
    restore(layout: import('../workspace-file.ts').WorkspaceLayout) {
      view.panels = { ...layout.panels }; view.selected = layout.selected; resize(layout.dockHeight);
      annotations.setExpanded(layout.marksExpanded);
      if (layout.filenameWidth !== undefined) trackColumns.resize(layout.filenameWidth);
      if (layout.marksWidth !== undefined) annotations.resize(layout.marksWidth);
      dockSignature = ''; trackSignature = ''; annotationSignature = ''; syncPanels(); panelResize.refresh(); render(session.getState());
    },
    dispose() { disposed = true; annotations.dispose(); lifecyle.abort(); },
  };
}
