import { installAnnotationActivity } from './annotation-activity.ts';
import { formatTime } from '../../shared/review/model.ts';
import { mergeAnnotationEvents } from '../../shared/review/annotation-events.ts';
import type { AnnotationEvent } from '../../shared/review/annotation-events.ts';
import { localOnly } from '../services/build-profile.ts';
import { t, msg, onLanguageChange } from '../i18n.ts';
import type { ReviewSession } from '../session.ts';
import { AnnotationStorage } from '../review/annotation-storage.ts';
import type { AnnotationDraft } from '../review/annotation-storage.ts';
import { AnnotationClient } from '../review/annotation-client.ts';
import type { AnnotationDocument } from '../../shared/review/annotation-record.ts';
import { annotationDocumentTarget, annotationTarget } from '../../shared/review/annotation-target.ts';
import { currentActor, identityHealth } from '../services/identity.ts';
import { randomUUID } from '../../shared/utils/uuid.ts';
import { AnnotationPendingQueue } from '../review/annotation-pending.ts';
import { annotationThumbnails, thumbnailSignature } from './annotation-thumbnails.ts';
import { publishMarkPreview } from './mark-preview-publish.ts';
import { PollingCadence } from '../services/polling-cadence.ts';

/** Each media version owns an independent cursor and draft queue. Layout changes never select an annotation collection. */
export function installAnnotationSync(session: ReviewSession, editing: () => boolean) {
  const storage = new AnnotationStorage(), life = new AbortController(), client = new AnnotationClient(life.signal);
  const activity = installAnnotationActivity(life.signal), eventsByTarget = new Map<string, AnnotationEvent[]>(), origins = new Map<string, string>();
  const pending = new AnnotationPendingQueue(), cadence = new PollingCadence(3000);
  const targets = new Map<string, { cursor: number; eventCursor?: number; epoch: number; initialized: boolean }>();
  const targetMedia = new Map<string, import('../../shared/media/types.ts').MediaInfo>();
  const assignments = new Map<string, string>(), versions = new Map<string, number>(), managed = new Set<string>();
  let actor = currentActor()?.id ?? 'local', available = false, working = false, saving = 0, generation = 0;
  let activityFailed = false, renderedConflicts = '';
  let idle: Promise<void> = Promise.resolve();
  let localFailure = false;
  let failure = '', drafts: AnnotationDraft[] = [], editTail: Promise<void> = Promise.resolve();
  let owner = randomUUID();
  try {
    if (performance.getEntriesByType('navigation').some(entry => (entry as PerformanceNavigationTiming).type === 'reload'))
      owner = sessionStorage.getItem('voidplayer.annotation-window') || owner;
    sessionStorage.setItem('voidplayer.annotation-window', owner);
  } catch {}
  const own = (draft: AnnotationDraft) => draft.actor === actor && draft.key.startsWith(`${actor}/${draft.space}/${owner}/`);
  function status() {
    const conflicts = drafts.filter(draft => own(draft) && draft.conflict);
    const queued = drafts.filter(draft => own(draft) && !draft.space.startsWith('local-'));
    const remote = available && (queued.length > 0 || session.getState().tracks.some(track => !!track.source));
    const message = failure || (saving || pending.size ? t(msg('sync.savingLocal', '正在保存到本机…'))
      : conflicts.length ? t(msg('sync.pendingCount', '{n, plural, other {# 条标注需要处理}}'), { n: conflicts.length })
      : queued.length && remote ? t(msg('sync.savedPendingSync', '已存本机 · 等待同步'))
      : remote ? t(msg('sync.synced', '已同步')) : t(msg('sync.savedLocal', '已存本机')));
    const output = document.getElementById?.('annotation-status');
    const state = failure || conflicts.length ? 'error' : saving || pending.size || (remote && queued.length) ? 'pending' : 'saved';
    if (output) { output.dataset.state = state; output.textContent = message; }
    window.dispatchEvent(new CustomEvent('voidplayer-annotation-status', { detail: { message, state } }));
    const list = document.getElementById?.('annotation-conflicts');
    if (!list) return;
    const signature = JSON.stringify(conflicts.map(draft => [draft.key, draft.generation, draft.conflict]));
    if (signature === renderedConflicts) return;
    renderedConflicts = signature;
    list.replaceChildren();
    for (const draft of conflicts) {
      const row = document.createElement('div'), label = document.createElement('strong'), reason = document.createElement('p');
      row.className = 'sync-conflict';
      label.textContent = draft.desired?.mark.text || draft.id;
      row.append(label);
      if (draft.desired) {
        const { media, mark } = draft.desired;
        const target = document.createElement('span');
        target.textContent = [media.find(item => item.id === mark.mediaId)?.name, formatTime(mark.frame.ptsUs)].filter(Boolean).join(' · ');
        row.append(target);
      }
      reason.textContent = draft.conflict ?? '';
      const actions = document.createElement('div');
      actions.className = 'sync-conflict-actions';
      const discard = document.createElement('button');
      discard.textContent = t(msg('sync.useServer', '采用服务器版本'));
      discard.onclick = () => void resolve(draft, false);
      actions.append(discard);
      if (draft.desired) {
        const copy = document.createElement('button'); copy.textContent = t(msg('sync.keepCopy', '保留为新标注'));
        copy.onclick = () => void resolve(draft, true); actions.append(copy);
      }
      row.append(reason, actions);
      list.append(row);
    }
  }
  async function refreshDrafts() {
    const captured = actor, collected: AnnotationDraft[] = [];
    for (const target of targets.keys()) collected.push(...await storage.drafts(target, captured));
    if (captured === actor && !life.signal.aborted) drafts = collected.filter(own);
  }
  async function resolve(draft: AnnotationDraft, copy: boolean) {
    if (!own(draft)) return;
    try {
      if (copy && draft.desired) {
        const document = structuredClone(draft.desired); document.mark.id = randomUUID();
        await enqueue(document.mark.id, document, draft.space, actor, 0);
      }
      await storage.change(draft.key, current => current?.generation === draft.generation ? undefined : current);
      await sync();
    } catch (error) { failure = (error as Error).message; status(); }
  }
  function targetState(target: string) {
    if (!targets.has(target)) targets.set(target, { cursor: 0, epoch: 0, initialized: false });
    return targets.get(target)!;
  }
  async function enqueue(id: string, document: AnnotationDocument | null, target: string, actorId: string, base?: number) {
    targetState(target); assignments.set(id, target); managed.add(id);
    const key = `${actorId}/${target}/${owner}/${id}`;
    const value = pending.stage(key, { id, document, base: base ?? versions.get(`${target}/${id}`) ?? 0, space: target, actorId });
    await persist(key, value);
    await refreshDrafts();
    cadence.reset();
  }
  async function persist(key: string, value: ReturnType<AnnotationPendingQueue['stage']>) {
    await pending.runIfCurrent(key, value, async () => {
      await storage.change(key, previous => ({ key, space: value.space, actor: value.actorId, id: value.id,
        base: previous?.base ?? value.base, desired: value.document, generation: (previous?.generation ?? 0) + 1,
        ...(previous?.attempt ? { attempt: previous.attempt, sentGeneration: previous.sentGeneration } : {}),
        ...(previous?.conflict ? { conflict: previous.conflict } : {}) }));
      pending.removeIfCurrent(key, value);
    });
  }
  const unsubscribeMarks = session.subscribeMarkChanges((id, document) => {
    const capturedActor = actor, snapshot = document ? structuredClone(document) : null;
    if (snapshot) for (const media of snapshot.media) if (media.source) media.source.url = new URL(media.source.url, location.href).href;
    saving++; status(); cadence.reset();
    editTail = editTail.then(async () => {
      const target = snapshot ? await annotationDocumentTarget(snapshot, location.href) : assignments.get(id);
      if (target) await enqueue(id, snapshot, target, capturedActor);
    }).catch(error => { localFailure = true; failure = (error as Error).message; }).finally(() => { saving--; status(); });
  });
  async function discover() {
    for (const track of session.getState().tracks) {
      const target = await annotationTarget(track, location.href); targetState(target); targetMedia.set(target, track);
      if (track.source) origins.set(target, new URL(track.source.url, location.href).origin);
    }
  }
  function mapDocument(document: AnnotationDocument, target: string): AnnotationDocument {
    const loaded = targetMedia.get(target), primary = document.media.find(media => media.id === document.mark.mediaId);
    if (!loaded?.source || !primary?.source) return document;
    const original = new URL(primary.source.url, location.href).origin, current = new URL(loaded.source.url, location.href).origin;
    if (original === current) return document;
    const mapped = structuredClone(document);
    for (const media of mapped.media) if (media.source) {
      const url = new URL(media.source.url, location.href);
      if (url.origin === original) media.source.url = new URL(url.pathname + url.search, current).href;
    }
    return mapped;
  }
  async function apply() {
    if (editing() || saving || pending.size || life.signal.aborted) return;
    const stamp = generation, documents: AnnotationDocument[] = [], nextDrafts: AnnotationDraft[] = [];
    for (const target of targets.keys()) {
      const records = await storage.records(target), localDrafts = (await storage.drafts(target, actor)).filter(own);
      nextDrafts.push(...localDrafts);
      const protectedIds = new Set(localDrafts.map(draft => draft.id));
      for (const record of records) {
        assignments.set(record.id, target); managed.add(record.id); versions.set(`${target}/${record.id}`, record.revision);
        if (!record.deleted && !protectedIds.has(record.id)) documents.push(mapDocument(record.document, target));
      }
      for (const draft of localDrafts) { managed.add(draft.id); if (draft.desired) documents.push(mapDocument(draft.desired, target)); }
      const previews = await storage.previews(target, documents.map(document => document.mark.id));
      for (const [id, preview] of previews) {
        const mark = documents.find(document => document.mark.id === id)?.mark;
        if (mark && preview.signature === thumbnailSignature(mark)) publishMarkPreview(id, preview);
      }
      if (available && !target.startsWith('local-')) for (const record of records) if (!record.deleted) {
        if (!annotationThumbnails.get(record.id)?.url.startsWith('data:') || annotationThumbnails.get(record.id)?.signature !== thumbnailSignature(record.document.mark)) publishMarkPreview(record.id,
          { url: `/api/annotations/media/${target}/${record.id}/preview?revision=${record.revision}`, width: 320, height: 180 });
      }
    }
    if (stamp !== generation || editing() || saving || pending.size || life.signal.aborted) return;
    drafts = nextDrafts;
    session.applyStoredAnnotations(documents, [...managed]); status();
  }
  const uploaded = new Map<string, string>();
  async function uploadPreviews() {
    if (!available || session.getState().playing || editing()) return;
    let count = 0;
    for (const [target, state] of targets) {
      if (target.startsWith('local-')) continue;
      for (const record of await storage.records(target)) {
        if (record.deleted || count >= 4) continue;
        const preview = await storage.preview(target, record.id), signature = thumbnailSignature(record.document.mark);
        if (!preview?.url.startsWith('data:image/jpeg;base64,') || preview.signature !== signature) continue;
        const key = `${target}/${record.id}`, token = `${record.revision}/${state.epoch}/${signature}`;
        if (uploaded.get(key) === token) continue;
        count++;
        const blob = await fetch(preview.url).then(response => response.blob());
        const response = await fetch(`/api/annotations/media/${target}/${record.id}/preview?revision=${record.revision}&epoch=${state.epoch}`,
          { method: 'PUT', headers: { 'x-voidplayer-action': 'annotation', 'x-voidplayer-actor': actor, 'content-type': 'image/jpeg' },
            body: blob, signal: AbortSignal.any([life.signal, AbortSignal.timeout(10000)]) });
        if (response.ok) uploaded.set(key, token);
      }
    }
  }
  async function sync() {
    if (life.signal.aborted) return;
    if (working) return idle;
    cadence.ready(!document.hidden);
    working = true; activityFailed = false;
    let release!: () => void; idle = new Promise(resolve => { release = resolve; });
    const stamp = generation, actorId = actor;
    try {
      await editTail; await discover();
      for (const [key, value] of pending.snapshot()) await persist(key, value);
      if (pending.size) return;
      localFailure = false;
      for (const [target, state] of targets) {
        if (!available || target.startsWith('local-')) continue;
        for (const queued of (await storage.drafts(target, actorId)).filter(draft => own(draft) && !draft.conflict)) {
          if (stamp !== generation || actorId !== actor) return;
          const draft = await storage.change(queued.key, current => {
            if (!current || current.conflict) return current;
            if (!current.attempt) {
              current.attempt = { operationId: randomUUID(), id: current.id, revision: current.base,
                action: current.desired ? 'put' : 'delete', client: { kind: 'gui', id: owner },
                ...(current.desired ? { document: current.desired } : {}) };
              current.sentGeneration = current.generation;
            }
            return current;
          });
          if (!draft?.attempt) continue;
          if (!draft.base && !draft.desired && !draft.attempt.document) { await storage.change(draft.key, () => undefined); continue; }
          try {
            const record = await client.mutate(target, draft.attempt, actorId);
            await storage.remember([record]);
            versions.set(`${target}/${record.id}`, record.revision);
            await storage.change(draft.key, current => {
              if (current?.attempt?.operationId !== draft.attempt!.operationId) return current;
              return current.generation === current.sentGeneration ? undefined
                : { ...current, base: record.revision, attempt: undefined, sentGeneration: undefined };
            });
          } catch (error) {
            const code = (error as { status?: number }).status;
            if (code && code >= 400 && code < 500 && ![408, 429].includes(code))
              await storage.change(draft.key, current => current ? { ...current, conflict: (error as Error).message } : undefined);
            else throw error;
          }
        }
        if (stamp !== generation) return;
        // Operation history detects database resets independently of the merged object cursor.
        let reset = !state.initialized, eventCursor = state.eventCursor;
        try {
          const events = await client.events(target, state.eventCursor);
          reset ||= events.resetRequired;
          eventsByTarget.set(target, mergeAnnotationEvents(eventsByTarget.get(target) ?? [], events));
          eventCursor = events.cursor;
        } catch { activityFailed = true; }
        const snapshot: import('../../shared/review/annotation-record.ts').AnnotationRecord[] = [];
        let page, cursor = reset ? 0 : state.cursor;
        do {
          page = await client.changes(target, cursor);
          if (stamp !== generation || life.signal.aborted) return;
          if (reset) snapshot.push(...page.entries); else await storage.remember(page.entries); cursor = page.cursor; state.epoch = page.previewEpoch ?? 0;
        } while (page.more);
        if (reset) await storage.replaceRecords(target, snapshot);
        state.cursor = cursor; state.eventCursor = eventCursor; state.initialized = true;
      }
      failure = '';
      if (stamp === generation) await apply();
      if (stamp === generation) activity.update(available ? 'media' : 'local', [...eventsByTarget.values()].flat().sort((a, b) => a.sequence - b.sequence).slice(-50), activityFailed, origins);
      if (stamp === generation) await uploadPreviews().catch(() => {});
      cadence.observe([...targets].map(([target, state]) => [target, state.cursor, state.eventCursor]), activityFailed || !!saving || !!pending.size || drafts.some(draft => own(draft) && !draft.conflict));
    } catch (error) {
      if (!life.signal.aborted && stamp === generation) {
        failure = available ? t(msg('sync.disconnectedKeepDrafts', '连接中断 · 本机草稿保留')) : (error as Error).message;
        cadence.reset(); await apply();
      }
    } finally {
      await refreshDrafts().catch(error => { localFailure = true; failure = (error as Error).message; });
      working = false; release(); status();
    }
  }
  window.addEventListener('voidplayer-annotation-preview', event => {
    const { id, preview } = (event as CustomEvent).detail, target = assignments.get(id);
    if (!target || !preview.url.startsWith('data:image/jpeg;base64,')) return;
    void storage.savePreview(target, id, preview).then(() => cadence.reset()).catch(() => {});
  }, { signal: life.signal });
  let signature = '';
  const unsubscribe = session.subscribe(() => {
    const next = session.getState().tracks.map(track => [track.id, track.source?.url].join(':')).join('|');
    if (next !== signature) { signature = next; cadence.reset(); void discover().then(apply).catch(error => { failure = (error as Error).message; status(); }); }
  });
  async function connect() {
    if (life.signal.aborted) return;
    try {
      if (!localOnly) {
        const health = await identityHealth();
        const next = health.actor?.id ?? 'local';
        if (next !== actor) { actor = next; generation++; }
        available = !!health.actor && !!health.capabilities?.annotations;
      }
      cadence.reset(); await sync();
    } catch (error) { failure = (error as Error).message; status(); }
  }
  const resume = () => { cadence.reset(); if (!document.hidden) void sync(); };
  const timer = setInterval(() => { if (cadence.ready(!document.hidden)) void sync(); }, 1000);
  window.addEventListener('focus', resume, { signal: life.signal });
  window.addEventListener('online', () => void connect(), { signal: life.signal });
  window.addEventListener('voidplayer-identity-change', () => { generation++; actor = currentActor()?.id ?? 'local'; void connect(); }, { signal: life.signal });
  document.addEventListener('visibilitychange', resume, { signal: life.signal });
  window.addEventListener('beforeunload', event => { if (saving || pending.size || localFailure) { event.preventDefault(); event.returnValue = ''; } }, { signal: life.signal });
  onLanguageChange(() => { renderedConflicts = ''; status(); }, life.signal);
  void connect();
  return { locallySaved: () => !saving && !pending.size && !localFailure, sync,
    dispose() { life.abort(); clearInterval(timer); unsubscribe(); unsubscribeMarks(); return Promise.allSettled([editTail, idle]).then(() => storage.close()); } };
}
