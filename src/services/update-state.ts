import { parseUriState, type UriState } from '../../shared/review/uri-state.ts';
import { parseWorkspaceEnhancements, type WorkspaceFile } from '../../shared/review/workspace-file.ts';

// A tab-scoped, one-use handoff for private workspace state during an explicit application update.
const key = 'voidplayer.update-state.v1';
type UpdateState = { state: UriState; enhancements?: WorkspaceFile['enhancements'] };

export function stageUpdateState(target: string, workspace: UpdateState) {
  sessionStorage.setItem(key, JSON.stringify({ target, ...workspace, state: parseUriState(workspace.state) }));
}
export function takeUpdateState(target: string): UpdateState | undefined {
  const raw = sessionStorage.getItem(key);
  sessionStorage.removeItem(key);
  if (!raw) return;
  const value = JSON.parse(raw);
  if (value.target !== target) return;
  const state = parseUriState(value.state);
  const enhancements = value.enhancements === undefined ? undefined : parseWorkspaceEnhancements(value.enhancements);
  if (enhancements?.some(entry => !state.tracks.some(track => track.slot === entry.slot))) throw new Error('工作区画面增强轨道引用无效。');
  return { state, enhancements };
}
