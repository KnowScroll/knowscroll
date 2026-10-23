import { ClientCapabilities } from '@knowscroll/contracts';
import type { EncounterSnapshot, ReadDiscoveryCandidates, ReadExactEncounter } from '../../content/public.js';
import type { PersonalAuthority, PersonalScopeTx, WithPersonalScope } from '../../identity/public.js';
import {
  ASSESSMENT_LIFETIME_MS,
  BUFFER_LIFETIME_MS,
  bufferIsServable,
  validAssessments,
  type BufferKey,
} from '../domain/buffer.js';
import { JEV_SHORTLIST_LIMIT } from '../domain/jev.js';
import { refKey } from '../domain/policy.js';
import type { ComposerDecision, ComposerSnapshot, SemanticAssessments } from '../domain/types.js';
import { PrepareBufferJobSchema, type PrepareBufferJob } from '../events.js';
import { storedAssessments, type AssessShortlist, type JevResult, type JevRunEnd } from './jev.js';
import type {
  ComposeEncounter,
  PersistComposerDecision,
  ReadBufferSource,
  ReadComposerBuffer,
  ReadHiddenAssets,
  ReadPreparedEvidenceInput,
  StoreComposerBuffer,
} from './ports.js';
import { assembleSnapshot, evidenceQueryFor, type SnapshotInput } from './snapshot-assembly.js';
import { readVerticalCandidates, renderableFormats } from './vertical-candidates.js';

/** Jev, when it is switched on: the assessor, the model it runs on and how to close its run. */
export interface JevPorts {
  readonly assess: AssessShortlist;
  /** The configured model name, stored beside the assessments. */
  readonly model: string;
  readonly closeRun: (scope: PersonalScopeTx, runId: string, end: JevRunEnd) => Promise<void>;
}

export interface PrepareBufferPorts {
  readonly withPersonalScope: WithPersonalScope;
  readonly readSource: ReadBufferSource;
  readonly readHidden: ReadHiddenAssets;
  readonly readExactEncounter: ReadExactEncounter;
  readonly readDiscoveryCandidates: ReadDiscoveryCandidates;
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
  | 'nothing_to_offer';

export type PrepareBufferResult =
  | {
      readonly kind: 'prepared';
      readonly offers: number;
      /** `off` when Jev is not configured; `absent` when it ran or was due but produced nothing usable. */
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
  readonly rankingInput: SnapshotInput;
  readonly reusedAssessments?: SemanticAssessments;
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
 * Steps: (1) one transaction reads the session facts, candidates, Hide and prepared context and
 * builds the ranking input; (2) outside any transaction, when Jev is on and no valid stored
 * assessment exists, Jev assesses the best baseline candidates; (3) the ranking runs; (4) one
 * transaction rechecks the session, persists the decision, replaces the buffer and closes Jev's run.
 * Side effects: `composer.decisions`, `composer.buffers` and Jev's reasoning run. No evidence, no
 * encounter: a buffer is only a prepared ranking.
 * Failure/retry: a redelivery finds the buffer already prepared and does nothing; Jev's run ID is
 * the job ID, so a redelivery cannot pay twice for the same assessment. A Jev failure is the
 * absence of an assessment and the buffer is still prepared from the deterministic baseline.
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
    const assessments = jev.assessments ?? gathered.reusedAssessments;
    const { snapshot } = assembleSnapshot({
      ...gathered.rankingInput,
      ...(assessments ? { semanticAssessments: assessments } : {}),
    });
    const decision = ports.compose(snapshot);

    const committed = await ports.withPersonalScope(authority, (scope) =>
      commit(ports, scope, { key, delivery, snapshot, decision, assessments, jev: jev.result }),
    );
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
  const capabilities = ClientCapabilities.safeParse(facts.capabilities);
  if (!capabilities.success) return skip('source_unavailable');
  const source = await ports.readExactEncounter(scope, { ...facts.source, capabilities: facts.capabilities });
  if (!source) return skip('source_unavailable');

  const candidates = await readVerticalCandidates(ports.readDiscoveryCandidates, scope, {
    source,
    formats: renderableFormats(capabilities.data.documentSchemas),
    capabilities: facts.capabilities,
  });
  const query = evidenceQueryFor(candidates, now.toISOString());
  const evidence = await ports.readPrepared(scope, query);
  const hiddenAssetIds = await ports.readHidden(scope, query.candidateAssetIds ?? []);
  const reusedAssessments = validAssessments(existing?.assessments, now);
  return {
    kind: 'gathered',
    gathered: {
      source,
      ...(reusedAssessments ? { reusedAssessments } : {}),
      rankingInput: {
        universeId: scope.authority.universeId,
        privacyEpoch: scope.authority.privacyEpoch,
        evaluatedAt: now.toISOString(),
        seed: `buffer:${key.sessionId}:${String(key.intentRevision)}:${key.source.offerId}`,
        mode: 'vertical',
        source,
        candidates,
        hiddenAssetIds,
        links: [],
        ...(evidence ? { evidence } : {}),
        ...(reusedAssessments ? { semanticAssessments: reusedAssessments } : {}),
        fallbackContextWatermark: `unprepared:${String(scope.revisionAtEntry)}`,
        hashCatalogWatermarks: ports.hashCatalogWatermarks,
      },
    },
  };
}

interface JevOutcome {
  readonly status: 'off' | 'reused' | 'assessed' | 'absent';
  readonly reason?: string;
  readonly result?: JevResult;
  readonly assessments?: SemanticAssessments;
}

/** Asks Jev only when it is on and nothing valid is stored for this key. Never inside a transaction. */
async function assessIfDue(
  ports: PrepareBufferPorts,
  authority: PersonalAuthority,
  gathered: Gathered,
  delivery: PrepareBufferDelivery,
): Promise<JevOutcome> {
  const { jev } = ports;
  if (!jev) return { status: 'off' };
  if (gathered.reusedAssessments) return { status: 'reused' };
  const shortlist = baselineShortlist(ports, gathered);
  if (shortlist.length === 0) return { status: 'absent', reason: 'empty_shortlist' };
  const result = await jev.assess({
    runId: delivery.jobId,
    authority,
    source: gathered.source,
    shortlist,
    signal: delivery.signal,
  });
  if (result.kind === 'absent') return { status: 'absent', reason: result.reason, result };
  if (result.entries.length === 0) return { status: 'absent', reason: 'no_usable_entries', result };
  return {
    status: 'assessed',
    result,
    assessments: storedAssessments({
      entries: result.entries,
      model: jev.model,
      assessedAt: ports.now(),
      lifetimeMs: ASSESSMENT_LIFETIME_MS,
    }),
  };
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

async function commit(
  ports: PrepareBufferPorts,
  scope: PersonalScopeTx,
  input: {
    readonly key: BufferKey;
    readonly delivery: PrepareBufferDelivery;
    readonly snapshot: ComposerSnapshot;
    readonly decision: ComposerDecision;
    readonly assessments?: SemanticAssessments;
    readonly jev?: JevResult;
  },
): Promise<{ kind: 'skip'; reason: PrepareBufferSkip } | { kind: 'stored'; offers: number }> {
  const { key, snapshot, decision } = input;
  // The paid run ends whatever happens to the buffer, so a superseded job still settles its run.
  if (ports.jev && input.jev?.end) await ports.jev.closeRun(scope, input.delivery.jobId, input.jev.end);

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
