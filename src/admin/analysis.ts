import { th, t, msg } from '../i18n.ts';
import { localizedText, type LocalizedValue } from '../ui/live-localization.ts';
import { rootReason, requestError } from './diagnostics.ts';
import type {AnalysisSettings as Settings,AnalysisResources as Resources} from '../../shared/service/admin.ts';

export function analysisSettingsShell() {
  return `<form id="analysis-resources" class="admin-panel">
    <h2>${th(msg('admin.analysisResources', '分析资源'))}</h2>
    <p>${th(msg('admin.analysisResourceHelp', '设置所有用户共享的服务端分析并发数。默认 8 路，可设为 1–32 路；并发越高，CPU 和内存占用越大。保存后立即生效，调低不会中断正在运行的任务。'))}</p>
    <label for="analysis-concurrency">${th(msg('admin.analysisConcurrency', '服务端分析并发数'))}</label>
    <input id="analysis-concurrency" type="number" min="1" max="32" step="1" required disabled aria-describedby="analysis-resource-status">
    <label for="analysis-threads">${th(msg('admin.analysisThreads', '解码线程上限'))}</label>
    <input id="analysis-threads" type="number" min="1" max="4" step="1" required disabled aria-describedby="analysis-decoder-help">
    <label for="analysis-contexts">${th(msg('admin.analysisContexts', '帧上下文数'))}</label>
    <input id="analysis-contexts" type="number" min="1" max="1" step="1" required disabled aria-describedby="analysis-decoder-help">
    <p id="analysis-decoder-help" class="admin-caption">${th(msg('admin.analysisDecoderHelp', '每路服务端分析默认使用 1 个线程和 1 套帧上下文。VVC 使用两项配置，H.264 按帧上下文数并行，HEVC 暂用单线程。上下文数不得超过线程上限。提高配置会增加 CPU 和内存开销，仅对新建任务生效。'))}</p>
    <p id="analysis-resource-status" class="admin-caption" role="status"></p>
    <div class="admin-panel-footer"><span id="analysis-resource-save-state" role="status"></span><div class="admin-button-group">
      <button id="analysis-resource-reload" type="button">${th(msg('admin.analysisReload', '载入配置'))}</button>
      <button id="analysis-resource-save" type="submit" class="admin-primary" disabled>${th(msg('admin.analysisSave', '保存分析配置'))}</button>
    </div></div>
  </form>`;
}

export function installAnalysisSettings(
  signal: AbortSignal,
  api: <T>(url: string, method?: string, body?: unknown) => Promise<T>,
  notice: (value: LocalizedValue, error?: boolean) => void,
) {
  const $ = (id: string) => document.getElementById(id)!;
  const input = $('analysis-concurrency') as HTMLInputElement;
  const threads = $('analysis-threads') as HTMLInputElement;
  const contexts = $('analysis-contexts') as HTMLInputElement;
  const inputs = [input, threads, contexts];
  const decoder = () => ({ threads: threads.valueAsNumber, contexts: contexts.valueAsNumber });
  let settings: Settings | undefined, dirty = false, busy = false;
  function controls() {
    for (const field of inputs) field.disabled = busy || !settings?.writable;
    $('analysis-resource-save').toggleAttribute('disabled', busy || !dirty || !settings?.writable || inputs.some(field => !field.validity.valid));
    $('analysis-resource-reload').toggleAttribute('disabled', busy);
    localizedText($('analysis-resource-save-state'), () => busy ? t(msg('admin.saving', '正在保存…'))
      : settings?.reasonCode ? rootReason(settings.reasonCode, null)
      : dirty ? t(msg('admin.unsavedChanges', '有未保存的修改'))
      : settings ? t(msg('admin.analysisSaved', '分析配置已保存')) : '');
  }
  function update(value: Resources) {
    localizedText($('analysis-resource-status'), () => t(msg('admin.analysisResourceStatus', '当前上限 {limit} 路 · {running} 项运行中 · {queued} 项排队'), { limit: value.concurrency, running: value.running, queued: value.queued }));
  }
  function accept(value: Settings) {
    settings = value; dirty = false; input.value = String(value.concurrency);
    input.min = String(value.min); input.max = String(value.max);
    threads.max = String(value.maxThreads);
    threads.value = contexts.max = String(value.decoder.threads);
    contexts.value = String(value.decoder.contexts);
    update(value);
  }
  async function load(reset = false) {
    if (busy || (dirty && !reset)) return;
    busy = true; controls();
    try { accept(await api<Settings>('/api/admin/analysis')); }
    catch (error) { if (!signal.aborted) notice(() => requestError(error), true); }
    finally { busy = false; controls(); }
  }
  for (const field of inputs) field.addEventListener('input', () => {
    const current = decoder();
    contexts.max = threads.validity.valid ? String(current.threads) : '1';
    dirty = input.valueAsNumber !== settings?.concurrency || current.threads !== settings?.decoder.threads ||
      current.contexts !== settings?.decoder.contexts;
    controls();
  }, { signal });
  $('analysis-resource-reload').addEventListener('click', () => void load(true), { signal });
  $('analysis-resources').addEventListener('submit', event => {
    event.preventDefault();
    if (busy || !dirty || !settings?.writable || inputs.some(field => !field.reportValidity())) return;
    busy = true; controls();
    void api<Settings>('/api/admin/analysis', 'PUT', { revision: settings.revision, concurrency: input.valueAsNumber, decoder: decoder() })
      .then(accept).catch(error => { if (!signal.aborted) notice(() => requestError(error), true); })
      .finally(() => { busy = false; controls(); });
  }, { signal });
  return { load, update, get dirty() { return dirty; } };
}
