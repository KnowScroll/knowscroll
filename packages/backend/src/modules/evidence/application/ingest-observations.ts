import { INTERACTION_KINDS, type BlockType } from '@knowscroll/scroll-model';
import { OBSERVATION_LIMITS, type InteractionEvent, type ObservationBatchResponse } from '@knowscroll/contracts';
import type { ReadingFacts } from '../../content/public.js';
import type { PersonalAuthority, ScopeRefusal } from '../../identity/public.js';
import { boundIntervals, boundOccurredAt, elapsedCapMs } from '../domain/bounds.js';
import type { ExposureLineage } from '../domain/exposure-lineage.js';
import { OBSERVATION_BOUNDS_V1 } from '../domain/policy.js';
import type { IngestObservationsPorts, NewObservation } from './ports.js';

export interface IngestObservationsCommand {
  /** Which recorder build produced the batch. */
  readonly instrumentationVersion: number;
  readonly events: readonly InteractionEvent[];
}

export type IngestObservationsRefusal = 'batch_too_large' | 'epoch_changed' | 'universe_unavailable';

type EventResult = ObservationBatchResponse['results'][number];

export type IngestObservationsResult =
  | {
      readonly kind: 'ingested';
      readonly results: readonly EventResult[];
      readonly accepted: number;
      readonly duplicates: number;
      readonly rejected: number;
      /** The universe revision under the lock; observations change nothing a client reads. */
      readonly revision: number;
    }
  | { readonly kind: 'refused'; readonly reason: IngestObservationsRefusal };

/** What the intake loaded for one exposure of the batch, kept for the rest of the batch. */
interface ExposureState {
  readonly exposure: ExposureLineage;
  readonly facts: ReadingFacts | undefined;
  count: number;
  nextSeq: number;
  accepted: number;
}

/**
 * `ingestObservations`: durable intake of a recorder's batch (`POST /v1/observations/batch`). The
 * acknowledgement means **stored**, never projected (blueprint §19): a projection job is enqueued in
 * the same transaction (pg-boss is the only outbox) and its progress is a separate watermark.
 *
 * Authority: the caller's account and universe at a privacy epoch, rechecked under the personal
 *   root lock. The owner and epoch come from the authenticated scope, never from the client; every
 *   event's exposure must belong to that universe and epoch.
 * Steps (one transaction, blueprint §19): lock → for each event, in order: the exposure exists in
 *   this universe and epoch (`exposure_unknown`; unknown and foreign are indistinguishable), the
 *   event's asset and revision are the exposure's (`lineage_mismatch`), the exposure is activated
 *   (`exposure_not_active`), every block ID exists in that immutable revision (`block_unknown`),
 *   the event is not too old (`too_old`; a future `occurredAt` is clamped), the exposure's intake
 *   limit is not reached (`exposure_event_limit`) → claims are bounded (intervals and offsets
 *   cannot exceed the wall time elapsed since activation; the stored payload is the bounded one) →
 *   insert keyed `(universe, event ID)`: a conflict is a retry and counts nothing (`duplicate`) →
 *   enqueue one projection job per exposure that gained an observation → commit.
 * Side effects: `evidence.observations` and one pg-boss job per touched exposure, all or nothing.
 *   No receipt (observations are not commands: their idempotency is the event ID), no revision bump
 *   and no notice (nothing a client reads changed until the projection commits), no network call.
 * Failure/retry: any exception rolls back the whole batch and retrying with the same event IDs is
 *   safe. Every per-event status is final: the client removes the event from its outbox.
 * Invariants: personal simulation parameter values never reach here (the payload schemas carry
 *   block IDs, kinds and numbers only, D-012); the stored payload is bounded and size-checked.
 */
