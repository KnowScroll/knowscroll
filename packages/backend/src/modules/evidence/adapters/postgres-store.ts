import { canonicalSha256 } from '@knowscroll/scroll-model';
import { OBSERVATION_LIMITS } from '@knowscroll/contracts';
import { sql, type Kysely } from 'kysely';
import type { PersonalAuthority, PersonalScopeTx, RecordingScopeTx } from '../../identity/public.js';
import type { Database } from '../../../infrastructure/postgres/database.js';
import { transactionOf } from '../../../infrastructure/postgres/personal-scope.js';
import { recordingTransactionOf } from '../../../infrastructure/postgres/recording-scope.js';
import { storedObservation } from './recording-store.js';
import type {
  ActionToRecord,
  IntakeState,
  LatestEvidence,
  NewEvidenceRevision,
  NewObservation,
  ReadEvidenceDiagnosticsPorts,
  StoredObservation,
} from '../application/ports.js';

export async function insertActionEvent(
  scope: RecordingScopeTx,
  event: ActionToRecord & { readonly eventId: string },
): Promise<boolean> {
  const inserted = await recordingTransactionOf(scope)
    .insertInto('evidence.action_events')
    .values({
      universe_id: scope.personal.authority.universeId,
      id: event.eventId,
      action_id: event.id,
      kind: event.kind,
      asset_id: event.assetId,
      asset_revision: event.assetRevision,
      privacy_epoch: scope.personal.authority.privacyEpoch,
    })
    .onConflict((c) => c.columns(['universe_id', 'action_id']).doNothing())
    .returning('id')
    .executeTakeFirst();
  return inserted !== undefined;
}
/** Lifetime, not per-generation. The1001sentinel never truncates a corrupt oversized history. */
export async function readIntakeState(scope: PersonalScopeTx, exposureId: string): Promise<IntakeState> {
  const rows = await transactionOf(scope)
    .selectFrom('evidence.observations')
    .select('seq')
    .where('universe_id', '=', scope.authority.universeId)
    .where('exposure_id', '=', exposureId)
    .orderBy('seq', 'desc')
    .limit(OBSERVATION_LIMITS.maxEventsPerExposure + 1)
    .execute();
  return { count: rows.length, maxSeq: rows[0]?.seq ?? 0 };
}
export async function insertObservation(scope: RecordingScopeTx, observation: NewObservation): Promise<boolean> {
  if (scope.generation !== observation.recordingGeneration) throw new Error('RECORDING_OBSERVATION_GENERATION');
  if (new TextEncoder().encode(JSON.stringify(observation.payload)).length > 8192)
    throw new Error('RECORDING_OBSERVATION_LIMIT');
  const result =
    await sql`insert into evidence.observations(universe_id,id,event_id,session_id,device_sequence,exposure_id,seq,asset_id,asset_revision,schema_version,kind,instrumentation_version,occurred_at,received_at,bounded,payload,privacy_epoch,recording_generation)
    values(${scope.personal.authority.universeId}::uuid,${observation.id}::uuid,${observation.eventId}::uuid,${observation.sessionId}::uuid,${observation.deviceSequence},${observation.exposureId}::uuid,${observation.seq},${observation.assetId}::uuid,${observation.assetRevision},'interaction.v1',${observation.kind},${observation.instrumentationVersion},${observation.occurredAt}::timestamptz,${observation.receivedAt}::timestamptz,${observation.bounded},${JSON.stringify(observation.payload)}::jsonb,${scope.personal.authority.privacyEpoch},${scope.generation})
    on conflict(universe_id,event_id) do nothing returning id`.execute(recordingTransactionOf(scope));
  return result.rows.length === 1;
}
export async function readObservations(
  scope: RecordingScopeTx,
  exposureId: string,
  domain: 'legacy' | 'session',
): Promise<
  { readonly kind: 'read'; readonly observations: readonly StoredObservation[] } | { readonly kind: 'limit' }
