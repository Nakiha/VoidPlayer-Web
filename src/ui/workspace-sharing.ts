import { t, msg, onLanguageChange } from '../i18n.ts';
import type { SavedWorkspace } from '../saved-workspaces.ts';
import type { WorkspaceFile } from '../../shared/review/workspace-file.ts';
import { prepareSharedWorkspace } from '../shared-workspace.ts';
import { randomUUID } from '../../shared/utils/uuid.ts';
import { icon } from './icons.ts';
import type { ToastStack } from './toast.ts';

/** Share is one action: save the current writable workspace and copy its URL. */
export function installWorkspaceSharing(options: {
  signal: AbortSignal;
  snapshot(): WorkspaceFile;
  binding(): SavedWorkspace | undefined;
  save(document: WorkspaceFile, id: string, previous?: SavedWorkspace): Promise<SavedWorkspace>;
  openSpace(space: string, seededIds: string[]): Promise<void>;
  scope(): string;
  canShare(): boolean;
  isOpening(): boolean;
  toasts: ToastStack;
  report(error: unknown): void;
}) {
  const buttons = ['workspace-share', 'saved-workspace-share'].map(id => document.getElementById(id) as HTMLButtonElement);
  let epoch = 0, busy = false, renderedBusy: boolean | undefined;
  let pending: { id: string; document: WorkspaceFile; previous?: SavedWorkspace; pinned: boolean; attached: boolean } | undefined;

  function update() {
    for (const button of buttons) { button.disabled = busy || !options.canShare(); button.setAttribute('aria-busy', String(busy)); }
    if (renderedBusy !== busy) {
      renderedBusy = busy;
      for (const button of buttons) {
        button.innerHTML = `${busy ? icon('refresh', 'share-spinner') : icon('shareNetwork')}<span>${busy ? t(msg("sharing.saving", "正在保存")) : t(msg("shell.share", "分享"))}</span>`;
      }
    }
  }
  onLanguageChange(() => { renderedBusy = undefined; update(); }, options.signal);
  async function copy(url: string) {
    await navigator.clipboard.writeText(url);
    options.toasts.show(() => t(msg('sharing.editableCopied', '工作区链接已复制，接收者可编辑和保存')));
  }
  async function create(trigger?: HTMLElement) {
    if (busy) throw new Error(t(msg("workspace.saving", "工作区正在保存，请稍后再分享。")));
    if (options.isOpening()) throw new Error(t(msg("workspace.saving", "工作区正在保存，请稍后再分享。")));
    // A retry retains the same request and ID if the server response was lost.
    const previous = options.binding();
    pending ??= { id: previous?.id ?? randomUUID(), document: structuredClone(options.snapshot()), previous, pinned: false, attached: !!previous?.space && options.scope() === previous.space };
    const request = pending, stamp = epoch;
    const ensureCurrent = () => { if(stamp !== epoch) throw new Error(t(msg("workspace.changed", "当前工作区已切换，请在新工作区重新分享。"))); };
    busy = true; update();
    try {
      if (!options.canShare()) throw new Error(t(msg("sharing.addVideo", "请先添加视频再分享。")));
      if (!request.pinned) { request.document = await prepareSharedWorkspace(request.document); request.pinned = true; }
      ensureCurrent();
      const record = await options.save(request.document, request.id, request.previous);
      ensureCurrent();
      if (record.space && !request.attached) {
        await options.openSpace(record.space, request.document.marks.map(mark => mark.id)); request.attached = true;
      }
      ensureCurrent();
      const current = new URL(location.href); current.searchParams.delete('share'); current.searchParams.delete('review'); current.searchParams.set('workspace', record.id); history.replaceState(null, '', current);
      const url = new URL(`/?workspace=${record.id}`, location.origin).href;
      pending = undefined; await copy(url); return { id: record.id, url };
    } catch (error) {
      if ([404,409].includes((error as {status?: number}).status ?? 0)) pending = undefined;
      if (!options.signal.aborted) { options.toasts.show((error as Error).message, {kind:'error',durationMs:0}); options.report(error); }
      throw error;
    } finally { busy = false; update(); }
  }
  for (const button of buttons) button.addEventListener('click', () => void create(button).catch(() => {}), {signal:options.signal});
  update();
  return { create, update, async copySaved(id: string) {
    try { await copy(new URL(`/?workspace=${encodeURIComponent(id)}`, location.origin).href); }
    catch (error) {
      if (!options.signal.aborted) options.toasts.show(error instanceof Error ? error.message : String(error), { kind: 'error', durationMs: 0 });
      throw error;
    }
  }, detach() { epoch++; pending = undefined; }, dispose() {} };
}
