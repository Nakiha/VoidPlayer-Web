import { th, t, msg } from '../i18n.ts';
import { localizedText, type LocalizedValue } from '../ui/live-localization.ts';
import { rootReason, requestError } from './diagnostics.ts';
import type { AdminController } from '../../server/admin.ts';

type Settings = Awaited<ReturnType<AdminController['analysisSettings']>>;
type Resources = ReturnType<AdminController['analysis']['resources']>;
export function analysisSettingsShell() {
  return `<form id="analysis-resources" class="admin-panel">
    <h2>${th(msg('admin.analysisResources', '分析资源'))}</h2>
    <p>${th(msg('admin.analysisResourceHelp', '设置所有用户共享的服务端分析并发数。默认 4 路，可设为 1–32 路；并发越高，CPU 和内存占用越大。保存后立即生效，调低不会中断正在运行的任务。'))}</p>
    <label for="analysis-concurrency">${th(msg('admin.analysisConcurrency', '服务端分析并发数'))}</label>
    <input id="analysis-concurrency" type="number" min="1" max="32" step="1" required disabled aria-describedby="analysis-resource-status">
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
  let settings: Settings | undefined, dirty = false, busy = false;
  function controls() {
    input.disabled = busy || !settings?.writable;
    $('analysis-resource-save').toggleAttribute('disabled', busy || !dirty || !settings?.writable || !input.validity.valid);
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
    input.min = String(value.min); input.max = String(value.max); update(value);
  }
  async function load(reset = false) {
    if (busy || (dirty && !reset)) return;
    busy = true; controls();
    try { accept(await api<Settings>('/api/admin/analysis')); }
    catch (error) { if (!signal.aborted) notice(() => requestError(error), true); }
    finally { busy = false; controls(); }
  }
  input.addEventListener('input', () => { dirty = input.valueAsNumber !== settings?.concurrency; controls(); }, { signal });
  $('analysis-resource-reload').addEventListener('click', () => void load(true), { signal });
  $('analysis-resources').addEventListener('submit', event => {
    event.preventDefault();
    if (busy || !dirty || !settings?.writable || !input.reportValidity()) return;
    busy = true; controls();
    void api<Settings>('/api/admin/analysis', 'PUT', { revision: settings.revision, concurrency: input.valueAsNumber })
      .then(accept).catch(error => { if (!signal.aborted) notice(() => requestError(error), true); })
      .finally(() => { busy = false; controls(); });
  }, { signal });
  return { load, update, get dirty() { return dirty; } };
}
