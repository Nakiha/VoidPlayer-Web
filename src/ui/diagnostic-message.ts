import type { MediaDiagnostic } from '../media-errors.ts';
import { msg, t } from '../i18n.ts';
/** Translate actionable errors at the UI edge, and retain original stage/reason. */
export function diagnosticMessage(raw: string, diagnostic?: MediaDiagnostic) {
  if(!diagnostic)return raw;
  const summary = diagnostic.code === 'reference-hdr-unsupported'
    ? t(msg('error.referenceHdr', '自有色彩目前仅支持 SDR。请切换为浏览器色彩后重试。'))
    : t(msg('error.referenceFormat', '自有色彩不支持此像素格式或颜色信息。请切换为浏览器色彩后重试。'));
  return t(msg('error.diagnostic', '{summary}\n[{code} / {stage}] {reason}'), {summary,code:diagnostic.code,stage:diagnostic.stage,reason:raw});
}
