import { installChoiceMenu } from './ui/choice-menu.ts';
import { icon } from './ui/icons.ts';
import { exportLog, getLogSessions, log, sessionLog, traceOperation } from './log.ts';

export function installLogPanel(container: HTMLElement) {
  const dialog = document.getElementById('settings') as HTMLDialogElement;
  const pane = document.getElementById('settings-pane-logs')!;
  const panel = document.createElement('div'); panel.className = 'log-panel';
  panel.innerHTML = `<div class="log-session-row"><label for="log-session">会话</label><button type="button" id="log-session" class="settings-choice" aria-label="日志会话"></button><button class="icon-button" data-action="refresh" aria-label="更新日志" data-tooltip="更新日志">${icon('refresh')}</button></div>
    <div class="log-summary"><span class="log-storage" role="status"></span><span class="log-result" role="status"></span></div>
    <div class="log-actions"><button data-action="download">${icon('download')}下载日志</button><button data-action="copy">${icon('copy')}复制日志</button><button data-action="upload">${icon('export')}上传日志</button></div>
    <p class="settings-caption">本地保留 3 次会话，最长 7 天；包含文件名与操作，不含视频或备注正文。点击「上传日志」才发送到当前服务器。</p>
    <textarea class="log-json" aria-label="日志内容" readonly spellcheck="false" wrap="off"></textarea>`;
  container.append(panel);
  let selectedSession = '';
  let sessions: { value: string; label: string }[] = [];
  const menu = installChoiceMenu('log-session', [], value => {
    selectedSession = value; syncMenu(); void action('select', snapshot);
  });
  const syncMenu = () => menu.sync(selectedSession, sessions.find(s => s.value === selectedSession)?.label ?? '暂无日志', sessions.length > 0);
  syncMenu();
  const textarea = panel.querySelector('textarea')!;
  const result = panel.querySelector<HTMLElement>('.log-result')!;
  let filename = 'voidplayer-log.json', generation = 0;
  const storageStatus = () => {
    panel.querySelector('.log-storage')!.textContent = ({ memory: '仅存于内存', pending: '正在保存…', saved: '已保存在本机', failed: '本地保存失败，日志暂留内存，请及时导出。' })[sessionLog.storageState] + (sessionLog.storageError ? ` ${sessionLog.storageError}` : '');
  };
  const unsubscribe = sessionLog.subscribe(storageStatus);
  async function snapshot() {
    const doc = await exportLog(selectedSession || undefined);
    textarea.value = JSON.stringify(doc, null, 2);
    filename = `voidplayer-log-${doc.startedAt.slice(0, 10)}-${doc.sessionId.slice(0, 8)}.json`;
    result.textContent = `${doc.events.length} 条记录${doc.droppedEvents ? `，较早的 ${doc.droppedEvents} 条已超出保留上限` : ''}。`;
  }
  async function refresh() {
    const request = ++generation, selected = selectedSession;
    const history = await getLogSessions();
    if (request !== generation || (!dialog.open || pane.hidden)) return;
    sessions = history.sessions.map(s => ({ value: s.sessionId, label: `${s.current ? '本次' : '历史'} · ${new Date(s.startedAt).toLocaleString()} · ${s.events} 条` }));
    selectedSession = sessions.some(s => s.value === selected) ? selected : sessions[0]?.value ?? '';
    menu.setOptions(sessions); syncMenu();
    await snapshot();
    if (history.error) result.textContent += ` 历史日志读取或保存异常：${history.error}`;
  }
  const action = async (name: string, work: () => unknown | Promise<unknown>) => {
    try { await traceOperation('ui', `logs.${name}`, { sessionId: selectedSession }, work); }
    catch (error) { result.textContent = error instanceof Error ? error.message : String(error); }
  };
  const onPaneChange = () => { if (dialog.open && !pane.hidden) { storageStatus(); void action('open', refresh); } else ++generation; };
  dialog.addEventListener('settings-pane-change', onPaneChange);
  panel.querySelector('[data-action="refresh"]')!.addEventListener('click', () => void action('refresh', refresh));
  panel.querySelector('[data-action="download"]')!.addEventListener('click', () => void action('download', async () => {
    await snapshot();
    const url = URL.createObjectURL(new Blob([textarea.value], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = filename;
    document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 10000);
    result.textContent = '下载已开始。';
  }));
  panel.querySelector('[data-action="copy"]')!.addEventListener('click', () => void action('copy', async () => {
    await snapshot();
    try { await navigator.clipboard.writeText(textarea.value); result.textContent = '日志已复制。'; }
    catch (error) {
      textarea.focus(); textarea.select();
      log.warn('ui', '剪贴板复制失败', { error });
      result.textContent = '浏览器未允许自动复制，请复制下方已选中的内容。';
    }
  }));
  panel.querySelector('[data-action="upload"]')!.addEventListener('click', () => void action('upload', async () => {
    await snapshot();
    let response: Response;
    try {
      response = await fetch('/api/logs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: textarea.value });
    } catch (error) {
      // fetch itself failed (e.g. Safari "Load failed") = the server is unreachable.
      throw new Error(`连不上当前页面的服务端，上传未发出（${error instanceof Error ? error.message : error}）。日志仍只保存在此浏览器；请先确认本地服务在运行，或改用下载/复制。`);
    }
    if (!response.ok) {
      const body = await response.json().catch(() => null);
      throw new Error(`上传失败（${response.status}）${body?.error ? `：${body.error}` : '。服务端未开启日志接收或未连接。'}`);
    }
    const body = await response.json();
    result.replaceChildren();
    result.append(`已上传到服务器：${body.name} `);
    const copyName = document.createElement('button');
    copyName.textContent = '复制文件名';
    copyName.onclick = () => void navigator.clipboard.writeText(body.name).then(
      () => { copyName.textContent = '已复制'; },
      () => { copyName.textContent = body.name; copyName.title = '浏览器未允许复制，请手动复制此文件名'; });
    result.append(copyName);
  }));
  const onClose = () => { ++generation; };
  dialog.addEventListener('close', onClose);
  return () => { menu.dispose(); unsubscribe(); dialog.removeEventListener('settings-pane-change', onPaneChange); dialog.removeEventListener('close', onClose); panel.remove(); };
}
