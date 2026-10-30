import { msg, th } from '../i18n.ts';

/** Human labels keep the existing API field names out of the normal form. */
export function qualityFieldLabel(id: string) {
  const labels: Record<string, string> = {
    maxRawBytes: th(msg('qualityFields.raw', '累计输入像素预算（字节）')),
    maxElapsedMs: th(msg('qualityFields.elapsed', '总运行时限（毫秒）')),
    nativeCpuSeconds: th(msg('qualityFields.scoringTime', '评分时限（秒）')),
    nativeMemoryBytes: th(msg('qualityFields.memory', '分析内存上限（字节）')),
    maxScore: th(msg('qualityFields.threshold', '候选分数上限')),
    limit: th(msg('qualityFields.limit', '最多候选数')),
    minFrameDistance: th(msg('qualityFields.spacing', '候选最小间隔（帧）')),
    severity: th(msg('qualityFields.severity', '严重程度（1–5）')),
  };
  return labels[id] ?? id;
}
