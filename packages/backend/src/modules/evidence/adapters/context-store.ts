import { z } from 'zod';
import { sql } from 'kysely';
import { transactionOf } from '../../../infrastructure/postgres/personal-scope.js';
import { decay } from '../domain/activity.js';
import { readCells } from './cell-store.js';
import type {
  ActivityStatistics,
  ReadActivityStatistics,
  ReadObservationTail,
  ReadRecentTopicIds,
} from '../application/context-ports.js';
const StatisticsQuery = z.strictObject({
  topicIds: z.array(z.string().min(1).max(160)).max(100),
  evaluatedAt: z.iso.datetime(),
});
const ChannelValues = z.strictObject({
  q: z.number().nonnegative(),
  L: z.number().nonnegative(),
  B: z.number().nonnegative(),
  S: z.number().nonnegative(),
  H: z.number().nonnegative(),
  R: z.number().nonnegative(),
});
export const readActivityStatistics: ReadActivityStatistics = async (scope, query) => {
  const q = StatisticsQuery.parse(query);
  if (new Set(q.topicIds).size !== q.topicIds.length) throw new Error('ACTIVITY_CONTEXT_QUERY_INVALID');
  if (!q.topicIds.length) return [];
  const r = await sql<{
    topic_id: string;
    activity: number;
    channel_values: ActivityStatistics['channels'];
    evaluated_at: Date;
    reel_measured: number;
    reel_qualified: number;
    scroll_measured: number;
    scroll_qualified: number;
  }>`select topic_id,activity,channel_values,evaluated_at,reel_measured,reel_qualified,scroll_measured,scroll_qualified from evidence.topic_context where universe_id=${scope.authority.universeId}::uuid and privacy_epoch=${scope.authority.privacyEpoch} and topic_id=any(${q.topicIds}::text[]) limit 100`.execute(
    transactionOf(scope),
  );
  const cells = await readCells(
    scope,
    r.rows.map((t) => t.topic_id),
  );
  return r.rows.map((t) => {
    const factor = decay(new Date(t.evaluated_at).getTime(), Date.parse(q.evaluatedAt));
    const channels = ChannelValues.parse(t.channel_values);
    return {
      topicId: t.topic_id,
      activity: t.activity * factor,
      channels: {
        q: channels.q * factor,
        L: channels.L * factor,
        B: channels.B * factor,
        S: channels.S * factor,
        H: channels.H * factor,
        R: channels.R * factor,
      },
      formats: [
        { kind: 'reel' as const, measured: t.reel_measured, qualified: t.reel_qualified },
        { kind: 'scroll' as const, measured: t.scroll_measured, qualified: t.scroll_qualified },
      ],
      cells: cells.get(t.topic_id) ?? [],
    };
  });
};
const TailQuery = z.strictObject({ exposureIds: z.array(z.uuid()).max(20), limit: z.number().int().min(0).max(20) });
export const readObservationTail: ReadObservationTail = async (scope, query) => {
  const q = TailQuery.parse(query);
  if (new Set(q.exposureIds).size !== q.exposureIds.length) throw new Error('ACTIVITY_TAIL_QUERY_INVALID');
  if (q.limit === 0 || !q.exposureIds.length) return { entries: [], hasMore: false };
  const u = scope.authority.universeId,
    e = scope.authority.privacyEpoch;
  // <=20 exact actual exposure IDs. Each indexed probe is bounded by intake's 1000/exposure.
  // Sequences already included by any evidence revision are explicitly excluded.
  const r = await sql<{
    event_id: string;
    exposure_id: string;
    seq: number;
  }>`select o.event_id,o.exposure_id,o.seq from unnest(${q.exposureIds}::uuid[]) as requested(id) cross join lateral (select event_id,exposure_id,seq,received_at from evidence.observations where universe_id=${u}::uuid and privacy_epoch=${e} and exposure_id=requested.id and seq>coalesce((select max(input_watermark) from evidence.encounter_evidence where universe_id=${u}::uuid and privacy_epoch=${e} and exposure_id=requested.id),0) order by seq desc limit ${q.limit + 1}) o order by o.received_at desc,o.event_id limit ${q.limit + 1}`.execute(
    transactionOf(scope),
  );
  return {
    entries: r.rows
      .slice(0, q.limit)
      .map((o) => ({ eventId: o.event_id, exposureId: o.exposure_id, inputWatermark: String(o.seq) })),
    hasMore: r.rows.length > q.limit,
  };
};

export const readRecentTopicIds: ReadRecentTopicIds = async (scope, query) => {
  const q = z.strictObject({ limit: z.number().int().min(1).max(100) }).parse(query);
  const r = await sql<{
    topic_id: string;
  }>`select topic_id from evidence.topic_context where universe_id=${scope.authority.universeId}::uuid and privacy_epoch=${scope.authority.privacyEpoch} order by evaluated_at desc,topic_id limit ${q.limit + 1}`.execute(
    transactionOf(scope),
  );
  return {
    policyVersion: 'recent_projected_topics.v0',
    topicIds: r.rows.slice(0, q.limit).map((t) => t.topic_id),
    hasMore: r.rows.length > q.limit,
  };
};
