import { OBSERVATION_LIMITS } from '@knowscroll/contracts';
import type { Kysely } from 'kysely';
import type { PersonalAuthority, PersonalScopeTx } from '../../identity/public.js';
import type { Database } from '../../../infrastructure/postgres/database.js';
import { transactionOf } from '../../../infrastructure/postgres/personal-scope.js';
import type {
  ActionToRecord,
  IntakeState,
  LatestEvidence,
  NewEvidenceRevision,
  NewObservation,
  ReadEvidenceDiagnosticsPorts,
  StoredObservation,
} from '../application/ports.js';

/** Inserts one evidence action event; `false` when the action already has one. */
export async function insertActionEvent(
  scope: PersonalScopeTx,
  event: ActionToRecord & { readonly eventId: string },
): Promise<boolean> {
  const inserted = await transactionOf(scope)
    .insertInto('evidence.action_events')
    .values({
      universe_id: scope.authority.universeId,
      id: event.eventId,
      action_id: event.id,
      kind: event.kind,
      asset_id: event.assetId,
      asset_revision: event.assetRevision,
      privacy_epoch: scope.authority.privacyEpoch,
    })
    .onConflict((conflict) => conflict.columns(['universe_id', 'action_id']).doNothing())
    .returning('id')
    .executeTakeFirst();
  return inserted !== undefined;
}

/** What the intake knows about one exposure's stored observations: how many, and the highest `seq`. */
export async function readIntakeState(scope: PersonalScopeTx, exposureId: string): Promise<IntakeState> {
  const row = await transactionOf(scope)
    .selectFrom('evidence.observations')
    .select((eb) => [eb.fn.countAll<string>().as('count'), eb.fn.max('seq').as('max_seq')])
    .where('universe_id', '=', scope.authority.universeId)
    .where('exposure_id', '=', exposureId)
    .executeTakeFirstOrThrow();
  return { count: Number(row.count), maxSeq: row.max_seq ?? 0 };
}

/**
 * Inserts one observation keyed `(universe_id, event_id)`; `false` when the event ID already exists
 * in this universe (a retried batch: nothing is counted twice).
 */
export async function insertObservation(scope: PersonalScopeTx, observation: NewObservation): Promise<boolean> {
  const inserted = await transactionOf(scope)
    .insertInto('evidence.observations')
    .values({
      universe_id: scope.authority.universeId,
      id: observation.id,
      event_id: observation.eventId,
      session_id: observation.sessionId,
      device_sequence: observation.deviceSequence,
      exposure_id: observation.exposureId,
      seq: observation.seq,
      asset_id: observation.assetId,
      asset_revision: observation.assetRevision,
      schema_version: 'interaction.v1',
      kind: observation.kind,
      instrumentation_version: observation.instrumentationVersion,
      occurred_at: observation.occurredAt,
      received_at: observation.receivedAt,
      bounded: observation.bounded,
      payload: JSON.stringify(observation.payload),
      privacy_epoch: scope.authority.privacyEpoch,
    })
    .onConflict((conflict) => conflict.columns(['universe_id', 'event_id']).doNothing())
    .returning('id')
    .executeTakeFirst();
  return inserted !== undefined;
}

/** The exposure's observations in intake order, bounded by the intake limit. */
export async function readObservations(
  scope: PersonalScopeTx,
  exposureId: string,
): Promise<readonly StoredObservation[]> {
  const rows = await transactionOf(scope)
    .selectFrom('evidence.observations')
    .select(['seq', 'session_id', 'device_sequence', 'instrumentation_version', 'kind', 'payload'])
    .where('universe_id', '=', scope.authority.universeId)
    .where('exposure_id', '=', exposureId)
    .orderBy('seq')
    .limit(OBSERVATION_LIMITS.maxEventsPerExposure)
    .execute();
  return rows.map((row) => ({
    seq: row.seq,
    sessionId: row.session_id,
    deviceSequence: row.device_sequence,
    instrumentationVersion: row.instrumentation_version,
    kind: row.kind,
    payload: row.payload,
  }));
}

/** The exposure's latest committed evidence revision, if any. */
export async function readLatestEvidence(
  scope: PersonalScopeTx,
  exposureId: string,
): Promise<LatestEvidence | undefined> {
  const row = await transactionOf(scope)
    .selectFrom('evidence.encounter_evidence')
    .select(['revision', 'input_watermark', 'policy_version'])
    .where('universe_id', '=', scope.authority.universeId)
    .where('exposure_id', '=', exposureId)
    .orderBy('revision', 'desc')
    .limit(1)
    .executeTakeFirst();
  return row === undefined
    ? undefined
    : { revision: row.revision, inputWatermark: row.input_watermark, policyVersion: row.policy_version };
}

