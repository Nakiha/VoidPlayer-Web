import { parseUriState, type UriState } from '../../shared/review/uri-state.ts';

// A tab-scoped, one-use handoff for local files during an explicit application update.
const key = 'voidplayer.update-state.v1';
export function stageUpdateState(target: string, state: UriState) {
  sessionStorage.setItem(key, JSON.stringify({ target, state: parseUriState(state) }));
}
export function takeUpdateState(target: string): UriState | undefined {
  const raw = sessionStorage.getItem(key);
  sessionStorage.removeItem(key);
  if (!raw) return;
  const value = JSON.parse(raw);
  if (value.target === target) return parseUriState(value.state);
}
