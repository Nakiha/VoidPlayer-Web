import { t, msg } from '../../i18n.ts';
import { canRetryAnalysis } from '../../../shared/analysis/bitstream/failure.ts';
import type { DeepAnalysisState } from '../../analysis/bitstream/service.ts';
import type { Slot } from '../../../shared/review/model.ts';
import { createIconButton } from '../controls.ts';

/** Explicit recovery is separate from visibility and automatic admission. */
export function analysisRetryButton(slot: Slot, run: () => Promise<unknown>) {
  const label = () => t(msg('analysis.retryTrack', '重新分析轨道 {slot}'), { slot });
  const button = createIconButton({ glyph: 'refresh', label: label(), className: 'analysis-retry' });
  let running = false, blocked = false, latest: DeepAnalysisState = { state: 'idle' };
  button.hidden = true; button.dataset.retrySlot = slot;
  button.onclick = () => {
    if (button.disabled || running) return;
    running = true; button.disabled = true;
    void run().catch(() => { /* Facade publishes the failure. */ }).finally(() => { running = false; button.disabled = blocked || latest.state === 'pending'; });
  };
  return {
    button,
    update(state: DeepAnalysisState, unavailable = false) {
      blocked = unavailable; latest = state; button.hidden = !canRetryAnalysis(state);
      button.disabled = running || blocked || state.state === 'pending';
      button.setAttribute('aria-label', label()); button.dataset.tooltip = label();
    },
  };
}
