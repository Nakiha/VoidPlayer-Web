import { icon } from './ui/icons.ts';
import { exportLog, getLogSessions, log, sessionLog, traceOperation } from './log.ts';

export function installLogPanel(container: HTMLElement) {
  const dialog = document.getElementById('settings') as HTMLDialogElement;
  const pane = document.getElementById('settings-pane-logs')!;
  const panel = document.createElement('div'); panel.className = 'log-panel';
  panel.innerHTML = `<div class="log-session-row"><label for="log-session">会话</label><select id="log-session" aria-label="日志会话"></select><button class="icon-button" data-action="refresh" aria-label="更新日志" data-tooltip="更新日志">${icon('refresh')}</button></div>
    <div class="log-summary"><span class="log-storage" role="status"></span><span class="log-result" role="status"></span></div>
    <div class="log-actions"><button data-action="download">${icon('download')}下载日志</button><button data-action="copy">${icon('copy')}复制日志</button><button data-action="upload">${icon('export')}上传日志</button></div>
    <p class="settings-caption">日志仅保存在此浏览器，保留最近 3 次会话、最长 7 天。包含文件名与操作，不包含视频或备注正文。仅点击「上传日志」时发送给当前页面的媒体服务。</p>
    <textarea class="log-json" aria-label="日志内容" readonly spellcheck="false" wrap="off"></textarea>`;
  container.append(panel);
  const select = panel.querySelector('select')!;
  const textarea = panel.querySelector('textarea')!;
  const result = panel.querySelector<HTMLElement>('.log-result')!;
  let filename = 'voidplayer-log.json', generation = 0;
  const storageStatus = () => {
    panel.querySelector('.log-storage')!.textContent = ({ memory: '当前仅保存在内存中。', pending: '正在保存到此浏览器…', saved: '已保存到此浏览器。', failed: '本地保存失败，日志暂留内存，请及时导出。' })[sessionLog.storageState] + (sessionLog.storageError ? ` ${sessionLog.storageError}` : '');
  };
  const unsubscribe = sessionLog.subscribe(storageStatus);
  async function snapshot() {
    const doc = await exportLog(select.value || undefined);
    textarea.value = JSON.stringify(doc, null, 2);
    filename = `voidplayer-log-${doc.startedAt.slice(0, 10)}-${doc.sessionId.slice(0, 8)}.json`;
    result.textContent = `${doc.events.length} 条记录${doc.droppedEvents ? `，较早的 ${doc.droppedEvents} 条已超出保留上限` : ''}。`;
  }
  async function refresh() {
    const request = ++generation, selected = select.value;
    const history = await getLogSessions();
    if (request !== generation || (!dialog.open || pane.hidden)) return;
    select.replaceChildren(...history.sessions.map(s => {
      const option = document.createElement('option'); option.value = s.sessionId;
      option.textContent = `${s.current ? '本次' : '历史'} · ${new Date(s.startedAt).toLocaleString()} · ${s.events} 条`;
      return option;
    }));
    if (history.sessions.some(s => s.sessionId === selected)) select.value = selected;
    await snapshot();
    if (history.error) result.textContent += ` 历史日志读取或保存异常：${history.error}`;
  }
  const action = async (name: string, work: () => unknown | Promise<unknown>) => {
    try { await traceOperation('ui', `logs.${name}`, { sessionId: select.value }, work); }
    catch (error) { result.textContent = error instanceof Error ? error.message : String(error); }
  };
  const onPaneChange = () => { if (dialog.open && !pane.hidden) { storageStatus(); void action('open', refresh); } else ++generation; };
  dialog.addEventListener('settings-pane-change', onPaneChange);
  select.onchange = () => void action('select', snapshot);
  panel.querySelector('[data-action="refresh"]')!.addEventListener('click', () => void action('refresh', refresh));
  panel.querySelector('[data-action="download"]')!.addEventListener('click', () => void action('download', async () => {
    await snapshot();
    const url = URL.createObjectURL(new Blob([textarea.value], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = filename;
    document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 10000);
    result.textContent = '已请求浏览器下载；若未出现文件，可以复制日志。';
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
  return () => { unsubscribe(); dialog.removeEventListener('settings-pane-change', onPaneChange); dialog.removeEventListener('close', onClose); panel.remove(); };
}
