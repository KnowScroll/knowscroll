import { sql } from 'kysely';
import { transactionOf } from '../../../infrastructure/postgres/personal-scope.js';
import type { ActivityPorts } from '../application/activity.js';
import type { ActivityChannels } from '../domain/activity.js';
import { decay, replaceContribution } from '../domain/activity.js';
export const readQualification: ActivityPorts['readQualification'] = async (scope, id) => {
  const r = await sql<{
    revision: number;
    qualification: 'qualified' | 'not_qualified' | 'unknown';
    q: number;
    asset_id: string;
    asset_revision: number;
  }>`select revision,qualification,q,asset_id,asset_revision from evidence.encounter_evidence where universe_id=${scope.authority.universeId}::uuid and privacy_epoch=${scope.authority.privacyEpoch} and exposure_id=${id}::uuid order by revision desc limit 1`.execute(
    transactionOf(scope),
  );
  const x = r.rows[0];
  return x
    ? {
        revision: x.revision,
        qualification: x.qualification,
        q: x.q,
        assetId: x.asset_id,
        assetRevision: x.asset_revision,
      }
    : undefined;
};
export const currentHash: ActivityPorts['currentHash'] = async (scope, id) => {
  const r = await sql<{
    input_sha256: string;
  }>`select r.input_sha256 from evidence.activity_current c join evidence.activity_revisions r on r.universe_id=c.universe_id and r.id=c.activity_id where c.universe_id=${scope.authority.universeId}::uuid and c.privacy_epoch=${scope.authority.privacyEpoch} and c.exposure_id=${id}::uuid`.execute(
    transactionOf(scope),
  );
  return r.rows[0]?.input_sha256;
};
type ChannelValues = Record<keyof ActivityChannels, number>;
const emptyChannels = (): ChannelValues => ({ q: 0, L: 0, B: 0, S: 0, H: 0, R: 0 });
function contributionChannels(channels: ActivityChannels, weight: number): ChannelValues {
  return {
    q: (channels.q ?? 0) * weight,
    L: Number(channels.L) * weight,
    B: Number(channels.B) * weight,
    S: 0,
    H: Number(channels.H) * weight,
    R: Number(channels.R) * weight,
  };
}
export const persistActivity: ActivityPorts['persist'] = async (scope, x) => {
  const db = transactionOf(scope),
    u = scope.authority.universeId,
    e = scope.authority.privacyEpoch;
  const prev = await sql<{
    revision: number;
  }>`select r.revision from evidence.activity_current c join evidence.activity_revisions r on r.universe_id=c.universe_id and r.id=c.activity_id where c.universe_id=${u}::uuid and c.exposure_id=${x.exposure.exposureId}::uuid and c.privacy_epoch=${e}`.execute(
    db,
  );
  const old = await sql<{
    topic_id: string;
    channel_values: ChannelValues;
    value: number;
    measured: number;
    qualified: number;
  }>`select topic_id,channel_values,value,measured,qualified from evidence.topic_contributions where universe_id=${u}::uuid and privacy_epoch=${e} and exposure_id=${x.exposure.exposureId}::uuid`.execute(
    db,
  );
  await sql`insert into evidence.activity_revisions(universe_id,privacy_epoch,id,exposure_id,revision,input_sha256,input_vector,channels,activity,policy_version) values(${u}::uuid,${e},${x.id}::uuid,${x.exposure.exposureId}::uuid,${(prev.rows[0]?.revision ?? 0) + 1},${x.inputHash},${JSON.stringify(x.inputVector)}::jsonb,${JSON.stringify(x.channels)}::jsonb,${x.value},'activity.v0')`.execute(
    db,
  );
  await sql`insert into evidence.activity_current(universe_id,privacy_epoch,exposure_id,activity_id) values(${u}::uuid,${e},${x.exposure.exposureId}::uuid,${x.id}::uuid) on conflict(universe_id,exposure_id) do update set activity_id=excluded.activity_id,privacy_epoch=excluded.privacy_epoch`.execute(
    db,
  );
  for (const topicId of new Set([...old.rows.map((t) => t.topic_id), ...x.metadata.topics.map((t) => t.topicId)])) {
    const topic = x.metadata.topics.find((t) => t.topicId === topicId);
    const before = old.rows.find((t) => t.topic_id === topicId);
    const next = topic ? topic.weight * x.value : 0;
    const measured = topic && topic.role !== 'incidental' && x.measured ? 1 : 0,
      qualified = topic && topic.role !== 'incidental' && x.qualified ? 1 : 0;
    const rows = await sql<{
      activity: number;
      channel_values: ChannelValues;
      evaluated_at: Date;
      reel_measured: number;
      reel_qualified: number;
      scroll_measured: number;
      scroll_qualified: number;
    }>`select * from evidence.topic_context where universe_id=${u}::uuid and privacy_epoch=${e} and topic_id=${topicId}`.execute(
      db,
    );
    const a = rows.rows[0];
    const activity = replaceContribution({
      aggregate: a?.activity ?? 0,
      aggregateAt: a ? new Date(a.evaluated_at).getTime() : Date.parse(x.evaluatedAt),
      evaluatedAt: Date.parse(x.evaluatedAt),
      encounterAt: Date.parse(x.exposure.activatedAt),
      previous: before?.value ?? 0,
      next,
    });
    const channelNext = contributionChannels(x.channels, topic?.weight ?? 0);
    const channelBefore = before?.channel_values ?? emptyChannels(),
      channelAggregate = a?.channel_values ?? emptyChannels();
    const channelValues = emptyChannels();
    for (const key of Object.keys(channelValues) as (keyof ChannelValues)[])
      channelValues[key] = replaceContribution({
        aggregate: channelAggregate[key],
        aggregateAt: a ? new Date(a.evaluated_at).getTime() : Date.parse(x.evaluatedAt),
        evaluatedAt: Date.parse(x.evaluatedAt),
        encounterAt: Date.parse(x.exposure.activatedAt),
        previous: channelBefore[key],
        next: channelNext[key],
      });
    const reel = x.exposure.kind === 'reel';
    const m = measured - (before?.measured ?? 0),
      q = qualified - (before?.qualified ?? 0);
    await sql`insert into evidence.topic_context(universe_id,privacy_epoch,topic_id,channel_values,activity,evaluated_at,reel_measured,reel_qualified,scroll_measured,scroll_qualified) values(${u}::uuid,${e},${topicId},${JSON.stringify(channelValues)}::jsonb,${activity},${x.evaluatedAt}::timestamptz,${(a?.reel_measured ?? 0) + (reel ? m : 0)},${(a?.reel_qualified ?? 0) + (reel ? q : 0)},${(a?.scroll_measured ?? 0) + (reel ? 0 : m)},${(a?.scroll_qualified ?? 0) + (reel ? 0 : q)}) on conflict(universe_id,topic_id) do update set channel_values=excluded.channel_values,activity=excluded.activity,evaluated_at=excluded.evaluated_at,reel_measured=excluded.reel_measured,reel_qualified=excluded.reel_qualified,scroll_measured=excluded.scroll_measured,scroll_qualified=excluded.scroll_qualified,privacy_epoch=excluded.privacy_epoch`.execute(
      db,
    );
  }
  await sql`delete from evidence.topic_contributions where universe_id=${u}::uuid and exposure_id=${x.exposure.exposureId}::uuid`.execute(
    db,
  );
  for (const t of x.metadata.topics)
    await sql`insert into evidence.topic_contributions(universe_id,privacy_epoch,exposure_id,topic_id,channel_values,value,measured,qualified) values(${u}::uuid,${e},${x.exposure.exposureId}::uuid,${t.topicId},${JSON.stringify(contributionChannels(x.channels, t.weight))}::jsonb,${t.weight * x.value},${t.role !== 'incidental' && x.measured ? 1 : 0},${t.role !== 'incidental' && x.qualified ? 1 : 0})`.execute(
      db,
    );
};
export const readTopicContext: ActivityPorts['readTopicContext'] = async (scope, ids, at) => {
  if (!ids.length) return [];
  const rows = await sql<{
    topic_id: string;
    activity: number;
    evaluated_at: Date;
    reel_measured: number;
    reel_qualified: number;
    scroll_measured: number;
    scroll_qualified: number;
  }>`select * from evidence.topic_context where universe_id=${scope.authority.universeId}::uuid and privacy_epoch=${scope.authority.privacyEpoch} and topic_id=any(${ids}::text[]) and (activity>0 or reel_measured+scroll_measured>0) limit 100`.execute(
    transactionOf(scope),
  );
  return rows.rows.map((r) => ({
    topicId: r.topic_id,
    activity: r.activity * decay(new Date(r.evaluated_at).getTime(), Date.parse(at)),
    formats: [
      { kind: 'reel', measured: r.reel_measured, qualified: r.reel_qualified },
      { kind: 'scroll', measured: r.scroll_measured, qualified: r.scroll_qualified },
    ],
  }));
};
export const pendingActivity: ActivityPorts['pending'] = async (scope, id) => {
  const r =
    await sql`select id from pgboss.job where name='evidence.project-encounter-activity' and state in('created','retry','active') and data->>'universeId'=${scope.authority.universeId} and data->>'privacyEpoch'=${String(scope.authority.privacyEpoch)} and data->>'exposureId'=${id} limit 1`.execute(
      transactionOf(scope),
    );
  return r.rows.length > 0;
};
