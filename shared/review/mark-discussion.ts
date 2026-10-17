import type { MarkReply } from './model.ts';

export function discussionValue(value: { resolved?: unknown; replies?: unknown }) {
  if (value.resolved !== undefined && typeof value.resolved !== 'boolean') throw new Error('批注状态无效。');
  const result: { resolved?: boolean; replies?: MarkReply[] } = {};
  if (value.resolved !== undefined) result.resolved = value.resolved as boolean;
  if (value.replies !== undefined) {
    if (!Array.isArray(value.replies) || value.replies.length > 200) throw new Error('每条批注最多保存 200 条回复。');
    const text = (v: unknown, max: number) => { if (typeof v !== 'string' || !v.trim() || v.length > max) throw new Error('回复内容无效。'); return v; };
    result.replies = value.replies.map(v => ({ id: text(v?.id, 200), text: text(v?.text, 2000), createdAt: text(v?.createdAt, 100), author: { id: text(v?.author?.id, 200), name: text(v?.author?.name, 200) } }));
    if (new Set(result.replies.map(r => r.id)).size !== result.replies.length) throw new Error('回复 ID 重复。');
  }
  return result;
}
