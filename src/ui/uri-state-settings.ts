import { localOnly } from '../services/build-profile.ts';
import { th, msg } from '../i18n.ts';
import { annotationActivityShell } from './annotation-activity.ts';
import { icon } from './icons.ts';

export function uriStateSettingsShell() {
  return `<div class="settings-section"><h4 class="settings-section-title">${th(msg('uriState.title', '观看状态'))}</h4>
    <p class="settings-caption">${th(msg('uriState.help', '片源、时间、比较条件和布局由地址栏保存；标注独立保存到片源版本。'))}</p>
    <div class="settings-group"><div class="settings-action-row"><span>${th(msg('uriState.address', '当前状态地址'))}</span>
      <button id="state-copy-readable">${icon('copy')}${th(msg('uriState.copyAddress', '复制可编辑地址'))}</button>
      ${localOnly ? '' : `<button id="saved-workspace-share">${icon('shareNetwork')}${th(msg('shell.share', '分享'))}</button>`}</div></div>
    <p id="state-link-fallback" class="settings-caption" hidden><a target="_blank" rel="noopener"></a></p>
    </div><div class="settings-section"><h4 class="settings-section-title">${th(msg('uriState.annotations', '片源标注同步'))}</h4>
      <p id="annotation-status" class="settings-caption" role="status"></p><div id="annotation-conflicts"></div></div>${annotationActivityShell()}`;
}
