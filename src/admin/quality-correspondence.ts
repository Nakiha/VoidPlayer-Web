import { assertCorrespondenceReceipt } from '../services/correspondence-receipt.ts';
import { FrozenSubmissionJournal } from '../services/frozen-submission.ts';
import { QualityObservationScope } from '../analysis/quality/observation-scope.ts';
import { qualityViewVisible } from './quality-navigation.ts';
import { clockToUs } from '../../shared/media/indexing/rational-clock.ts';
import { th, t, msg } from '../i18n.ts';
import { confirmedActor, observeIdentity } from '../services/identity.ts';
import { QualityClient } from '../services/quality-jobs.ts';
import type { LibraryEntry } from '../services/library.ts';
import { LibraryDiscoveryClient } from '../services/library-discovery.ts';
import { randomUUID } from '../../shared/utils/uuid.ts';
import type { LibraryPairBinding } from '../../shared/analysis/quality/library-pair.ts';
import {
  CORRESPONDENCE_LIMITS,
  referenceRelationInput,
  correspondenceInput,
  terminalCorrespondence,
} from '../../shared/analysis/quality/correspondence.ts';
import type { ReferenceRelation, CorrespondencePlan, CorrespondenceRow } from '../../shared/analysis/quality/correspondence.ts';
import { SSIM_VARIANT } from '../../shared/analysis/quality/ssim.ts';
import { rangeCandidatePolicy } from '../../shared/analysis/quality/ranges.ts';
import type { QualityRangeJob } from '../../shared/analysis/quality/ranges.ts';

const sides = ['reference', 'distorted'] as const;
const label = (side: (typeof sides)[number]) =>
  side === 'reference' ? t(msg('qualityWorkflow.reference', '参考片源')) : t(msg('qualityWorkflow.distorted', '待测片源'));
const number = (id: string, text: string, value: number, min?: number) =>
  `<label>${text}<input id="quality-clock-${id}" type="number" step="1" value="${value}" ${min === undefined ? '' : `min="${min}"`} required></label>`;
