import { installTemporalQuality } from "./quality-temporal.ts";
import { qualityFieldLabel } from "./quality-fields.ts";
import { clockToUs } from "../../shared/media/indexing/rational-clock.ts";
import {
  xpsnrComparisonShell,
  installXpsnrComparison,
} from "./quality-xpsnr-comparison.ts";
import { th, msg } from "../i18n.ts";
import {
  xpsnrInput,
  XPSNR_LIMITS,
  XPSNR_RECIPE,
} from "../../shared/analysis/quality/xpsnr.ts";
import type { XpsnrDb } from "../../shared/analysis/quality/xpsnr.ts";

/** This panel observes the same durable commands as HTTP agents. It never scores
 * browser pixels, controls playback or guesses alignment. Technical recipe names
 * stay literal so a copied recipe has exactly the same meaning in either client. */
export function qualityXpsnrShell() {
  const number = (id: string, value: number, min = 1) =>
    `<label>${qualityFieldLabel(id)}<input id="xpsnr-${id}" type="number" step="1" min="${min}" value="${value}" required></label>`;
  return `<section id="quality-xpsnr" class="admin-panel"><h2>${th(msg("xpsnr.title", "XPSNR · 连续片段评分"))}</h2>
 <p>${th(msg("xpsnr.sources", "支持已有可信 FLV/Enhanced FLV 和严格非分片 MP4，可混合比较。MP4 支持 avc1 H.264 8 位、hvc1 HEVC 8/10 位，使用原始有理数时钟精确对齐。"))}</p>
 <p>${th(msg("xpsnr.scope", "支持 2–1024 个连续呈现帧，可按计划中的固定区域重算。参考输入在前，保留时域权重和官方逐平面池化；整帧或区域分数不是热图或人工缺陷判断。具体格式、色彩和预算限制见支持范围。"))}</p>
 <details class="quality-advanced"><summary>${th(msg("qualityWorkspace.capability", "执行器与支持范围"))}</summary><pre id="xpsnr-capability"></pre></details><p>${th(msg("qualityWorkspace.planHelp", "先在“参考关系”中选择已完成的计划，再将它带入评分。下方保留计划凭据，便于核对或接续已有任务。"))}</p><button type="button" data-quality-open="correspondence">${th(msg("qualityWorkspace.choosePlan", "选择参考关系与对应计划"))}</button><form id="xpsnr-form"><fieldset id="xpsnr-inputs"><legend>${th(msg("xpsnr.recipe", "片段与评分设置"))}</legend>
 <details class="quality-advanced"><summary>${th(msg("qualityWorkspace.clientSettings", "客户端与请求设置"))}</summary><label>client<input id="xpsnr-client" maxlength="80" required></label></details><div class="quality-roi"><label>${th(msg("qualityFields.plan", "对应计划"))}<input id="xpsnr-plan" required></label><label>${th(msg("qualityFields.attempt", "计划执行编号"))}<input id="xpsnr-attempt" required></label><label>${th(msg("qualityFields.digest", "计划摘要（SHA256）"))}<input id="xpsnr-digest" required></label></div>
 <div class="quality-roi"><label>${th(msg("qualityFields.frameRate", "帧率（如 30000/1001）"))}<input id="xpsnr-frame-rate" value="4/1"></label><label><input id="xpsnr-ssim" type="checkbox">${th(msg("qualityFields.ssim", "同时计算 SSIM"))}</label></div>
 <details><summary>${th(msg("xpsnr.budgets", "执行预算"))}</summary><div class="quality-roi">${number("maxRawBytes", XPSNR_LIMITS.maxRawBytes)}${number("maxElapsedMs", XPSNR_LIMITS.maxElapsedMs)}${number("nativeCpuSeconds", 30)}${number("nativeMemoryBytes", XPSNR_LIMITS.nativeMemoryBytes)}</div></details></fieldset>
 <button type="button" id="xpsnr-preflight">${th(msg("xpsnr.preflight", "检查准入（不解码）"))}</button><button id="xpsnr-submit" type="submit">${th(msg("xpsnr.submit", "开始 PSNR + XPSNR 评分"))}</button><button type="button" id="xpsnr-retry" hidden>${th(msg("reexecution.replaySubmission", "重放原提交（不重新计算）"))}</button><button type="button" id="xpsnr-new" hidden>${th(msg("xpsnr.new", "新建显式请求"))}</button><details class="quality-advanced"><summary>${th(msg("qualityWorkspace.pendingFacts", "待确认请求"))}</summary><pre id="xpsnr-pending"></pre></details></form>
 <p id="xpsnr-status" role="status"></p><button id="xpsnr-refresh" type="button">${th(msg("xpsnr.history", "刷新服务端历史"))}</button><div id="xpsnr-history"></div><button id="xpsnr-more" type="button" hidden>${th(msg("xpsnr.more", "更多历史"))}</button>
 ${xpsnrComparisonShell()}<section id="xpsnr-detail" hidden><h3 id="xpsnr-title"></h3><details class="quality-advanced"><summary>${th(msg("qualityWorkspace.requestFacts", "请求与执行详情"))}</summary><pre id="xpsnr-state"></pre></details><button id="xpsnr-cancel" type="button">${th(msg("xpsnr.cancel", "取消并终止本任务执行"))}</button><div id="xpsnr-summary"></div><div id="xpsnr-frames"></div><button id="xpsnr-frames-more" type="button" hidden>${th(msg("xpsnr.frames", "更多逐帧事实"))}</button>
 <form id="xpsnr-policy"><h3>${th(msg("xpsnr.candidates", "片段测量候选"))}</h3><p>${th(msg("xpsnr.share", "此操作共享片源身份及不可变序列事实，不定位空间缺陷。关闭页面只停止观察，不会取消后台执行。"))}</p><fieldset id="xpsnr-policy-inputs"><label>${th(msg("qualityFields.space", "评审空间"))}<input id="xpsnr-space" value="default" required></label><label>${th(msg("qualityFields.side", "候选所在片源"))}<select id="xpsnr-side"><option value="reference">${th(msg("qualityFields.reference", "参考片源"))}</option><option value="distorted">${th(msg("qualityFields.distorted", "待评片源"))}</option></select></label><div class="quality-roi">${number("maxScore", 80, 0)}${number("limit", 3)}${number("minFrameDistance", 1)}${number("severity", 3)}</div><label>${th(msg("qualityFields.text", "候选说明"))}<textarea id="xpsnr-text" maxlength="2000" required></textarea></label></fieldset><button id="xpsnr-publish" type="submit">${th(msg("xpsnr.publish", "按显式策略发布候选"))}</button></form><details class="quality-advanced"><summary>${th(msg("qualityWorkspace.publicationFacts", "候选发布记录"))}</summary><pre id="xpsnr-publication"></pre></details><div id="xpsnr-links"></div></section></section>`;
}
export function installQualityXpsnr(signal: AbortSignal) {
  return installTemporalQuality(signal, {
    kind: "xpsnr",
    parseInput: xpsnrInput,
    readInput(input) {
      const rate = input("frame-rate").value.trim().split("/").map(Number);
      if (
        rate.length > 2 ||
        !rate.every((n) => Number.isSafeInteger(n) && n > 0)
      )
        throw Error("Enter an exact frame rate, such as 30 or 30000/1001");
      const cadence = { ticks: rate[1] ?? 1, timescale: rate[0] };
      return xpsnrInput({
        schema: "voidplayer-native-xpsnr-job",
        version: 1,
        client: { id: input("client").value, kind: "browser" },
        plan: {
          id: input("plan").value,
          attemptId: input("attempt").value,
          digest: input("digest").value,
        },
        recipe: XPSNR_RECIPE,
        cadenceUs: clockToUs(cadence),
        cadence,
        metrics: { psnr: true, ssim: input("ssim").checked },
        budget: Object.fromEntries(
          [
            "maxRawBytes",
            "maxElapsedMs",
            "nativeCpuSeconds",
            "nativeMemoryBytes",
          ].map((id) => [id, Number(input(id).value)]),
        ),
      });
    },
    frameLabel: (index, score: XpsnrDb | null) =>
      `presentation frame ${index} · XPSNR ${score?.kind === "finite" ? score.db.toFixed(4) : score ? "∞" : "unavailable"} dB (minimum plane)`,
    installComparison: (select) => installXpsnrComparison(signal, select),
  });
}
