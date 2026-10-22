import { sql } from 'kysely';
import { z } from 'zod';
import type { EncounterAttribution } from '../../content/public.js';
import { activity } from '../domain/activity.js';
import type { RecordingScopeTx } from '../../identity/public.js';
import { recordingTransactionOf } from '../../../infrastructure/postgres/recording-scope.js';
import { RecordingCreditSchema, emptyRecordingCredit, type RecordingCredit } from '../domain/recording-credit.js';
const InternalObservation = z.strictObject({
  recording: z.strictObject({
    v: z.literal(1),
    clockDomain: z.enum(['legacy', 'session']),
    wireSha256: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  body: z.unknown(),
});
/** Reserved stored envelope cannot downgrade into a legacy payload on malformed metadata. */
export function storedObservation(payload: unknown) {
  if (
    payload !== null &&
    typeof payload === 'object' &&
    (Object.hasOwn(payload, 'recording') || Object.hasOwn(payload, 'body'))
  ) {
    const parsed = InternalObservation.parse(payload);
    return { ...parsed.recording, body: parsed.body };
  }
  return { clockDomain: 'legacy' as const, body: payload, wireSha256: undefined };
}
export async function findRecordedEvent(scope: RecordingScopeTx, eventId: string) {
  const row = (
    await sql<{
      recording_generation: number;
      payload: unknown;
    }>`select recording_generation,payload from evidence.observations
    where universe_id=${scope.personal.authority.universeId}::uuid and event_id=${eventId}::uuid limit 1`.execute(
      recordingTransactionOf(scope),
    )
  ).rows[0];
  if (!row) return undefined;
  return { generation: row.recording_generation, wireSha256: storedObservation(row.payload).wireSha256 };
}
export async function readRecordingSession(scope: RecordingScopeTx, exposureId: string, sessionId: string) {
  const row = (
    await sql<{ server_started_at: Date }>`select server_started_at from evidence.recording_sessions
    where universe_id=${scope.personal.authority.universeId}::uuid and privacy_epoch=${scope.personal.authority.privacyEpoch}
    and recording_generation=${scope.generation} and exposure_id=${exposureId}::uuid and session_id=${sessionId}::uuid limit 1`.execute(
      recordingTransactionOf(scope),
    )
  ).rows[0];
  return row ? new Date(row.server_started_at) : undefined;
}
export async function hasRecordingSession(scope: RecordingScopeTx, sessionId: string) {
  return (
    (
      await sql`select 1 from evidence.recording_sessions where universe_id=${scope.personal.authority.universeId}::uuid
    and session_id=${sessionId}::uuid limit 1`.execute(recordingTransactionOf(scope))
    ).rows.length !== 0
  );
}
export async function startRecordingSession(
  scope: RecordingScopeTx,
  input: { exposureId: string; sessionId: string; serverStartedAt: Date },
) {
  const result =
    await sql`insert into evidence.recording_sessions(universe_id,privacy_epoch,session_id,exposure_id,recording_generation,activation_command_id,server_started_at)
    values(${scope.personal.authority.universeId}::uuid,${scope.personal.authority.privacyEpoch},${input.sessionId}::uuid,${input.exposureId}::uuid,${scope.generation},${input.sessionId}::uuid,${input.serverStartedAt}::timestamptz)
    on conflict(universe_id,session_id) do nothing returning session_id`.execute(recordingTransactionOf(scope));
  if (result.rows.length !== 1) throw new Error('RECORDING_SESSION_ALREADY_EXISTS');
}
export interface ExposureCreditState {
  readonly generation: number;
  readonly attributionSha256: string;
  readonly base: RecordingCredit;
  readonly effective: RecordingCredit;
  readonly inputHash: string;
}
export async function readExposureCredit(
  scope: RecordingScopeTx,
  exposureId: string,
): Promise<ExposureCreditState | undefined> {
  const row = (
    await sql<{
      working_generation: number;
      attribution_sha256: string;
      frozen_base: unknown;
      last_effective: unknown;
      input_sha256: string;
    }>`select working_generation,attribution_sha256,frozen_base,last_effective,input_sha256 from evidence.recording_exposure_credit
    where universe_id=${scope.personal.authority.universeId}::uuid and privacy_epoch=${scope.personal.authority.privacyEpoch} and exposure_id=${exposureId}::uuid limit 1`.execute(
      recordingTransactionOf(scope),
    )
  ).rows[0];
  return row
    ? {
        generation: row.working_generation,
        attributionSha256: row.attribution_sha256,
        base: RecordingCreditSchema.parse(row.frozen_base),
        effective: RecordingCreditSchema.parse(row.last_effective),
        inputHash: row.input_sha256,
      }
    : undefined;
}
/** Only an existing COMMITTED own activity head plus <=16 exact topic rows may seed a base. */
export async function legacyExposureCredit(
  scope: RecordingScopeTx,
  exposureId: string,
  metadata: EncounterAttribution,
): Promise<RecordingCredit> {
  const db = recordingTransactionOf(scope),
    u = scope.personal.authority.universeId,
    epoch = scope.personal.authority.privacyEpoch;
  const row = (
    await sql<{
      id: string;
      channels: unknown;
      input_vector: Record<string, string | number>;
    }>`select r.id,r.channels,r.input_vector from evidence.activity_current c join evidence.activity_revisions r
    on r.universe_id=c.universe_id and r.id=c.activity_id where c.universe_id=${u}::uuid and c.privacy_epoch=${epoch} and c.exposure_id=${exposureId}::uuid and r.recording_generation=1 limit 1`.execute(
      db,
    )
  ).rows[0];
  if (!row) return emptyRecordingCredit();
  if (row.input_vector.policy !== 'activity.v0') throw new Error('RECORDING_EFFECTIVE_BASE_MISSING');
  const topics = (
    await sql<{
      topic_id: string;
      channel_values: Record<string, number>;
      value: number;
      measured: number;
      qualified: number;
    }>`select topic_id,channel_values,value,measured,qualified from evidence.topic_contributions
    where universe_id=${u}::uuid and privacy_epoch=${epoch} and exposure_id=${exposureId}::uuid limit 17`.execute(db)
  ).rows;
  if (topics.length > 16) throw new Error('RECORDING_BASELINE_LIMIT');
  // A missing downstream contribution is not a source for historical repair.
  if (!topics.length) return emptyRecordingCredit();
  const credit = RecordingCreditSchema.parse({
    ...emptyRecordingCredit(),
    channels: row.channels,
    measured: topics.some((x) => x.measured > 0),
    qualified: topics.some((x) => x.qualified > 0),
  });
  const close = (a: number, b: number) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= 1e-9;
  if (
    topics.length !== metadata.topics.length ||
    topics.some((t) => {
      const m = metadata.topics.find((x) => x.topicId === t.topic_id);
      if (
        !m ||
        !close(t.value, m.weight * activity(credit.channels)) ||
        t.measured !== Number(m.role !== 'incidental' && credit.measured) ||
        t.qualified !== Number(m.role !== 'incidental' && credit.qualified)
      )
        return true;
      return Object.entries(credit.channels).some(
        ([key, value]) => !close(t.channel_values[key] ?? Number.NaN, m.weight * (value === null ? 0 : Number(value))),
      );
    })
  )
    throw new Error('RECORDING_LEGACY_BASE_UNCERTIFIED');
  // Old storage has no full explanation/facet/attribution fingerprint. Matching topic rows alone
  // cannot certify a conversion; leave committed legacy contributions untouched until the
  // separately allocated finite certification supplies a genuine owning witness.
  throw new Error('RECORDING_LEGACY_ATTRIBUTION_UNCERTIFIED');
}
export async function persistExposureCredit(
  scope: RecordingScopeTx,
  exposureId: string,
  input: {
    attributionSha256: string;
    base: RecordingCredit;
    effective: RecordingCredit;
    inputHash: string;
    vector: Readonly<Record<string, string | number>>;
  },
) {
  for (const value of [input.base, input.effective]) {
    RecordingCreditSchema.parse(value);
    if (new TextEncoder().encode(JSON.stringify(value)).length > 16384) throw new Error('RECORDING_CREDIT_LIMIT');
  }
  await sql`insert into evidence.recording_exposure_credit(universe_id,privacy_epoch,exposure_id,working_generation,attribution_sha256,frozen_base,last_effective,input_sha256,source_vector)
    values(${scope.personal.authority.universeId}::uuid,${scope.personal.authority.privacyEpoch},${exposureId}::uuid,${scope.generation},${input.attributionSha256},${JSON.stringify(input.base)}::jsonb,${JSON.stringify(input.effective)}::jsonb,${input.inputHash},${JSON.stringify(input.vector)}::jsonb)
    on conflict(universe_id,exposure_id) do update set working_generation=excluded.working_generation,frozen_base=excluded.frozen_base,last_effective=excluded.last_effective,input_sha256=excluded.input_sha256,source_vector=excluded.source_vector`.execute(
    recordingTransactionOf(scope),
  );
}
