import { z } from 'zod';
import { sql } from 'kysely';
import type { Kysely } from 'kysely';
import type { Database } from '../../../infrastructure/postgres/database.js';
import { transactionOf } from '../../../infrastructure/postgres/personal-scope.js';
import { replaceContribution } from '../domain/activity.js';
import { decayedActivity, logWeightFloor, logWeightOf } from '../domain/interest.js';
import type {
  InterestRollup,
  InterestTopic,
  ReadInterestRollups,
  ReadTopInterestTopics,
} from '../application/context-ports.js';

type ChannelValues = Readonly<Record<'q' | 'L' | 'B' | 'S' | 'H' | 'R', number>>;
const CHANNELS = ['q', 'L', 'B', 'S', 'H', 'R'] as const;

/** What one exposure's projection changed for one topic: its value and channels before and after, and the count deltas. */
export interface TopicInterestDelta {
  readonly topicId: string;
  readonly previous: number;
  readonly next: number;
  readonly previousChannels: ChannelValues;
  readonly nextChannels: ChannelValues;
  /** Change in measured / qualified encounters of the topic for the exposure's kind (the topic row's own deltas). */
  readonly measured: number;
  readonly qualified: number;
}

type RollupKey = { readonly level: 'system' | 'person'; readonly subjectId: string };

/** The roll-ups a topic feeds: its catalogue system (from the release the caller read), when the catalogue holds it, and always the person. */
function rollupKeysOf(topicId: string, systemOf: (topicId: string) => string | undefined): readonly RollupKey[] {
  const system = systemOf(topicId);
  return [
    ...(system === undefined ? [] : [{ level: 'system' as const, subjectId: system }]),
    { level: 'person', subjectId: '' },
  ];
}

const emptyChannels = (): Record<(typeof CHANNELS)[number], number> => ({ q: 0, L: 0, B: 0, S: 0, H: 0, R: 0 });

type StoredRollup = {
  activity: number;
  channel_values: ChannelValues;
  evaluated_at: Date;
  reel_measured: number;
  reel_qualified: number;
  scroll_measured: number;
  scroll_qualified: number;
};

/**
 * Applies one exposure's change to the system and person roll-ups of every topic it touched, in the caller's transaction and
 * at the same evaluation time as the topic rows (D-420). A roll-up is the sum of the topic rows beneath it, so each is replaced
 * exactly as a topic row is: the old aggregate decays once and this exposure's previous contribution is swapped for its new one
 * at the exposure's own time. Counts never go below zero and a roll-up never has more qualified than measured encounters.
 */
export async function applyInterestRollups(
  db: Kysely<Database>,
  where: {
    readonly universeId: string;
    readonly privacyEpoch: number;
    readonly kind: 'reel' | 'scroll';
    readonly evaluatedAt: string;
    readonly encounterAt: string;
  },
  deltas: readonly TopicInterestDelta[],
  systemOf: (topicId: string) => string | undefined,
): Promise<void> {
  const grouped = new Map<string, { key: RollupKey; deltas: TopicInterestDelta[] }>();
  for (const delta of deltas)
    for (const key of rollupKeysOf(delta.topicId, systemOf)) {
      const id = `${key.level}\u0000${key.subjectId}`;
      const entry = grouped.get(id) ?? { key, deltas: [] };
      entry.deltas.push(delta);
      grouped.set(id, entry);
    }
  const evaluatedAtMs = Date.parse(where.evaluatedAt);
  for (const { key, deltas: members } of grouped.values()) {
    const found =
      await sql<StoredRollup>`select activity,channel_values,evaluated_at,reel_measured,reel_qualified,scroll_measured,scroll_qualified
      from evidence.interest_rollups where universe_id=${where.universeId}::uuid and level=${key.level} and subject_id=${key.subjectId}`.execute(
        db,
      );
    const row = found.rows[0];
    const aggregateAt = row ? new Date(row.evaluated_at).getTime() : evaluatedAtMs;
    const sum = (read: (delta: TopicInterestDelta) => number) =>
      members.reduce((total, delta) => total + read(delta), 0);
    const replace = (aggregate: number, previous: number, next: number) =>
      replaceContribution({
        aggregate,
        aggregateAt,
        evaluatedAt: evaluatedAtMs,
        encounterAt: Date.parse(where.encounterAt),
        previous,
        next,
      });
    const activity = replace(
      row?.activity ?? 0,
      sum((d) => d.previous),
      sum((d) => d.next),
    );
    const channels = emptyChannels();
    for (const channel of CHANNELS)
      channels[channel] = replace(
        row?.channel_values[channel] ?? 0,
        sum((d) => d.previousChannels[channel]),
        sum((d) => d.nextChannels[channel]),
      );
    const measured = sum((d) => d.measured);
    const qualified = sum((d) => d.qualified);
    const reel = where.kind === 'reel';
    const reelMeasured = Math.max(0, (row?.reel_measured ?? 0) + (reel ? measured : 0));
    const scrollMeasured = Math.max(0, (row?.scroll_measured ?? 0) + (reel ? 0 : measured));
    const reelQualified = Math.min(reelMeasured, Math.max(0, (row?.reel_qualified ?? 0) + (reel ? qualified : 0)));
    const scrollQualified = Math.min(
      scrollMeasured,
      Math.max(0, (row?.scroll_qualified ?? 0) + (reel ? 0 : qualified)),
    );
    await sql`insert into evidence.interest_rollups(universe_id,privacy_epoch,level,subject_id,channel_values,activity,evaluated_at,
        reel_measured,reel_qualified,scroll_measured,scroll_qualified,log_weight)
      values(${where.universeId}::uuid,${where.privacyEpoch},${key.level},${key.subjectId},${JSON.stringify(channels)}::jsonb,${activity},${where.evaluatedAt}::timestamptz,
        ${reelMeasured},${reelQualified},${scrollMeasured},${scrollQualified},${logWeightOf(activity, evaluatedAtMs)})
      on conflict(universe_id,level,subject_id) do update set privacy_epoch=excluded.privacy_epoch,channel_values=excluded.channel_values,
        activity=excluded.activity,evaluated_at=excluded.evaluated_at,reel_measured=excluded.reel_measured,reel_qualified=excluded.reel_qualified,
        scroll_measured=excluded.scroll_measured,scroll_qualified=excluded.scroll_qualified,log_weight=excluded.log_weight`.execute(
      db,
    );
  }
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
