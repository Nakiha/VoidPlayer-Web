import { formatRecentDate, formatNumber, msg, t, th } from '../i18n.ts';
import { localizedText, localizedAttribute } from '../ui/live-localization.ts';
import { confirmedActor } from '../services/identity.ts';
import type { AdminStatus } from '../../shared/service/admin.ts';

export type OverviewStatus = AdminStatus & {
  identity: { id: string; name: string };
  http: { activeRequests: number; connections: number; completedRequests: number; abortedRequests: number };
};

function trendCard(id: 'cpu' | 'memory', label: string) {
  return `<div class="overview-trend"><span>${label}</span><strong id="${id}">—</strong>
    <svg viewBox="0 0 240 36" preserveAspectRatio="none" aria-hidden="true">
      <line x1="1" x2="239" y1="18" y2="18"/><line x1="1" x2="239" y1="34" y2="34"/>
      <path id="${id}-trend"/></svg>
    <small id="${id}-scale">—</small></div>`;
}

export function overviewShell() {
  return `<section id="pane-overview">
    <header class="admin-heading"><h1>${th(msg('admin.overviewTitle', '概览'))}</h1><small id="overview-updated">${th(msg('admin.reading', '正在读取…'))}</small></header>
    <div class="admin-section-title"><h2>${th(msg('admin.processLoad', '进程负载'))}</h2><small>${th(msg('admin.recentMinute', '最近 60 秒'))}</small></div>
    <div class="admin-metrics overview-load">${trendCard('cpu', th(msg('admin.procCpu', '进程 CPU')))}${trendCard('memory', th(msg('admin.procMemory', '进程内存')))}</div>
    <div class="overview-strip"><span>${th(msg('admin.uptime', '已运行'))}<b id="uptime">—</b></span><span>${th(msg('admin.connections', '连接数'))}<b id="connections">—</b></span></div>
    <dl class="admin-properties"><div><dt>${th(msg('admin.systemMemory', '系统可用内存'))}</dt><dd><span id="system-memory">—</span><meter id="system-free-meter" min="0" max="1" aria-label="${th(msg('admin.systemMemory', '系统可用内存'))}" hidden></meter></dd></div>
      <div><dt>${th(msg('admin.httpRequests', 'HTTP 请求'))}</dt><dd id="requests">—</dd></div></dl>
    <h2>${th(msg('admin.indexTitle', '媒体索引'))}</h2>
    <dl class="admin-properties"><div><dt>${th(msg('admin.scanJobs', '扫描任务'))}</dt><dd id="scan-summary">—</dd></div><div><dt>${th(msg('admin.rootDirs', '根目录'))}</dt><dd id="root-summary">—</dd></div>
      <div><dt>${th(msg('admin.watchDirs', '目录监听'))}</dt><dd id="watch-summary">—</dd></div><div><dt>${th(msg('admin.analysisTasks', '分析任务'))}</dt><dd id="analysis-summary">—</dd></div></dl>
    <h2>${th(msg('admin.serviceTitle', '服务'))}</h2><dl class="admin-properties"><div><dt>${th(msg('admin.version', '版本'))}</dt><dd id="version">—</dd></div><div><dt>${th(msg('admin.runtime', '运行环境'))}</dt><dd id="runtime">—</dd></div>
      <div><dt>${th(msg('admin.dataDir', '数据目录'))}</dt><dd id="data-dir">—</dd></div><div><dt>${th(msg('admin.currentIdentity', '当前身份'))}</dt><dd id="identity">—</dd></div></dl>
  </section>`;
}

const windowMs = 60_000;
type Sample = { at: number; cpu: number; memory: number; uptime: number; segment: number };

export function installOverview(signal: AbortSignal, read: (signal: AbortSignal) => Promise<OverviewStatus>,
  render: (status: OverviewStatus) => void, report: (error: unknown) => void) {
  const pane = document.getElementById('pane-overview')!;
  const updated = document.getElementById('overview-updated')!;
  const samples: Sample[] = [];
  let request: AbortController | undefined;
  let segment = 0;
  function stop() {
    segment++;
    request?.abort();
    request = undefined;
  }
  function reset() {
    stop();
    samples.length = 0;
    for (const el of pane.querySelectorAll<HTMLElement>('dd[id], b[id], strong[id], #system-memory, small[id$="-scale"]')) localizedText(el, '—');
    localizedAttribute(document.getElementById('identity')!, 'data-tooltip', () => '');
    document.getElementById('system-free-meter')!.hidden = true;
    for (const path of pane.querySelectorAll('svg path')) path.removeAttribute('d');
    localizedText(updated, () => t(msg('admin.reading', '正在读取…')));
  }
  function plot(key: 'cpu' | 'memory', now: number) {
    const peak = Math.max(...samples.map(sample => sample[key]));
    const top = 2 ** Math.ceil(Math.log2(Math.max(key === 'cpu' ? 1 : 2 ** 20, peak)));
    let path = '';
    for (let i = 0; i < samples.length; i++) {
      const s = samples[i], previous = samples[i - 1];
      const x = 239 - (now - s.at) / windowMs * 238, y = 34 - (s[key] / top) * 32;
      const start = !previous || previous.segment !== s.segment || s.at - previous.at > 6500;
      path += `${start ? 'M' : 'L'}${x.toFixed(2)} ${y.toFixed(2)}`;
    }
    document.getElementById(key + '-trend')!.setAttribute('d', path);
    localizedText(document.getElementById(key + '-scale')!, () => key === 'cpu' ? `0–${formatNumber(top)}%` : `0–${formatNumber(top / 2 ** 20)} MiB`);
  }
  async function refresh() {
    const actor = confirmedActor()?.id;
    if (signal.aborted || pane.hidden || document.hidden || !actor || request) return;
    const controller = request = new AbortController();
    try {
      const status = await read(controller.signal);
      if (controller.signal.aborted || pane.hidden || document.hidden || actor !== confirmedActor()?.id || actor !== status.identity.id) return;
      const now = performance.now();
      if (samples.length && status.uptimeSeconds < samples[samples.length - 1].uptime) samples.length = 0;
      while (samples.length && samples[0].at < now - windowMs) samples.shift();
      samples.push({ at: now, cpu: status.cpuPercent, memory: status.memory.rss, uptime: status.uptimeSeconds, segment });
      render(status);
      plot('cpu', now);
      plot('memory', now);
      const received = Date.now();
      localizedText(updated, () => t(msg('admin.overviewUpdated', '更新于 {time}'), { time: formatRecentDate(received) }));
    } catch (error) {
      if (!controller.signal.aborted) report(error);
    } finally { if (request === controller) request = undefined; }
  }
  signal.addEventListener('abort', stop, { once: true });
  return { refresh, stop, reset };
}
