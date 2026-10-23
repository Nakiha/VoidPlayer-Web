import type { MediaIndexIdentity } from './media-index-identity.ts';
import type { CachedField } from './semantic-query.ts';

export const TECHNICAL_FILTER_PATH = '/api/library/technical-filter';
export const TECHNICAL_FILTER_SCHEMA = 'voidplayer-cached-technical-filter';
export const TECHNICAL_FILTER_LIMITS = { candidates: 8, identitiesPerCandidate: 8, projectionBytesPerIdentity: 45056, responseBytes: 262144 } as const;
export type TechnicalDecision = 'match' | 'not-match' | 'unknown';
export type TechnicalSource = { id: string; version: string };
export type TechnicalFilters = { codec?: string; minWidth?: number; maxWidth?: number; minHeight?: number; maxHeight?: number; recordsReady?: true };
export type TechnicalFilterQuery = { sources: TechnicalSource[]; filters: TechnicalFilters; byteBudget: number };
export function parseTechnicalFilter(params: URLSearchParams): TechnicalFilterQuery {
  const allowed = ['candidate', 'codec', 'minWidth', 'maxWidth', 'minHeight', 'maxHeight', 'recordsReady', 'byteBudget'];
  for (const key of params.keys()) if (!allowed.includes(key) || key !== 'candidate' && params.getAll(key).length !== 1) throw Error('Unknown or duplicate technical filter parameter; v1 has no cursor.');
  const candidates = params.getAll('candidate');
  if (!candidates.length || candidates.length > TECHNICAL_FILTER_LIMITS.candidates) throw Error('Supply 1..8 candidate=ID@VERSION from browse.');
  const sources = candidates.map(value => {
    const match = /^([0-9a-f]{24})@([0-9a-f]{24})$/.exec(value);
    if (!match) throw Error('Pin each candidate as ID@VERSION.');
    return { id: match[1], version: match[2] };
  }).sort((a, b) => a.id.localeCompare(b.id));
  if (new Set(sources.map(s => s.id)).size !== sources.length) throw Error('Duplicate candidate.');
  const filters: TechnicalFilters = {};
  if (params.has('codec')) {
    const value = params.get('codec')!;
    if (!/^[a-z0-9_+-]{1,64}$/i.test(value)) throw Error('Invalid codec token.');
    filters.codec = value.toLowerCase();
  }
  for (const key of ['minWidth', 'maxWidth', 'minHeight', 'maxHeight'] as const) if (params.has(key)) {
    const value = params.get(key)!;
    if (!/^[1-9][0-9]{0,4}$/.test(value) || Number(value) > 16384) throw Error('Dimensions must be integers 1..16384.');
    filters[key] = Number(value);
  }
  for (const [min, max] of [['minWidth', 'maxWidth'], ['minHeight', 'maxHeight']] as const) if (filters[min] !== undefined && filters[max] !== undefined && filters[min]! > filters[max]!) throw Error('Dimension minimum exceeds maximum.');
  if (params.has('recordsReady')) {
    if (params.get('recordsReady') !== '1') throw Error('v1 supports recordsReady=1 only.');
    filters.recordsReady = true;
  }
  if (!Object.keys(filters).length) throw Error('Supply at least one technical condition.');
  const budget = params.get('byteBudget') ?? '65536';
  if (!/^[1-9][0-9]{3,5}$/.test(budget) || Number(budget) < 8192 || Number(budget) > TECHNICAL_FILTER_LIMITS.responseBytes) throw Error('byteBudget must be 8192..262144.');
  return { sources, filters, byteBudget: Number(budget) };
}

export type TechnicalEvidence = {
  identity: MediaIndexIdentity | null;
  state: TechnicalDecision;
  reason: string | null;
  cacheState: string;
  geometryScope: 'initial-codec-configuration' | 'cached-stream-metadata';
  fields: { codec: CachedField; width: CachedField; height: CachedField; recordsReady: CachedField };
  checks: { condition: keyof TechnicalFilters; state: TechnicalDecision }[];
};
type Overview = { identity: MediaIndexIdentity; state: string; buildState: string | null; terminal: boolean; integrity: string;
  technical: Record<string, CachedField>; capabilities: { records: { implemented: boolean; enabled: boolean; ready: boolean } } };
