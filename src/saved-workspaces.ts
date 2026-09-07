import { currentActor, identityHealth } from './identity.ts';
import type { SavedWorkspace } from '../server/workspaces.ts';
import type { WorkspaceFile } from './workspace-file.ts';
export type { SavedWorkspace };
export type WorkspaceRecord = SavedWorkspace & { document: WorkspaceFile };
export type WorkspacePage = { entries: SavedWorkspace[]; next: string | null };
export class SavedWorkspaceClient {
  private signal: AbortSignal;
  constructor(signal: AbortSignal) { this.signal = signal; }
  async request<T>(url: string, method = 'GET', value?: unknown, revision?: number): Promise<T> {
    const previous = currentActor();
    const health = await identityHealth();
    if (previous && previous.id !== health.actor?.id) throw new Error('用户已切换，请重新选择工作区。');
    const response = await fetch(url, { method, cache: 'no-store', headers: { ...(health.actor ? { 'x-voidplayer-actor': health.actor.id } : {}), ...(method === 'GET' ? {} : { 'x-voidplayer-action': 'workspace', 'content-type': 'application/json' }), ...(revision === undefined ? {} : { 'if-match': `"${revision}"` }) }, body: value === undefined ? undefined : JSON.stringify(value), signal: AbortSignal.any([this.signal, AbortSignal.timeout(30000)]) });
    const result = await response.json();
    if (!response.ok) throw Object.assign(new Error(result.error ?? `请求失败 (${response.status})`), { status: response.status });
    return result;
  }
  list(before = '', search = '', all = false) { return this.request<WorkspacePage>(`/api/workspaces?before=${encodeURIComponent(before)}&search=${encodeURIComponent(search)}${all ? '&all=1' : ''}`); }
  read(id: string) { return this.request<WorkspaceRecord>(`/api/workspaces/${id}`); }
  save(name: string, document: WorkspaceFile, previous?: SavedWorkspace) { return this.request<SavedWorkspace>(previous ? `/api/workspaces/${previous.id}` : '/api/workspaces', previous ? 'PUT' : 'POST', { name, document }, previous?.revision); }
  remove(record: SavedWorkspace) { return this.request(`/api/workspaces/${record.id}`, 'DELETE', undefined, record.revision); }
}
