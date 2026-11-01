import { ClientCapabilities } from '@knowscroll/contracts';
import {
  applyClosingRun,
  runToClose,
  startRunOwner,
  type RecordingReasoningHarness,
  type RunOwner,
} from '../../../reasoning/public.js';
import type {
  EncounterSnapshot,
  ReadContinuations,
  ReadDiscoveryCandidates,
  ReadExactEncounter,
} from '../../content/public.js';
import type { PersonalAuthority, PersonalScopeTx, WithPersonalScope } from '../../identity/public.js';
import { ASSESSMENT_LIFETIME_MS, BUFFER_LIFETIME_MS, bufferIsServable, type BufferKey } from '../domain/buffer.js';
import { JEV_SHORTLIST_LIMIT } from '../domain/jev.js';
import {
  jevSubjectOf,
  planAssessments,
  usableAssessments,
  type JevPool,
  type PooledAssessment,
} from '../domain/jev-pool.js';
import { refKey } from '../domain/policy.js';
import type { ComposerDecision, ComposerSnapshot, SemanticAssessments } from '../domain/types.js';
import { PrepareBufferJobSchema, type PrepareBufferJob } from '../events.js';
import { JEV_ASSESSMENT_VERSION, storedAssessments, type AssessShortlist, type JevResult } from './jev.js';
import type {
  ComposeEncounter,
  PersistComposerDecision,
  ReadBufferSource,
  ReadComposerBuffer,
  ReadHiddenAssets,
  ReadJevPool,
  ReadPreparedEvidenceInput,
  StoreComposerBuffer,
  StoreJevAssessments,
} from './ports.js';
import { assembleSnapshot, evidenceQueryFor, type SnapshotInput } from './snapshot-assembly.js';
import { readRelatedAssetIds } from './related-targets.js';
import { readVerticalCandidates, renderableFormats } from './vertical-candidates.js';

/** Jev, when it is switched on: the assessor, the recording-aware harness it runs on, the model and the person's pool. */
export interface JevPorts {
  readonly assess: AssessShortlist;
  /** Learns the generation recording is at, and closes Jev's run under that generation's fence (D-270). */
  readonly harness: RecordingReasoningHarness;
  /** The configured model name, stored beside the assessments. */
  readonly model: string;
  /** The person's stored assessments, read in the first transaction. */
  readonly readPool: ReadJevPool;
  /** Adds the assessments just paid for to the person's pool, in the second transaction. */
  readonly storePool: StoreJevAssessments;
}

export interface PrepareBufferPorts {
  readonly withPersonalScope: WithPersonalScope;
  readonly readSource: ReadBufferSource;
  readonly readHidden: ReadHiddenAssets;
  readonly readExactEncounter: ReadExactEncounter;
  readonly readDiscoveryCandidates: ReadDiscoveryCandidates;
  readonly readContinuations: ReadContinuations;
  readonly readPrepared: ReadPreparedEvidenceInput;
  readonly readBuffer: ReadComposerBuffer;
  readonly storeBuffer: StoreComposerBuffer;
  readonly persistDecision: PersistComposerDecision;
  readonly compose: ComposeEncounter;
  readonly hashCatalogWatermarks: (watermarks: readonly string[]) => string;
  readonly newId: () => string;
  readonly now: () => Date;
  readonly jev?: JevPorts;
}

export type PrepareBufferSkip =
  | 'universe_unavailable'
  | 'session_superseded'
  | 'source_unavailable'
  | 'region_scoped'
  | 'already_prepared'
  | 'nothing_to_offer'
  /** Recording was paused, resumed or cleared while Jev worked: its result was dropped and nothing was prepared. */
  | 'recording_changed';

export type PrepareBufferResult =
  | {
      readonly kind: 'prepared';
      readonly offers: number;
      /**
       * `off` when Jev is not configured; `reused` when no call was needed (every shortlisted candidate
       * has a stored assessment, or the subject was assessed minutes ago); `assessed` when a call added
       * assessments; `absent` when a call was due but produced nothing usable.
       */
      readonly jev: 'off' | 'reused' | 'assessed' | 'absent';
      readonly jevReason?: string;
    }
  | { readonly kind: 'skipped'; readonly reason: PrepareBufferSkip };

/** One delivery of the job: its stable ID names the Jev business run, and its signal is the worker's stop. */
export interface PrepareBufferDelivery {
  readonly jobId: string;
  readonly signal: AbortSignal;
}

export type PrepareBuffer = (job: PrepareBufferJob, delivery: PrepareBufferDelivery) => Promise<PrepareBufferResult>;

