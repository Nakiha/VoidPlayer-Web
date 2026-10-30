import { qualityViewVisible } from "./quality-navigation.ts";
import {
  renderQualitySummary,
  type QualityScoreSummary,
} from "./quality-summary.ts";
import { installQualityReexecution } from "./quality-reexecution.ts";
import { th, t, msg } from "../i18n.ts";
import { confirmedActor, observeIdentity } from "../services/identity.ts";
import { QualityClient } from "../services/quality-jobs.ts";
import {
  FrozenSubmissionJournal,
  assertJobReceipt,
} from "../services/frozen-submission.ts";
import type { FrozenSubmission } from "../services/frozen-submission.ts";
import { QualityObservationScope } from "../analysis/quality/observation-scope.ts";
import { candidateAnnotations } from "../analysis/quality/candidate-evidence.ts";
import { randomUUID } from "../../shared/utils/uuid.ts";
import {
  cambiInput,
  CAMBI_LIMITS,
  terminalCambi,
} from "../../shared/analysis/quality/cambi.ts";
import type {
  CambiInput,
  CambiJob,
  CambiFrame,
  CambiFramePage,
} from "../../shared/analysis/quality/cambi.ts";
import type { DiscoveryPage } from "../services/library-discovery.ts";
import type { AnnotationRecord } from "../../shared/review/annotation-record.ts";
import type { SourceBinding } from "../../shared/analysis/quality/frame-pair.ts";
export function qualityCambiShell() {
  return `<section id="quality-cambi" class="admin-panel"><h2>${th(msg("cambi.title", "CAMBI · 单源色带筛查"))}</h2><p>${th(msg("cambi.scope", "使用分析 WASM core；可信 FLV/Enhanced FLV 8/10 位，或严格 MP4 avc1 H2648 / hvc1 HEVC8/10；限范围 BT.709 SDR，整帧、方形像素、不裁剪，长边至少320。分数越高表示检测到更多色带，不是产品合格线；内部按10位处理。允许明确抽样，未采样帧不冒充覆盖。没有跨帧目标跟踪，未认证引用完整性，无法检测错误隐藏。"))}</p><details class="quality-advanced"><summary>${th(msg("qualityWorkspace.capability", "执行器与支持范围"))}</summary><pre id="cambi-capability"></pre></details>
 <form id="cambi-search-form"><label>${th(msg("cambi.find", "从技术发现选择单源"))}<input id="cambi-search" maxlength="300"></label><button id="cambi-browse" type="submit">${th(msg("admin.search", "搜索"))}</button><button id="cambi-next" type="button" hidden>${th(msg("admin.nextPage", "下一页"))}</button></form><div id="cambi-media"></div><p id="cambi-source"></p><a href="/admin/#discovery" target="_blank" rel="noopener">${th(msg("cambi.prepare", "缺少可信缓存时，显式前往技术准备；此处不会自动探测或建索引。"))}</a>
 <form id="cambi-form"><fieldset id="cambi-inputs"><details class="quality-advanced"><summary>${th(msg("qualityWorkspace.clientSettings", "客户端与请求设置"))}</summary><label>client<input id="cambi-client" required maxlength="80"></label></details><label>startPtsUs<input id="cambi-start" type="number" min="0" step="1" value="0" required></label><label>endPtsUs<input id="cambi-end" type="number" min="1" step="1" value="1000000" required></label><label>stride<input id="cambi-stride" type="number" min="1" max="256" step="1" value="1" required></label></fieldset><button id="cambi-submit" type="submit">${th(msg("cambi.submit", "发起持久单源 CAMBI"))}</button><button id="cambi-retry" type="button" hidden>${th(msg("cambi.retry", "用冻结请求与原键重试"))}</button><button id="cambi-new" type="button" hidden>${th(msg("cambi.new", "新建显式请求"))}</button></form>
 <p role="status" id="cambi-status"></p><button id="cambi-refresh" type="button">${th(msg("cambi.history", "刷新后台历史"))}</button><div id="cambi-history"></div><button id="cambi-history-more" type="button" hidden>${th(msg("admin.nextPage", "下一页"))}</button>
 <section id="cambi-detail" hidden><section id="cambi-reexecution"></section><h3 id="cambi-title"></h3><details class="quality-advanced"><summary>${th(msg("qualityWorkspace.requestFacts", "请求与执行详情"))}</summary><pre id="cambi-state"></pre></details><button id="cambi-cancel" type="button">${th(msg("cambi.cancel", "立即取消（丢弃暂存结果）"))}</button><button id="cambi-stop-keep" type="button">${th(msg("cambi.stopKeep", "停止并保留已算部分"))}</button><p id="cambi-validation" role="status"></p><div id="cambi-summary"></div><div id="cambi-frames"></div><button id="cambi-frames-more" type="button" hidden>${th(msg("cambi.frames", "更多逐帧事实"))}</button>
 <form id="cambi-policy"><h3>${th(msg("cambi.candidates", "从真实热图显式创建共享空间候选"))}</h3><p>${th(msg("cambi.policyNote", "阈值由调用者指定，未校准。区域来自所选尺度中达到 cellThreshold 的真实热图单元包围框；保留帧、尺度、统计与坐标映射，不是裁剪重算或人工缺陷判断。关闭页面不会取消后台执行。"))}</p><fieldset id="cambi-policy-inputs"><label>space<input id="cambi-space" value="default" required></label><label>minScore<input id="cambi-minScore" type="number" min="0" step="any" value="0" required></label><label>limit<input id="cambi-limit" type="number" min="1" max="8" value="1" required></label><label>scale<select id="cambi-scale">${[0, 1, 2, 3, 4].map((s) => `<option>${s}</option>`).join("")}</select></label><label>cellThreshold (gray16)<input id="cambi-cellThreshold" type="number" min="1" max="65535" value="1" required></label><label>severity<input id="cambi-severity" type="number" min="1" max="5" value="3" required></label><label>text<textarea id="cambi-text" maxlength="2000" required></textarea></label></fieldset><button id="cambi-publish" type="submit">${th(msg("cambi.publish", "显式共享候选与证据"))}</button></form><details class="quality-advanced"><summary>${th(msg("qualityWorkspace.publicationFacts", "候选发布记录"))}</summary><pre id="cambi-publication"></pre></details><div id="cambi-links"></div></section></section>`;
}
export function installQualityCambi(signal: AbortSignal) {
  const $ = (id: string) => document.getElementById("cambi-" + id)!,
    input = (id: string) => $(id) as HTMLInputElement;
  const api = new QualityClient();
  const observation = new QualityObservationScope();
  let browsingMore = false,
    active = false,
    actor = "",
    source: SourceBinding | null = null,
    nextCursor: string | null = null,
    selected = "",
    revision = 0,
    after = 0,
    frameAfter: number | null = null,
    mediaSeq = 0;
  let publicationToken = "";
  let resumeSelection: { actor: string; id: string } | null = null;
  type Pending = FrozenSubmission<CambiInput>;
  const storage = (a: string) => "voidplayer-cambi-pending:" + a;
  const journal = new FrozenSubmissionJournal(
    sessionStorage,
    storage,
    cambiInput,
  );
  const pending = () => journal.pending(actor);
  const context = (
      level: "actor" | "selection" = "selection",
      slot?: string,
    ) => ({
      actor,
      scope: observation.capture(level, slot),
      get signal() {
        return this.scope.signal;
      },
    }),
    valid = (c: ReturnType<typeof context>) =>
      active &&
      !signal.aborted &&
      c.actor === actor &&
      confirmedActor()?.id === c.actor &&
      c.scope.current(),
    error = (e: unknown) => {
      $("status").textContent = e instanceof Error ? e.message : String(e);
    };
  function lock() {
    const p = pending(),
      frozen = !!p && !p.confirmed;
    ($("inputs") as HTMLFieldSetElement).disabled = frozen;
    input("submit").disabled = frozen;
    input("browse").disabled = frozen;
    input("next").disabled = frozen;
    $("retry").hidden = !frozen;
    $("new").hidden = !p?.confirmed;
  }
  const reexecution = installQualityReexecution(
    $("reexecution"),
    "cambi",
    signal,
    (id) => select(id),
  );
  function resetFrames() {
    observation.cancel("frames");
    frameAfter = null;
    input("frames-more").disabled = false;
    $("frames-more").hidden = true;
  }
  function reset() {
    resetFrames();
    browsingMore = false;
    reexecution.clear();
    observation.invalidate();
    actor = confirmedActor()?.id ?? "";
    source = null;
    selected = "";
    revision = 0;
    publicationToken = "";
    after = 0;
    frameAfter = null;
    mediaSeq++;
    $("detail").hidden = true;
    for (const id of [
      "media",
      "source",
      "history",
      "status",
      "summary",
      "frames",
      "links",
      "publication",
      "title",
      "state",
      "validation",
      "capability",
    ])
      $(id).replaceChildren();
    input("space").value = "default";
    input("text").value = "";
    try {
      lock();
    } catch (e) {
      error(e);
    }
  }
  async function browse(more = false) {
    if (!actor) return;
    const c = context("actor"),
      ticket = ++mediaSeq;
    try {
      const q = new URLSearchParams({
        limit: "16",
        search: input("search").value,
      });
      if (more && nextCursor) q.set("cursor", nextCursor);
      const p = await api.request<DiscoveryPage>(
        c.actor,
        "/api/library/discovery?" + q,
        c.signal,
      );
      if (!valid(c) || ticket !== mediaSeq) return;
      nextCursor = p.nextCursor;
      $("next").hidden = !nextCursor;
      if (!more) $("media").replaceChildren();
      for (const e of p.entries) {
        const b = document.createElement("button");
        b.type = "button";
        b.textContent =
          e.file.name + " · " + e.source.version + " · " + e.scoring.state;
        b.dataset.cambiMedia = e.source.id;
        b.onclick = () => {
          if (!valid(c)) return;
          try {
            if (pending() && !pending()?.confirmed)
              throw Error("Retry the original frozen request first");
          } catch (e) {
            error(e);
            return;
          }
          source = null;
          $("source").textContent = "loading";
          const seq = ++mediaSeq,
            owner = context("actor");
          void api
            .request<{
              binding: SourceBinding;
            }>(owner.actor, e.scoring.source, owner.signal)
            .then(
              (v) => {
                if (valid(owner) && seq === mediaSeq) {
                  if (!["flv", "mp4"].includes(v.binding.indexIdentity.kind)) {
                    source = null;
                    error(
                      new Error(
                        "CAMBI requires a trusted FLV or strict MP4 quality cache",
                      ),
                    );
                    return;
                  }
                  source = v.binding;
                  $("source").textContent = JSON.stringify(v, null, 2);
                }
              },
              (e) => {
                if (valid(owner) && seq === mediaSeq) {
                  source = null;
                  error(e);
                }
              },
            );
        };
        $("media").append(b);
      }
    } catch (e) {
      if (valid(c) && ticket === mediaSeq) error(e);
    }
  }
  function select(id: string) {
    observation.select();
    resetFrames();
    $("detail").hidden = true;
    selected = id;
    reexecution.show(id);
    revision = 0;
    publicationToken = "";
    frameAfter = null;
    for (const id of ["summary", "frames", "links", "publication"])
      $(id).replaceChildren();
    ($("policy-inputs") as HTMLFieldSetElement).disabled = false;
    void detail();
  }
  function capability(): Promise<void> {
    return observation.run("capability", "actor", async () => {
      if (!active || !actor) return;
      const c = context("actor", "capability");
      try {
        const value = await api.request(c.actor, "/api/quality/cambi/capability", c.signal);
        if (valid(c)) $("capability").textContent = JSON.stringify(value, null, 2);
      } catch (e) {
        if (valid(c)) error(e);
      }
    });
  }
  async function submit(p: Pending, c: ReturnType<typeof context>) {
    const receiptContext = context("actor");
    try {
      const r = await journal.execute(
        c.actor,
        p.key,
        (frozen) =>
          api.request<{ job: CambiJob }>(
            c.actor,
            "/api/quality/cambi/jobs",
            c.signal,
            "POST",
            frozen.body,
            frozen.key,
          ),
        (response, frozen) => assertJobReceipt(response, c.actor, frozen),
      );
      if (valid(c)) {
        select(r.job.id);
        void history();
      }
    } finally {
      // Submission controls project actor-owned acceptance, independently of
      // which task is selected when its valid receipt eventually arrives.
      if (valid(receiptContext)) lock();
    }
  }
  function history(more = false): Promise<void> {
    const pageAfter=more?after:0;
    browsingMore = more || browsingMore;
    return observation.run("history", "actor", async () => {
      if (!actor) return;
      const c = context("actor", "history");
      try {
        const p = await api.request<{
          entries: CambiJob[];
          after: number;
          more: boolean;
        }>(
          c.actor,
          `/api/quality/cambi/jobs?after=${pageAfter}&limit=8`,
          c.signal,
        );
        if (!valid(c)) return;
        after = p.after;
        $("history-more").hidden = !p.more;
        if (!more) $("history").replaceChildren();
        for (const j of p.entries) {
          const b = document.createElement("button");
          b.type = "button";
          b.dataset.cambiJob = j.id;
          b.textContent = j.id + " · " + j.state;
          b.onclick = () => {
            const click = context();
            if (valid(click) && click.actor === c.actor) select(j.id);
          };
          $("history").append(b);
        }
      } catch (e) {
        if (valid(c)) error(e);
      }
    },`${more}:${pageAfter}`);
  }
  function frames(more = false): Promise<boolean> {
    if (more && observation.busy("frames")) return Promise.resolve(false);
    return observation.run("frames", "selection", async () => {
      if (!actor || !selected || (more && frameAfter === null)) return false;
      const c = context("selection", "frames"),
        id = selected,
        cursor = more ? frameAfter! : 0;
      input("frames-more").disabled = true;
      const current = () => valid(c) && id === selected;
      try {
        const p = await api.request<CambiFramePage>(
          c.actor,
          `/api/quality/cambi/jobs/${id}/frames?after=${cursor}&limit=4`,
          c.signal,
        );
        if (!current()) return false;
        const nodes = document.createDocumentFragment();
        for (const f of p.entries) {
          const row = document.createElement("pre");
          row.dataset.cambiFrame = String(f.index);
          row.textContent = JSON.stringify(f, null, 2);
          const link = document.createElement("a");
          link.href = `/quality.html?cambi=1&cambiJob=${id}&index=${f.index}${p.publishable ? "" : "&preview=1"}`;
          link.target = "_blank";
          link.rel = "noopener";
          link.dataset.cambiInspect = String(f.index);
          link.textContent = p.publishable
            ? t(msg("cambi.open", "CAMBI · 查看原始热图、源快照与真实区域"))
            : t(msg("cambi.preview", "预览暂存分数与热图"));
          nodes.append(link, row);
        }
        if (!current()) return false;
        if (more) $("frames").append(nodes);
        else $("frames").replaceChildren(nodes);
        frameAfter = p.next;
        $("frames-more").hidden = p.next === null;
        return true;
      } catch (e) {
        if (current()) error(e);
        return false;
      } finally {
        if (current()) {
          input("frames-more").disabled = false;
        }
      }
    });
  }
  function detail(): Promise<void> {
    return observation.run("detail", "selection", async () => {
      if (!selected) return;
      const c = context("selection", "detail"),
        id = selected;
      try {
        const j = await api.request<CambiJob>(
          c.actor,
          `/api/quality/cambi/jobs/${id}`,
          c.signal,
        );
        if (!valid(c) || id !== selected) return;
        for (const button of $("history").querySelectorAll<HTMLButtonElement>(
          "[data-cambi-job]",
        ))
          if (button.dataset.cambiJob === id)
            button.textContent = id + " · " + j.state;
        $("detail").hidden = false;
        $("title").textContent = id + " · " + j.state;
        $("state").textContent = JSON.stringify(j, null, 2);
        input("cancel").disabled = terminalCambi(j.state);
        input("publish").disabled = !j.resultDigest || j.resultRetained === false;
        input("stop-keep").disabled =
          terminalCambi(j.state) ||
          !!j.stopRequested ||
          j.state === "cancelling";
        $("validation").textContent = j.resultRetained === false && j.resultDigest
          ? t(msg('qualityWorkspace.resultReleased','评分结果已回收；原始摘要与回执保留。'))
          : j.resultDigest
          ? j.state === "partial"
            ? t(
                msg(
                  "cambi.partial",
                  "部分结果已核验；未评分范围不计零分，可复用已完成证据。",
                ),
              )
            : ""
          : terminalCambi(j.state)
            ? (j.reason?.message ?? "")
            : j.stopRequested
              ? t(
                  msg(
                    "cambi.finishingPartial",
                    "正在排空当前解码窗口并核验来源；完成后保留已算部分。可随时立即取消。",
                  ),
                )
              : j.progress.scoredFrames
                ? t(
                    msg(
                      "cambi.provisional",
                      "运行中结果为暂存，尚未完成排空和来源核验，不能发布。",
                    ),
                  )
                : "";
        if (
          !j.resultDigest &&
          !terminalCambi(j.state) &&
          j.progress.scoredFrames &&
          revision !== j.revision
        ) {
          await frames();
          if (valid(c)) revision = j.revision;
        }
        if (terminalCambi(j.state) && (!j.resultDigest || j.resultRetained === false)) {
          resetFrames();
          $("frames").replaceChildren();
          $("summary").replaceChildren();
          if(j.resultRetained===false&&j.resultDigest)$("summary").textContent=t(msg('qualityWorkspace.resultReleased','评分结果已回收；原始摘要与回执保留。'));
          revision = j.revision;
        }
        if (j.resultDigest && j.resultRetained !== false && revision !== j.revision) {
          const summary = await api.request<QualityScoreSummary>(
            c.actor,
            `/api/quality/cambi/jobs/${id}/result`,
            c.signal,
          );
          if (!valid(c)) return;
          renderQualitySummary($("summary"), summary);
          const loaded = await frames();
          if (!valid(c)) return;
          if (loaded) revision = j.revision;
        }
        const pub = await api.request<{
          createdIds: string[];
          policy: Record<string, string | number> & { space: string };
        } | null>(
          c.actor,
          `/api/quality/cambi/jobs/${id}/candidates`,
          c.signal,
        );
        if (!valid(c)) return;
        const token = JSON.stringify(pub);
        if (token === publicationToken) return;
        const records = await candidateAnnotations(pub, (space, markId) =>
          api.request<AnnotationRecord>(
            c.actor,
            `/api/annotations/spaces/${encodeURIComponent(space)}/${markId}`,
            c.signal,
          ),
        );
        if (!valid(c)) return;
        const links = document.createDocumentFragment();
        for (const record of records)
          for (const e of record.document.mark.cambiEvidence ?? []) {
            const link = document.createElement("a");
            link.href = `/quality.html?cambi=1&space=${encodeURIComponent(record.space)}&annotationId=${record.id}&evidenceId=${e.id}`;
            link.target = "_blank";
            link.rel = "noopener";
            link.dataset.cambiCandidate = record.id;
            link.textContent = t(
              msg("cambi.open", "CAMBI · 查看原始热图、源快照与真实区域"),
            );
            links.append(link);
          }
        if (!valid(c)) return;
        $("publication").textContent = JSON.stringify(pub, null, 2);
        $("links").replaceChildren(links);
        ($("policy-inputs") as HTMLFieldSetElement).disabled = !!pub;
        if (pub)
          for (const [k, v] of Object.entries(pub.policy))
            input(k).value = String(v);
        publicationToken = token;
      } catch (e) {
        if (valid(c)) error(e);
      }
    });
  }
  input("client").value = randomUUID();
  $("search-form").onsubmit = (e) => {
    e.preventDefault();
    void browse();
  };
  $("next").onclick = () => void browse(true);
  $("form").onsubmit = (e) => {
    e.preventDefault();
    const c = context();
    try {
      if (!source)
        throw Error("Select a source with a verified complete cache first");
      if (pending() && !pending()?.confirmed)
        throw Error("Retry the frozen request first");
      const body = cambiInput({
        schema: "voidplayer-cambi-job",
        version: 1,
        client: { id: input("client").value, kind: "browser" },
        source,
        interval: {
          startPtsUs: Number(input("start").value),
          endPtsUs: Number(input("end").value),
        },
        sampling: { stride: Number(input("stride").value) },
        budget: Object.fromEntries(
          [
            "maxRawBytes",
            "maxHeatBytes",
            "maxTemporaryBytes",
            "maxElapsedMs",
            "nativeCpuSeconds",
            "nativeMemoryBytes",
          ].map((k) => [k, CAMBI_LIMITS[k as keyof typeof CAMBI_LIMITS]]),
        ),
      });
      journal.clearConfirmed(actor);
      const p = journal.freeze(actor, body);
      lock();
      void submit(p, c).catch((e) => {
        if (valid(c)) error(e);
      });
    } catch (e) {
      error(e);
    }
  };
  $("retry").onclick = () => {
    const c = context();
    try {
      const p = pending();
      if (p)
        void submit(p, c).catch((e) => {
          if (valid(c)) error(e);
        });
    } catch (e) {
      error(e);
    }
  };
  $("new").onclick = () => {
    if (pending()?.confirmed) {
      journal.clearConfirmed(actor);
      lock();
    }
  };
  $("refresh").onclick = () => {
    browsingMore = false;
    void history();
    void detail();
  };
  $("history-more").onclick = () => void history(true);
  $("frames-more").onclick = () => void frames(true);
  $("cancel").onclick = () => {
    const c = context(),
      id = selected;
    void api
      .request(
        c.actor,
        `/api/quality/cambi/jobs/${id}/cancel`,
        c.signal,
        "POST",
        {},
      )
      .then(
        () => {
          if (valid(c)) void detail();
        },
        (e) => {
          if (valid(c)) error(e);
        },
      );
  };
  $("stop-keep").onclick = () => {
    const c = context(),
      id = selected;
    input("stop-keep").disabled = true;
    void api
      .request(
        c.actor,
        `/api/quality/cambi/jobs/${id}/stop-and-keep`,
        c.signal,
        "POST",
        {},
      )
      .then(
        () => {
          if (valid(c)) void detail();
        },
        (e) => {
          if (valid(c)) {
            input("stop-keep").disabled = false;
            error(e);
          }
        },
      );
  };
  $("policy").onsubmit = (e) => {
    e.preventDefault();
    const c = context(),
      id = selected;
    const policy = {
      space: input("space").value,
      minScore: Number(input("minScore").value),
      limit: Number(input("limit").value),
      scale: Number(input("scale").value),
      cellThreshold: Number(input("cellThreshold").value),
      severity: Number(input("severity").value),
      text: input("text").value,
    };
    void api
      .request(
        c.actor,
        `/api/quality/cambi/jobs/${id}/candidates`,
        c.signal,
        "POST",
        policy,
      )
      .then(
        () => {
          if (valid(c)) {
            revision = 0;
            publicationToken = "";
            void detail();
          }
        },
        (e) => {
          if (valid(c)) error(e);
        },
      );
  };
  observeIdentity(signal, {
    invalidated: () => {
      if (selected && actor) resumeSelection = { actor, id: selected };
      reset();
    },
    confirmed: () => {
      const resume = resumeSelection;
      resumeSelection = null;
      reset();
      if (active) {
        void history();
        void browse();
        void capability();
        if (resume?.actor === actor) select(resume.id);
      }
    },
    failed: error,
  });
  const timer = setInterval(() => {
    if (active && qualityViewVisible("cambi")) {
      if (selected) void detail();
      else if (!browsingMore) void history();
    }
  }, 1000);
  signal.addEventListener(
    "abort",
    () => {
      clearInterval(timer);
      observation.close();
    },
    { once: true },
  );
  return {
    activate(value: boolean) {
      if (active === value) return;
      active = value;
      resumeSelection = null;
      reset();
      if (active) {
        void history();
        void browse();
        void capability();
      }
    },
  };
}
