import type { ReviewSession } from '../../session.ts';
import type { AnalysisViewState } from '../../workspace-file.ts';
import type { AnalysisHooks, installAnalysisPanel } from '../analysis-panel.ts';
import { loadAnalysisPreferences } from './preferences.ts';
import { reconcileTrackSelection } from '../track-selection.ts';
import type { Slot } from '../../model.ts';

type Action = Parameters<typeof installAnalysisPanel>[1];
type Panel = ReturnType<typeof installAnalysisPanel>;
type Loader = () => Promise<{ installAnalysisPanel: typeof installAnalysisPanel }>;

/** Preserve snapshots and restore intent before the optional UI is loaded.
 * Closing or disposing during import never reopens or mounts a stale panel. */
export function installLazyAnalysisPanel(session: ReviewSession, act: Action, hooks: AnalysisHooks,
  load: Loader = () => import('../analysis-panel.ts')) {
  let panel: Panel | undefined, loading: Promise<void> | undefined, open = hooks.isOpen();
  let snapshot: AnalysisViewState = { ...loadAnalysisPreferences(), view: null };
  const known = new Set<string>();
  function reconcile() {
    const tracks = session.getAnalysisCapabilities();
    snapshot.selected = reconcileTrackSelection(snapshot.selected, tracks.map(t => ({ slot: t.slot, mediaId: t.mediaId })), known).selected as Slot[];
  }
  function ensure() {
    if (panel || hooks.signal.aborted) return Promise.resolve();
    if (loading) return loading;
    reconcile();
    loading = load().then(module => {
      if (hooks.signal.aborted) return;
      // Import can finish after closing: retain the snapshot and mount only
      // on a later explicit open, when it has a useful subscription lifetime.
      if (!open) return;
      panel = module.installAnalysisPanel(session, act, hooks);
      reconcile(); panel.restoreAnalysisState(snapshot); panel.setOpen(open);
    }).finally(() => { loading = undefined; });
    return loading;
  }
  function setOpen(next: boolean) {
    open = next;
    if (panel) panel.setOpen(next);
    else if (next) void ensure().catch(error => act(() => { throw error; }, 'analysis.open'));
  }
  return {
    setOpen,
    ready: () => open ? ensure() : Promise.resolve(),
    getAnalysisState() { if (panel) return panel.getAnalysisState(); reconcile(); return structuredClone(snapshot); },
    restoreAnalysisState(state: AnalysisViewState) {
      snapshot = structuredClone(state);
      known.clear();
      for (const track of session.getAnalysisCapabilities()) known.add(`${track.slot}|${track.mediaId}`);
      panel?.restoreAnalysisState(state);
    },
  };
}
