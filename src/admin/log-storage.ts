import type { LogStorageOverview } from '../../shared/service/logging.ts';
import { t, msg } from '../i18n.ts';
import { localizedText, type LocalizedValue } from '../ui/live-localization.ts';

export function renderLogStorage(host: HTMLElement, storage: LogStorageOverview | undefined, bytes: (value: number) => string) {
  host.replaceChildren();
  host.hidden = !storage;
  if (!storage) return;
  const text = (tag: string, value: LocalizedValue) => {
    const node = document.createElement(tag);
    localizedText(node, value);
    return node;
  };
  for (const kind of ['reports', 'runtime'] as const) {
    const value = storage[kind];
    if (!value) continue;
    const card = document.createElement('section'); card.className = 'admin-log-storage-card';
    const title = () => kind === 'reports' ? t(msg('admin.uploadedReports', '上传报告')) : t(msg('admin.runtimeLogs', '运行日志'));
    card.append(text('h2', title));
    const meter = (key: string, label: LocalizedValue, used: number, limit: number, caption: LocalizedValue) => {
      const heading = document.createElement('div'); heading.className = 'admin-storage-heading';
      const name = text('span', label); name.id = `log-${kind}-${key}`;
      heading.append(name, text('span', caption));
      const progress = document.createElement('progress'); progress.className = 'admin-storage-meter';
      progress.max = Math.max(1, limit); progress.value = Math.max(0, Math.min(used, progress.max));
      progress.setAttribute('aria-labelledby', name.id);
      card.append(heading, progress);
    };
    meter('bytes', () => t(msg('admin.storageUsage', '存储占用')), value.bytes, value.maxBytes,
      () => `${bytes(value.bytes)} / ${bytes(value.maxBytes)}`);
    if (kind === 'reports' && value.maxFiles !== undefined) {
      meter('files', () => t(msg('admin.reportCount', '报告数量')), value.files, value.maxFiles,
        () => t(msg('admin.reportQuota', '{count} / {max} 份'), { count: value.files, max: value.maxFiles! }));
    }
    const policy = document.createElement('div'); policy.className = 'admin-storage-policy';
    policy.append(text('span', () => value.days
      ? t(msg('admin.logRetentionDays', '{days} 天后自动删除'), { days: value.days })
      : t(msg('admin.logRetentionManual', '保留到手动删除'))));
    if (kind === 'reports') policy.append(text('span', () => t(msg('admin.logRejectFull', '满额拒收'))));
    else {
      policy.append(text('span', () => t(msg('admin.logSegments', '按 {size} 或每天切段压缩'), { size: bytes(value.segmentBytes ?? 0) })));
      policy.append(text('span', () => t(msg('admin.logDropped', '丢弃 {count} 条'), { count: value.dropped ?? 0 })));
    }
    card.append(policy);
    if (value.error) { const error = text('p', () => value.error!); error.className = 'admin-storage-error'; error.setAttribute('role', 'status'); card.append(error); }
    host.append(card);
  }
}