/** Everything read in the first transaction; ranking and the model call use it outside any transaction. */
interface Gathered {
  readonly source: EncounterSnapshot;
  /** The baseline ranking input: without assessments, so the shortlist is chosen the same way every time. */
  readonly rankingInput: SnapshotInput;
  readonly pool?: JevPool;
  /** Who Jev's run is for and the generation recording was at when the job started; absent while recording is paused. */
  readonly owner?: RunOwner;
}

const skipped = (reason: PrepareBufferSkip): PrepareBufferResult => ({ kind: 'skipped', reason });

/**
 * Prepares the buffer for the next vertical move from an activated offer (blueprint §9). Runs in
 * the worker. HTTP navigation later serves this buffer if it is still valid, and otherwise ranks
 * for itself, so nothing here is on the navigation path.
 *
 * Authority: a `system` actor for the payload's universe and epoch, rechecked under the personal
 * lock in both transactions (workers have no HTTP guard). The session must still be at the job's
 * intent revision and the offer must really have been activated.
 * Steps: (1) one transaction reads the session facts, candidates, Hide, prepared context and the
 * person's stored Jev assessments, learns the generation recording is at, and builds the ranking input; (2) outside any
 * transaction, when Jev is on, it assesses only the best baseline candidates that have no usable stored assessment
 * (and none at all when there are none, or the subject was assessed minutes ago), on the recording-aware harness at that
 * generation (D-270); (3) the ranking runs with the stored and new assessments; (4) one transaction rechecks the session, adds
 * what was paid for to the person's pool, persists the decision, replaces the buffer and closes Jev's run. When Jev's run
 * was made it is that whole transaction that runs under the recording fence: a person who paused, resumed or cleared recording
 * meanwhile gets nothing stored (`recording_changed`) and the next navigation ranks for itself.
 * Side effects: `composer.decisions`, `composer.buffers`, `composer.jev_assessments` and Jev's
 * reasoning run. No evidence, no encounter: a buffer is only a prepared ranking.
 * Failure/retry: a redelivery finds the buffer already prepared and does nothing; Jev's run ID is
 * the job ID, so a redelivery cannot pay twice for the same assessment. A Jev failure (a budget
 * stop included) is the absence of new assessments: the stored ones still inform the ranking, and
 * with none the buffer is prepared from the deterministic baseline.
 */
export function makePrepareBuffer(ports: PrepareBufferPorts): PrepareBuffer {
  return async function prepareBuffer(rawJob, delivery) {
    const job = PrepareBufferJobSchema.parse(rawJob);
    const authority: PersonalAuthority = {
      universeId: job.universeId,
      privacyEpoch: job.privacyEpoch,
      actor: { kind: 'system', purpose: 'composer.prepare-buffer' },
    };
    const key: BufferKey = {
      sessionId: job.sessionId,
      intentRevision: job.intentRevision,
      source: { offerId: job.sourceOfferId, exposureId: job.sourceExposureId },
    };

    const entered = await ports.withPersonalScope(authority, (scope) => gather(ports, scope, key));
    if (entered.kind !== 'entered') return skipped('universe_unavailable');
    if (entered.value.kind === 'skip') return skipped(entered.value.reason);
    const gathered = entered.value.gathered;

    const jev = await assessIfDue(ports, authority, gathered, delivery);
    const { snapshot } = assembleSnapshot({
      ...gathered.rankingInput,
      ...(jev.assessments ? { semanticAssessments: jev.assessments } : {}),
    });
    const decision = ports.compose(snapshot);

    const committed = await commitUnderFence(ports, authority, {
      key,
      delivery,
      snapshot,
      decision,
      assessments: jev.assessments,
      jev,
    });
    if (committed.kind === 'dropped') return skipped('recording_changed');
    if (committed.kind !== 'entered') return skipped('universe_unavailable');
    if (committed.value.kind === 'skip') return skipped(committed.value.reason);
    return {
      kind: 'prepared',
      offers: committed.value.offers,
      jev: jev.status,
      ...(jev.reason ? { jevReason: jev.reason } : {}),
    };
  };
}