/**
 * Inserts one evidence revision; `false` when one already exists for this exposure, input
 * watermark and policy version (a redelivered job, or two jobs for one watermark).
 */
export async function insertEvidence(scope: PersonalScopeTx, evidence: NewEvidenceRevision): Promise<boolean> {
  const inserted = await transactionOf(scope)
    .insertInto('evidence.encounter_evidence')
    .values({
      universe_id: scope.authority.universeId,
      id: evidence.id,
      exposure_id: evidence.exposureId,
      revision: evidence.revision,
      input_watermark: evidence.inputWatermark,
      policy_version: evidence.policyVersion,
      qualification: evidence.qualification,
      q: evidence.q,
      coverage: evidence.coverage,
      active_dwell_ms: evidence.activeDwellMs,
      estimated_reading_ms: evidence.estimatedReadingMs,
      asset_id: evidence.assetId,
      asset_revision: evidence.assetRevision,
      summary: JSON.stringify(evidence.summary),
      privacy_epoch: scope.authority.privacyEpoch,
    })
    .onConflict((conflict) =>
      conflict.columns(['universe_id', 'exposure_id', 'input_watermark', 'policy_version']).doNothing(),
    )
    .returning('id')
    .executeTakeFirst();
  return inserted !== undefined;
}

/**
 * The diagnostics read: one statement rechecks the universe's status, epoch, owner and revision, then
 * two bounded reads of the exposure's durable evidence state. No lock, so reads never wait behind
 * commands.
 */
export function makeReadDiagnostics(db: Kysely<Database>): ReadEvidenceDiagnosticsPorts['readDiagnostics'] {
  return async (authority: PersonalAuthority, exposureId: string) => {
    const universe = await db
      .selectFrom('identity.universes as universe')
      .innerJoin('identity.accounts as account', 'account.id', 'universe.account_id')
      .select([
        'universe.privacy_epoch',
        'universe.status',
        'universe.revision',
        'universe.account_id',
        'account.status as account_status',
      ])
      .where('universe.id', '=', authority.universeId)
      .executeTakeFirst();
    const ownerMatches = authority.actor.kind !== 'account' || universe?.account_id === authority.actor.accountId;
    if (
      universe === undefined ||
      universe.status !== 'active' ||
      universe.account_status !== 'active' ||
      !ownerMatches
    ) {
      return { kind: 'refused', reason: 'universe_unavailable' };
    }
    if (universe.privacy_epoch !== authority.privacyEpoch) return { kind: 'refused', reason: 'epoch_changed' };
    const intake = await db
      .selectFrom('evidence.observations')
      .select((eb) => [eb.fn.countAll<string>().as('count'), eb.fn.max('received_at').as('last_received_at')])
      .where('universe_id', '=', authority.universeId)
      .where('exposure_id', '=', exposureId)
      .executeTakeFirstOrThrow();
    const latest = await db
      .selectFrom('evidence.encounter_evidence')
      .select([
        'revision',
        'input_watermark',
        'policy_version',
        'qualification',
        'q',
        'coverage',
        'active_dwell_ms',
        'estimated_reading_ms',
        'created_at',
      ])
      .where('universe_id', '=', authority.universeId)
      .where('exposure_id', '=', exposureId)
      .orderBy('revision', 'desc')
      .limit(1)
      .executeTakeFirst();
    return {
      kind: 'read',
      diagnostics: {
        revision: universe.revision,
        exposureId,
        observations: {
          count: Number(intake.count),
          lastReceivedAt: intake.last_received_at === null ? undefined : new Date(intake.last_received_at),
        },
        evidence:
          latest === undefined
            ? undefined
            : {
                revision: latest.revision,
                inputWatermark: latest.input_watermark,
                policyVersion: latest.policy_version,
                qualification: latest.qualification as 'qualified' | 'not_qualified' | 'unknown',
                q: latest.q,
                coverage: latest.coverage,
                activeDwellMs: latest.active_dwell_ms,
                estimatedReadingMs: latest.estimated_reading_ms,
                committedAt: new Date(latest.created_at),
              },
      },
    };
  };
}
