import { SLOTS } from '../../model.ts';
import type { Slot } from '../../model.ts';
import { BITRATE_WINDOW_OPTIONS_US, DEFAULT_BITRATE_WINDOW_US } from '../../analysis/statistics.ts';

export const PREF_KEY = 'voidplayer.analysis.v2';
const LEGACY_PREF_KEY = 'voidplayer.analysis.v1';

export interface AnalysisPreferences {
  showBitrate: boolean; showSize: boolean;
  axis: 'pts' | 'dts'; windowUs: number; layoutMode: 'merged' | 'rows';
  /** 状态区帧号顺序（PTS序/解码序），与图表时间基准独立。 */
  numAxis: 'pts' | 'dts';
  follow: boolean; selected: Slot[];
}

function migrateLayoutMode(raw: unknown): AnalysisPreferences['layoutMode'] {
  // 旧偏好 auto/paired 一律迁到 merged，rows 保留。
  if (raw === 'rows') return 'rows';
  return 'merged';
}

function sanitizeAnalysisPreferences(p: Partial<AnalysisPreferences> & { layoutMode?: unknown }, fallback: AnalysisPreferences): AnalysisPreferences {
  return {
    ...fallback,
    showBitrate: typeof p.showBitrate === 'boolean' ? p.showBitrate : fallback.showBitrate,
    showSize: typeof p.showSize === 'boolean' ? p.showSize : fallback.showSize,
    follow: typeof p.follow === 'boolean' ? p.follow : fallback.follow,
    axis: p.axis === 'dts' ? 'dts' : 'pts',
    numAxis: p.numAxis === 'dts' ? 'dts' : 'pts',
    windowUs: BITRATE_WINDOW_OPTIONS_US.includes(p.windowUs!) ? p.windowUs! : DEFAULT_BITRATE_WINDOW_US,
    layoutMode: migrateLayoutMode(p.layoutMode),
    selected: Array.isArray(p.selected) ? p.selected.filter((s): s is Slot => SLOTS.includes(s as Slot)) : [],
  };
}

export function loadAnalysisPreferences(): AnalysisPreferences {
  const fallback: AnalysisPreferences = {
    // 多轨主体色恒为轨道色（与曲线对应），关键用顶端菱形/K 标记，不再按类型填色。
    showBitrate: true, showSize: true,
    axis: 'pts', windowUs: DEFAULT_BITRATE_WINDOW_US, layoutMode: 'merged',
    numAxis: 'pts',
    follow: true, selected: [],
  };
  // v2 优先；无 v2 时从 v1 迁移可保留项，colorByType 一律丢弃（旧版本无法区分
  // 用户显式选择，新默认恒为轨道主体色）。只迁移一次，不反复覆盖 v2。
  try {
    const raw = localStorage.getItem(PREF_KEY);
    if (raw) return sanitizeAnalysisPreferences(JSON.parse(raw) as Partial<AnalysisPreferences>, fallback);
  } catch { /* 损坏的 v2 视为无偏好，走迁移。 */ }
  try {
    const legacy = localStorage.getItem(LEGACY_PREF_KEY);
    if (legacy) {
      const next = sanitizeAnalysisPreferences(JSON.parse(legacy) as Partial<AnalysisPreferences>, fallback);
      try { localStorage.setItem(PREF_KEY, JSON.stringify(next)); } catch { /* 偏好不影响播放。 */ }
      return next;
    }
  } catch { /* 损坏的 v1 视为无偏好。 */ }
  return fallback;
}
