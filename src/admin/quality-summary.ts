import { msg, t } from '../i18n.ts';
import type { VmafNativeResult } from '../../shared/analysis/quality/vmaf.ts';
import type { XpsnrNativeResult, XpsnrDb } from '../../shared/analysis/quality/xpsnr.ts';
import type { CambiNative } from '../../shared/analysis/quality/cambi.ts';

/** The routes expose their official pools. Never average displayed frame scores. */
export type QualityScoreSummary = {
  vmaf?: VmafNativeResult | null;
  xpsnr?: XpsnrNativeResult | null;
  pooled?: CambiNative['pooled'];
};

export function renderQualitySummary(root: HTMLElement, result: QualityScoreSummary) {
  root.replaceChildren();
  const metrics = document.createElement('dl');
  metrics.className = 'quality-score-summary';
  const number = (value: number) => Number.isFinite(value) ? value.toFixed(4) : '—';
  const db = (value: XpsnrDb) => value.kind === 'positive-infinity' ? '∞ dB' : `${number(value.db!)} dB`;
  const add = (label: string, value: string) => {
    const row = document.createElement('div');
    const term = document.createElement('dt'), score = document.createElement('dd');
    term.textContent = label; score.textContent = value;
    row.append(term, score); metrics.append(row);
  };
  const pool = result.vmaf?.pooled ?? result.pooled;
  if (pool) {
    add(result.vmaf ? 'VMAF' : 'CAMBI', number(pool.mean));
    add(t(msg('qualityWorkspace.minimum', '最低分')), number(pool.min));
    add(t(msg('qualityWorkspace.maximum', '最高分')), number(pool.max));
    add(t(msg('qualityWorkspace.harmonic', '调和平均')), number(pool.harmonic_mean));
  } else if (result.xpsnr) {
    for (const plane of ['y', 'u', 'v'] as const) add(`XPSNR ${plane.toUpperCase()}`, db(result.xpsnr.pooled.planes[plane]));
    add(t(msg('qualityWorkspace.minimum', '最低分')), db(result.xpsnr.pooled.minimum));
  } else {
    const unavailable = document.createElement('p');
    unavailable.textContent = t(msg('qualityWorkspace.unscored', '此指标没有可用分数，请查看执行详情。'));
    root.append(unavailable);
  }
  const details = document.createElement('details');
  details.className = 'quality-advanced';
  const label = document.createElement('summary'), raw = document.createElement('pre');
  label.textContent = t(msg('qualityWorkspace.resultFacts', '完整结果数据'));
  raw.textContent = JSON.stringify(result, null, 2);
  details.append(label, raw);
  root.append(metrics, details);
}
