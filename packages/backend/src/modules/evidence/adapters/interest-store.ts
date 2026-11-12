import { z } from 'zod';
import { sql } from 'kysely';
import type { Kysely } from 'kysely';
import type { Database } from '../../../infrastructure/postgres/database.js';
import { transactionOf } from '../../../infrastructure/postgres/personal-scope.js';
import {
  applyCountedChanges,
  RollupAccumulator,
  type ChannelKey,
  type ChannelValues,
  type CountedState,
  type RollupValue,
} from '../domain/interest-rollup.js';
import { decayedActivity, logWeightFloor } from '../domain/interest.js';
import type {
  InterestRollup,
  InterestTopic,
  ReadInterestRollups,
  ReadTopInterestTopics,
} from '../application/context-ports.js';

/** The catalogue system of a topic, from one release of the topic catalogue (`CatalogueSnapshot.systemOf`); `undefined` for a topic it does not hold. */
export type SystemOf = (topicId: string) => string | undefined;

type RollupKey = { readonly level: 'system' | 'person'; readonly subjectId: string };

/** The roll-ups a topic feeds: its catalogue system, when the catalogue holds it, and always the person. */
function rollupKeysOf(topicId: string, systemOf: SystemOf): readonly RollupKey[] {
  const system = systemOf(topicId);
  return [
    ...(system === undefined ? [] : [{ level: 'system' as const, subjectId: system }]),
    { level: 'person', subjectId: '' },
  ];
}

/** A topic row as it was counted into the roll-ups before this write, and as this write leaves it. */
export interface TopicCountedChange {
  readonly topicId: string;
  readonly previous: CountedState | undefined;
  readonly next: CountedState;
}

type StoredRollup = {
  activity: number;
  channel_values: unknown;
  evaluated_at: Date;
  reel_measured: number;
  reel_qualified: number;
  scroll_measured: number;
  scroll_qualified: number;
};

/** The channels of a stored row, every key a number (a missing or malformed one is 0). */
function channelsOf(value: unknown): ChannelValues {
  const read = (key: ChannelKey): number => {
    const found = (value as Record<string, unknown> | null)?.[key];
    return typeof found === 'number' && Number.isFinite(found) && found > 0 ? found : 0;
  };
  return { q: read('q'), L: read('L'), B: read('B'), S: read('S'), H: read('H'), R: read('R') };
}

const valueOfRow = (row: StoredRollup): RollupValue => ({
  a: row.activity,
  t: new Date(row.evaluated_at).getTime(),
  ch: channelsOf(row.channel_values),
  rm: row.reel_measured,
  rq: row.reel_qualified,
  sm: row.scroll_measured,
  sq: row.scroll_qualified,
});

/**
 * Writes the roll-up rows of a system or the person (`log_weight` is derived by the table's trigger, as for `topic_context`).
 * Idempotent: the row is replaced whole.
 */
async function writeRollup(
  db: Kysely<Database>,
  where: { readonly universeId: string; readonly privacyEpoch: number },
  key: RollupKey,
  value: RollupValue,
): Promise<void> {
  await sql`insert into evidence.interest_rollups(universe_id,privacy_epoch,level,subject_id,channel_values,activity,evaluated_at,
      reel_measured,reel_qualified,scroll_measured,scroll_qualified)
    values(${where.universeId}::uuid,${where.privacyEpoch},${key.level},${key.subjectId},${JSON.stringify(value.ch)}::jsonb,${value.a},
      ${new Date(value.t).toISOString()}::timestamptz,${value.rm},${value.rq},${value.sm},${value.sq})
    on conflict(universe_id,level,subject_id) do update set privacy_epoch=excluded.privacy_epoch,channel_values=excluded.channel_values,
      activity=excluded.activity,evaluated_at=excluded.evaluated_at,reel_measured=excluded.reel_measured,reel_qualified=excluded.reel_qualified,
      scroll_measured=excluded.scroll_measured,scroll_qualified=excluded.scroll_qualified`.execute(db);
}

