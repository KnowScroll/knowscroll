/**
 * #132 — the background bridge inquiry context family (ADR-0038 §5), routed by
 * `source_policy_version` like the Ask context (ADR-0017), never guessed from JSON shape.
 *
 * `readInquiryInputs` reads what `selectInquiryPairs` needs; `sealInquiryContext` seals the chosen
 * pairs with every fact they rest on — consent, recording, the route, each place, each claim's
 * support and each pair's disconnection; `validateInquiryContext` rechecks those facts at admission,
 * before sending and before applying. Any change is stale: the inquiry is discarded, never re-sent.
 * Callers hold the universe lock; the shared substrate lock follows it (ADR-0031 §7).
 */
import type pg from 'pg';
import {
  INQUIRY_CONTEXT_LIMITS, INQUIRY_CONTEXT_VERSIONS, INQUIRY_DIRTY_SCOPE, inquiryContextPayload, inquiryDependency, inquiryDependencyKey,
  type InquiryContextPayload, type InquiryContextRefusal, type InquiryDependency,
} from '../../contracts/src/reasoning-inquiry-context.ts';
import type { InquiryCandidateInput, InquiryPair } from '../../core/src/reasoning/bridge-inquiry.ts';
import { ReasoningDenied, validateReasoningPolicy, type ReasoningAuthority, type ReasoningContextCheck, type ReasoningScope } from './reasoning-runtime-policy.ts';
import { canonicalJson, lockSubstrateShared, sha256 } from './semantic/read-set.ts';

type PolicyResolver = ReasoningAuthority['resolvePolicy'];
export type InquiryContextValidation = { valid: true; contentHash: string; readSetHash: string } | { valid: false; reason: InquiryContextRefusal };

const codepoint = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const iso = (v: Date | string) => (v instanceof Date ? v : new Date(v)).toISOString();

function sortDependencies(reads: InquiryDependency[]): InquiryDependency[] {
  const unique = new Map<string, InquiryDependency>();
  for (const read of reads) unique.set(inquiryDependencyKey(read), read);
  return [...unique.values()].sort((a, b) => codepoint(inquiryDependencyKey(a), inquiryDependencyKey(b)));
}

function policyDigest(policy: unknown, scope: ReasoningScope): { version: string; hash: string } {
  const resolved = validateReasoningPolicy(policy, scope).policy;
  return {
    version: resolved.policyVersion,
    hash: sha256(canonicalJson({
      scope: { jobId: scope.jobId, privacyEpoch: scope.privacyEpoch, universeId: scope.universeId },
      policy: { ...resolved, requiredDimensions: [...resolved.requiredDimensions].sort(), buckets: [...resolved.buckets].sort((a, b) => codepoint(a.bucketId, b.bucketId)) },
    })),
  };
}

// The one source title a claim is shown with: its first current supporting source, by key.
const CLAIM_SOURCE = `(SELECT s.title FROM claim_support cs JOIN source_snapshot ss ON ss.id = cs.snapshot_id AND ss.status = 'current'
  JOIN semantic_source s ON s.id = ss.source_id WHERE cs.claim_id = cl.id AND cs.support_kind = 'supports' ORDER BY s.key LIMIT 1)`;
const claimHash = (c: { key: string; statement: string; sourceTitle: string }) => sha256(canonicalJson({ key: c.key, statement: c.statement, sourceTitle: c.sourceTitle }));

