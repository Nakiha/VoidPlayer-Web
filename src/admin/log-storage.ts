import type { LogStorageOverview } from '../../shared/service/logging.ts';
import { t, th, msg } from '../i18n.ts';
import { localizedText } from '../ui/live-localization.ts';
import { icon } from '../ui/icons.ts';

const kinds = ['reports', 'runtime'] as const;
export function logStorageShell() {
  return `<section class="admin-log-retention" aria-labelledby="log-storage-title">
    <h2 id="log-storage-title">${th(msg('admin.logStoragePolicy', '日志存储与保留策略'))}</h2>
    <div id="log-storage">${kinds.map(kind => {
      const reports = kind === 'reports';
      return `<article class="admin-log-storage-card" data-log-store="${kind}">
        <h3>${icon(reports ? 'fileText' : 'diagnostics')}${reports ? th(msg('admin.uploadedReports', '上传报告')) : th(msg('admin.runtimeLogs', '运行日志'))}</h3>
        <div class="admin-storage-usage"><strong data-used>—</strong><span data-limit></span></div>
        <progress data-bytes class="admin-storage-meter" aria-label="${th(msg('admin.storageUsage', '存储占用'))}"></progress>
        ${reports ? `<div class="admin-report-count"><span>${th(msg('admin.reportCount', '报告数量'))}</span><span data-count>—</span>
          <progress data-files class="admin-storage-meter" aria-label="${th(msg('admin.reportCount', '报告数量'))}"></progress></div>` : ''}
        <div class="admin-storage-policy"><span data-retention></span><span data-policy></span>${reports ? '' : '<span data-dropped></span>'}</div>
        <p data-error class="admin-storage-error" role="status" hidden></p>
      </article>`;
    }).join('')}</div></section>`;
}

export function renderLogStorage(host: HTMLElement, storage: LogStorageOverview | undefined, bytes: (value: number) => string) {
  host.closest<HTMLElement>('section')!.hidden = !storage;
  if (!storage) return;
  for (const kind of kinds) {
    const card = host.querySelector<HTMLElement>(`[data-log-store="${kind}"]`)!;
    const value = storage[kind];
    card.hidden = !value;
    if (!value) continue;
    const field = <T extends HTMLElement = HTMLElement>(name: string) => card.querySelector<T>(`[data-${name}]`)!;
    const meter = (name: string, used: number, limit: number) => {
      const bar = field<HTMLProgressElement>(name);
      bar.max = Math.max(1, limit); bar.value = Math.min(used, bar.max);
    };
    localizedText(field('used'), () => bytes(value.bytes));
    localizedText(field('limit'), () => t(msg('admin.storageLimit', '上限 {size}'), { size: bytes(value.maxBytes) }));
    meter('bytes', value.bytes, value.maxBytes);
    localizedText(field('retention'), () => value.days
      ? t(msg('admin.logRetentionDays', '{days} 天后自动删除'), { days: value.days }) : t(msg('admin.logRetentionManual', '保留到手动删除')));
    if (kind === 'reports') {
      field('count').parentElement!.hidden = value.maxFiles === undefined;
      if (value.maxFiles !== undefined) {
        localizedText(field('count'), () => t(msg('admin.reportQuota', '{count} / {max} 份'), { count: value.files, max: value.maxFiles! }));
        meter('files', value.files, value.maxFiles);
      }
      localizedText(field('policy'), () => t(msg('admin.logRejectFull', '满额拒收')));
    } else {
      localizedText(field('policy'), () => t(msg('admin.logSegments', '按 {size} 或每天切段压缩'), { size: bytes(value.segmentBytes ?? 0) }));
      localizedText(field('dropped'), () => t(msg('admin.logDropped', '丢弃 {count} 条'), { count: value.dropped ?? 0 }));
    }
    field('error').hidden = !value.error;
    field('error').textContent = value.error ?? '';
  }
}
