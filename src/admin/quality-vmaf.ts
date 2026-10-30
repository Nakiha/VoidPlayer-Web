import { installTemporalQuality } from "./quality-temporal.ts";
import { qualityFieldLabel } from "./quality-fields.ts";
import { clockToUs } from "../../shared/media/indexing/rational-clock.ts";
import { th, msg } from "../i18n.ts";
import { vmafInput, VMAF_LIMITS } from "../../shared/analysis/quality/vmaf.ts";

/** This panel observes the same durable commands as HTTP agents. It never scores
 * browser pixels, controls playback or guesses alignment. Technical recipe names
 * stay literal so a copied recipe has exactly the same meaning in either client. */
export function qualityVmafShell() {
  const number = (id: string, value: number, min = 1) =>
    `<label>${qualityFieldLabel(id)}<input id="vmaf-${id}" type="number" step="1" min="${min}" value="${value}" required></label>`;
  return `<section id="quality-vmaf" class="admin-panel"><h2>${th(msg("vmaf.title", "VMAF · 连续片段评分"))}</h2>
 <p>${th(msg("vmaf.sources", "支持已有可信 FLV/Enhanced FLV 和严格非分片 MP4，可混合比较。MP4 支持 avc1 H.264 8 位、hvc1 HEVC 8/10 位，使用原始有理数时钟精确对齐。"))}</p>
 <p>${th(msg("vmaf.scope", "支持 2–1024 个连续呈现帧，可按计划中的固定区域重算。v0.6.1 是固定基线，NEG 可用于编码比较；整帧或区域分数不是热图或人工缺陷判断。具体格式、色彩和预算限制见支持范围。"))}</p>
 <details class="quality-advanced"><summary>${th(msg("qualityWorkspace.capability", "执行器与支持范围"))}</summary><pre id="vmaf-capability"></pre></details><p>${th(msg("qualityWorkspace.planHelp", "先在“参考关系”中选择已完成的计划，再将它带入评分。下方保留计划凭据，便于核对或接续已有任务。"))}</p><button type="button" data-quality-open="correspondence">${th(msg("qualityWorkspace.choosePlan", "选择参考关系与对应计划"))}</button><form id="vmaf-form"><fieldset id="vmaf-inputs"><legend>${th(msg("vmaf.recipe", "片段与评分设置"))}</legend>
 <details class="quality-advanced"><summary>${th(msg("qualityWorkspace.clientSettings", "客户端与请求设置"))}</summary><label>client<input id="vmaf-client" maxlength="80" required></label></details><div class="quality-roi"><label>${th(msg("qualityFields.plan", "对应计划"))}<input id="vmaf-plan" required></label><label>${th(msg("qualityFields.attempt", "计划执行编号"))}<input id="vmaf-attempt" required></label><label>${th(msg("qualityFields.digest", "计划摘要（SHA256）"))}<input id="vmaf-digest" required></label></div>
 <div class="quality-roi"><label>${th(msg("qualityFields.frameRate", "帧率（如 30000/1001）"))}<input id="vmaf-frame-rate" value="4/1"></label><label>${th(msg("qualityFields.model", "评分模型"))}<select id="vmaf-model"><option>vmaf_v0_6_1</option><option>vmaf_v0_6_1neg</option></select></label><label><input id="vmaf-ssim" type="checkbox">${th(msg("qualityFields.ssim", "同时计算 SSIM"))}</label></div>
 <details><summary>${th(msg("vmaf.budgets", "执行预算"))}</summary><div class="quality-roi">${number("maxRawBytes", VMAF_LIMITS.maxRawBytes)}${number("maxElapsedMs", VMAF_LIMITS.maxElapsedMs)}${number("nativeCpuSeconds", 30)}${number("nativeMemoryBytes", VMAF_LIMITS.nativeMemoryBytes)}</div></details></fieldset>
 <button type="button" id="vmaf-preflight">${th(msg("vmaf.preflight", "检查准入（不解码）"))}</button><button id="vmaf-submit" type="submit">${th(msg("vmaf.submit", "开始 PSNR + VMAF 评分"))}</button><button type="button" id="vmaf-retry" hidden>${th(msg("reexecution.replaySubmission", "重放原提交（不重新计算）"))}</button><button type="button" id="vmaf-new" hidden>${th(msg("vmaf.new", "新建显式请求"))}</button><details class="quality-advanced"><summary>${th(msg("qualityWorkspace.pendingFacts", "待确认请求"))}</summary><pre id="vmaf-pending"></pre></details></form>
 <p id="vmaf-status" role="status"></p><button id="vmaf-refresh" type="button">${th(msg("vmaf.history", "刷新服务端历史"))}</button><div id="vmaf-history"></div><button id="vmaf-more" type="button" hidden>${th(msg("vmaf.more", "更多历史"))}</button>
 <section id="vmaf-detail" hidden><h3 id="vmaf-title"></h3><details class="quality-advanced"><summary>${th(msg("qualityWorkspace.requestFacts", "请求与执行详情"))}</summary><pre id="vmaf-state"></pre></details><button id="vmaf-cancel" type="button">${th(msg("vmaf.cancel", "取消并终止本任务执行"))}</button><div id="vmaf-summary"></div><div id="vmaf-frames"></div><button id="vmaf-frames-more" type="button" hidden>${th(msg("vmaf.frames", "更多逐帧事实"))}</button>
 <form id="vmaf-policy"><h3>${th(msg("vmaf.candidates", "片段测量候选"))}</h3><p>${th(msg("vmaf.share", "此操作共享片源身份及不可变序列事实，不定位空间缺陷。关闭页面只停止观察，不会取消后台执行。"))}</p><fieldset id="vmaf-policy-inputs"><label>${th(msg("qualityFields.space", "评审空间"))}<input id="vmaf-space" value="default" required></label><label>${th(msg("qualityFields.side", "候选所在片源"))}<select id="vmaf-side"><option value="reference">${th(msg("qualityFields.reference", "参考片源"))}</option><option value="distorted">${th(msg("qualityFields.distorted", "待评片源"))}</option></select></label><div class="quality-roi">${number("maxScore", 80, 0)}${number("limit", 3)}${number("minFrameDistance", 1)}${number("severity", 3)}</div><label>${th(msg("qualityFields.text", "候选说明"))}<textarea id="vmaf-text" maxlength="2000" required></textarea></label></fieldset><button id="vmaf-publish" type="submit">${th(msg("vmaf.publish", "按显式策略发布候选"))}</button></form><details class="quality-advanced"><summary>${th(msg("qualityWorkspace.publicationFacts", "候选发布记录"))}</summary><pre id="vmaf-publication"></pre></details><div id="vmaf-links"></div></section></section>`;
}
export function installQualityVmaf(signal: AbortSignal) {
  return installTemporalQuality(signal, {
    kind: "vmaf",
    parseInput: vmafInput,
    readInput(input) {
      const rate = input("frame-rate").value.trim().split("/").map(Number);
      if (
        rate.length > 2 ||
        !rate.every((n) => Number.isSafeInteger(n) && n > 0)
      )
        throw Error("Enter an exact frame rate, such as 30 or 30000/1001");
      const cadence = { ticks: rate[1] ?? 1, timescale: rate[0] };
      return vmafInput({
        schema: "voidplayer-native-vmaf-job",
        version: 1,
        client: { id: input("client").value, kind: "browser" },
        plan: {
          id: input("plan").value,
          attemptId: input("attempt").value,
          digest: input("digest").value,
        },
        model: input("model").value,
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
    frameLabel: (index, score: number | null) =>
      `presentation frame ${index} · VMAF ${score ?? "unavailable"}`,
  });
}