/** Everything the pure selection reads, for one universe and epoch. Caller holds the universe lock. */
export async function readInquiryInputs(client: pg.PoolClient, universeId: string, privacyEpoch: number): Promise<InquiryCandidateInput> {
  await lockSubstrateShared(client);
  const places = (await client.query<{ id: string; code: string; name: string }>(
    `SELECT p.id, c.code, c.name FROM atlas_place p JOIN concept c ON c.id = p.anchor_concept_id
     WHERE p.universe_id = $1 AND p.state = 'live' AND p.kind IN ('planet','region') ORDER BY c.code`, [universeId],
  )).rows.map(r => ({ placeId: r.id, code: r.code, name: r.name }));
  const parentOf = new Map((await client.query<{ code: string; parent: string | null }>(
    'SELECT c.code, p.code AS parent FROM concept c LEFT JOIN concept p ON p.id = c.parent_id',
  )).rows.map(r => [r.code, r.parent]));
  const claims = (await client.query<{ key: string; statement: string; supported: boolean; source_title: string | null; links: InquiryCandidateInput['claims'][number]['links'] }>(
    `SELECT cl.key, cl.statement, claim_is_supported(cl.id) AS supported, ${CLAIM_SOURCE} AS source_title,
       COALESCE(json_agg(json_build_object('code', co.code, 'role', cc.role) ORDER BY co.code, cc.role) FILTER (WHERE co.code IS NOT NULL), '[]') AS links
     FROM claim cl LEFT JOIN claim_concept cc ON cc.claim_id = cl.id LEFT JOIN concept co ON co.id = cc.concept_id
     GROUP BY cl.id, cl.key, cl.statement ORDER BY cl.key`,
  )).rows.map(r => ({ key: r.key, statement: r.statement, sourceTitle: r.source_title ?? '', supported: r.supported && r.source_title !== null, links: r.links }));
  const connections = (await client.query<{ from: string; to: string }>(
    `SELECT f.code AS from, t.code AS to FROM concept_relation r JOIN concept f ON f.id = r.from_concept_id JOIN concept t ON t.id = r.to_concept_id
     WHERE r.status = 'active'
     UNION SELECT f.code, t.code FROM bridge b JOIN concept f ON f.id = b.from_concept_id JOIN concept t ON t.id = b.to_concept_id
     WHERE b.status = 'admitted' AND (b.universe_id IS NULL OR b.universe_id = $1)`, [universeId],
  )).rows;
  const suppressed = (await client.query<{ from: string; to: string }>(
    `SELECT f.code AS from, t.code AS to FROM connection_feedback cf JOIN bridge b ON b.id = cf.bridge_id
     JOIN concept f ON f.id = b.from_concept_id JOIN concept t ON t.id = b.to_concept_id
     WHERE cf.universe_id = $1 AND cf.objection = 'seems_wrong'`, [universeId],
  )).rows;
  const asked = (await client.query<{ pairs: { a: { code: string }; b: { code: string } }[] }>(
    'SELECT pairs FROM background_inquiry WHERE universe_id = $1 AND privacy_epoch = $2 AND pairs IS NOT NULL', [universeId, privacyEpoch],
  )).rows.flatMap(r => r.pairs.map(p => [p.a.code, p.b.code] as const));
  return { places, parentOf, claims, connections, suppressed, asked };
}

type SealInput = { universeId: string; privacyEpoch: number; jobId: string; contextId: string; inquiryId: string };

