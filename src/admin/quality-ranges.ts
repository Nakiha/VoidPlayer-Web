import { QualityObservationScope } from "../analysis/quality/observation-scope.ts";
import { candidateAnnotations } from "../analysis/quality/candidate-evidence.ts";
import { qualityViewVisible } from "./quality-navigation.ts";
import { installQualityReexecution } from "./quality-reexecution.ts";
import { t, th, msg } from "../i18n.ts";
import { confirmedActor, observeIdentity } from "../services/identity.ts";
import { QualityClient } from "../services/quality-jobs.ts";
import { qualityFacts } from "../ui/quality-evidence.ts";
import { qualityPairViewUrl } from "../../shared/review/quality-pair-view.ts";
import type { QualityRangeJob } from "../../shared/analysis/quality/ranges.ts";
import type { QualityJobResult } from "../../shared/analysis/quality/jobs.ts";
import type { AnnotationRecord } from "../../shared/review/annotation-record.ts";

export function qualityRangesShell() {
  return `<section id="quality-ranges" class="admin-panel">
  <h2>${th(msg("qualityRange.title", "有界区间与抽样任务"))}</h2>
  <p>${th(msg("qualityRange.scope", "查看后台显式 AU 对应计划、评分覆盖和测量候选。抽样结果仅代表已评分帧，不推断整段质量。打开详情与原帧窗口不会控制播放器。"))}</p>
  <button type="button" id="quality-range-refresh">${th(msg("qualityWorkflow.refresh", "刷新任务"))}</button>
  <p id="quality-range-status" role="status"></p>
  <div id="quality-range-list"></div>
  <button type="button" id="quality-range-more" hidden>${th(msg("admin.nextPage", "下一页"))}</button>
  <section id="quality-range-detail" hidden>
  <h3 id="quality-range-title"></h3>
  <pre id="quality-range-coverage"></pre>
  <pre id="quality-range-summary"></pre>
  <details><summary>${th(msg("qualityRange.plan", "对应、抽样、预算与执行计划"))}</summary><pre id="quality-range-plan"></pre></details>
  <button type="button" id="quality-range-cancel">${th(msg("qualityWorkflow.cancel", "取消任务"))}</button>
  <div id="quality-range-results"></div>
  <button type="button" id="quality-range-results-more" hidden>${th(msg("qualityRange.moreResults", "下一页评分结果"))}</button>
  <h3>${th(msg("qualityRange.candidates", "按显式策略生成的测量候选"))}</h3>
  <p>${th(msg("qualityCandidate.badge", "测量候选 · 创建时未作人工判断"))}</p>
  <div id="quality-range-candidates"></div>
  </section></section>`;
}