async function gather(
  ports: PrepareBufferPorts,
  scope: PersonalScopeTx,
  key: BufferKey,
): Promise<{ kind: 'skip'; reason: PrepareBufferSkip } | { kind: 'gathered'; gathered: Gathered }> {
  const skip = (reason: PrepareBufferSkip) => ({ kind: 'skip' as const, reason });
  const now = ports.now();
  // The account gate comes first. The claim is the exposure the buffer is for: Jev's owner check finds it by that.
  const owner = ports.jev && (await startRunOwner(ports.jev.harness, scope, key.source.exposureId));
  const facts = await ports.readSource(scope, {
    sessionId: key.sessionId,
    offerId: key.source.offerId,
    exposureId: key.source.exposureId,
  });
  if (!facts) return skip('source_unavailable');
  if (facts.intentRevision !== key.intentRevision) return skip('session_superseded');
  if (facts.regionScoped) return skip('region_scoped');
  const existing = await ports.readBuffer(scope, key);
  if (existing && bufferIsServable(existing, now)) return skip('already_prepared');
  const pool = await ports.jev?.readPool(scope);
  const capabilities = ClientCapabilities.safeParse(facts.capabilities);
  if (!capabilities.success) return skip('source_unavailable');
  const source = await ports.readExactEncounter(scope, { ...facts.source, capabilities: facts.capabilities });
  if (!source) return skip('source_unavailable');

  const candidates = await readVerticalCandidates(ports.readDiscoveryCandidates, scope, {
    source,
    formats: renderableFormats(capabilities.data.documentSchemas),
    capabilities: facts.capabilities,
    stickyFormat: source.kind,
  });
  const relatedAssetIds = await readRelatedAssetIds(ports.readContinuations, scope, source, candidates);
  const query = evidenceQueryFor(candidates, now.toISOString());
  const evidence = await ports.readPrepared(scope, query);
  const hiddenAssetIds = await ports.readHidden(scope, query.candidateAssetIds ?? []);
  return {
    kind: 'gathered',
    gathered: {
      source,
      ...(pool ? { pool } : {}),
      ...(owner ? { owner } : {}),
      rankingInput: {
        universeId: scope.authority.universeId,
        privacyEpoch: scope.authority.privacyEpoch,
        evaluatedAt: now.toISOString(),
        seed: `buffer:${key.sessionId}:${String(key.intentRevision)}:${key.source.offerId}`,
        mode: 'vertical',
        source,
        // A buffer is the next subject in the source's own format, which is what the client asks for.
        stickyFormat: source.kind,
        excludeSourceSeries: true,
        relatedAssetIds,
        candidates,
        hiddenAssetIds,
        links: [],
        ...(evidence ? { evidence } : {}),
        fallbackContextWatermark: `unprepared:${String(scope.revisionAtEntry)}`,
        hashCatalogWatermarks: ports.hashCatalogWatermarks,
      },
    },
  };
}

interface JevOutcome {
  readonly status: 'off' | 'reused' | 'assessed' | 'absent';
  readonly reason?: string;
  /** How the Jev run must end when the buffer commits; absent when no run was started. */
  readonly result?: JevResult;
  /** What informs the ranking: the person's usable stored assessments plus the ones just made. */
  readonly assessments?: SemanticAssessments;
  /** The assessments just paid for, to add to the person's pool whatever happens to the buffer. */
  readonly paid: readonly PooledAssessment[];
}

/**
 * Asks Jev only about the shortlisted candidates that have no usable stored assessment, and only
 * when the subject was not assessed minutes ago (`planAssessments`). Never inside a transaction.
 */
async function assessIfDue(
  ports: PrepareBufferPorts,
  authority: PersonalAuthority,
  gathered: Gathered,
  delivery: PrepareBufferDelivery,
): Promise<JevOutcome> {
  const { jev } = ports;
  if (!jev) return { status: 'off', paid: [] };
  const now = ports.now();
  const subject = jevSubjectOf(gathered.source);
  const usable = usableAssessments(
    gathered.pool,
    { roleVersion: JEV_ASSESSMENT_VERSION, model: jev.model },
    subject,
    now,
  );
  const informing = (entries: readonly PooledAssessment[]) => assessmentsFor(entries, jev.model);
  const shortlist = baselineShortlist(ports, gathered);
  if (shortlist.length === 0) return { status: 'absent', reason: 'empty_shortlist', paid: [] };
  const plan = planAssessments(shortlist, usable, now);
  if (plan.kind === 'reuse') return { status: 'reused', reason: plan.reason, assessments: informing(usable), paid: [] };

  const result = await jev.assess({
    runId: delivery.jobId,
    authority,
    source: gathered.source,
    shortlist: plan.candidates,
    owner: gathered.owner,
    signal: delivery.signal,
  });
  const absent = (reason: string): JevOutcome => ({
    status: 'absent',
    reason,
    result,
    assessments: informing(usable),
    paid: [],
  });
  if (result.kind === 'absent') return absent(result.reason);
  if (result.entries.length === 0) return absent('no_usable_entries');
  const paid = result.entries.map((entry) => ({ ...entry, subject, assessedAt: now.toISOString() }));
  return { status: 'assessed', result, assessments: informing([...usable, ...paid]), paid };
}