/** Seals the chosen pairs. The Job and the queued inquiry naming this context already exist. */
export async function sealInquiryContext(client: pg.PoolClient, input: SealInput, pairs: readonly InquiryPair[], resolvePolicy: PolicyResolver): Promise<InquiryContextPayload> {
  const scope = { universeId: input.universeId, privacyEpoch: input.privacyEpoch, jobId: input.jobId };
  const job = (await client.query<{ through_sequence: string; policy_version: string }>(
    `SELECT through_sequence::text, policy_version FROM reasoning_job WHERE id=$1 AND universe_id=$2 AND privacy_epoch=$3 AND status='queued' FOR UPDATE`,
    [input.jobId, input.universeId, input.privacyEpoch])).rows[0];
  if (!job) throw new ReasoningDenied('context_unsupported');
  const policy = policyDigest(await resolvePolicy(client, scope), scope);
  if (policy.version !== job.policy_version) throw new ReasoningDenied('context_changed_policy');
  const sealedAt = iso((await client.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0]!.now);
  const own = { universeId: input.universeId, privacyEpoch: input.privacyEpoch };
  const dependencies = sortDependencies([
    { kind: 'inquiry', id: input.inquiryId, ...own, jobId: input.jobId, throughSequence: job.through_sequence },
    { kind: 'consent', ...own }, { kind: 'recording', ...own }, { kind: 'route', policyVersion: policy.version },
    { kind: 'runtime_policy', version: policy.version, hash: policy.hash },
    ...pairs.flatMap((p): InquiryDependency[] => [
      { kind: 'place', id: p.a.placeId, ...own, code: p.a.code }, { kind: 'place', id: p.b.placeId, ...own, code: p.b.code },
      { kind: 'pair', from: p.a.code, to: p.b.code },
      ...[...p.claimsA, ...p.claimsB, ...p.both].map((c): InquiryDependency => ({ kind: 'claim', key: c.key, hash: claimHash(c) })),
    ]),
  ]);
  const parsed = inquiryContextPayload.safeParse({
    version: 1, kind: 'bridge_inquiry_v1', contextId: input.contextId, jobId: input.jobId, inquiryId: input.inquiryId, ...own,
    compilerVersion: INQUIRY_CONTEXT_VERSIONS.compiler, promptVersion: INQUIRY_CONTEXT_VERSIONS.prompt, sourcePolicyVersion: INQUIRY_CONTEXT_VERSIONS.sourcePolicy,
    runtimePolicyVersion: policy.version, runtimePolicyHash: policy.hash, sealedAt, throughSequence: job.through_sequence, pairs, dependencies,
  });
  if (!parsed.success) throw new ReasoningDenied('context_malformed');
  const canonicalPayload = canonicalJson(parsed.data);
  if (Buffer.byteLength(canonicalPayload, 'utf8') > INQUIRY_CONTEXT_LIMITS.maxBytes) throw new ReasoningDenied('context_bounds_exceeded');
  // The facts it rests on must hold now, in this transaction, or nothing is sealed.
  const refusal = await currentRefusal(client, parsed.data);
  if (refusal) throw new ReasoningDenied(`context_${refusal}`);
  const contentHash = sha256(canonicalPayload);
  const rows = dependencies.map(read => ({ identity: inquiryDependencyKey(read), value: canonicalJson(read) }));
  const readSetHash = sha256(canonicalJson(rows));
  await client.query('INSERT INTO reasoning_context(id,job_id,universe_id,privacy_epoch,content_hash,policy_version,source_policy_version) VALUES($1,$2,$3,$4,$5,$6,$7)',
    [input.contextId, input.jobId, input.universeId, input.privacyEpoch, contentHash, policy.version, INQUIRY_CONTEXT_VERSIONS.sourcePolicy]);
  for (const row of rows) {
    await client.query('INSERT INTO reasoning_context_dependency(context_id,universe_id,privacy_epoch,identity,canonical_dependency) VALUES($1,$2,$3,$4,$5)',
      [input.contextId, input.universeId, input.privacyEpoch, row.identity, row.value]);
  }
  await client.query('INSERT INTO reasoning_context_payload(context_id,universe_id,privacy_epoch,canonical_payload,content_hash,read_set_hash) VALUES($1,$2,$3,$4,$5,$6)',
    [input.contextId, input.universeId, input.privacyEpoch, canonicalPayload, contentHash, readSetHash]);
  return parsed.data;
}