export function installQualityRanges(signal: AbortSignal) {
  const $ = (id: string) => document.getElementById(`quality-range-${id}`)!;
  const api = new QualityClient();
  const observation = new QualityObservationScope();
  let active = false,
    actor = "",
    selected = "";
  let after = 0,
    next: number | null = null,
    revision = 0;
  let browsingMore = false,
    publicationToken = "";
  const valid = (owner: string, s: AbortSignal) =>
    active && !s.aborted && actor === owner && confirmedActor()?.id === owner;
  const request = <T>(
    owner: string,
    url: string,
    s: AbortSignal,
    method = "GET",
    body?: unknown,
  ) => api.request<T>(owner, url, s, method, body);
  const reexecutionRoot = document.createElement("section");
  reexecutionRoot.id = "quality-range-reexecution";
  $("detail").append(reexecutionRoot);
  const reexecution = installQualityReexecution(
    reexecutionRoot,
    "range",
    signal,
    (id) =>
      window.dispatchEvent(
        new CustomEvent("voidplayer-quality-range-select", {
          detail: { id, actor: confirmedActor()?.id },
        }),
      ),
  );
  function reset() {
    reexecution.clear();
    observation.invalidate();
    actor = confirmedActor()?.id ?? "";
    selected = "";
    after = 0;
    next = null;
    revision = 0;
    browsingMore = false;
    publicationToken = "";
    observation.select();
    $("list").replaceChildren();
    $("detail").hidden = true;
    $("more").hidden = true;
    $("status").textContent = "";
    for (const id of [
      "title",
      "coverage",
      "summary",
      "plan",
      "results",
      "candidates",
    ])
      $(id).replaceChildren();
  }
  function list(more = false): Promise<void> {
    return observation.run("history", "actor", async () => {
      const owner = actor,
        s = observation.capture("actor", "history").signal;
      if (!owner) return;
      browsingMore = more;
      try {
        const page = await request<{
          entries: Omit<QualityRangeJob, "plan">[];
          after: number;
          more: boolean;
        }>(owner, `/api/quality/ranges?after=${more ? after : 0}&limit=10`, s);
        if (!valid(owner, s)) return;
        after = page.after;
        $("more").hidden = !page.more;
        const list = $("list"),
          rows = new Map(
            [
              ...list.querySelectorAll<HTMLButtonElement>("[data-range-id]"),
            ].map((row) => [row.dataset.rangeId!, row]),
          );
        for (const [index, job] of page.entries.entries()) {
          let button = rows.get(job.id);
          rows.delete(job.id);
          if (!button) {
            button = document.createElement("button");
            button.type = "button";
            button.dataset.rangeId = job.id;
            button.onclick = () => {
              if (!valid(owner, s)) return;
              reexecution.clear();
              selected = job.id;
              revision = 0;
              next = null;
              publicationToken = "";
              observation.select();
              $("detail").hidden = true;
              $("results").replaceChildren();
              $("candidates").replaceChildren();
              $("status").textContent = "";
              void detail();
            };
          }
          const text = `${job.id} · ${job.state} · ${job.summary.scoredPairs}`;
          if (button.textContent !== text) button.textContent = text;
          if (more) {
            if (!button.isConnected) list.append(button);
          } else if (list.children[index] !== button)
            list.insertBefore(button, list.children[index] ?? null);
        }
        if (!more) for (const row of rows.values()) row.remove();
      } catch (e) {
        if (valid(owner, s)) $("status").textContent = String(e);
      }
    });
  }
  function results(more = false): Promise<boolean> {
    return observation.run("frames", "selection", async () => {
      const owner = actor,
        s = observation.capture("selection", "frames").signal,
        id = selected;
      try {
        const page = await request<{
          entries: { au: number; result: QualityJobResult }[];
          nextAu: number | null;
        }>(
          owner,
          `/api/quality/ranges/${id}/results?after=${more ? (next ?? 0) : 0}&limit=4`,
          s,
        );
        if (!valid(owner, s) || selected !== id) return false;
        if (!more) $("results").replaceChildren();
        next = page.nextAu;
        $("results-more").hidden = next === null;
        for (const entry of page.entries) {
          const root = document.createElement("section"),
            title = document.createElement("h4");
          title.textContent = `AU ${entry.au}`;
          root.append(title);
          qualityFacts(root, entry.result.value);
          $("results").append(root);
        }
        $("status").textContent = "";
        return true;
      } catch (e) {
        if (valid(owner, s) && selected === id)
          $("status").textContent = String(e);
        return false;
      }
    });
  }
  function detail(): Promise<void> {
    return observation.run("detail", "selection", async () => {
      if (!selected) return;
      const owner = actor,
        s = observation.capture("selection", "detail").signal,
        id = selected;
      try {
        const response = await request<{
          job: QualityRangeJob;
          coverage: unknown;
          progress: unknown;
          publication: {
            policy: { space: string };
            createdIds: string[];
          } | null;
        }>(owner, `/api/quality/ranges/${id}`, s);
        if (!valid(owner, s) || selected !== id) return;
        const job = response.job;
        reexecution.show(job.id);
        $("detail").hidden = false;
        $("title").textContent =
          `${id} · ${job.state} · ${job.summary.scoredPairs}/${job.plan.targets}`;
        $("coverage").textContent = JSON.stringify(
          { coverage: response.coverage, progress: response.progress },
          null,
          2,
        );
        $("summary").textContent = JSON.stringify(job.summary, null, 2);
        $("plan").textContent = JSON.stringify(job.plan, null, 2);
        ($("cancel") as HTMLButtonElement).disabled = ![
          "queued",
          "running",
        ].includes(job.state);
        const loaded = revision !== job.revision ? await results() : false;
        if (!valid(owner, s) || selected !== id) return;
        if (loaded) revision = job.revision;
        const token = JSON.stringify(response.publication);
        if (token === publicationToken) return;
        const publication = response.publication;
        const records = await candidateAnnotations(
          publication,
          (space, annotationId) =>
            request<AnnotationRecord>(
              owner,
              `/api/annotations/spaces/${encodeURIComponent(space)}/${annotationId}`,
              s,
            ),
        );
        if (!valid(owner, s) || selected !== id) return;
        const nodes = document.createDocumentFragment();
        if (publication) {
          const policy = document.createElement("pre");
          policy.textContent = JSON.stringify(publication, null, 2);
          nodes.append(policy);
        }
        for (const record of records)
          for (const evidence of record.document.mark.qualityEvidence ?? []) {
            const link = document.createElement("a");
            link.href = qualityPairViewUrl(
              {
                space: record.space,
                annotationId: record.id,
                evidenceId: evidence.id,
              },
              location.origin,
            );
            link.target = "_blank";
            link.rel = "noopener";
            link.textContent = t(
              msg("quality.openPair", "在新窗口查看原帧对与 ROI"),
            );
            link.dataset.candidateId = record.id;
            nodes.append(link);
          }
        if (!valid(owner, s) || selected !== id) return;
        $("candidates").replaceChildren(nodes);
        publicationToken = token;
      } catch (e) {
        if (valid(owner, s) && selected === id) {
          publicationToken = "";
          $("status").textContent = String(e);
        }
      }
    });
  }
  window.addEventListener(
    "voidplayer-quality-range-select",
    (event) => {
      const request = (event as CustomEvent<{ id: string; actor: string }>)
        .detail;
      if (
        !active ||
        request?.actor !== actor ||
        confirmedActor()?.id !== actor ||
        !/^[a-f0-9-]{36}$/.test(request.id)
      )
        return;
      reexecution.clear();
      selected = request.id;
      revision = 0;
      next = null;
      publicationToken = "";
      observation.select();
      $("detail").hidden = true;
      $("results").replaceChildren();
      $("candidates").replaceChildren();
      void detail();
    },
    { signal },
  );
  $("refresh").onclick = () => {
    void list();
    void detail();
  };
  $("more").onclick = () => void list(true);
  $("results-more").onclick = () => void results(true);
  $("cancel").onclick = () => {
    const owner = actor,
      s = observation.capture().signal,
      id = selected;
    void request(owner, `/api/quality/ranges/${id}/cancel`, s, "POST", {}).then(
      () => {
        if (valid(owner, s) && id === selected) void detail();
      },
      (e) => {
        if (valid(owner, s) && id === selected)
          $("status").textContent = String(e);
      },
    );
  };
  observeIdentity(signal, {
    invalidated: reset,
    confirmed: () => {
      reset();
      if (active) {
        void list();
      }
    },
  });
  const timer = setInterval(() => {
    if (active && qualityViewVisible("ranges")) {
      if (selected) void detail();
      else if (!browsingMore) void list();
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
      reset();
      if (active) void list();
    },
  };
}
