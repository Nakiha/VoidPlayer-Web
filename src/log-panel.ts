import { installChoiceMenu } from './ui/choice-menu.ts';
import { icon } from './ui/icons.ts';
import { exportLog, getLogSessions, log, sessionLog, traceOperation, withLogDescription, LOG_DESCRIPTION_LIMIT } from './log.ts';

export function installLogPanel(container: HTMLElement) {
  const dialog = document.getElementById('settings') as HTMLDialogElement;
  const pane = document.getElementById('settings-pane-logs')!;
  const panel = document.createElement('div'); panel.className = 'log-panel';
  panel.innerHTML = `<div class="log-session-row"><button type="button" id="log-session" class="settings-choice" aria-label="日志会话"></button><button type="button" class="icon-button" data-action="refresh" aria-label="更新日志" data-tooltip="更新日志">${icon('refresh')}</button><button type="button" class="icon-button" id="log-help-toggle" aria-label="日志说明" data-tooltip="日志说明" popovertarget="log-help">${icon('info')}</button></div>
    <div class="log-description-field"><label for="log-description">问题描述 <span>选填</span></label><textarea id="log-description" maxlength="${LOG_DESCRIPTION_LIMIT}" rows="3" placeholder="遇到了什么问题？如何复现？" spellcheck="false"></textarea></div>
    <section class="log-report" aria-label="日志报告"><header class="log-report-toolbar"><span>报告预览</span><div class="log-actions"><button type="button" class="icon-button" data-action="copy" aria-label="复制报告" data-tooltip="复制报告">${icon('copy')}</button><button type="button" class="icon-button" data-action="download" aria-label="下载报告" data-tooltip="下载报告">${icon('download')}</button><button type="button" data-action="upload">${icon('export')}上传报告</button></div></header><textarea class="log-json" aria-label="日志内容" readonly spellcheck="false" wrap="off"></textarea><div class="log-feedback" hidden><p class="log-storage" role="status" hidden></p><p class="log-result" role="status" hidden></p></div></section>`;
  container.append(panel);
  const help = document.createElement('div'); help.id = 'log-help'; help.className = 'log-help'; help.setAttribute('popover', 'auto');
  help.innerHTML = '<strong>日志说明</strong><p>本机保留最近 3 次会话，最长 7 天。</p><p>报告包含设备信息、文件名、操作记录及你填写的问题描述，不含视频或标注正文。</p><p>仅点击“上传报告”后，才发送到当前服务器。</p>';
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
  let reportDocument: Awaited<ReturnType<typeof exportLog>> | undefined;
  const menu = installChoiceMenu('log-session', [], value => {
    selectedSession = value; description.value = descriptions.get(value) ?? ''; reportDocument = undefined; syncMenu(); void action('select', snapshot);
  });
  const syncMenu = () => menu.sync(selectedSession, sessions.find(s => s.value === selectedSession)?.label ?? '暂无日志', sessions.length > 0 && !busy);
  const controls = () => {
    syncMenu(); description.disabled = busy || !selectedSession;
    panel.querySelectorAll<HTMLButtonElement>('[data-action]').forEach(button => { button.disabled = busy || (button.dataset.action !== 'refresh' && !reportDocument); });
    panel.setAttribute('aria-busy', String(busy));
  };
  const showFeedback = () => { storage.hidden = !storage.textContent; result.hidden = !result.textContent; feedback.hidden = storage.hidden && result.hidden; };
  const message = (text = '', error = false) => { result.textContent = text; result.dataset.error = String(error); showFeedback(); };
  const storageStatus = () => {
    storage.textContent = sessionLog.storageState === 'failed' ? '本地保存失败，请下载报告备份。' : '';
    showFeedback();
  };
  const unsubscribe = sessionLog.subscribe(storageStatus);
  const renderReport = () => {
    if (reportDocument) textarea.value = JSON.stringify(withLogDescription(reportDocument, description.value), null, 2);
  };
  description.addEventListener('input', () => { descriptions.set(selectedSession, description.value); message(); renderReport(); });
  async function snapshot() {
    const ticket = ++snapshotGeneration, id = selectedSession;
    const doc = await exportLog(id || undefined, descriptions.get(id) ?? '');
    if (ticket === snapshotGeneration && id === selectedSession) { reportDocument = doc; renderReport(); }
    return { json: JSON.stringify(doc, null, 2), filename: `voidplayer-log-${doc.startedAt.slice(0, 10)}-${doc.sessionId.slice(0, 8)}.json` };
  }
  async function refresh() {
    const request = ++generation, selected = selectedSession;
    const history = await getLogSessions();
    if (request !== generation || (!dialog.open || pane.hidden)) return;
    sessions = history.sessions.map(s => ({ value: s.sessionId, label: `${s.current ? '本次' : '历史'} · ${new Date(s.startedAt).toLocaleString()}` }));
    selectedSession = sessions.some(s => s.value === selected) ? selected : sessions[0]?.value ?? '';
    description.value = descriptions.get(selectedSession) ?? '';
    menu.setOptions(sessions); syncMenu();
    await snapshot();
    if (history.error) message(`历史日志读取异常：${history.error}`, true);
  }
  const action = async (name: string, work: () => unknown | Promise<unknown>) => {
    if (busy) return;
    busy = true; message(); controls();
    try { await traceOperation('ui', `logs.${name}`, { sessionId: selectedSession }, work); }
    catch (error) { message(error instanceof Error ? error.message : String(error), true); }
    finally {
      busy = false;
      if (!disposed) {
        controls();
        if (refreshRequested && dialog.open && !pane.hidden) { refreshRequested = false; void action('open', refresh); }
      }
    }
  };
  controls();
  const onPaneChange = () => {
    closeHelp();
    if (dialog.open && !pane.hidden) { storageStatus(); if (busy) refreshRequested = true; else void action('open', refresh); }
    else { refreshRequested = false; ++generation; ++snapshotGeneration; }
  };
  dialog.addEventListener('settings-pane-change', onPaneChange);
  panel.querySelector('[data-action="refresh"]')!.addEventListener('click', () => void action('refresh', refresh));
  panel.querySelector('[data-action="download"]')!.addEventListener('click', () => void action('download', async () => {
    const { json, filename } = await snapshot();
    const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = filename;
    document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 10000);
    message('下载已开始。');
  }));
  panel.querySelector('[data-action="copy"]')!.addEventListener('click', () => void action('copy', async () => {
    const { json } = await snapshot();
    try { await navigator.clipboard.writeText(json); message('报告已复制。'); }
    catch (error) {
      textarea.focus(); textarea.select(); log.warn('ui', '剪贴板复制失败', { error });
      message('请复制下方已选中的报告内容。');
    }
  }));
  panel.querySelector('[data-action="upload"]')!.addEventListener('click', () => void action('upload', async () => {
    const { json } = await snapshot();
    let response: Response;
    try { response = await fetch('/api/logs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: json }); }
    catch (error) { log.warn('ui', '日志上传请求失败', { error }); throw new Error('无法连接当前服务器，请重试或下载报告。'); }
    if (!response.ok) {
      const body = await response.json().catch(() => null);
      throw new Error(`上传失败（${response.status}）${body?.error ? `：${body.error}` : '，可改用下载报告。'}`);
    }
    const body = await response.json();
    message('已上传。');
    const copyName = document.createElement('button'); copyName.textContent = '复制文件名'; copyName.title = body.name;
    copyName.onclick = () => void navigator.clipboard.writeText(body.name).then(
      () => { copyName.textContent = '已复制'; },
      () => { message(`文件名：${body.name}`); });
    result.append(' ', copyName);
  }));
  const onClose = () => { closeHelp(); refreshRequested = false; ++generation; ++snapshotGeneration; };
  dialog.addEventListener('close', onClose);
  return () => { disposed = true; ++generation; ++snapshotGeneration; menu.dispose(); unsubscribe(); help.remove(); dialog.removeEventListener('settings-pane-change', onPaneChange); dialog.removeEventListener('close', onClose); panel.remove(); };
}