const unknown = (reason: string): CachedField => ({ value: null, status: 'unknown', source: 'unavailable', reason });
/** Every conjunction is evaluated against one identity. No cross-cache joins. */
export function evaluateTechnicalEvidence(overview: Overview, filters: TechnicalFilters, supported = true): TechnicalEvidence {
  const complete = supported && overview.state === 'complete' && overview.terminal && overview.buildState === 'complete' && overview.integrity === 'complete';
  const fields = { codec: overview.technical.codec, width: overview.technical.width, height: overview.technical.height,
    recordsReady: complete && overview.capabilities.records.implemented && overview.capabilities.records.enabled && overview.capabilities.records.ready
      ? { value: true, status: 'known', source: 'index-observation', reason: 'overview-adapter-ready; payload-not-read' } as CachedField : unknown('record-adapter-not-ready-or-unsupported') };
  const checks = (Object.keys(filters) as (keyof TechnicalFilters)[]).map(condition => {
    const field = condition === 'codec' ? fields.codec : condition === 'recordsReady' ? fields.recordsReady : condition.endsWith('Width') ? fields.width : fields.height;
    let state: TechnicalDecision = 'unknown';
    if (complete && field?.status === 'known') {
      if (condition === 'codec' && typeof field.value === 'string') state = field.value.toLowerCase() === filters.codec ? 'match' : 'not-match';
      else if (condition === 'recordsReady' && field.value === true) state = 'match';
      else if (typeof field.value === 'number') state = (condition.startsWith('min') ? field.value >= Number(filters[condition]) : field.value <= Number(filters[condition])) ? 'match' : 'not-match';
    }
    return { condition, state };
  });
  // Any missing/unsupported condition prevents a known negative conjunction.
  const state: TechnicalDecision = checks.some(c => c.state === 'unknown') ? 'unknown' : checks.some(c => c.state === 'not-match') ? 'not-match' : 'match';
  return { identity: overview.identity, state, reason: !supported ? 'unsupported-cache-identity' : !complete ? 'cache-not-complete' : state === 'unknown' ? 'condition-evidence-unavailable' : null,
    cacheState: overview.state, geometryScope: ['flv', 'js-ts'].includes(overview.identity.kind) ? 'initial-codec-configuration' : 'cached-stream-metadata', fields, checks };
}
export function markTechnicalConflicts(evidence: TechnicalEvidence[]) {
  for (const row of evidence) {
    if (!row.identity) continue;
    const peers = evidence.filter(other => other.identity?.streamKey === row.identity!.streamKey);
    const conflict = (['codec', 'width', 'height'] as const).some(key => new Set(peers.filter(p => p.cacheState === 'complete' && p.fields[key]?.status === 'known')
      .map(p => typeof p.fields[key].value === 'string' ? p.fields[key].value.toLowerCase() : p.fields[key].value)).size > 1);
    if (conflict) { row.state = 'unknown'; row.reason = 'cached-stream-evidence-conflict'; row.checks = row.checks.map(c => ({ ...c, state: 'unknown' })); }
  }
}
export const TECHNICAL_FILTER_FIELDS = {
  schema: TECHNICAL_FILTER_SCHEMA, version: 1, endpoint: TECHNICAL_FILTER_PATH, limits: TECHNICAL_FILTER_LIMITS,
  input: '1..8 explicit candidate=ID@VERSION; exact case-insensitive codec token, inclusive min/max Width/Height 1..16384, recordsReady=1; conditions are AND within one cache identity.',
  decisions: 'Evidence match/not-match/unknown concerns exactly its identity and stream. Partial, unsupported, missing or conflicting evidence is unknown. Source state is match if returned evidence matches, otherwise unknown: streamInventoryComplete is always false, so no whole-source negative is established.',
  geometry: 'FLV/TS initial-codec-configuration; FFmpeg cached-stream-metadata. Neither guarantees dimensions of every picture.',
  recordsReady: 'Existing bounded overview adapter capability only; packet payloads are not read or rehashed and all chunks are not certified.',
  pagination: 'none; rejects cursor/offset. Explicit candidate batch only; no library total. truncated marks omitted identities/evidence; repeat a new bounded query, not a continuation.',
  consistency: 'Single read snapshot, then bounded source/evidence revalidation. Changes return 409; unrelated database writes can conservatively require restart. Snapshot is evidence identity, not a reusable cursor.',
  sideEffects: 'No media-byte reads, probe, scan, build, decode, migration, LRU touch, job scheduling or player commands.',
};