> {
  const rows = await sql<{
    seq: number;
    session_id: string;
    device_sequence: number;
    instrumentation_version: number;
    kind: string;
    payload: unknown;
    privacy_epoch: number;
    recording_generation: number;
    received_at: Date;
    server_started_at: Date | null;
  }>`
    select o.seq,o.session_id,o.device_sequence,o.instrumentation_version,o.kind,o.payload,o.privacy_epoch,o.recording_generation,o.received_at,s.server_started_at
    from evidence.observations o left join evidence.recording_sessions s on s.universe_id=o.universe_id and s.session_id=o.session_id and s.exposure_id=o.exposure_id and s.recording_generation=o.recording_generation
    where o.universe_id=${scope.personal.authority.universeId}::uuid and o.exposure_id=${exposureId}::uuid
    order by o.seq limit 1001`.execute(recordingTransactionOf(scope));
  if (rows.rows.length > 1000) return { kind: 'limit' };
  const output: StoredObservation[] = [];
  for (const row of rows.rows) {
    if (row.privacy_epoch !== scope.personal.authority.privacyEpoch || row.recording_generation !== scope.generation)
      continue;
    const stored = storedObservation(row.payload);
    if (row.recording_generation !== scope.generation || stored.clockDomain !== domain) continue;
    if (domain === 'session' && !row.server_started_at) throw new Error('RECORDING_SESSION_MISSING');
    output.push({
      seq: row.seq,
      sessionId: row.session_id,
      deviceSequence: row.device_sequence,
      instrumentationVersion: row.instrumentation_version,
      kind: row.kind,
      payload: stored.body,
      recordingGeneration: row.recording_generation,
      clockDomain: stored.clockDomain,
      receivedAt: new Date(row.received_at),
      originalWireProved: stored.wireSha256 !== undefined,
      ...(row.server_started_at ? { serverStartedAt: new Date(row.server_started_at) } : {}),
    });
  }
  return { kind: 'read', observations: output };
}
export async function nextEvidenceRevision(scope: RecordingScopeTx, exposureId: string): Promise<number> {
  const row = (
    await sql<{
      revision: number;
    }>`select revision from evidence.encounter_evidence where universe_id=${scope.personal.authority.universeId}::uuid and exposure_id=${exposureId}::uuid order by revision desc limit 1`.execute(
      recordingTransactionOf(scope),
    )
  ).rows[0];
  const revision = (row?.revision ?? 0) + 1;
  if (!Number.isSafeInteger(revision) || revision > 2147483647) throw new Error('RECORDING_REVISION_EXHAUSTED');
  return revision;
}
export async function readLatestEvidence(
  scope: RecordingScopeTx,
  exposureId: string,
  domain: 'legacy' | 'session',
): Promise<LatestEvidence | undefined> {
  const result =
    domain === 'legacy'
      ? await sql<{
          id: string;
          revision: number;
          input_watermark: number;
          policy_version: string;
        }>`select id,revision,input_watermark,policy_version from evidence.encounter_evidence
    where universe_id=${scope.personal.authority.universeId}::uuid and privacy_epoch=${scope.personal.authority.privacyEpoch} and exposure_id=${exposureId}::uuid and recording_generation=1 and policy_version in('scroll-qualification.v0','reel-qualification.v0') order by revision desc limit 1`.execute(
          recordingTransactionOf(scope),
        )
      : await sql<{
          id: string;
          revision: number;
          input_watermark: number;
          policy_version: string;
        }>`select r.id,r.revision,r.input_watermark,r.policy_version from evidence.recording_segment_heads h join evidence.encounter_evidence r on r.universe_id=h.universe_id and r.id=h.qualification_id
    where h.universe_id=${scope.personal.authority.universeId}::uuid and h.privacy_epoch=${scope.personal.authority.privacyEpoch} and h.exposure_id=${exposureId}::uuid and h.recording_generation=${scope.generation} and r.policy_version in('scroll-qualification.recording.v1','reel-qualification.recording.v1') limit 1`.execute(
          recordingTransactionOf(scope),
        );
  const row = result.rows[0];
  return row
    ? { id: row.id, revision: row.revision, inputWatermark: row.input_watermark, policyVersion: row.policy_version }
    : undefined;
}
export async function insertEvidence(scope: RecordingScopeTx, evidence: NewEvidenceRevision): Promise<boolean> {
  if (evidence.recordingGeneration !== scope.generation) throw new Error('RECORDING_EVIDENCE_GENERATION');
  const result =
    await sql`insert into evidence.encounter_evidence(universe_id,id,exposure_id,revision,input_watermark,policy_version,qualification,q,coverage,active_dwell_ms,estimated_reading_ms,asset_id,asset_revision,summary,privacy_epoch,recording_generation)
    values(${scope.personal.authority.universeId}::uuid,${evidence.id}::uuid,${evidence.exposureId}::uuid,${evidence.revision},${evidence.inputWatermark},${evidence.policyVersion},${evidence.qualification},${evidence.q},${evidence.coverage},${evidence.activeDwellMs},${evidence.estimatedReadingMs},${evidence.assetId}::uuid,${evidence.assetRevision},${JSON.stringify(evidence.summary)}::jsonb,${scope.personal.authority.privacyEpoch},${scope.generation})
    on conflict(universe_id,exposure_id,input_watermark,policy_version) do nothing returning id`.execute(
      recordingTransactionOf(scope),
    );
  if (result.rows.length && evidence.clockDomain === 'session') {
    const prior = (
      await sql<{
        source_vector: Record<string, string | number>;
      }>`select source_vector from evidence.recording_segment_heads where universe_id=${scope.personal.authority.universeId}::uuid and exposure_id=${evidence.exposureId}::uuid and recording_generation=${scope.generation} limit 1`.execute(
        recordingTransactionOf(scope),
      )
    ).rows[0];
    const vector = { ...prior?.source_vector, qualificationId: evidence.id, qualificationRevision: evidence.revision };
    await sql`insert into evidence.recording_segment_heads(universe_id,privacy_epoch,exposure_id,recording_generation,qualification_id,input_sha256,source_vector)
      values(${scope.personal.authority.universeId}::uuid,${scope.personal.authority.privacyEpoch},${evidence.exposureId}::uuid,${scope.generation},${evidence.id}::uuid,${canonicalSha256(vector)},${JSON.stringify(vector)}::jsonb)
      on conflict(universe_id,exposure_id,recording_generation) do update set qualification_id=excluded.qualification_id,input_sha256=excluded.input_sha256,source_vector=excluded.source_vector`.execute(
      recordingTransactionOf(scope),
    );
  }
  return result.rows.length === 1;
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
      .where('privacy_epoch', '=', authority.privacyEpoch)
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
      .where('privacy_epoch', '=', authority.privacyEpoch)
      .where('exposure_id', '=', exposureId)
      .where('policy_version', 'in', ['scroll-qualification.v0', 'reel-qualification.v0'])
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
