import { msg, th } from '../i18n.ts';

const views = ['single', 'correspondence', 'vmaf', 'cambi', 'ranges', 'xpsnr'] as const;
export type QualityView = (typeof views)[number];

/** Observation follows the visible form; frozen requests remain mounted. */
export function qualityViewVisible(view: QualityView) {
  const pane = document.getElementById(`quality-view-${view}`);
  return !document.hidden && !!pane && !pane.closest('[hidden]');
}

export function qualityNavigationShell() {
  const labels = [
    msg('qualityWorkspace.single', '单帧与区域'),
    msg('qualityWorkspace.correspondence', '参考关系'),
    msg('vmaf.title', 'VMAF · 连续片段评分'),
    msg('cambi.title', 'CAMBI · 单源色带筛查'),
    msg('qualityWorkspace.ranges', '区间任务'),
    msg('qualityWorkspace.xpsnr', 'XPSNR'),
  ];
  return `<div class="admin-log-tabs quality-navigation" role="group" aria-label="${th(msg('qualityWorkspace.navigation', '评分流程'))}">${views.map((view, index) =>
    `<button type="button" data-quality-section="${view}" aria-controls="quality-view-${view}" aria-pressed="${index === 0}">${th(labels[index])}</button>`,
  ).join('')}</div>`;
}

/** View changes only hide forms. They neither submit nor reset frozen requests. */
export function installQualityNavigation(signal: AbortSignal) {
  const root = document.getElementById('pane-quality')!;
  const select = (view: QualityView, remember = true) => {
    for (const pane of root.querySelectorAll<HTMLElement>('[data-quality-view]')) {
      pane.hidden = pane.dataset.qualityView !== view;
    }
    for (const button of root.querySelectorAll<HTMLElement>('[data-quality-section]')) {
      button.setAttribute('aria-pressed', String(button.dataset.qualitySection === view));
    }
    if (remember) {
      const url = new URL(location.href);
      url.searchParams.set('qualityView', view);
      history.replaceState(history.state, '', url);
    }
  };
  for (const button of root.querySelectorAll<HTMLButtonElement>('[data-quality-section]')) {
    button.addEventListener('click', () => select(button.dataset.qualitySection as QualityView), { signal });
  }
  for (const button of root.querySelectorAll<HTMLButtonElement>('[data-quality-open]')) {
    button.addEventListener('click', () => select(button.dataset.qualityOpen as QualityView), { signal });
  }
  const params = new URL(location.href).searchParams;
  const initial = params.get('qualityView') ?? (params.has('xpsnrComparison') ? 'xpsnr' : null);
  select(views.includes(initial as QualityView) ? initial as QualityView : 'single', false);
  // Register before the metric controllers so their existing scroll/focus happens
  // after the selected panel becomes visible. The controller still checks actor
  // and frozen-request ownership before accepting a transferred plan.
  window.addEventListener('voidplayer-quality-range-select', () => select('ranges'), { signal });
  for (const metric of ['vmaf', 'xpsnr'] as const) {
    window.addEventListener(`voidplayer-${metric}-plan`, () => select(metric), { signal });
  }
}