export function makeIngestObservations(ports: IngestObservationsPorts) {
  return async function ingestObservations(
    authority: PersonalAuthority,
    command: IngestObservationsCommand,
  ): Promise<IngestObservationsResult> {
    if (new TextEncoder().encode(JSON.stringify(command.events)).length > OBSERVATION_LIMITS.maxBatchBytes)
      return { kind: 'refused', reason: 'batch_too_large' };
    const entered = await ports.withPersonalScope(authority, async (scope): Promise<IngestObservationsResult> => {
      const receivedAt = ports.now();
      const states = new Map<string, ExposureState | undefined>();
      const stateOf = async (exposureId: string): Promise<ExposureState | undefined> => {
        if (states.has(exposureId)) return states.get(exposureId);
        const exposure = await ports.readExposure(scope, exposureId);
        let state: ExposureState | undefined;
        if (exposure !== undefined && exposure.privacyEpoch === scope.authority.privacyEpoch) {
          const facts = await ports.readReadingFacts(scope, exposure.assetId, exposure.assetRevision);
          const intake = await ports.readIntakeState(scope, exposure.id);
          state = { exposure, facts, count: intake.count, nextSeq: intake.maxSeq + 1, accepted: 0 };
        }
        states.set(exposureId, state);
        return state;
      };

      const results: EventResult[] = [];
      let accepted = 0;
      let duplicates = 0;
      let rejected = 0;
      for (const event of command.events) {
        const state = await stateOf(event.exposureId);
        const refusal = refusalOf(event, state, receivedAt);
        if (refusal !== undefined || state === undefined || state.exposure.activatedAt === undefined) {
          results.push({ eventId: event.eventId, status: 'rejected', reason: refusal ?? 'exposure_unknown' });
          rejected += 1;
          continue;
        }
        const occurred = boundOccurredAt(new Date(event.occurredAt), receivedAt, OBSERVATION_BOUNDS_V1);
        if (occurred.kind === 'too_old') {
          results.push({ eventId: event.eventId, status: 'rejected', reason: 'too_old' });
          rejected += 1;
          continue;
        }
        if (state.count >= OBSERVATION_LIMITS.maxEventsPerExposure) {
          results.push({ eventId: event.eventId, status: 'rejected', reason: 'exposure_event_limit' });
          rejected += 1;
          continue;
        }
        const capMs = elapsedCapMs(state.exposure.activatedAt, receivedAt, OBSERVATION_BOUNDS_V1);
        const bounded = boundPayload(event, capMs);
        const observation: NewObservation = {
          id: ports.newId(),
          eventId: event.eventId,
          sessionId: event.sessionId,
          deviceSequence: event.deviceSequence,
          exposureId: event.exposureId,
          seq: state.nextSeq,
          assetId: event.assetId,
          assetRevision: event.assetRevision,
          kind: event.kind,
          instrumentationVersion: command.instrumentationVersion,
          occurredAt: occurred.occurredAt,
          receivedAt,
          bounded: bounded.bounded || occurred.clamped,
          payload: bounded.payload,
        };
        if (await ports.insertObservation(scope, observation)) {
          state.nextSeq += 1;
          state.count += 1;
          state.accepted += 1;
          accepted += 1;
          results.push({ eventId: event.eventId, status: 'accepted' });
        } else {
          duplicates += 1;
          results.push({ eventId: event.eventId, status: 'duplicate' });
        }
      }
      for (const state of states.values()) {
        if (state !== undefined && state.accepted > 0) {
          await ports.enqueueProjection(scope, {
            v: 1,
            universeId: authority.universeId,
            privacyEpoch: authority.privacyEpoch,
            exposureId: state.exposure.id,
          });
        }
      }
      return { kind: 'ingested', results, accepted, duplicates, rejected, revision: scope.revisionAtEntry };
    });
    return entered.kind === 'entered' ? entered.value : { kind: 'refused', reason: refusalOfScope(entered.refusal) };
  };
}

export type IngestObservations = ReturnType<typeof makeIngestObservations>;

/**
 * Why one event cannot be accepted, or `undefined` when its lineage holds: the exposure is the
 * caller's, the event names the exposure's asset and revision, the exposure is active, and every
 * block ID the event names exists in that immutable revision.
 */
function refusalOf(
  event: InteractionEvent,
  state: ExposureState | undefined,
  receivedAt: Date,
): Extract<EventResult, { status: 'rejected' }>['reason'] | undefined {
  void receivedAt;
  if (state === undefined) return 'exposure_unknown';
  const { exposure, facts } = state;
  if (event.assetId !== exposure.assetId || event.assetRevision !== exposure.assetRevision) return 'lineage_mismatch';
  if (exposure.activatedAt === undefined) return 'exposure_not_active';
  if (facts === undefined) return 'lineage_mismatch';
  const known = new Set<string>([...facts.blocks.map((block) => block.id), ...facts.nested.map((block) => block.id)]);
  switch (event.kind) {
    case 'scroll.block_coverage':
      return event.payload.blocks.every((block) => known.has(block.blockId)) ? undefined : 'block_unknown';
    case 'scroll.block_interaction': {
      const block = [...facts.blocks, ...facts.nested].find((item) => item.id === event.payload.blockId);
      if (block === undefined) return 'block_unknown';
      const declared: Partial<Record<BlockType, readonly string[]>> = INTERACTION_KINDS;
      return declared[block.type]?.includes(event.payload.kind) === true ? undefined : 'interaction_kind_invalid';
    }
    case 'scroll.active_dwell':
      return undefined;
  }
}

/**
 * Bounds an event's claims against the wall time elapsed since activation (`capMs`): intervals and
 * offsets beyond it are clipped, never trusted. The stored payload is the bounded one.
 */
function boundPayload(
  event: InteractionEvent,
  capMs: number,
): { readonly payload: { readonly [key: string]: unknown }; readonly bounded: boolean } {
  switch (event.kind) {
    case 'scroll.block_coverage': {
      let bounded = false;
      const blocks = event.payload.blocks.map((block) => {
        const clipped = boundIntervals(block.intervalsMs, capMs);
        bounded ||= clipped.bounded;
        return { blockId: block.blockId, intervalsMs: clipped.intervals, peakFraction: block.peakFraction };
      });
      return { payload: { blocks }, bounded };
    }
    case 'scroll.active_dwell': {
      const clipped = boundIntervals(event.payload.activeIntervalsMs, capMs);
      return { payload: { activeIntervalsMs: clipped.intervals }, bounded: clipped.bounded };
    }
    case 'scroll.block_interaction': {
      const atMs = Math.min(event.payload.atMs, Math.floor(capMs));
      return {
        payload: { blockId: event.payload.blockId, kind: event.payload.kind, atMs },
        bounded: atMs !== event.payload.atMs,
      };
    }
  }
}

function refusalOfScope(refusal: ScopeRefusal): IngestObservationsRefusal {
  switch (refusal.kind) {
    case 'epoch_changed':
      return 'epoch_changed';
    case 'universe_missing':
    case 'universe_suspended':
    case 'account_mismatch':
      return 'universe_unavailable';
  }
}