/** The stored form of the entries that inform one ranking; it is valid until the oldest of them expires. */
function assessmentsFor(entries: readonly PooledAssessment[], model: string): SemanticAssessments | undefined {
  if (entries.length === 0) return undefined;
  const oldest = Math.min(...entries.map((entry) => Date.parse(entry.assessedAt)));
  return storedAssessments({
    entries: entries.map(({ assetId, assetRevision, relevance, appropriateness, redundancy }) => ({
      assetId,
      assetRevision,
      relevance,
      appropriateness,
      redundancy,
    })),
    model,
    assessedAt: new Date(oldest),
    lifetimeMs: ASSESSMENT_LIFETIME_MS,
  });
}

/** The best eligible candidates by the deterministic baseline: the ones worth a model's attention. */
function baselineShortlist(ports: PrepareBufferPorts, gathered: Gathered): readonly EncounterSnapshot[] {
  const { snapshot } = assembleSnapshot(gathered.rankingInput);
  const decision = ports.compose(snapshot);
  const byKey = new Map(snapshot.candidates.map((c) => [refKey(c.encounter), c.encounter]));
  return decision.evaluations
    .filter((evaluation) => evaluation.eligible)
    .sort((a, b) => b.score - a.score || (refKey(a) < refKey(b) ? -1 : 1))
    .slice(0, JEV_SHORTLIST_LIMIT)
    .flatMap((evaluation) => {
      const encounter = byKey.get(refKey(evaluation));
      return encounter ? [encounter] : [];
    });
}

interface CommitInput {
  readonly key: BufferKey;
  readonly delivery: PrepareBufferDelivery;
  readonly snapshot: ComposerSnapshot;
  readonly decision: ComposerDecision;
  readonly assessments: SemanticAssessments | undefined;
  readonly jev: JevOutcome;
}
type Committed = { kind: 'skip'; reason: PrepareBufferSkip } | { kind: 'stored'; offers: number };

/**
 * The second transaction. When Jev's run was made, the run closes and everything it bought is stored in one transaction under
 * the recording fence, so a pause, a resume or a Clear while the model worked stores nothing (`dropped`; the run is left for
 * the ledger's idle sweep). With no run to close (Jev off, paused, reused, or an attempt of unknown outcome) it is the plain
 * transaction it always was.
 */
async function commitUnderFence(ports: PrepareBufferPorts, authority: PersonalAuthority, input: CommitInput) {
  const closing = runToClose(input.delivery.jobId, input.jev.result?.purpose, input.jev.result?.end);
  if (ports.jev === undefined || closing === undefined)
    return ports.withPersonalScope(authority, (scope) => commit(ports, scope, input));
  const applied = await applyClosingRun(ports.jev.harness, authority, closing, (scope) => commit(ports, scope, input));
  return applied.kind === 'applied' ? ({ kind: 'entered', value: applied.value } as const) : applied;
}

/** Stores what Jev bought and the buffer, inside the caller's transaction. Closing Jev's run is the caller's. */
async function commit(ports: PrepareBufferPorts, scope: PersonalScopeTx, input: CommitInput): Promise<Committed> {
  const { key, snapshot, decision } = input;
  // What the paid run bought is kept whatever happens to the buffer: a superseded job's assessments serve the next preparation.
  if (ports.jev && input.jev.paid.length > 0)
    await ports.jev.storePool(
      scope,
      { roleVersion: JEV_ASSESSMENT_VERSION, model: ports.jev.model, entries: input.jev.paid },
      ports.now(),
    );

  const facts = await ports.readSource(scope, {
    sessionId: key.sessionId,
    offerId: key.source.offerId,
    exposureId: key.source.exposureId,
  });
  if (!facts || facts.intentRevision !== key.intentRevision) return { kind: 'skip', reason: 'session_superseded' };
  const existing = await ports.readBuffer(scope, key);
  const now = ports.now();
  if (existing && bufferIsServable(existing, now)) return { kind: 'skip', reason: 'already_prepared' };
  if (decision.selection.length === 0) return { kind: 'skip', reason: 'nothing_to_offer' };

  const decisionId = ports.newId();
  // The navigation that serves this buffer commits revision + 1, which is what the decision is bound to.
  await ports.persistDecision(
    scope,
    { decisionId, commandId: ports.newId(), sessionId: key.sessionId, intentRevision: key.intentRevision + 1 },
    decision,
  );
  const watermarks = new Map(snapshot.candidates.map((c) => [refKey(c.encounter), c.encounter.catalogWatermark]));
  await ports.storeBuffer(scope, {
    key,
    decisionId,
    selection: decision.selection.map((selected) => ({
      assetId: selected.assetId,
      assetRevision: selected.assetRevision,
      catalogWatermark: watermarks.get(refKey(selected)) ?? '',
    })),
    preparedAt: now,
    expiresAt: new Date(now.getTime() + BUFFER_LIFETIME_MS),
    ...(input.assessments ? { assessments: input.assessments } : {}),
  });
  return { kind: 'stored', offers: decision.selection.length };
}