/**
 * Applies one exposure's change to the system and person roll-ups of every topic it touched, in the caller's transaction (D-420).
 * A roll-up is the sum of the topic rows beneath it, and it changes by the difference between what each topic was counted as
 * (`previous`, stored with the topic row) and what the write leaves it as (`next`): it never subtracts what it did not add, and it
 * corrects a topic an older binary changed without counting it. When a roll-up would go negative, or is absent for a topic that was
 * counted, it has lost something (a deleted row, a restore): the person's roll-ups are rebuilt from the topic rows instead and the
 * result says so. Counts never go below zero and a roll-up never has more qualified than measured encounters.
 */
export async function applyInterestRollups(
  db: Kysely<Database>,
  where: { readonly universeId: string; readonly privacyEpoch: number; readonly atMs: number },
  changes: readonly TopicCountedChange[],
  systemOf: SystemOf,
): Promise<'applied' | 'rebuilt'> {
  const grouped = new Map<
    string,
    { key: RollupKey; changes: { previous: CountedState | undefined; next: CountedState }[] }
  >();
  for (const change of changes)
    for (const key of rollupKeysOf(change.topicId, systemOf)) {
      const id = `${key.level}\u0000${key.subjectId}`;
      const entry = grouped.get(id) ?? { key, changes: [] };
      entry.changes.push({ previous: change.previous, next: change.next });
      grouped.set(id, entry);
    }
  const writes: { key: RollupKey; value: RollupValue }[] = [];
  for (const { key, changes: members } of grouped.values()) {
    const found =
      await sql<StoredRollup>`select activity,channel_values,evaluated_at,reel_measured,reel_qualified,scroll_measured,scroll_qualified
      from evidence.interest_rollups where universe_id=${where.universeId}::uuid and level=${key.level} and subject_id=${key.subjectId}`.execute(
        db,
      );
    const row = found.rows[0];
    const result = applyCountedChanges(row === undefined ? undefined : valueOfRow(row), members, where.atMs);
    if (!result.consistent) {
      await rebuildInterestRollups(db, where, systemOf);
      return 'rebuilt';
    }
    writes.push({ key, value: result.value });
  }
  for (const { key, value } of writes) await writeRollup(db, where, key, value);
  return 'applied';
}

const REBUILD_PAGE = 2000;

/**
 * Rebuilds a person's roll-ups from their topic rows, in the caller's transaction (migration 0121, D-420). It streams the topic rows
 * in pages, sums them by catalogue system and for the person as of the latest row, replaces the person's roll-up rows, and stamps
 * every topic row as counted as it is now (`rollup_counted`), which also lets the table's trigger derive the `log_weight` of rows no
 * writer has touched since the migration. Idempotent: a second run reads the same rows and writes the same values. The caller holds
 * the personal root lock, so no projection runs beside it.
 */
export async function rebuildInterestRollups(
  db: Kysely<Database>,
  where: { readonly universeId: string; readonly privacyEpoch: number },
  systemOf: SystemOf,
): Promise<{ readonly topics: number; readonly rollups: number }> {
  const sums = new Map<string, { key: RollupKey; sum: RollupAccumulator }>();
  const sumFor = (key: RollupKey) => {
    const id = `${key.level}\u0000${key.subjectId}`;
    const entry = sums.get(id) ?? { key, sum: new RollupAccumulator() };
    sums.set(id, entry);
    return entry.sum;
  };
  let topics = 0;
  let after = '';
  for (;;) {
    const page = await sql<
      StoredRollup & { topic_id: string }
    >`select topic_id,activity,channel_values,evaluated_at,reel_measured,reel_qualified,scroll_measured,scroll_qualified
      from evidence.topic_context where universe_id=${where.universeId}::uuid and privacy_epoch=${where.privacyEpoch} and topic_id>${after}
      order by topic_id limit ${REBUILD_PAGE}`.execute(db);
    for (const row of page.rows) {
      const value = valueOfRow(row);
      const counted: CountedState = {
        a: value.a,
        t: value.t,
        ch: value.ch,
        rm: value.rm,
        rq: value.rq,
        sm: value.sm,
        sq: value.sq,
      };
      for (const key of rollupKeysOf(row.topic_id, systemOf)) sumFor(key).add(counted);
    }
    topics += page.rows.length;
    if (page.rows.length < REBUILD_PAGE) break;
    after = page.rows.at(-1)!.topic_id;
  }
  await sql`delete from evidence.interest_rollups where universe_id=${where.universeId}::uuid`.execute(db);
  let rollups = 0;
  for (const { key, sum } of sums.values()) {
    if (sum.result === undefined) continue;
    await writeRollup(db, where, key, sum.result);
    rollups += 1;
  }
  await sql`update evidence.topic_context set rollup_counted=jsonb_build_object('a',activity,'t',extract(epoch from evaluated_at)::double precision*1000,
      'ch',channel_values,'rm',reel_measured,'rq',reel_qualified,'sm',scroll_measured,'sq',scroll_qualified)
    where universe_id=${where.universeId}::uuid and privacy_epoch=${where.privacyEpoch}`.execute(db);
  return { topics, rollups };
}

