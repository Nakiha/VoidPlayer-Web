import { t, msg } from "../i18n.ts";
import type { AnalysisReasonCode } from "../bitstream-analysis/failure.ts";
export function bitstreamReasonText(code: AnalysisReasonCode): string {
  switch (code) {
    case "unsupported-container":
      return t(
        msg(
          "bitstream.unsupportedContainer",
          "此封装暂不支持分析；首批仅支持普通 MP4。",
        ),
      );
    case "unsupported-codec":
      return t(msg("bitstream.unsupportedCodec", "此编码暂不支持码流分析。"));
    case "unsupported-picture-layout":
      return t(
        msg(
          "bitstream.unsupportedLayout",
          "此画面布局或编码工具暂不支持精确遮罩。",
        ),
      );
    case "no-safe-anchor-within-budget":
      return t(
        msg("bitstream.noSafeAnchor", "预滚预算内没有可验证的闭合 IDR 起点。"),
      );
    case "unsupported-qp-depth":
      return t(
        msg(
          "bitstream.unsupportedQpDepth",
          "此位深的 QP 暂不支持，块和模式仍可查看。",
        ),
      );
    case "incomplete-reference-state":
      return t(
        msg(
          "bitstream.incompleteReferences",
          "参考状态不完整，无法生成精确遮罩。",
        ),
      );
    case "ambiguous-picture-identity":
      return t(
        msg(
          "bitstream.ambiguousIdentity",
          "无法唯一确定源画面，已隐藏精确遮罩。",
        ),
      );
    case "resource-limit":
      return t(
        msg(
          "bitstream.resourceLimit",
          "分析达到资源上限，请缩短区间或选择更近的起点。",
        ),
      );
    case "source-changed":
      return t(
        msg("bitstream.sourceChanged", "片源已变更，请重新载入后分析。"),
      );
    case "invalid-request":
      return t(msg("bitstream.invalidRequest", "分析目标或区间无效。"));
    case "cancelled":
      return t(msg("bitstream.cancelled", "分析已取消。"));
    case "internal-error":
      return t(msg("bitstream.internalError", "分析执行出错，请重试。"));
  }
}
