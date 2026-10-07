import { currentActor } from '../identity.ts';
import { t, th, msg, formatDate, onLanguageChange } from '../i18n.ts';
import type { WorkspaceCheckpoints, CheckpointSummary } from '../workspace-checkpoint.ts';
import type { WorkspaceFile } from '../workspace-file.ts';

export function checkpointHistoryShell() {
  return `<div class="settings-section"><h4 class="settings-section-title">${th(msg('recovery.history', '本机恢复记录'))}</h4>
    <p class="settings-caption">${th(msg('recovery.historyHelp', '记录仅存于此浏览器。可导出备份或删除不再需要的历史记录，当前页面的记录会继续自动保存。'))}</p>
    <p id="checkpoint-history-usage" class="settings-caption" role="status"></p>
    <div id="checkpoint-history-list" class="settings-card"></div>
    <p id="checkpoint-history-message" class="settings-caption" role="status" hidden></p>
    <div class="checkpoint-history-pages"><button id="checkpoint-history-first">${th(msg('savedWorkspaces.backToLatest', '返回最新'))}</button><button id="checkpoint-history-next">${th(msg('savedWorkspaces.nextPage', '下一页'))}</button></div></div>`;
}

export function installCheckpointHistory(store: WorkspaceCheckpoints, options: {
  signal: AbortSignal; currentId(): string; restore(document: WorkspaceFile): Promise<boolean>; report(error: Error): void;
}) {
  const list = document.getElementById('checkpoint-history-list')!;
  const usage = document.getElementById('checkpoint-history-usage')!;
  const message = document.getElementById('checkpoint-history-message')!;
  const first = document.getElementById('checkpoint-history-first') as HTMLButtonElement;
  const next = document.getElementById('checkpoint-history-next') as HTMLButtonElement;
  const actor = () => currentActor()?.id ?? 'local';
  let before: CheckpointSummary | undefined, page: CheckpointSummary[] = [], more = false, busy = false, sequence = 0;
  const current = (owner: string) => !options.signal.aborted && actor() === owner;
  function controls() {
    first.disabled = busy || !before; next.disabled = busy || !more;
    for (const button of list.querySelectorAll<HTMLButtonElement>('button')) button.disabled = busy || button.dataset.current === 'true';
  }
  async function refresh() {
    const owner = actor(), request = ++sequence;
    try {
      const [result, budget] = await Promise.all([store.list(owner, before), store.usage(owner)]);
      if (!current(owner) || sequence !== request) return;
      usage.textContent = t(msg('recovery.capacity', '已保存 {count}/{limit} 份 · 估算 {used} / {budget} MiB。达到上限后请先导出并删除旧记录，已有记录不会自动删除。'),
        { count: budget.count, limit: budget.limits.count, used: (budget.bytes / 1048576).toFixed(1), budget: (budget.limits.bytes / 1048576).toFixed(0) });
      page = result.entries; more = result.more; message.hidden = true;
      list.replaceChildren();
      if (!page.length) {
        const empty = document.createElement('p'); empty.className = 'settings-caption';
        empty.textContent = t(msg('recovery.noHistory', '暂无本机恢复记录')); list.append(empty);
      }
      for (const entry of page) {
        const row = document.createElement('div'); row.className = 'checkpoint-history-row'; row.dataset.checkpointId = entry.id;
        const info = document.createElement('span'); info.className = 'saved-workspace-info';
        const name = document.createElement('strong'); name.textContent = entry.name || t(msg('savedWorkspaces.untitledWorkspace', '未命名工作区'));
        const detail = document.createElement('span'); detail.className = 'saved-workspace-meta';
        detail.textContent = `${formatDate(new Date(entry.updatedAt).toISOString())} · ${t(msg('recovery.historyCounts', '{tracks, plural, other {# 轨道}} · {marks, plural, other {# 标注}}'), { tracks: entry.tracks, marks: entry.marks })}`;
        info.append(name, detail); row.append(info);
        const action = (label: string, work: () => Promise<void>) => {
          const button = document.createElement('button'); button.type = 'button'; button.textContent = label;
          button.onclick = () => void run(owner, work); row.append(button); return button;
        };
        const read = async () => {
          const record = await store.exact(owner, entry.id);
          if (!record || record.updatedAt !== entry.updatedAt) throw new Error(t(msg('recovery.historyChanged', '恢复记录已改变，请刷新列表后重试。')));
          return record.document;
        };
        action(t(msg('recovery.restore', '恢复工作区')), async () => { const document = await read(); if (current(owner)) await options.restore(document); });
        action(t(msg('recovery.export', '导出备份')), async () => {
          const workspace = await read(); if (!current(owner)) return;
          const url = URL.createObjectURL(new Blob([JSON.stringify(workspace, null, 2)], { type: 'application/json' }));
          const link = document.createElement('a'); link.href = url; link.download = `voidplayer-recovery-${entry.updatedAt}.voidplayer`; link.click();
          setTimeout(() => URL.revokeObjectURL(url), 1000);
        });
        const remove = action(t(msg('marks.delete', '删除')), async () => {
          if (!await store.remove(owner, entry.id, entry.updatedAt)) throw new Error(t(msg('recovery.historyChanged', '恢复记录已改变，请刷新列表后重试。')));
          await refresh();
        });
        remove.dataset.current = String(entry.id === options.currentId());
        const commit = remove.onclick;
        remove.onclick = () => {
          row.querySelector('.annotation-confirm')?.remove();
          const confirm = document.createElement('div'); confirm.className = 'annotation-confirm';
          const prompt = document.createElement('span'); prompt.textContent = t(msg('recovery.deleteHistory', '删除这份本机恢复记录？'));
          const cancel = document.createElement('button'); cancel.textContent = t(msg('marks.cancel', '取消'));
          const accept = document.createElement('button'); accept.textContent = t(msg('marks.delete', '删除'));
          cancel.onclick = () => { confirm.remove(); remove.focus(); };
          accept.onclick = event => { confirm.remove(); commit?.call(remove, event); };
          confirm.append(prompt, cancel, accept); row.append(confirm); cancel.focus();
        };
        list.append(row);
      }
      controls();
    } catch (error) { if (current(owner) && sequence === request) showError(error); }
  }
  function showError(error: unknown) {
    message.textContent = error instanceof Error ? error.message : String(error); message.hidden = false;
  }
  async function run(owner: string, work: () => Promise<void>) {
    if (busy || !current(owner)) return;
    busy = true; controls();
    try { await work(); }
    catch (error) { if (current(owner)) { showError(error); options.report(error instanceof Error ? error : new Error(String(error))); } }
    finally { busy = false; controls(); if (!current(owner)) refreshVisible(); }
  }
  first.onclick = () => { before = undefined; void refresh(); };
  next.onclick = () => { before = page.at(-1); void refresh(); };
  const settings = document.getElementById('settings')!;
  const refreshVisible = () => { if (!busy && (settings as HTMLDialogElement).open && !document.getElementById('settings-pane-workspace')!.hidden) void refresh(); };
  settings.addEventListener('settings-pane-change', event => { if ((event as CustomEvent).detail === 'workspace') refreshVisible(); }, { signal: options.signal });
  window.addEventListener('focus', refreshVisible, { signal: options.signal });
  window.addEventListener('voidplayer-identity-change', () => { ++sequence; before = undefined; page = []; list.replaceChildren(); refreshVisible(); }, { signal: options.signal });
  onLanguageChange(refreshVisible, options.signal);
  controls();
}
