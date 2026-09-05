import { exportLog, getLogSessions, log, sessionLog, traceOperation } from './log.ts';

export function installLogPanel(openButton: HTMLElement) {
  const dialog = document.createElement('dialog'); dialog.className = 'log-panel';
  dialog.innerHTML = `<h2>问题日志</h2><p>仅保存在此浏览器，最近 3 次会话、最长 7 天。记录文件名与操作，不包含视频内容或备注正文。</p><label>会话 <select aria-label="日志会话"></select></label><p class="log-storage" role="status"></p><p class="log-result" role="status"></p><div class="log-actions"><button data-action="refresh">更新</button><button data-action="download">下载日志</button><button data-action="copy">复制日志</button><button data-action="close">关闭</button></div><details><summary>查看内容</summary><textarea aria-label="日志内容" readonly rows="10"></textarea></details>`;
  document.body.append(dialog);
  const select = dialog.querySelector('select')!;
  const textarea = dialog.querySelector('textarea')!;
  const result = dialog.querySelector<HTMLElement>('.log-result')!;
  let filename = 'voidplayer-log.json', generation = 0;
  const storageStatus = () => {
    dialog.querySelector('.log-storage')!.textContent = ({ memory: '当前仅保存在内存中。', pending: '正在保存到此浏览器…', saved: '已保存到此浏览器。', failed: '本地保存失败，日志暂留内存，请及时导出。' })[sessionLog.storageState] + (sessionLog.storageError ? ` ${sessionLog.storageError}` : '');
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
    if (request !== generation || !dialog.open) return;
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
  openButton.onclick = () => { dialog.showModal(); storageStatus(); void action('open', refresh); };
  select.onchange = () => void action('select', snapshot);
  dialog.querySelector('[data-action="refresh"]')!.addEventListener('click', () => void action('refresh', refresh));
  dialog.querySelector('[data-action="download"]')!.addEventListener('click', () => void action('download', async () => {
    await snapshot();
    const url = URL.createObjectURL(new Blob([textarea.value], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = filename;
    document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 10000);
    result.textContent = '已请求浏览器下载；若未出现文件，可以复制日志。';
  }));
  dialog.querySelector('[data-action="copy"]')!.addEventListener('click', () => void action('copy', async () => {
    await snapshot();
    try { await navigator.clipboard.writeText(textarea.value); result.textContent = '日志已复制。'; }
    catch (error) {
      dialog.querySelector('details')!.open = true; textarea.focus(); textarea.select();
      log.warn('ui', '剪贴板复制失败', { error });
      result.textContent = '浏览器未允许自动复制，请复制下方已选中的内容。';
    }
  }));
  dialog.querySelector('[data-action="close"]')!.addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => { ++generation; log.info('ui', '关闭日志窗口'); });
  return () => { unsubscribe(); openButton.onclick = null; dialog.remove(); };
}
