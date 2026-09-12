import type { LogDocument } from './log.ts';
export const LOG_PREVIEW_PAGE_SIZE = 25;
export const LOG_PREVIEW_CHAR_LIMIT = 24000;
export function logPreview(document: LogDocument, page: number) {
  const pages = Math.max(1, Math.ceil(document.events.length / LOG_PREVIEW_PAGE_SIZE));
  page = Math.max(0, Math.min(pages - 1, page));
  const start = page * LOG_PREVIEW_PAGE_SIZE;
  const text = document.events.slice(start, start + LOG_PREVIEW_PAGE_SIZE).map(event => {
    const line = JSON.stringify(event);
    return line.length > 850 ? line.slice(0, 850) + ' …（完整内容见下载日志）' : line;
  }).join('\n').slice(0, LOG_PREVIEW_CHAR_LIMIT);
  return { page, pages, text, label: `第 ${page + 1}/${pages} 页 · 共 ${document.events.length} 条事件` };
}
