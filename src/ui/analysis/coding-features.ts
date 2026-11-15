import { msg, t, onLanguageChange } from '../../i18n.ts';
import type { ReviewSession } from '../../session.ts';
import type { ParameterSetFeatures } from '../../../shared/media/codecs/coding-features.ts';

const labels = {
  wavefront: msg('analysis.features.wpp', '波前并行（WPP）'),
  tileColumns: msg('analysis.features.tiles', 'Tile 网格（列 × 行）'),
  entryPointOffsets: msg('analysis.features.entryPoints', '子码流入口偏移'),
  entropyCoding: msg('analysis.features.entropy', '熵编码'),
  maxReferenceFrames: msg('analysis.features.refs', '参考帧上限'),
  maxReorderFrames: msg('analysis.features.reorder', '重排帧上限'),
  frameMbsOnly: msg('analysis.features.frameOnly', '仅帧编码'),
  ctuSize: msg('analysis.features.ctu', '编码树单元（CTU）'),
  profileIdc: msg('analysis.features.profile', '编码档次（profile_idc）'),
  levelIdc: msg('analysis.features.level', '编码级别（level_idc）'),
  profileSpace: msg('analysis.features.profileSpace', '档次空间（profile_space）'),
  highTier: msg('analysis.features.tier', '层级（Tier）'),
  lumaBitDepth: msg('analysis.features.depth', '亮度位深'),
  chromaFormatIdc: msg('analysis.features.chroma', '色度采样'),
} as const;
const title = msg('analysis.features.title', '编码特性');

function fieldValue(set: ParameterSetFeatures, key: keyof typeof labels) {
  const value = set[key];
  if (value === undefined) return;
  if (key === 'highTier') return value ? 'High' : 'Main';
  if (typeof value === 'boolean') return t(value ? msg('analysis.features.on', '开启') : msg('analysis.features.off', '关闭'));
  if (key === 'tileColumns') return `${value} × ${set.tileRows}`;
  if (key === 'ctuSize') return `${value} × ${value}`;
  if (key === 'chromaFormatIdc') return ['4:0:0', '4:2:0', '4:2:2', '4:4:4'][Number(value)];
  if (key === 'lumaBitDepth') return `${value} bit`;
  return String(value);
}
function element<K extends keyof HTMLElementTagNameMap>(tag: K, text: string) {
  const node = document.createElement(tag); node.textContent = text; return node;
}
type Tracks = ReturnType<ReviewSession['getState']>['tracks'];

export function installCodingFeatures(trigger: HTMLButtonElement, session: ReviewSession, signal: AbortSignal) {
  const dialog = document.createElement('dialog');
  dialog.className = 'coding-features'; dialog.id = 'coding-features';
  dialog.setAttribute('aria-labelledby', 'coding-features-title');
  const heading = element('h2', ''); heading.id = 'coding-features-title';
  heading.tabIndex = -1; heading.autofocus = true;
  const intro = element('p', ''), content = document.createElement('div'), actions = document.createElement('footer');
  content.className = 'coding-features-tracks';
  const download = element('button', ''), close = element('button', '');
  actions.append(download, close); dialog.append(heading, intro, content, actions); document.body.append(dialog);
  let signature = '';
  function render(tracks: Tracks) {
    content.replaceChildren();
    download.disabled = !tracks.length;
    if (!tracks.length) content.append(element('p', t(msg('analysis.features.empty', '载入视频后可查看编码特性。'))));
    for (const track of tracks) {
      const report = track.codecFeatures;
      const group = document.createElement('section');
      group.append(element('h3', `${track.slot} · ${track.name}`), element('small', [track.codec, report?.format].filter(Boolean).join(' · ')));
      if (!report?.parameterSets.length) group.append(element('p', t(msg('analysis.features.unknown', '当前片源没有可读取的 H.264、H.265 或 H.266 参数集。'))));
      if (report?.unreadableParameterSets) group.append(element('p', t(msg('analysis.features.partial', '部分参数集未能读取。'))));
      for (const set of report?.parameterSets ?? []) {
        const layer = set.layer ? ` · L${set.layer}` : '';
        const parent = set.spsId === undefined ? '' : ` → SPS ${set.spsId}`;
        group.append(element('h4', `${set.kind} ${set.id}${parent}${layer}`));
        const list = document.createElement('dl');
        for (const key of Object.keys(labels) as (keyof typeof labels)[]) {
          const value = fieldValue(set, key);
          if (value !== undefined) list.append(element('dt', t(labels[key])), element('dd', value));
        }
        group.append(list);
      }
      if (report?.firstPacket) {
        const list = document.createElement('dl');
        list.append(element('dt', t(msg('analysis.features.firstPacket', '首个压缩包的 VCL NAL 数'))), element('dd', String(report.firstPacket.vclNalUnits)));
        group.append(list);
      }
      content.append(group);
    }
  }
  function localize() {
    heading.textContent = trigger.textContent = t(title);
    intro.textContent = t(msg('analysis.features.scope', '取自初始解码配置。WPP 和 Tile 可为解码器提供帧内并行机会；实际速度取决于设备、解码器和画面内容。'));
    download.textContent = t(msg('analysis.features.export', '导出 JSON'));
    close.textContent = t(msg('analysis.features.close', '关闭面板'));
    if (dialog.open) render(session.getState().tracks);
  }
  localize(); onLanguageChange(localize, signal);
  trigger.addEventListener('click', () => { render(session.getState().tracks); content.scrollTop = 0; dialog.showModal(); }, {signal});
  close.addEventListener('click', () => dialog.close(), {signal});
  download.addEventListener('click', () => {
    const tracks = session.getState().tracks.map(({slot, id, name, codec, codecFeatures}) => ({slot, id, name, codec, codecFeatures: codecFeatures ?? null}));
    const json = JSON.stringify({schema: 'voidplayer-coding-features', version: 1, tracks}, null, 2);
    const a = document.createElement('a'); a.download = 'VoidPlayer-coding-features.json';
    a.href = URL.createObjectURL(new Blob([json], {type: 'application/json'}));
    a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }, {signal});
  signal.addEventListener('abort', () => { dialog.close(); dialog.remove(); }, {once: true});
  return (tracks: Tracks) => {
    if (!dialog.open) return;
    const next = JSON.stringify(tracks.map(track => [track.slot, track.id, track.sourceGen, track.name]));
    if (next !== signature) { signature = next; render(tracks); }
  };
}