const TopQuery = z.strictObject({
  limit: z.number().int().min(1).max(64),
  evaluatedAt: z.iso.datetime(),
  minActivity: z.number().min(0).max(3).optional(),
});
/** The default floor of decayed activity below which a topic is not "long-term interest" (about 0.07 of one fully read Scroll). */
const DEFAULT_MIN_ACTIVITY = 0.05;

export const readTopInterestTopics: ReadTopInterestTopics = async (scope, query) => {
  const q = TopQuery.parse(query);
  const nowMs = Date.parse(q.evaluatedAt);
  const floor = logWeightFloor(q.minActivity ?? DEFAULT_MIN_ACTIVITY, nowMs);
  // One range scan of `topic_context_top_interest` (a descending index, so the scan runs forward): equal universe and epoch, `log_weight` from the floor upward, no sort.
  const rows = await sql<{
    topic_id: string;
    activity: number;
    evaluated_at: Date;
  }>`select topic_id,activity,evaluated_at
    from evidence.topic_context where universe_id=${scope.authority.universeId}::uuid and privacy_epoch=${scope.authority.privacyEpoch}
    and log_weight is not null ${floor === null ? sql`` : sql`and log_weight>=${floor}`}
    order by log_weight desc,topic_id limit ${q.limit}`.execute(transactionOf(scope));
  return rows.rows.map((row): InterestTopic => ({
    topicId: row.topic_id,
    activity: decayedActivity(row.activity, new Date(row.evaluated_at).getTime(), nowMs),
  }));
};

const RollupQuery = z.strictObject({
  systemIds: z.array(z.string().min(1).max(160)).max(100),
  person: z.boolean(),
  evaluatedAt: z.iso.datetime(),
});

export const readInterestRollups: ReadInterestRollups = async (scope, query) => {
  const q = RollupQuery.parse(query);
  if (new Set(q.systemIds).size !== q.systemIds.length) throw new Error('INTEREST_ROLLUP_QUERY_INVALID');
  if (q.systemIds.length === 0 && !q.person) return [];
  const nowMs = Date.parse(q.evaluatedAt);
  const rows = await sql<
    StoredRollup & { level: 'system' | 'person'; subject_id: string }
  >`select level,subject_id,activity,channel_values,evaluated_at,
      reel_measured,reel_qualified,scroll_measured,scroll_qualified
    from evidence.interest_rollups where universe_id=${scope.authority.universeId}::uuid and privacy_epoch=${scope.authority.privacyEpoch}
    and ((level='system' and subject_id=any(${q.systemIds}::text[])) or (level='person' and ${q.person}))
    order by level,subject_id limit 101`.execute(transactionOf(scope));
  return rows.rows.map((row): InterestRollup => ({
    level: row.level,
    subjectId: row.subject_id,
    activity: decayedActivity(row.activity, new Date(row.evaluated_at).getTime(), nowMs),
    formats: [
      { kind: 'reel', measured: row.reel_measured, qualified: row.reel_qualified },
      { kind: 'scroll', measured: row.scroll_measured, qualified: row.scroll_qualified },
    ],
  }));
};