export function qualityCorrespondenceShell() {
  return `<section id="quality-clock" class="admin-panel">
  <h2>${th(msg('qualityClock.title', '显式参考关系与 AU 对应计划'))}</h2><p>${th(msg('qualityClock.scope', '关系由调用者声明，不认证同内容。时钟按原始 ticks 与时基精确匹配；缺洞、歧义与不支持会保留。只读取已有可信 FLV 或严格 MP4 缓存，评分与候选均须显式提交。'))}</p>
  <form id="quality-clock-relation-form"><div class="quality-sources">${sides.map((side) => `<fieldset data-clock-source="${side}"><legend>${label(side)}</legend><input type="search" data-clock-search aria-label="${th(msg('qualityWorkflow.searchMedia', '搜索媒体库'))}"><button type="button" data-clock-search-button>${th(msg('admin.search', '搜索'))}</button><button type="button" data-clock-more hidden>${th(msg('admin.nextPage', '下一页'))}</button><div data-clock-media></div><p data-clock-source-status role="status"></p></fieldset>`).join('')}</div>
  <label>${th(msg('qualityClock.declaration', '参考关系声明说明（不等于内容认证）'))}<textarea id="quality-clock-declaration" maxlength="2000" required></textarea></label>
  <p>${th(msg('qualityClock.direction', '映射方向：待测源时间 = 参考源时间 + 偏移。参考区间为 [开始, 结束)，单位为微秒。偏移可用微秒或指定帧率下的整帧数；两侧区间均不得重叠。'))}</p>
  <div id="quality-clock-segments"></div><button type="button" id="quality-clock-add-segment">${th(msg('qualityClock.addSegment', '添加时钟段'))}</button><button type="submit" id="quality-clock-save-relation">${th(msg('qualityClock.saveRelation', '保存不可变关系声明'))}</button></form>
  <section id="quality-clock-pending"><p>${th(msg('qualityClock.pendingNotice', '提交结果未确认时，保留原请求与重试键。重试不会新建另一项工作；结束本地重试不会取消服务端工作。'))}</p>${['relation', 'plan'].map((kind) => `<div id="quality-clock-pending-${kind}" hidden><pre id="quality-clock-pending-body-${kind}"></pre><button type="button" id="quality-clock-retry-${kind}">${th(msg('qualityClock.retryFrozen', '重试原冻结提交'))}</button><button type="button" id="quality-clock-forget-${kind}">${th(msg('qualityClock.forgetFrozen', '结束本地重试，准备新请求'))}</button></div>`).join('')}</section>
  <button type="button" id="quality-clock-refresh">${th(msg('qualityWorkflow.refresh', '刷新任务'))}</button><div id="quality-clock-relations"></div><button type="button" id="quality-clock-relations-more" hidden>${th(msg('admin.nextPage', '下一页'))}</button><pre id="quality-clock-relation"></pre>
  <form id="quality-clock-plan-form"><h3>${th(msg('qualityClock.planTitle', '固定缓存、抽样与执行预算'))}</h3><p id="quality-clock-builds"></p><button type="button" id="quality-clock-pin">${th(msg('qualityClock.pin', '读取并固定此关系的现有缓存'))}</button>
  <div class="quality-roi">${number('start', 'start AU', 0, 0)}${number('end', 'end AU', 1, 0)}<label>${th(msg('qualityClock.sampling', '抽样计划'))}<select id="quality-clock-sampling"><option value="all">all</option><option value="stride">stride</option></select></label>${number('every', 'stride every', 2, 2)}${number('offset', 'stride offset', 0, 0)}${['x', 'y', 'width', 'height'].map((k) => number(k, `ROI ${k}`, k === 'width' || k === 'height' ? 32 : 0, 0)).join('')}</div>
  <label><input type="checkbox" id="quality-clock-ssim">SSIM</label><label><input type="checkbox" id="quality-clock-grid">${th(msg('quality.spatialTitle', '源像素分块 PSNR'))} 16×16</label>
  <details><summary>${th(msg('qualityClock.budgets', '规划和评分预算（超额会明确拒绝）'))}</summary><div class="quality-roi">${number('pair-read', 'pair source bytes', 65536, 1)}${number('pair-input', 'pair numeric bytes', 65536, 1)}${number('total-read', 'total source bytes', 67108864, 1)}${number('total-input', 'total numeric bytes', 536870912, 1)}${number('packets', 'total packets / outputs', 4096, 2)}${number('elapsed', 'range milliseconds', 120000, 1)}${number('index-bytes', 'planning index bytes', CORRESPONDENCE_LIMITS.maxIndexBytes, 1)}${number('index-packets', 'planning index packets', CORRESPONDENCE_LIMITS.maxIndexPackets, 1)}${number('planning-elapsed', 'planning milliseconds', 30000, 1)}</div></details>
  <button type="submit" id="quality-clock-plan-submit">${th(msg('qualityClock.createPlan', '生成并持久保存 AU 解释计划'))}</button></form>
  <p id="quality-clock-status" role="status"></p><div id="quality-clock-history"></div><button type="button" id="quality-clock-history-more" hidden>${th(msg('admin.nextPage', '下一页'))}</button>
  <section id="quality-clock-detail" hidden><h3 id="quality-clock-title"></h3><pre id="quality-clock-summary"></pre><div id="quality-clock-rows"></div><button type="button" id="quality-clock-rows-more" hidden>${th(msg('admin.nextPage', '下一页'))}</button><button type="button" id="quality-clock-cancel">${th(msg('qualityWorkflow.cancel', '取消任务'))}</button><button type="button" id="quality-clock-new-plan" disabled hidden>${th(msg('qualityClock.newSamePlan', '新建相同计划'))}</button><button type="button" id="quality-clock-execute">${th(msg('qualityClock.execute', '按此冻结计划提交评分'))}</button><button type="button" id="quality-clock-vmaf">${th(msg('vmaf.usePlan', 'VMAF：使用此已提交计划'))}</button><button type="button" id="quality-clock-xpsnr">${th(msg('xpsnr.usePlan', 'XPSNR：使用此已提交计划'))}</button><p id="quality-clock-execution"></p><button type="button" id="quality-clock-show-range" hidden>${th(msg('qualityClock.showRange', '查看区间评分、候选与原帧'))}</button>
  <form id="quality-clock-candidate-form"><h3>${th(msg('qualityRange.candidates', '按显式策略生成的测量候选'))}</h3><p>${th(msg('qualityCandidate.badge', '测量候选 · 创建时未作人工判断'))}</p><div class="quality-roi"><label>space<input id="quality-clock-space" value="default" required></label><label>side<select id="quality-clock-side"><option value="reference">reference</option><option value="distorted">distorted</option></select></label>${number('max-db', 'PSNR ≤ dB', 35, 0)}${number('top-n', 'top N', 3, 1)}${number('distance', 'min AU distance', 4, 0)}${number('severity', 'severity 1..5', 3, 1)}</div><label>${th(msg('qualityClock.candidateText', '候选说明'))}<textarea id="quality-clock-candidate-text" maxlength="2000" required></textarea></label><button id="quality-clock-publish" type="submit" disabled>${th(msg('qualityClock.publish', '按此显式策略生成候选'))}</button><pre id="quality-clock-publication"></pre></form></section></section>`;
}

