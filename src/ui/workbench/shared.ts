import type { ReviewSession } from '../../session.ts';
import type { Slot } from '../../model.ts';
import type { WorkspaceState, Panel } from '../workspace-state.ts';
import type { SourceCatalog } from '../source-catalog.ts';

export type WorkbenchState = ReturnType<ReviewSession['getState']>;
export type WorkbenchAction = (action: () => unknown | Promise<unknown>, name?: string, data?: unknown) => Promise<void>;

/** Mutable assembly shared by the workbench panes. Panes call back into the
 *  core for selection, panels and rendering; the core delegates pane content. */
export type WorkbenchShared = {
  session: ReviewSession;
  act: WorkbenchAction;
  addMark: (slot: Slot, markId?: string) => void;
  view: WorkspaceState;
  catalog: SourceCatalog;
  workspace: HTMLElement;
  lifecyle: AbortController;
  save(): void;
  select(slot: Slot): void;
  inspect(slot: Slot): void;
  setPanel(panel: Panel, open: boolean): void;
  render(state: WorkbenchState): void;
  renderSources(): void;
  resize(value: number): void;
  dockHeight(): number;
  annotationHeightDelta(): number;
};