/** The first sealed fact that no longer holds, or null. Reads only; the caller already holds its locks. */
async function currentRefusal(client: pg.PoolClient, payload: InquiryContextPayload): Promise<InquiryContextRefusal | null> {
  const { universeId, privacyEpoch, sealedAt } = payload;
  const inquiry = (await client.query<{ status: string; job_id: string | null; context_id: string | null; through_sequence: string | null }>(
    'SELECT status, job_id, context_id, through_sequence::text FROM background_inquiry WHERE id=$1 AND universe_id=$2 AND privacy_epoch=$3',
    [payload.inquiryId, universeId, privacyEpoch])).rows[0];
  if (!inquiry || inquiry.job_id !== payload.jobId || inquiry.context_id !== payload.contextId || inquiry.through_sequence !== payload.throughSequence) return 'corrupt_seal';
  if (inquiry.status !== 'queued') return 'inquiry_closed';
  const consent = (await client.query<{ enabled: boolean; turned_off: boolean }>(
    `SELECT c.enabled, EXISTS (SELECT 1 FROM background_inquiry_consent_request r WHERE r.universe_id = c.universe_id AND r.privacy_epoch = c.privacy_epoch
       AND NOT r.enabled AND r.requested_at > $3::timestamptz) AS turned_off
     FROM background_inquiry_consent c WHERE c.universe_id=$1 AND c.privacy_epoch=$2`, [universeId, privacyEpoch, sealedAt])).rows[0];
  if (!consent?.enabled || consent.turned_off) return 'consent_inactive';
  const recording = (await client.query<{ paused: boolean }>(
    `SELECT u.recording_paused_at IS NOT NULL OR EXISTS (SELECT 1 FROM privacy_recording_receipt p WHERE p.universe_id = u.id AND p.action = 'pause' AND p.applied_at > $2::timestamptz) AS paused
     FROM universe u WHERE u.id=$1`, [universeId, sealedAt])).rows[0];
  if (!recording || recording.paused) return 'recording_paused';
  if (!(await client.query('SELECT 1 FROM background_inquiry_route WHERE policy_version=$1 AND enabled', [payload.runtimePolicyVersion])).rowCount) return 'route_disabled';
  for (const pair of payload.pairs) {
    for (const place of [pair.a, pair.b]) {
      const live = (await client.query<{ code: string }>(
        `SELECT c.code FROM atlas_place p JOIN concept c ON c.id = p.anchor_concept_id
         WHERE p.id=$1 AND p.universe_id=$2 AND p.state='live' AND p.kind IN ('planet','region')`, [place.placeId, universeId])).rows[0];
      if (live?.code !== place.code) return 'place_changed';
    }
    const connected = (await client.query<{ connected: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM concept_relation r JOIN concept f ON f.id = r.from_concept_id JOIN concept t ON t.id = r.to_concept_id
         WHERE r.status = 'active' AND ((f.code=$1 AND t.code=$2) OR (f.code=$2 AND t.code=$1)))
       OR EXISTS (SELECT 1 FROM bridge b JOIN concept f ON f.id = b.from_concept_id JOIN concept t ON t.id = b.to_concept_id
         WHERE b.status = 'admitted' AND (b.universe_id IS NULL OR b.universe_id = $3) AND ((f.code=$1 AND t.code=$2) OR (f.code=$2 AND t.code=$1)))
       OR EXISTS (SELECT 1 FROM connection_feedback cf JOIN bridge b ON b.id = cf.bridge_id JOIN concept f ON f.id = b.from_concept_id JOIN concept t ON t.id = b.to_concept_id
         WHERE cf.universe_id = $3 AND cf.objection = 'seems_wrong' AND ((f.code=$1 AND t.code=$2) OR (f.code=$2 AND t.code=$1))) AS connected`,
      [pair.a.code, pair.b.code, universeId])).rows[0]!;
    if (connected.connected) return 'pair_connected';
    const offered = [...pair.claimsA, ...pair.claimsB, ...pair.both];
    const current = new Map((await client.query<{ key: string; statement: string; supported: boolean; source_title: string | null }>(
      `SELECT cl.key, cl.statement, claim_is_supported(cl.id) AS supported, ${CLAIM_SOURCE} AS source_title FROM claim cl WHERE cl.key = ANY($1::text[])`,
      [offered.map(c => c.key)])).rows.map(r => [r.key, r]));
    for (const c of offered) {
      const now = current.get(c.key);
      if (!now?.supported || now.source_title === null || claimHash({ key: c.key, statement: now.statement, sourceTitle: now.source_title }) !== claimHash(c)) return 'claim_changed';
    }
  }
  return null;
}

type SealedRow = { canonical_payload: string; content_hash: string; metadata_content_hash: string; read_set_hash: string; job_id: string; policy_version: string; source_policy_version: string };

async function loadSealed(client: pg.PoolClient, scope: ReasoningContextCheck): Promise<{ payload: InquiryContextPayload; sealed: SealedRow } | { reason: InquiryContextRefusal }> {
  const sealed = (await client.query<SealedRow>(
    `SELECT p.canonical_payload, p.content_hash, p.read_set_hash, c.job_id, c.content_hash AS metadata_content_hash, c.policy_version, c.source_policy_version
     FROM reasoning_context_payload p JOIN reasoning_context c ON c.id = p.context_id AND c.universe_id = p.universe_id AND c.privacy_epoch = p.privacy_epoch
     WHERE p.context_id=$1 AND p.universe_id=$2 AND p.privacy_epoch=$3`, [scope.contextId, scope.universeId, scope.privacyEpoch])).rows[0];
  if (!sealed) return { reason: 'missing' };
  if (sealed.job_id !== scope.jobId) return { reason: 'foreign' };
  const step = (await client.query('SELECT 1 FROM reasoning_step WHERE id=$1 AND job_id=$2 AND context_id=$3 AND universe_id=$4 AND privacy_epoch=$5',
    [scope.stepId, scope.jobId, scope.contextId, scope.universeId, scope.privacyEpoch])).rowCount;
  if (!step) return { reason: 'foreign' };
  if ((await client.query('SELECT 1 FROM reasoning_context_read WHERE context_id=$1', [scope.contextId])).rowCount) return { reason: 'unsupported' };
  let value: unknown;
  try { value = JSON.parse(sealed.canonical_payload); } catch { return { reason: 'corrupt_seal' }; }
  const payload = inquiryContextPayload.safeParse(value);
  if (!payload.success || canonicalJson(payload.data) !== sealed.canonical_payload || sha256(sealed.canonical_payload) !== sealed.content_hash
    || sealed.content_hash !== sealed.metadata_content_hash || sealed.source_policy_version !== INQUIRY_CONTEXT_VERSIONS.sourcePolicy
    || payload.data.contextId !== scope.contextId || payload.data.jobId !== scope.jobId || payload.data.universeId !== scope.universeId
    || payload.data.privacyEpoch !== scope.privacyEpoch || sealed.policy_version !== payload.data.runtimePolicyVersion) return { reason: 'corrupt_seal' };
  const rows = (await client.query<{ identity: string; canonical_dependency: string }>(
    'SELECT identity, canonical_dependency FROM reasoning_context_dependency WHERE context_id=$1 ORDER BY identity', [scope.contextId])).rows;
  const expected = sortDependencies(payload.data.dependencies).map(read => ({ identity: inquiryDependencyKey(read), value: canonicalJson(read) }));
  try {
    const stored = rows.map(row => {
      const read = inquiryDependency.parse(JSON.parse(row.canonical_dependency));
      if (canonicalJson(read) !== row.canonical_dependency || inquiryDependencyKey(read) !== row.identity) throw new Error('bad dependency');
      return { identity: row.identity, value: row.canonical_dependency };
    }).sort((a, b) => codepoint(a.identity, b.identity));
    if (canonicalJson(stored) !== canonicalJson(expected) || sha256(canonicalJson(stored)) !== sealed.read_set_hash) return { reason: 'corrupt_seal' };
  } catch { return { reason: 'corrupt_seal' }; }
  return { payload: payload.data, sealed };
}

/** The sealed payload of a context, for the worker's byte rebuild and the applying recheck. */
export async function readInquiryPayload(client: pg.PoolClient | pg.Pool, contextId: string): Promise<InquiryContextPayload> {
  const row = (await client.query<{ canonical_payload: string }>('SELECT canonical_payload FROM reasoning_context_payload WHERE context_id=$1', [contextId])).rows[0];
  if (!row) throw new Error('Inquiry context is missing');
  return inquiryContextPayload.parse(JSON.parse(row.canonical_payload));
}

/** ADR-0017 family validator. `lock` may take the shared substrate lock; `recheck` takes no new locks. */
export async function validateInquiryContext(client: pg.PoolClient, scope: ReasoningContextCheck, resolvePolicy: PolicyResolver, phase: 'lock' | 'recheck'): Promise<InquiryContextValidation> {
  const universe = (await client.query<{ privacy_epoch: number }>('SELECT privacy_epoch FROM universe WHERE id=$1', [scope.universeId])).rows[0];
  if (!universe) return { valid: false, reason: 'foreign' };
  if (universe.privacy_epoch !== scope.privacyEpoch) return { valid: false, reason: 'obsolete_epoch' };
  const loaded = await loadSealed(client, scope);
  if ('reason' in loaded) return { valid: false, reason: loaded.reason };
  const { payload } = loaded;
  if (payload.runtimePolicyVersion !== scope.policyVersion) return { valid: false, reason: 'unsupported' };
  const job = (await client.query<{ wake_kind: string; class: string; dirty_scope: string | null; through_sequence: string | null; policy_version: string; live: boolean }>(
    `SELECT wake_kind, class, dirty_scope, through_sequence::text, policy_version, deadline > clock_timestamp() AS live FROM reasoning_job
     WHERE id=$1 AND universe_id=$2 AND privacy_epoch=$3`, [scope.jobId, scope.universeId, scope.privacyEpoch])).rows[0];
  if (!job || job.wake_kind !== 'dirty' || job.class !== 'background_inquiry' || job.dirty_scope !== INQUIRY_DIRTY_SCOPE || job.through_sequence !== payload.throughSequence) return { valid: false, reason: 'corrupt_seal' };
  if (!job.live) return { valid: false, reason: 'expired' };
  if (job.policy_version !== scope.policyVersion) return { valid: false, reason: 'changed_policy' };
  if (phase === 'lock') await lockSubstrateShared(client);
  let policy: { version: string; hash: string };
  try { policy = policyDigest(await resolvePolicy(client, { universeId: scope.universeId, privacyEpoch: scope.privacyEpoch, jobId: scope.jobId }), scope); }
  catch (error) { if (error instanceof ReasoningDenied) return { valid: false, reason: 'changed_policy' }; throw error; }
  if (policy.version !== scope.policyVersion || policy.hash !== payload.runtimePolicyHash) return { valid: false, reason: 'changed_policy' };
  const refusal = await currentRefusal(client, payload);
  if (refusal) return { valid: false, reason: refusal };
  return { valid: true, contentHash: loaded.sealed.content_hash, readSetHash: loaded.sealed.read_set_hash };
}