export function installQualityCorrespondence(signal: AbortSignal) {
  const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(`quality-clock-${id}`) as T;
  const api = new QualityClient(),
    discovery = new LibraryDiscoveryClient();
  let active = false,
    actor = '',
    selected = '',
    relation: ReferenceRelation | null = null,
    plan: CorrespondencePlan | null = null,
    rangeId = '',
    digest = '',
    nextAu: number | null = null,
    revision = 0,
    relationAfter = 0,
    historyAfter = 0,
    pinSequence = 0;
  const pins = new Map<string, LibraryPairBinding>(),
    sourceSequences = new Map<string, number>(),
    picked = new Map<string, LibraryEntry>();
  let clientId = '';
  try {
    clientId = sessionStorage.getItem('voidplayer-clock-client') ?? randomUUID();
    sessionStorage.setItem('voidplayer-clock-client', clientId);
  } catch {
    clientId = randomUUID();
  }
  const observation = new QualityObservationScope();
  const submissions = { relation: 0, plan: 0 };
  const context = (level: 'actor' | 'selection' = 'actor', key?: string) => ({
    actor,
    ...observation.capture(level, key),
    view: observation.capture('selection'),
  });
  const valid = (c: ReturnType<typeof context>) =>
    active && !signal.aborted && c.current() && c.actor === actor && confirmedActor()?.id === c.actor;
  const value = (id: string) => $(id) as HTMLInputElement,
    integer = (id: string) => Number(value(id).value);
  function message(error: unknown) {
    $('status').textContent = error instanceof Error ? error.message : String(error);
  }
  const pendingKey = (owner: string, kind: string) => `voidplayer-clock-pending:${owner}:${kind}`;
  const journals = Object.fromEntries(
    (['relation', 'plan'] as const).map((kind) => [
      kind,
      new FrozenSubmissionJournal<unknown>(
        sessionStorage,
        (owner) => pendingKey(owner, kind),
        kind === 'relation' ? referenceRelationInput : correspondenceInput,
        {
          read(value: any) {
            if (typeof value?.body !== 'string') throw Error('Invalid stored correspondence submission');
            return { ...value, body: JSON.parse(value.body) };
          },
          write(value) {
            return { ...value, body: JSON.stringify(value.body) };
          },
        },
      ),
    ]),
  ) as Record<'relation' | 'plan', FrozenSubmissionJournal<unknown>>;
  const pending = (owner: string, kind: 'relation' | 'plan') => journals[kind].pending(owner);
  function canStartNewPlan() {
    try {
      const saved = pending(actor, 'plan');
      return (
        active && !!plan && terminalCorrespondence(plan.state) && confirmedActor()?.id === actor && (!saved || saved.confirmed === true)
      );
    } catch {
      return false;
    }
  }
  function refreshNewPlan() {
    value('new-plan').disabled = !canStartNewPlan();
    $('new-plan').hidden = !plan || !terminalCorrespondence(plan.state);
  }
  function renderPending() {
    let outstanding = false;
    for (const kind of ['relation', 'plan'] as const) {
      let saved,
        invalid = false;
      try {
        saved = pending(actor, kind);
      } catch {
        invalid = true;
      }
      const unknown = invalid || (!!saved && !saved.confirmed);
      outstanding ||= unknown;
      $(`pending-${kind}`).hidden = !unknown;
      $(`pending-body-${kind}`).textContent = unknown
        ? saved
          ? JSON.stringify(saved.body)
          : (sessionStorage.getItem(pendingKey(actor, kind)) ?? 'Invalid stored request')
        : '';
      for (const input of $(kind === 'relation' ? 'relation-form' : 'plan-form').querySelectorAll<
        HTMLInputElement | HTMLButtonElement | HTMLTextAreaElement | HTMLSelectElement
      >('input,button,textarea,select'))
        input.disabled = unknown;
    }
    $('pending').hidden = !outstanding;
    refreshNewPlan();
  }
  function commandKey(c: ReturnType<typeof context>, kind: 'relation' | 'plan', body: unknown, newAttempt = false) {
    const journal = journals[kind],
      saved = journal.pending(c.actor);
    if (saved && JSON.stringify(saved.body) === JSON.stringify(body) && !newAttempt) return saved.key;
    if (saved && !saved.confirmed) throw Error(t(msg('qualityClock.pendingConflict', '先重试原冻结请求，或显式结束本地重试后再编辑。')));
    try {
      journal.clearConfirmed(c.actor);
      const frozen = journal.freeze(c.actor, body);
      renderPending();
      return frozen.key;
    } catch {
      throw Error(t(msg('qualityClock.storageRequired', '无法持久保存重试键，请允许此页使用会话存储后再提交。')));
    }
  }
  async function submitFrozen(kind: 'relation' | 'plan', key: string, c: ReturnType<typeof context>) {
    const sequence = ++submissions[kind],
      receipt = context('actor');
    try {
      const r = await journals[kind].execute(
        c.actor,
        key,
        (p) =>
          api.request<{ relation?: ReferenceRelation; plan?: CorrespondencePlan; replayed: boolean }>(
            c.actor,
            '/api/quality/' + (kind === 'relation' ? 'reference-relations' : 'correspondence-plans'),
            c.signal,
            'POST',
            p.body,
            p.key,
          ),
        (r, p) => {
          assertCorrespondenceReceipt(r, c.actor, p, kind);
        },
        true,
        'keep',
      );
      // Acceptance belongs to this actor/key even if another plan is now open.
      if (valid(receipt)) renderPending();
      if (!valid(c) || !c.view.current() || sequence !== submissions[kind]) return;
      $('status').textContent = '';
      if (kind === 'relation') {
        await chooseRelation(r.relation!);
        if (valid(c)) await lists('relations');
      } else {
        clearDetail();
        selected = r.plan!.id;
        const next = context('selection');
        await lists('history');
        if (valid(next)) await detail();
      }
    } finally {
      if (valid(receipt)) renderPending();
    }
  }
  function segment(start = 0, end = 1000000, offset = 0, exact?: { ticks: number; timescale: number }) {
    const row = document.createElement('div');
    row.className = 'quality-roi';
    row.dataset.clockSegment = randomUUID();
    const field = (name: string, text: string, n: number) => {
      const label = document.createElement('label');
      label.textContent = text;
      const input = document.createElement('input');
      input.type = 'number';
      input.step = '1';
      input.required = true;
      input.dataset.segmentField = name;
      input.value = String(n);
      label.append(input);
      row.append(label);
      return { label, input };
    };
    field('start', t(msg('qualityClock.segmentStart', '参考开始 (µs)')), start);
    field('end', t(msg('qualityClock.segmentEnd', '参考结束 (µs)')), end);
    const isNtsc = exact && [30000, 24000, 60000].includes(exact.timescale) && exact.ticks % 1001 === 0;
    const value = field('offset', t(msg('qualityClock.segmentOffset', '偏移')), exact ? exact.ticks / (isNtsc ? 1001 : 1) : offset);
    const unitLabel = document.createElement('label');
    unitLabel.textContent = t(msg('qualityClock.offsetUnit', '偏移单位'));
    const unit = document.createElement('select');
    unit.dataset.segmentUnit = '';
    for (const [key, title] of [
      ['microseconds', t(msg('qualityClock.microseconds', '微秒'))],
      ['frames', t(msg('qualityClock.frames', '帧'))],
    ]) {
      const option = document.createElement('option');
      option.value = key;
      option.textContent = title;
      unit.append(option);
    }
    unit.value = exact ? 'frames' : 'microseconds';
    unitLabel.append(unit);
    row.append(unitLabel);
    const numerator = field('rate', t(msg('qualityClock.rateNumerator', '帧率分子')), exact?.timescale ?? 30000),
      denominator = field('rateDenominator', t(msg('qualityClock.rateDenominator', '帧率分母')), exact ? (isNtsc ? 1001 : 1) : 1001);
    numerator.input.min = denominator.input.min = '1';
    const update = () => {
      const frames = unit.value === 'frames';
      for (const f of [numerator, denominator]) {
        f.label.hidden = !frames;
        f.input.disabled = !frames;
      }
      value.input.title = frames ? t(msg('qualityClock.frameOffsetHelp', '按精确帧率换算；例如 1 帧、30000/1001 fps。')) : '';
    };
    unit.onchange = update;
    update();
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = t(msg('qualityClock.removeSegment', '移除此段'));
    remove.onclick = () => row.remove();
    row.append(remove);
    $('segments').append(row);
  }
  function readSegments() {
    return [...$('segments').children].map((row, i) => {
      const n = (name: string) => Number((row.querySelector(`[data-segment-field="${name}"]`) as HTMLInputElement).value);
      const exact =
        (row.querySelector('[data-segment-unit]') as HTMLSelectElement).value === 'frames'
          ? { ticks: n('offset') * n('rateDenominator'), timescale: n('rate') }
          : undefined;
      return {
        id: `segment-${i + 1}`,
        referenceStartUs: n('start'),
        referenceEndUs: n('end'),
        offsetUs: exact ? clockToUs(exact) : n('offset'),
        ...(exact ? { offset: exact } : {}),
      };
    });
  }

  function clearDetail() {
    observation.select();
    selected = '';
    plan = null;
    rangeId = '';
    digest = '';
    nextAu = null;
    revision = 0;
    $('detail').hidden = true;
    for (const id of ['title', 'summary', 'rows', 'execution', 'publication']) $(id).replaceChildren();
    $('show-range').hidden = true;
    $('rows-more').hidden = true;
    value('publish').disabled = true;
    refreshNewPlan();
  }
  function reset() {
    observation.invalidate();
    actor = confirmedActor()?.id ?? '';
    relation = null;
    pins.clear();
    picked.clear();
    sourceSequences.clear();
    relationAfter = 0;
    historyAfter = 0;
    pinSequence++;
    clearDetail();
    for (const id of ['relations', 'history', 'relation', 'builds', 'status']) $(id).replaceChildren();
    $('relations-more').hidden = true;
    $('history-more').hidden = true;
    value('declaration').value = '';
    value('candidate-text').value = '';
    $('segments').replaceChildren();
    segment();
    for (const side of sides) {
      const root = document.querySelector<HTMLElement>(`[data-clock-source="${side}"]`)!;
      root.querySelector('[data-clock-media]')!.replaceChildren();
      root.querySelector('[data-clock-source-status]')!.textContent = '';
      (root.querySelector('[data-clock-search]') as HTMLInputElement).value = '';
    }
    renderPending();
  }
  async function pin() {
    if (!relation) throw Error(t(msg('qualityClock.chooseRelation', '先选择一条关系声明。')));
    const c = context(),
      id = relation.id,
      sequence = ++pinSequence;
    pins.clear();
    $('builds').textContent = '';
    for (const side of sides) {
      const source = relation.input[side],
        proof = await api.source(c.actor, source.mediaId, source.mediaVersion, c.signal);
      if (!valid(c) || relation?.id !== id || sequence !== pinSequence || !c.view.current()) return;
      pins.set(side, proof);
    }
    $('builds').textContent = sides.map((side) => `${label(side)}: ${pins.get(side)!.binding.indexBuildId}`).join('\n');
  }
  async function chooseRelation(item: ReferenceRelation) {
    pinSequence++;
    $('status').textContent = '';
    relation = item;
    picked.clear();
    for (const side of sides) {
      const source = item.input[side];
      picked.set(side, { id: source.mediaId, version: source.mediaVersion, name: source.mediaId, root: '', size: 0, lastModified: 0 });
      document.querySelector(`[data-clock-source="${side}"] [data-clock-source-status]`)!.textContent =
        source.mediaId + ' · ' + source.mediaVersion;
    }
    pins.clear();
    clearDetail();
    $('builds').textContent = '';
    $('relation').textContent = JSON.stringify(item, null, 2);
    value('declaration').value = item.input.declaration;
    $('segments').replaceChildren();
    for (const s of item.input.clock.segments) segment(s.referenceStartUs, s.referenceEndUs, s.offsetUs, s.offset);
    renderPending();
  }
  function lists(kind: 'relations' | 'history', more = false): Promise<void> {
    const after = more ? (kind === 'relations' ? relationAfter : historyAfter) : 0;
    return observation.run(
      kind,
      'actor',
      async () => {
        const c = context('actor', kind);
        if (!active || signal.aborted || !c.actor) return;
        try {
          const page = await api.request<{ entries: (ReferenceRelation | { id: string; state: string })[]; after: number; more: boolean }>(
            c.actor,
            `/api/quality/${kind === 'relations' ? 'reference-relations' : 'correspondence-plans'}?after=${after}&limit=10`,
            c.signal,
          );
          if (!valid(c)) return;
          if (kind === 'relations') relationAfter = page.after;
          else historyAfter = page.after;
          $(kind + '-more').hidden = !page.more;
          const root = $(kind);
          if (!more) root.replaceChildren();
          for (const item of page.entries) {
            const button = document.createElement('button'),
              row = context('actor');
            button.type = 'button';
            if (kind === 'relations') {
              button.dataset.clockRelation = item.id;
              button.textContent = (item as ReferenceRelation).input.declaration + ' · ' + item.id;
              button.onclick = () => {
                if (valid(row)) void chooseRelation(item as ReferenceRelation);
              };
            } else {
              button.dataset.clockPlan = item.id;
              button.textContent = item.id + ' · ' + (item as { state: string }).state;
              button.onclick = () => {
                if (!valid(row)) return;
                clearDetail();
                selected = item.id;
                void detail();
              };
            }
            root.append(button);
          }
        } catch (e) {
          if (valid(c)) message(e);
        }
      },
      `${more}:${after}`,
    );
  }
  function rows(more = false): Promise<boolean> {
    const after = more ? (nextAu ?? 0) : 0;
    return observation.run(
      'rows',
      'selection',
      async () => {
        const c = context('selection', 'rows'),
          id = selected;
        try {
          const page = await api.request<{ entries: CorrespondenceRow[]; nextAu: number | null; digest: string }>(
            c.actor,
            `/api/quality/correspondence-plans/${id}/rows?after=${after}&limit=32`,
            c.signal,
          );
          if (!valid(c) || selected !== id) return false;
          if (!more) $('rows').replaceChildren();
          nextAu = page.nextAu;
          $('rows-more').hidden = nextAu === null;
          for (const row of page.entries) {
            const p = document.createElement('pre');
            p.dataset.clockAu = String(row.au);
            p.textContent = JSON.stringify(row, null, 2);
            $('rows').append(p);
          }
          return true;
        } catch (e) {
          if (valid(c) && selected === id) message(e);
          return false;
        }
      },
      `${selected}:${more}:${after}`,
    );
  }
  function detail(): Promise<void> {
    return observation.run('detail', 'selection', async () => {
      if (!selected) return;
      const c = context('selection', 'detail'),
        id = selected;
      try {
        const response = await api.request<{
          plan: CorrespondencePlan;
          summary: unknown;
          execution: { rangeId: string | null; state: string } | null;
        }>(c.actor, `/api/quality/correspondence-plans/${id}`, c.signal);
        if (!valid(c) || selected !== id) return;
        plan = response.plan;
        refreshNewPlan();
        digest = plan.resultDigest ?? '';
        $('detail').hidden = false;
        $('title').textContent = id + ' · ' + plan.state;
        $('summary').textContent = JSON.stringify(
          { relation: plan.relation, input: plan.input, attemptId: plan.attemptId, summary: response.summary, reason: plan.reason },
          null,
          2,
        );
        value('execute').disabled = plan.state !== 'completed';
        value('cancel').disabled = !['queued', 'running'].includes(plan.state);
        if (digest && revision !== plan.revision) {
          const loaded = await rows();
          if (!valid(c) || selected !== id) return;
          if (loaded) revision = plan.revision;
        }
        rangeId = response.execution?.rangeId ?? '';
        $('show-range').hidden = !rangeId;
        $('execution').textContent = response.execution ? JSON.stringify(response.execution) : '';
        if (rangeId) {
          const r = await api.request<{ job: QualityRangeJob }>(c.actor, `/api/quality/ranges/${rangeId}`, c.signal);
          if (!valid(c) || selected !== id) return;
          $('execution').textContent = rangeId + ' · ' + r.job.state + ' · ' + r.job.summary.scoredPairs;
          value('publish').disabled = ['queued', 'running', 'cancelling'].includes(r.job.state);
        }
      } catch (e) {
        if (valid(c) && selected === id) message(e);
      }
    });
  }
  for (const side of sides) {
    const root = document.querySelector<HTMLElement>(`[data-clock-source="${side}"]`)!;
    let cursor: string | null = null;
    async function search(more = false) {
      const c = context(),
        seq = (sourceSequences.get(side) ?? 0) + 1;
      sourceSequences.set(side, seq);
      try {
        const params = new URLSearchParams({
          search: (root.querySelector('[data-clock-search]') as HTMLInputElement).value,
          includeUnknown: '1',
          limit: '20',
          ...(more && cursor ? { cursor } : {}),
        });
        const page = await discovery.browse(params, c.actor, c.signal);
        if (!valid(c) || sourceSequences.get(side) !== seq) return;
        cursor = page.nextCursor;
        (root.querySelector('[data-clock-more]') as HTMLElement).hidden = cursor === null;
        const list = root.querySelector('[data-clock-media]')!;
        if (!more) list.replaceChildren();
        for (const item of page.entries) {
          const entry: LibraryEntry = {
              id: item.source.id,
              version: item.source.version,
              name: item.file.name,
              root: item.file.root,
              size: item.file.size,
              state: item.file.state,
              lastModified: 0,
            },
            b = document.createElement('button');
          b.type = 'button';
          b.dataset.clockMedia = entry.id;
          b.textContent = entry.name + ' · ' + entry.version + ' · ' + item.scoring.state;
          b.onclick = () => {
            if (!valid(c)) return;
            picked.set(side, entry);
            root.querySelector('[data-clock-source-status]')!.textContent =
              entry.name + ' · ' + entry.version + ' · ' + item.scoring.state + ' · ' + item.scoring.reason;
          };
          list.append(b);
        }
      } catch (e) {
        if (valid(c) && sourceSequences.get(side) === seq) message(e);
      }
    }
    (root.querySelector('[data-clock-search-button]') as HTMLButtonElement).onclick = () => void search();
    (root.querySelector('[data-clock-more]') as HTMLButtonElement).onclick = () => void search(true);
  }
  $('add-segment').onclick = () => segment();
  $('relation-form').onsubmit = (event) => {
    event.preventDefault();
    const c = context();
    void (async () => {
      try {
        const source = (side: string) => {
          const e = picked.get(side);
          if (!e?.version) throw Error(t(msg('qualityClock.chooseSources', '请显式选择双方媒体版本。')));
          return { mediaId: e.id, mediaVersion: e.version, stream: 'video', configuration: 0 };
        };
        const body = referenceRelationInput({
          schema: 'voidplayer-quality-reference-relation',
          version: 1,
          client: { id: clientId, kind: 'browser' },
          reference: source('reference'),
          distorted: source('distorted'),
          declaration: value('declaration').value,
          clock: { mode: 'piecewise-exact-source-pts-offset', segments: readSegments() },
        });
        await submitFrozen('relation', commandKey(c, 'relation', body), c);
      } catch (e) {
        if (valid(c) && c.view.current()) message(e);
      }
    })();
  };
  $('pin').onclick = () => {
    const c = context();
    void pin().catch((e) => {
      if (valid(c) && c.view.current()) message(e);
    });
  };
  $('plan-form').onsubmit = (event) => {
    event.preventDefault();
    const c = context();
    void (async () => {
      try {
        if (!relation || sides.some((side) => !pins.has(side)))
          throw Error(t(msg('qualityClock.pinRequired', '先读取并固定双方现有缓存。')));
        const body = correspondenceInput({
          schema: 'voidplayer-quality-correspondence-plan',
          version: 1,
          client: { id: clientId, kind: 'browser' },
          relation: { id: relation.id, revision: relation.revision },
          referenceBuildId: pins.get('reference')!.binding.indexBuildId,
          distortedBuildId: pins.get('distorted')!.binding.indexBuildId,
          interval: { startAu: integer('start'), endAu: integer('end') },
          sampling:
            value('sampling').value === 'all' ? { mode: 'all' } : { mode: 'stride', every: integer('every'), offset: integer('offset') },
          recipe: {
            roi: Object.fromEntries(['x', 'y', 'width', 'height'].map((k) => [k, integer(k)])),
            ...(value('ssim').checked ? { ssim: { variant: SSIM_VARIANT } } : {}),
            ...(value('grid').checked ? { spatial: { blockWidth: 16, blockHeight: 16 } } : {}),
            budget: { maxReadBytes: integer('pair-read'), maxInputBytes: integer('pair-input') },
          },
          budget: {
            maxReadBytes: integer('total-read'),
            maxInputBytes: integer('total-input'),
            maxPackets: integer('packets'),
            maxOutputFrames: integer('packets'),
            maxElapsedMs: integer('elapsed'),
          },
          planningBudget: {
            maxIndexBytes: integer('index-bytes'),
            maxIndexPackets: integer('index-packets'),
            maxElapsedMs: integer('planning-elapsed'),
          },
        });
        await submitFrozen('plan', commandKey(c, 'plan', body), c);
      } catch (e) {
        if (valid(c) && c.view.current()) message(e);
      }
    })();
  };
  $('new-plan').onclick = () => {
    const c = context();
    if (!valid(c) || !canStartNewPlan() || !plan) return;
    const body = structuredClone(plan.input);
    try {
      const key = commandKey(c, 'plan', body, true);
      void submitFrozen('plan', key, c).catch((e) => {
        if (valid(c) && c.view.current()) message(e);
      });
    } catch (e) {
      if (valid(c) && c.view.current()) message(e);
    }
  };
  $('vmaf').onclick = () => {
    if (!plan || plan.state !== 'completed' || !plan.attemptId || !plan.resultDigest) return;
    window.dispatchEvent(
      new CustomEvent('voidplayer-vmaf-plan', { detail: { actor, id: plan.id, attemptId: plan.attemptId, digest: plan.resultDigest } }),
    );
  };
  $('xpsnr').onclick = () => {
    if (!plan || plan.state !== 'completed' || !plan.attemptId || !plan.resultDigest) return;
    window.dispatchEvent(
      new CustomEvent('voidplayer-xpsnr-plan', { detail: { actor, id: plan.id, attemptId: plan.attemptId, digest: plan.resultDigest } }),
    );
  };
  $('execute').onclick = () => {
    const c = context(),
      id = selected,
      expected = digest;
    void api
      .request<{ job: QualityRangeJob }>(c.actor, `/api/quality/correspondence-plans/${id}/execute`, c.signal, 'POST', { digest: expected })
      .then(
        () => {
          if (valid(c) && selected === id && c.view.current()) void detail();
        },
        (e) => {
          if (valid(c) && selected === id && c.view.current()) message(e);
        },
      );
  };
  $('cancel').onclick = () => {
    const c = context(),
      id = selected;
    void api.request(c.actor, `/api/quality/correspondence-plans/${id}/cancel`, c.signal, 'POST', {}).then(
      () => {
        if (valid(c) && selected === id && c.view.current()) void detail();
      },
      (e) => {
        if (valid(c) && selected === id && c.view.current()) message(e);
      },
    );
  };
  $('show-range').onclick = () => {
    if (rangeId) window.dispatchEvent(new CustomEvent('voidplayer-quality-range-select', { detail: { id: rangeId, actor } }));
  };
  $('candidate-form').onsubmit = (event) => {
    event.preventDefault();
    const c = context(),
      id = selected,
      target = rangeId;
    void (async () => {
      try {
        if (!target) throw Error('Select a submitted range');
        const policy = rangeCandidatePolicy({
          space: value('space').value,
          side: value('side').value,
          metric: 'psnr',
          maxDb: integer('max-db'),
          limit: integer('top-n'),
          minAuDistance: integer('distance'),
          severity: integer('severity'),
          text: value('candidate-text').value,
        });
        const r = await api.request(c.actor, `/api/quality/ranges/${target}/candidates`, c.signal, 'POST', policy);
        if (valid(c) && selected === id && c.view.current() && rangeId === target)
          $('publication').textContent = JSON.stringify(r, null, 2);
      } catch (e) {
        if (valid(c) && selected === id && c.view.current()) message(e);
      }
    })();
  };
  for (const kind of ['relation', 'plan'] as const) {
    $(`retry-${kind}`).onclick = () => {
      const c = context();
      try {
        const saved = pending(c.actor, kind);
        if (saved && !saved.confirmed)
          void submitFrozen(kind, saved.key, c).catch((e) => {
            if (valid(c) && c.view.current()) message(e);
          });
      } catch (e) {
        message(e);
      }
    };
    $(`forget-${kind}`).onclick = () => {
      try {
        journals[kind].abandon(actor);
        submissions[kind]++;
        renderPending();
        $('status').textContent = '';
      } catch (e) {
        message(e);
      }
    };
  }
  $('refresh').onclick = () =>
    void (async () => {
      await lists('relations');
      await lists('history');
      await detail();
    })();
  $('relations-more').onclick = () => void lists('relations', true);
  $('history-more').onclick = () => void lists('history', true);
  $('rows-more').onclick = () => void rows(true);
  observeIdentity(signal, {
    invalidated: reset,
    confirmed: () => {
      reset();
      if (active) {
        void lists('relations').then(() => lists('history'));
      }
    },
  });
  const timer = setInterval(() => {
    if (active && qualityViewVisible('correspondence') && selected) void detail();
  }, 1000);
  signal.addEventListener(
    'abort',
    () => {
      clearInterval(timer);
      observation.close();
    },
    { once: true },
  );
  segment();
  return {
    activate(value: boolean) {
      if (value === active) return;
      active = value;
      reset();
      if (active) void lists('relations').then(() => lists('history'));
    },
  };
}
