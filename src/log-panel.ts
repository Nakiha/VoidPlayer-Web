import { logPreview } from './log-preview.ts';
import { installChoiceMenu } from './ui/choice-menu.ts';
import { icon } from './ui/icons.ts';
import type { ToastStack } from './ui/toast.ts';
import { exportLog, getLogSessions, log, sessionLog, traceOperation, withLogDescription, LOG_DESCRIPTION_LIMIT } from './log.ts';

export function installLogPanel(container: HTMLElement, toasts: ToastStack) {
  const dialog = document.getElementById('settings') as HTMLDialogElement;
  const pane = document.getElementById('settings-pane-logs')!;
  const panel = document.createElement('div'); panel.className = 'log-panel';
  panel.innerHTML = `<div class="settings-section"><h4 class="settings-section-title">上传日志</h4><div class="settings-card log-settings-card"><div class="log-session-row"><button type="button" id="log-session" class="settings-choice" aria-label="日志会话"></button><button type="button" class="icon-button" id="log-help-toggle" aria-label="日志说明" data-tooltip="日志说明" popovertarget="log-help">${icon('info')}</button></div>
    <div class="log-description-field"><textarea id="log-description" aria-label="问题描述（选填）" maxlength="${LOG_DESCRIPTION_LIMIT}" rows="1" placeholder="遇到了什么问题？如何复现？" spellcheck="false"></textarea></div>
    <div class="log-send-footer"><p class="settings-caption log-destination">发送到 <span></span><br>仅在点击发送时上传</p><div class="log-submit-row"><button type="button" data-action="download">${icon('download')}下载日志</button><button type="button" class="primary" data-action="upload">${icon('export')}发送日志</button></div></div>
    </div><div class="log-feedback" hidden><p class="log-storage" role="status" hidden></p><p class="log-result" role="status" hidden></p></div>
    </div><section class="settings-section log-details"><h4 class="settings-section-title">本地日志</h4><section class="settings-card log-report" aria-label="本地日志"><header class="log-report-toolbar"><span class="log-preview-status" role="status"></span><div class="log-detail-actions"><div class="log-preview-navigation" role="group" aria-label="日志分页"><button type="button" data-page="previous">上一页</button><button type="button" data-page="next">下一页</button></div><button type="button" data-action="copy">${icon('copy')}复制日志</button></div></header><textarea class="log-json" aria-label="日志内容" readonly spellcheck="false" wrap="off"></textarea></section></section>`;
  container.append(panel);
  panel.querySelector('.log-destination span')!.textContent = location.host;
  const help = document.createElement('div'); help.id = 'log-help'; help.className = 'log-help'; help.setAttribute('popover', 'auto');
  help.innerHTML = '<strong>日志说明</strong><p>本机保留最近 3 次会话，最长 7 天。</p><p>日志包含设备信息、文件名、操作记录及你填写的问题描述，不含视频或标注正文。</p><p>仅点击“发送日志”后，才发送到当前服务器。</p>';
  dialog.append(help);
  help.addEventListener('beforetoggle', event => {
    if ((event as ToggleEvent).newState !== 'open') return;
    const rect = panel.querySelector('#log-help-toggle')!.getBoundingClientRect();
    help.style.left = `${Math.max(12, Math.min(rect.right - 320, innerWidth - 332))}px`;
    help.style.top = `${Math.min(rect.bottom + 8, innerHeight - 230)}px`;
  });
  const closeHelp = () => { if (help.matches(':popover-open')) help.hidePopover(); };
  let selectedSession = '', busy = false, refreshRequested = false, disposed = false, generation = 0, snapshotGeneration = 0;
  let sessions: { value: string; label: string }[] = [];
  const descriptions = new Map<string, string>();
  const description = panel.querySelector<HTMLTextAreaElement>('#log-description')!;
  const textarea = panel.querySelector<HTMLTextAreaElement>('.log-json')!;
  const result = panel.querySelector<HTMLElement>('.log-result')!;
  const storage = panel.querySelector<HTMLElement>('.log-storage')!;
  const feedback = panel.querySelector<HTMLElement>('.log-feedback')!;
  const toast = (text: string, error = false) => {
    (dialog.open ? dialog : document.body).append(toasts.stack);
    toasts.show(text, { kind: error ? 'error' : 'info', durationMs: error ? 0 : 7000 });
  };
  const fitDescription = () => {
    if (pane.hidden) return;
    description.style.height = 'auto';
    description.style.height = `${description.scrollHeight}px`;
  };
  let reportDocument: Awaited<ReturnType<typeof exportLog>> | undefined;
  const menu = installChoiceMenu('log-session', [], value => {
    selectedSession = value; description.value = descriptions.get(value) ?? ''; fitDescription(); reportDocument = undefined; syncMenu(); void action('select', snapshot);
  });
  const syncMenu = () => menu.sync(selectedSession, sessions.find(s => s.value === selectedSession)?.label ?? '暂无日志', sessions.length > 0 && !busy);
  const controls = () => {
    syncMenu(); description.disabled = busy || !selectedSession;
    panel.querySelectorAll<HTMLButtonElement>('[data-action]').forEach(button => { button.disabled = busy || !reportDocument; });
    panel.setAttribute('aria-busy', String(busy));
  };
  const showFeedback = () => { storage.hidden = !storage.textContent; result.hidden = !result.textContent; feedback.hidden = storage.hidden && result.hidden; };
  const message = (text = '', error = false) => { result.textContent = text; result.dataset.error = String(error); showFeedback(); };
  const storageStatus = () => {
    storage.textContent = sessionLog.storageState === 'failed' ? '本地保存失败，请下载日志备份。' : '';
    showFeedback();
  };
  const unsubscribe = sessionLog.subscribe(storageStatus);
  let previewPage = 0;
  const renderReport = () => {
    if (!reportDocument) return;
    const preview = logPreview(reportDocument, previewPage); previewPage = preview.page;
    textarea.value = preview.text; textarea.rows = Math.max(1, Math.min(12, preview.text.split('\n').length)); textarea.dataset.sessionId = reportDocument.sessionId;
    panel.querySelector('.log-preview-status')!.textContent = preview.label;
    panel.querySelector<HTMLButtonElement>('[data-page="previous"]')!.disabled = preview.page === 0;
    panel.querySelector<HTMLButtonElement>('[data-page="next"]')!.disabled = preview.page === preview.pages - 1;
  };
  for (const button of panel.querySelectorAll<HTMLButtonElement>('[data-page]')) button.onclick = () => {
    previewPage += button.dataset.page === 'next' ? 1 : -1; renderReport();
  };
  description.addEventListener('input', () => { fitDescription(); descriptions.set(selectedSession, description.value); message(); });
  async function snapshot(serialize = false) {
    const ticket = ++snapshotGeneration, id = selectedSession;
    const doc = await exportLog(id || undefined, descriptions.get(id) ?? '');
    if (ticket === snapshotGeneration && id === selectedSession) { reportDocument = doc; previewPage = Math.max(0, Math.ceil(doc.events.length / 25) - 1); renderReport(); }
    return { json: serialize ? JSON.stringify(withLogDescription(doc, description.value), null, 2) : '', filename: `voidplayer-log-${doc.startedAt.slice(0, 10)}-${doc.sessionId.slice(0, 8)}.json` };
  }
  async function refresh() {
    const request = ++generation, selected = selectedSession;
    // Paint the current bounded preview before asking disk for history.
    if (!selectedSession) {
      selectedSession = sessionLog.summary().sessionId;
      sessions = [{ value: selectedSession, label: '本次会话' }]; menu.setOptions(sessions);
      await snapshot();
    }
    const history = await getLogSessions();
    if (request !== generation || (!dialog.open || pane.hidden)) return;
    sessions = history.sessions.map(s => ({ value: s.sessionId, label: `${s.current ? '本次' : '历史'} · ${new Date(s.startedAt).toLocaleString()}` }));
    selectedSession = sessions.some(s => s.value === selected) ? selected : sessions[0]?.value ?? '';
    description.value = descriptions.get(selectedSession) ?? '';
    fitDescription();
    menu.setOptions(sessions); syncMenu();
    await snapshot();
    if (history.error) message(`历史日志读取异常：${history.error}`, true);
  }
  const action = async (name: string, work: () => unknown | Promise<unknown>, record = true) => {
    if (busy) return;
    busy = true; message(); controls();
    try { if (record) await traceOperation('ui', `logs.${name}`, { sessionId: selectedSession }, work); else await work(); }
    catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      if (name === 'upload') toast(text, true); else message(text, true);
    }
    finally {
      busy = false;
      if (!disposed) {
        controls();
        if (refreshRequested && dialog.open && !pane.hidden) { refreshRequested = false; void action('sync', refresh, false); }
      }
    }
  };
  controls();
  const onPaneChange = () => {
    closeHelp();
    if (dialog.open && !pane.hidden) { fitDescription(); storageStatus(); if (busy) refreshRequested = true; else void action('open', refresh); }
    else { refreshRequested = false; ++generation; ++snapshotGeneration; }
  };
  dialog.addEventListener('settings-pane-change', onPaneChange);
  window.addEventListener('resize', fitDescription);
  const syncVisibleLogs = () => {
    if (disposed || !dialog.open || pane.hidden) return;
    if (busy) { refreshRequested = true; return; }
    void action('sync', refresh, false);
  };
  window.addEventListener('focus', syncVisibleLogs);
  const onVisibilityChange = () => { if (!document.hidden) syncVisibleLogs(); };
  document.addEventListener('visibilitychange', onVisibilityChange);
  const syncTimer = window.setInterval(syncVisibleLogs, 15_000);
  panel.querySelector('[data-action="download"]')!.addEventListener('click', () => void action('download', async () => {
    const { json, filename } = await snapshot(true);
    const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = filename;
    document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 10000);
    message('下载已开始。');
  }));
  panel.querySelector('[data-action="copy"]')!.addEventListener('click', () => void action('copy', async () => {
    const { json } = await snapshot(true);
    try { await navigator.clipboard.writeText(json); message('日志已复制。'); }
    catch (error) {
      log.warn('ui', '剪贴板复制失败', { error });
      message('复制失败，请使用下载日志保存完整内容。');
    }
  }));
  panel.querySelector('[data-action="upload"]')!.addEventListener('click', () => void action('upload', async () => {
    const { json } = await snapshot(true);
    let response: Response;
    try { response = await fetch('/api/logs', { method: 'POST', headers: { 'content-type': 'application/json', 'x-voidplayer-action': 'log' }, body: json }); }
    catch (error) { log.warn('ui', '日志上传请求失败', { error }); throw new Error('无法连接当前服务器，请重试或下载日志。'); }
    if (!response.ok) {
      const body = await response.json().catch(() => null);
      throw new Error(`上传失败（${response.status}）${body?.error ? `：${body.error}` : '，可改用下载日志。'}`);
    }
    const body = await response.json();
    try {
      await navigator.clipboard.writeText(body.name);
      toast(`日志已上传，文件名已复制：${body.name}`);
    } catch (error) {
      log.warn('ui', '日志文件名复制失败', { error });
      toast(`日志已上传，无法自动复制文件名：${body.name}`, true);
    }
  }));
  const onClose = () => { closeHelp(); document.body.append(toasts.stack); refreshRequested = false; ++generation; ++snapshotGeneration; };
  dialog.addEventListener('close', onClose);
  return () => { disposed = true; ++generation; ++snapshotGeneration; menu.dispose(); unsubscribe(); help.remove(); dialog.removeEventListener('settings-pane-change', onPaneChange); dialog.removeEventListener('close', onClose); window.removeEventListener('resize', fitDescription); window.removeEventListener('focus', syncVisibleLogs); document.removeEventListener('visibilitychange', onVisibilityChange); clearInterval(syncTimer); panel.remove(); };
}
