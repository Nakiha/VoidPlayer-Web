import { t, msg } from '../../i18n.ts';
import { indexProgressLabel } from '../index-progress.ts';
import { installTimeInput } from '../../time-input.ts';
import { parseTimeInput } from '../../time-input.ts';
import type { Slot, Mark } from '../../model.ts';
import { formatTime } from '../../model.ts';
import { colorLabel, rangeLabel } from '../media-labels.ts';
import { isHdrTransfer } from '../../presentation-color.ts';
import { markSymbol, identifyMark, bindMarkHover } from '../mark-symbol.ts';
import { seekTarget, showSeekPreview } from '../seek-preview.ts';
import { icon } from '../icons.ts';
import { createIconButton } from '../controls.ts';
import { fileBasename } from '../filename.ts';
import { trackTimelineRatio } from '../track-timeline.ts';
import { marksForTrack, trackTiming } from '../workspace-state.ts';
import type { ReviewTrack } from '../workspace-state.ts';
import type { WorkbenchShared, WorkbenchState } from './shared.ts';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const text = (tag: string, value: string, className = '') => {
  const el = document.createElement(tag); el.textContent = value; el.className = className; return el;
};

/** Track inspector + subtrack dock. Owns cursor nodes and dock signatures. */
export function createTracksPane(shared: WorkbenchShared) {
  const { session, act, view } = shared;
  let trackSignature = '';
  let dockSignature = '';
  let annotationSignature = '';
  const cursors = new Map<Slot, { current: HTMLElement; hover: HTMLElement; startUs: number; endUs: number }>();

  function hideSeekPreview() { $('subtrack-preview').hidden = true; for (const c of cursors.values()) c.hover.hidden = true; }
  function previewPosition(ptsUs: number, durationUs: number) {
    for (const c of cursors.values()) { c.hover.style.left = `${trackTimelineRatio(ptsUs, c.startUs, c.endUs, durationUs) * 100}%`; c.hover.hidden = false; }
  }
  window.addEventListener('resize', hideSeekPreview, { signal: shared.lifecyle.signal });
  document.querySelector('.subtrack-scroll')!.addEventListener('scroll', hideSeekPreview, { signal: shared.lifecyle.signal });
  $('subtrack-add-mark').onclick = () => { if (!session.getState().busy) shared.addMark(view.selected); };

  function propertyRows(track: ReviewTrack) {
    const color = track.color;
    const hdr = isHdrTransfer(color?.transfer);
    return [
      [t(msg("tracks.codec", "编码")), track.codec], [t(msg("tracks.dimensions", "尺寸")), `${track.width} × ${track.height}`],
      ...(track.indexWarning ? [[t(msg("tracks.fileIntegrity", "文件完整性")), track.indexWarning]] : []),
      ...(track.indexState ? [[t(msg("tracks.frameIndex", "帧索引")), track.indexState === 'building' ? t(msg("tracks.durationCoversIndexedPortion", "{p0} · 时长为已索引范围"), { p0: indexProgressLabel(track) }) : track.indexState === 'error' ? t(msg("tracks.indexFailed", "索引失败：{p0}"), { p0: track.indexError ?? '' }) : track.indexSource === 'server' ? t(msg("tracks.reusedServerCache", "已复用服务器缓存")) : t(msg("tracks.complete", "已完成"))]] : []),
      [t(msg("tracks.duration", "时长")), formatTime(track.durationUs)], [t(msg("colorFlow.decode", "解码")), track.decoder === 'webcodecs' ? 'WebCodecs' : 'FFmpeg WASM'],
      [t(msg("tracks.accelerationRequest", "加速请求")), track.decoder === 'ffmpeg-wasm' ? t(msg("colorFlow.softwareDecoding", "软件解码")) : track.hardwareAcceleration === 'prefer-hardware' ? t(msg("tracks.preferHardwareActualHardwareUseUnverified", "硬件优先（实际硬件使用未验证）")) : t(msg("tracks.browserDefault", "浏览器自动选择"))],
      ...(track.seekStrategy ? [[t(msg("tracks.seekMethod", "定位方式")), ({ 'packet-anchor': t(msg("tracks.packetIndex", "包索引定位")), 'demuxer-keyframe': t(msg("tracks.containerKeyframes", "容器关键帧定位")), 'demuxer-timestamp': t(msg("tracks.containerTimestampsMayScanBackward", "容器时间戳定位（可能回扫）")), browser: t(msg("tracks.browserMediaIndex", "浏览器媒体索引")) })[track.seekStrategy]]] : []),
      [track.pixelFormat ? t(msg("tracks.pixelFormat", "像素格式")) : t(msg("tracks.decodedPixelFormat", "解码像素格式")), track.pixelFormat || track.decodedPixelFormat || t(msg("tracks.notProvided", "未提供")), track.pixelFormat ? 'pixel-format' : 'decoded-format'],
      [t(msg("tracks.colorPrimaries", "色域原色")), colorLabel(color?.primaries), 'color-metadata'],
      [t(msg("tracks.transferFunction", "传递特性")), colorLabel(color?.transfer), 'color-metadata'],
      [t(msg("tracks.matrixCoefficients", "矩阵系数")), colorLabel(color?.matrix), 'color-metadata'],
      [t(msg("tracks.range", "范围")), rangeLabel(color?.fullRange), 'color-metadata'],
      ...(hdr ? [[t(msg("tracks.hdrSource", "HDR 源")), track.decoder === 'ffmpeg-wasm' ? t(msg("tracks.sdrFallbackDisplay", "SDR 兜底显示")) : t(msg("tracks.browserOutputUnverified", "浏览器输出未验证"))]] : []),
    ];
  }

  function renderInspector(state: WorkbenchState) {
    const selected = state.tracks.find(t => t.slot === view.selected);
    const signature = state.tracks.map(t => `${t.slot}:${t.id}:${t.metadataRevision ?? 0}`).join('/') + view.selected;
    if (signature !== trackSignature) {
      trackSignature = signature;
      const list = $('track-selector'); list.replaceChildren();
      for (const track of state.tracks) {
        const button = document.createElement('button'); button.className = 'track-choice';
        button.setAttribute('aria-label', t(msg("tracks.selectTrack", "选择轨道 {p0}"), { p0: track.slot }));
        button.setAttribute('aria-pressed', String(track.slot === view.selected));
        button.append(text('span', track.slot, `slot slot-${track.slot}`), text('span', fileBasename(track.name), 'filename'));
        button.dataset.tooltip = track.name; button.onclick = () => shared.select(track.slot); list.append(button);
      }
      const properties = $('track-properties'); properties.replaceChildren();
      if (!selected) properties.append(text('p', t(msg("tracks.noTracksLoaded", "尚未载入轨道")), 'panel-empty'));
      else {
        properties.append(text('h3', t(msg("tracks.track", "轨道 {p0}"), { p0: selected.slot })));
        const dl = document.createElement('dl');
        for (const [label, value, id] of propertyRows(selected)) {
          const dd = text('dd', value);
          if (id === 'decoded-format') dd.dataset.tooltip = t(msg("tracks.browserDecoderMemoryFormatMayDifferFrom", "浏览器解码输出的内存格式，可能与源视频的像素格式不同"));
          if (id === 'color-metadata' && selected.colorSource) dd.title = selected.colorSource === 'container' ? t(msg("tracks.sourceContainerTags", "来源：封装标记")) : t(msg("tracks.sourceBitstreamMetadataReadByDecoder", "来源：解码器读取的码流元数据"));
          if(dd.dataset.tooltip) { dd.tabIndex=0; dd.setAttribute('aria-description',dd.dataset.tooltip); }
          dl.append(text('dt', label), dd);
        }
        properties.append(dl, text('h3', t(msg("tracks.currentFrame", "当前帧"))));
        const timing = document.createElement('dl');
        for (const [label, id] of [[t(msg("tracks.clipPts", "片内 PTS")), 'inspect-pts'], [t(msg("tracks.sourcePts", "源 PTS")), 'inspect-source-pts'], [t(msg("tracks.frameDuration", "帧时长")), 'inspect-frame-duration'], [t(msg("tracks.relativeToPlayhead", "相对游标")), 'inspect-frame-delta']]) {
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

  function renderDock(state: WorkbenchState, annotations: { render(items: { mark: Mark; slot: Slot; offsetUs: number }[]): void }) {
    const signature = state.tracks.map(t => `${t.slot}:${t.id}:${t.offsetUs}:${t.metadataRevision ?? 0}`).join('/') + JSON.stringify(state.marks);
    if (signature !== dockSignature) {
      dockSignature = signature;
      hideSeekPreview(); cursors.clear();
      const list = $('subtrack-list'); list.replaceChildren();
      const maxDuration = Math.max(1, ...state.tracks.map(t => t.durationUs + t.offsetUs));
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
        name.setAttribute('aria-label', t(msg("tracks.inspectSubtrack", "检视子轨道 {p0}"), { p0: track.slot }));
        name.setAttribute('aria-pressed', String(track.slot === view.selected));
        name.append(text('span', track.slot, `slot slot-${track.slot}`), text('span', fileBasename(track.name), 'filename'));
        name.dataset.tooltip = track.name;
        name.onclick = () => shared.inspect(track.slot);
        const lane = document.createElement('div'); lane.className = 'track-lane';
        const seek = document.createElement('button'); seek.className = 'track-duration';
        seek.style.left = `${Math.max(0, track.offsetUs) / maxDuration * 100}%`;
        seek.style.width = `${Math.max(0, track.durationUs + Math.min(0, track.offsetUs)) / maxDuration * 100}%`;
        seek.textContent = formatTime(track.durationUs); seek.title = t(msg("tracks.trackDurationClickToSeek", "轨道 {p0} 时长 {p1}；点击定位"), { p0: track.slot, p1: formatTime(track.durationUs) });
        seek.setAttribute('aria-label', t(msg("tracks.seekTrack", "定位轨道 {p0}"), { p0: track.slot }));
        const trackMarks = marksForTrack(track, state.marks).map(m => ({ ...m, frame: { ...m.frame, ptsUs: m.frame.ptsUs + track.offsetUs } })).filter(m => m.frame.ptsUs >= 0);
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
          marker.setAttribute('aria-label', t(msg("tracks.mark", "标记 {p0} {p1} {p2}"), { p0: track.slot, p1: formatTime(mark.frame.ptsUs), p2: mark.text }));
          marker.onpointerenter = () => showTarget({ ptsUs: mark.frame.ptsUs, nearby: trackMarks.filter(m => m.frame.ptsUs === mark.frame.ptsUs) });
          marker.onfocus = () => showTarget({ ptsUs: mark.frame.ptsUs, nearby: [mark] });
          marker.onblur = hideSeekPreview;
          marker.onclick = e => { e.stopPropagation(); void act(() => session.seek(mark.frame.ptsUs), 'ui.subtrack-mark', { id: mark.id }); };
          lane.append(marker);
        }
        const cursor = document.createElement('span'); cursor.className = 'track-playhead'; cursor.id = `subtrack-playhead-${track.slot}`; lane.append(cursor);
        const hover = document.createElement('span'); hover.className = 'track-playhead track-seek-preview'; hover.hidden = true; lane.append(hover);
        cursors.set(track.slot, { current: cursor, hover, startUs: Math.max(0, track.offsetUs), endUs: track.durationUs + track.offsetUs });
        const offset = document.createElement('input'); offset.type = 'text'; offset.className = 'track-offset offset-input';
        offset.setAttribute('aria-label', t(msg("tracks.trackOffsetMilliseconds", "轨道 {p0} 偏移，毫秒"), { p0: track.slot })); offset.dataset.tooltip = t(msg("tracks.syncOffsetPositiveDelaysNegativeAdvancesMilliseconds", "同步偏移：正值延后，负值提前（毫秒）"));
        installTimeInput(offset, {
          read: () => session.getState().tracks.find(t => t.slot === track.slot)?.offsetUs ?? 0,
          format: value => `${+(value / 1000).toFixed(3)} ms`, parse: value => parseTimeInput(value, 'ms', true), begin: () => session.pause(),
          commit: offsetUs => act(() => session.setTrackOffset(track.slot, offsetUs), 'ui.track-offset', { slot: track.slot, offsetUs }),
        });
        const visibility = createIconButton({ glyph: 'eye', label: t(msg("tracks.hideTrack", "隐藏轨道 {slot}"), { slot: track.slot }), className: 'track-visibility' });
        visibility.onclick = () => {
          const current = session.getState().tracks.find(t => t.slot === track.slot);
          if (current) session.setTrackVisibility(track.slot, !current.visible);
        };
        label.append(name); row.append(label, offset, lane, visibility); list.append(row);
      }
      if (!state.tracks.length) list.append(text('p', t(msg("tracks.loadAVideoToViewTracksAnd", "载入视频后查看轨道与标记")), 'panel-empty'));
    }
    // Selection changes state in place; keep row, offset input and seek nodes.
    for (const row of $('subtrack-list').querySelectorAll<HTMLElement>('.subtrack-row')) {
      const track = state.tracks.find(t => t.slot === row.dataset.trackDrag)!;
      const visibility = row.querySelector<HTMLButtonElement>('.track-visibility')!;
      const label = track.visible ? t(msg("tracks.hideTrack", "隐藏轨道 {slot}"), { slot: track.slot }) : t(msg("tracks.showTrack", "显示轨道 {slot}"), { slot: track.slot });
      visibility.setAttribute('aria-label', label);
      visibility.setAttribute('aria-pressed', String(!track.visible));
      visibility.dataset.tooltip = label;
      // 只在图标真正变化时重建 svg：选中轨道是原地更新，不应替换任何节点。
      const glyph = track.visible ? 'eye' : 'eyeClosed';
      if (visibility.firstElementChild?.getAttribute('data-icon') !== glyph) visibility.innerHTML = icon(glyph);
      const selected = row.dataset.trackDrag === view.selected;
      row.classList.toggle('selected', selected);
      row.querySelector('.subtrack-name')!.setAttribute('aria-pressed', String(selected));
    }
    const nextAnnotationSignature = dockSignature;
    if (nextAnnotationSignature !== annotationSignature) {
      annotationSignature = nextAnnotationSignature;
      annotations.render(state.tracks.flatMap(track => marksForTrack(track, state.marks).map(mark => ({
        mark, slot: track.slot, offsetUs: track.offsetUs,
      }))).sort((a, b) => (a.mark.frame.ptsUs + a.offsetUs) - (b.mark.frame.ptsUs + b.offsetUs)));
    }
    renderProgress(state.positionUs, state.durationUs);
  }

  function renderProgress(positionUs: number, durationUs: number) {
    if (!view.panels.subtracks) return;
    for (const c of cursors.values()) c.current.style.left = `${trackTimelineRatio(positionUs, c.startUs, c.endUs, durationUs) * 100}%`;
  }

  function localize(state: WorkbenchState) {
    // The dock owns editable offsets and annotation cards. Keep their nodes and
    // pending input intact, including when a peer tab changes the language.
    const selected = state.tracks.find(track => track.slot === view.selected);
    for(const button of $('track-selector').querySelectorAll<HTMLElement>('.track-choice')) {
      const slot = button.querySelector('.slot')!.textContent!;
      button.setAttribute('aria-label', t(msg('tracks.selectTrack', '选择轨道 {p0}'), {p0:slot}));
    }
    if(selected && $('track-properties').querySelector('dl')) {
      const rows = propertyRows(selected), properties = $('track-properties').querySelector('dl')!;
      [...properties.querySelectorAll('dt')].forEach((node,i)=>{node.textContent=rows[i][0];});
      [...properties.querySelectorAll('dd')].forEach((node,i)=>{node.textContent=rows[i][1];
        if(rows[i][2]==='decoded-format')node.dataset.tooltip=t(msg('tracks.browserDecoderMemoryFormatMayDifferFrom', '浏览器解码输出的内存格式，可能与源视频的像素格式不同'));
        if(rows[i][2]==='color-metadata'&&selected.colorSource)node.title=selected.colorSource==='container'?t(msg('tracks.sourceContainerTags', '来源：封装标记')):t(msg('tracks.sourceBitstreamMetadataReadByDecoder', '来源：解码器读取的码流元数据'));
        if(node.dataset.tooltip)node.setAttribute('aria-description',node.dataset.tooltip);
      });
      const headings = $('track-properties').querySelectorAll('h3');
      headings[0].textContent=t(msg('tracks.track', '轨道 {p0}'), {p0:selected.slot});
      headings[1].textContent=t(msg('tracks.currentFrame', '当前帧'));
      const labels=[t(msg('tracks.clipPts','片内 PTS')),t(msg('tracks.sourcePts','源 PTS')),t(msg('tracks.frameDuration','帧时长')),t(msg('tracks.relativeToPlayhead','相对游标'))];
      [...$('track-properties').querySelectorAll('dl')[1].querySelectorAll('dt')].forEach((node,i)=>node.textContent=labels[i]);
    } else if(!selected) $('track-properties').querySelector('.panel-empty')?.replaceChildren(t(msg('tracks.noTrackLoaded','尚未载入轨道')));
    for (const track of state.tracks) {
      const row = $('subtrack-list').querySelector<HTMLElement>(`[data-track-drag="${track.slot}"]`);
      if (!row) continue;
      row.querySelector('.subtrack-name')!.setAttribute('aria-label', t(msg("tracks.inspectSubtrack", "检视子轨道 {p0}"), { p0: track.slot }));
      const seek = row.querySelector<HTMLElement>('.track-duration')!;
      seek.title = t(msg("tracks.trackDurationClickToSeek", "轨道 {p0} 时长 {p1}；点击定位"), { p0: track.slot, p1: formatTime(track.durationUs) });
      seek.setAttribute('aria-label', t(msg("tracks.seekTrack", "定位轨道 {p0}"), { p0: track.slot }));
      const offset = row.querySelector<HTMLElement>('.track-offset')!;
      offset.setAttribute('aria-label', t(msg("tracks.trackOffsetMilliseconds", "轨道 {p0} 偏移，毫秒"), { p0: track.slot }));
      offset.dataset.tooltip = t(msg("tracks.syncOffsetPositiveDelaysNegativeAdvancesMilliseconds", "同步偏移：正值延后，负值提前（毫秒）"));
      const visibility = row.querySelector<HTMLElement>('.track-visibility');
      if (visibility) {
        const visibilityLabel = track.visible ? t(msg("tracks.hideTrack", "隐藏轨道 {slot}"), { slot: track.slot }) : t(msg("tracks.showTrack", "显示轨道 {slot}"), { slot: track.slot });
        visibility.setAttribute('aria-label', visibilityLabel); visibility.dataset.tooltip = visibilityLabel;
      }
      for (const marker of row.querySelectorAll<HTMLElement>('.track-marker')) {
        const mark = state.marks.find(mark => mark.id === marker.dataset.markId);
        if (mark) marker.setAttribute('aria-label', t(msg("tracks.mark", "标记 {p0} {p1} {p2}"), { p0: track.slot, p1: formatTime(mark.frame.ptsUs + track.offsetUs), p2: mark.text }));
      }
    }
  }

  function resetSignatures() { trackSignature = ''; dockSignature = ''; annotationSignature = ''; }

  /** Selection only rebuilds the inspector; the dock syncs selection in place. */
  function resetInspectorSignature() { trackSignature = ''; }

  return { localize, renderInspector, renderDock, renderProgress, hideSeekPreview, resetSignatures, resetInspectorSignature };
}
