import { msg, t } from '../../i18n.ts';
import type { WorkbenchState } from './shared.ts';
import type { CodingFeatures, ParameterSetFeatures } from '../../../shared/media/codecs/coding-features.ts';

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

export function createCodingFeatures(getTracks: () => WorkbenchState['tracks']) {
  const details = document.createElement('details'); details.id = 'inspect-coding-features'; details.hidden = true;
  const summary = document.createElement('summary'), fields = document.createElement('div'), download = element('button', '');
  download.type = 'button';
  details.append(summary, fields, download);
  let source = '', report: CodingFeatures | undefined, dirty = true;

  function render() {
    if (!details.open || !dirty || details.hidden) return;
    const fragment = document.createDocumentFragment();
    if (!report?.parameterSets.length) fragment.append(element('p', t(msg('analysis.features.unknown', '当前片源没有可读取的 H.264、H.265 或 H.266 参数集。'))));
    if (report) {
      const origin = element('small', t(msg('tracks.initialCodecConfiguration', '初始解码配置 · {format}'), {format: report.format}));
      origin.title = t(msg('analysis.features.scope', '取自初始解码配置。WPP 和 Tile 可为解码器提供帧内并行机会；实际速度取决于设备、解码器和画面内容。'));
      fragment.append(origin);
      if (report.unreadableParameterSets) fragment.append(element('p', t(msg('analysis.features.partial', '部分参数集未能读取。'))));
      for (const set of report.parameterSets) {
        const layer = set.layer ? ` · L${set.layer}` : '';
        const parent = set.spsId === undefined ? '' : ` → SPS ${set.spsId}`;
        fragment.append(element('h4', `${set.kind} ${set.id}${parent}${layer}`));
        const list = document.createElement('dl');
        for (const key of Object.keys(labels) as (keyof typeof labels)[]) {
          const value = fieldValue(set, key);
          if (value !== undefined) addRow(list, t(labels[key]), value);
        }
        fragment.append(list);
      }
      if (report.firstPacket) {
        const list = document.createElement('dl');
        addRow(list, t(msg('analysis.features.firstPacket', '首个压缩包的 VCL NAL 数')), String(report.firstPacket.vclNalUnits));
        fragment.append(list);
      }
    }
    fields.replaceChildren(fragment); dirty = false;
  }
  function addRow(list: HTMLDListElement, label: string, value: string) {
    const row = document.createElement('div');
    row.append(element('dt', label), element('dd', value)); list.append(row);
  }
  function localize() {
    summary.textContent = t(title);
    download.textContent = t(msg('tracks.exportAllCodingFeatures', '导出全部轨道 JSON'));
    dirty = true; render();
  }
  localize();
  details.ontoggle = render;
  download.onclick = () => {
    const tracks = getTracks().map(({slot, id, name, codec, codecFeatures}) => ({slot, id, name, codec, codecFeatures: codecFeatures ?? null}));
    const json = JSON.stringify({schema: 'voidplayer-coding-features', version: 1, tracks}, null, 2);
    const a = document.createElement('a'); a.download = 'VoidPlayer-coding-features.json';
    a.href = URL.createObjectURL(new Blob([json], {type: 'application/json'}));
    a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  return {details, localize, select(key: string, features?: CodingFeatures) {
    if (source === key) return;
    source = key; report = features; dirty = true; details.hidden = !key;
    if (details.hidden || !details.open) fields.replaceChildren();
    else render();
  }};
}
