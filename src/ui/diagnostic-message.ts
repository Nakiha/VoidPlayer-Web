import type { MediaDiagnostic } from '../../shared/media/io/media-errors.ts';
import { msg, t } from '../i18n.ts';
import { classifyUserError } from '../session/errors.ts';

function translateUserError(raw: string): string {
  switch (classifyUserError(raw)) {
    case 'open-video-first':
      return t(msg('error.openVideoFirst', '请先打开视频。'));
    case 'load-video-first':
      return t(msg('error.loadVideoFirst', '请先载入视频。'));
    case 'duplicate-source':
      return t(msg('error.duplicateSource', '该片源已在视图中，不能重复添加。'));
    case 'all-tracks-disabled':
      return t(msg('error.allTracksDisabled', '所有轨道均已停用，请重新载入片源。'));
    case 'wait-operation-before-play':
      return t(msg('error.waitOperationBeforePlay', '请等待当前操作完成后再播放。'));
    case 'finish-seek-first':
      return t(msg('error.finishSeekFirst', '请先完成画面定位。'));
    case 'pause-before-mark':
      return t(msg('error.pauseBeforeMark', '请暂停并等待画面定位完成后再标注。'));
    case 'track-not-synced-for-mark':
      return t(msg('error.trackNotSyncedForMark', '当前轨道尚未同步，请等待追赶完成或定位后再标注。'));
    case 'no-valid-frame-for-mark':
      return t(msg('error.noValidFrameForMark', '当前轨道没有可标注的有效画面，请重新载入停用的片源。'));
    case 'pause-before-edit-mark':
      return t(msg('error.pauseBeforeEditMark', '请暂停并等待画面定位完成后再编辑标注。'));
    case 'return-to-mark-frame':
      return t(msg('error.returnToMarkFrame', '请返回标注对应的画面后再编辑。'));
    case 'wait-color-mode':
      return t(msg('error.waitColorMode', '请等待色彩模式切换完成。'));
    case 'changing-color-mode':
      return t(msg('error.changingColorMode', '正在切换色彩模式。'));
    case 'empty-video-file':
      return t(msg('error.emptyVideoFile', '请选择非空的视频文件。'));
    default:
      return raw;
  }
}

/** Translate actionable errors at the UI edge, and retain original stage/reason. */
export function diagnosticMessage(raw: string, diagnostic?: MediaDiagnostic) {
  if (!diagnostic) return translateUserError(raw);
  const summary = diagnostic.code === 'wasm-core-incompatible'
    ? t(msg('error.wasmCoreIncompatible', '软件解码器资源与播放器版本不匹配，请更新解码器资源并刷新页面后重试。'))
    : diagnostic.code === 'reference-hdr-unsupported'
    ? t(msg('error.referenceHdr', '此 HDR 视频未提供可核对的高位深平面。请切换为浏览器色彩后重试。'))
    : t(msg('error.referenceFormat', '自有色彩不支持此像素格式或颜色信息。请切换为浏览器色彩后重试。'));
  return t(msg('error.diagnostic', '{summary}\n[{code} / {stage}] {reason}'), { summary, code: diagnostic.code, stage: diagnostic.stage, reason: raw });
}
