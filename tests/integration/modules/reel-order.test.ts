/** Fixtures only: a fake Cutroom (no provider, no spend), a disposable pool and generated colour-bar video. */
import { readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { sql } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkShippedReelScript } from '@knowscroll/backend/modules/content/nest-providers';
import { createReelWorld, seedTwinScroll, type ReelWorld } from '../support/reel-world.js';

const twins = {
  'stars-fusion': {
    assetId: '637df7a3-e65d-4c94-8205-36e95818e7f8',
    explanationUnitId: 'space-stars-fusion-v1',
    topicId: 'space.stars',
  },
  'black-hole-horizon': {
    assetId: 'f1b42f11-432b-4533-ad08-bba27304d457',
    explanationUnitId: 'space-black-holes-horizon-v1',
    topicId: 'space.black-holes',
  },
  'exoplanet-transit': {
    assetId: 'f625ad99-e71c-4bc0-980e-4636455d8b02',
    explanationUnitId: 'space-exoplanets-transit-v1',
    topicId: 'space.exoplanets',
  },
} as const;
type Name = keyof typeof twins;

function identityOf(script: Name) {
  const check = checkShippedReelScript({ scriptName: script });
  if (check.kind !== 'ok') throw new Error('shipped script refused');
  return check;
}
const requestIdOf = (script: Name, until: 'plan' | 'video', take = 1) =>
  identityOf(script)[until === 'plan' ? 'rehearsal' : 'order'].requestId.replace(/-1$/, `-${take}`);

let world: ReelWorld;
let posts: { requestId: string; claimedInPool: boolean }[];
beforeEach(async () => {
  posts = [];
  world = await createReelWorld({
    onPost: async (body) => {
      // What the pool holds at the moment the POST arrives: claim before order.
      const { requestId } = JSON.parse(body) as { requestId: string };
      const claimed = await world.pool.client.query(
        "select 1 from pool_order where request_id = $1 and state = 'claimed'",
        [requestId],
      );
      posts.push({ requestId, claimedInPool: claimed.rowCount === 1 });
    },
  });
  await world.pool.raiseCap();
});
afterEach(async () => {
  await world.close();
});

async function dev(...scripts: Name[]) {
  const joined = await world.join('dev');
  for (const script of scripts) await seedTwinScroll(joined.db.db, twins[script]);
  return joined;
}
const row = async (db: Awaited<ReturnType<typeof dev>>['db'], query: ReturnType<typeof sql>) =>
  (await query.execute(db.db)).rows as Record<string, unknown>[];

describe('ordering a Reel from an approved script', () => {
  it('rehearses for nothing, claims before ordering, follows to the end, publishes the twin and settles once', async () => {
    const { db, operator, mediaRoot } = await dev('stars-fusion');
    const twin = twins['stars-fusion'];

    // A rehearsal is free: no claim, one POST, and it finishes as a plan with an estimate.
    const rehearsal = await operator.order({
      scriptName: 'stars-fusion',
      until: 'plan',
      ceilingCents: 75,
      retake: false,
    });
    expect(rehearsal).toMatchObject({ kind: 'sent', attempt: { state: 'succeeded', poolState: 'none' } });
    expect((await world.pool.orders()).length).toBe(0);
    world.cutroom.finishPlan(requestIdOf('stars-fusion', 'plan'), 48);
    expect(await operator.follow({ scriptName: 'stars-fusion', until: 'plan' })).toMatchObject({
      kind: 'finished',
      outcome: 'completed',
      costCents: 0,
      estimateCents: 48,
    });

    // The paid order: the pool holds the whole ceiling before the one POST arrives.
    const before = await world.pool.budget();
    const ordered = await operator.order({
      scriptName: 'stars-fusion',
      until: 'video',
      ceilingCents: 75,
      retake: false,
    });
    expect(ordered).toMatchObject({
      kind: 'sent',
      attempt: { take: 1, state: 'succeeded', poolState: 'claimed', ceilingCents: 75 },
    });
    const videoRequest = requestIdOf('stars-fusion', 'video');
    expect(posts.at(-1)).toEqual({ requestId: videoRequest, claimedInPool: true });
    expect((await world.pool.budget()).committed_cents).toBe(before.committed_cents + 75);
    const body = JSON.parse(world.cutroom.posts.at(-1)!) as { options: unknown };
    expect(body.options).toEqual({ until: 'video', budgetCents: 75 });

    // While Cutroom works nothing is settled and the operator sees progress.
    expect(await operator.follow({ scriptName: 'stars-fusion', until: 'video' })).toMatchObject({
      kind: 'running',
      progress: expect.arrayContaining(['stage.started plan']) as unknown,
    });
    expect((await world.pool.budget()).committed_cents).toBe(before.committed_cents + 75);

    // It completes at 58 cents: the Reel is published in the Scroll's unit and planet, then settled.
    await world.cutroom.finishCompleted(videoRequest, { costCents: 58 });
    const finished = await operator.follow({ scriptName: 'stars-fusion', until: 'video' });
    expect(finished, JSON.stringify(finished)).toMatchObject({
      kind: 'finished',
      outcome: 'completed',
      costCents: 58,
      overCeiling: false,
      settled: true,
    });
    const assetId = (finished as { published?: { assetId: string } }).published!.assetId;
    expect(assetId).toBe('53fcdbab-2ae5-4f40-a008-6f80fa4d0c61');

    const [reel] = await row(
      db,
      sql`select a.kind, a.status, r.explanation_unit_id, r.provenance_kind, d.facets, d.attribution_version
      from content.assets a join content.asset_revisions r on r.asset_id = a.id join content.discovery_revisions d on d.asset_id = r.asset_id
      where a.id = ${assetId}::uuid`,
    );
    expect(reel).toMatchObject({
      kind: 'reel',
      status: 'admitted',
      explanation_unit_id: twin.explanationUnitId,
      provenance_kind: 'cutroom_import',
      facets: [twin.topicId],
    });
    const siblings = await row(
      db,
      sql`select a.kind from content.asset_revisions r join content.assets a on a.id = r.asset_id
      where r.explanation_unit_id = ${twin.explanationUnitId} order by a.kind`,
    );
    expect(siblings.map((entry) => entry['kind'])).toEqual(['reel', 'scroll']);
    expect(
      await row(db, sql`select topic_id, role, weight from content.encounter_topics where asset_id = ${assetId}::uuid`),
    ).toEqual([{ topic_id: twin.topicId, role: 'primary', weight: 1 }]);
    const [provenance] = await row(
      db,
      sql`select provenance from content.asset_provenance where asset_id = ${assetId}::uuid`,
    );
    expect(provenance!['provenance']).toMatchObject({
      script: assetId,
      recipe: 'stars-fusion',
      take: 1,
      reportedCostCents: 58,
      witness: { label: 'engine-attested, not independent' },
      twin: { assetId: twin.assetId, assetRevision: 1 },
      approval: { ref: 'D-030 delegated' },
    });
    expect(JSON.stringify(provenance)).not.toContain('example.invalid');

    // The pool settled the real cost once and the world's own records agree.
    const pool = await world.pool.orders();
    expect(pool).toHaveLength(1);
    expect(pool[0]).toMatchObject({
      request_id: videoRequest,
      state: 'settled',
      outcome: 'completed',
      spent_cents: 58,
    });
    expect((await world.pool.budget()).committed_cents).toBe(before.committed_cents + 58);
    const [attempt] = await row(
      db,
      sql`select state, pool_state, remote_outcome, remote_cost_cents from content.reel_attempts where request_id = ${videoRequest}`,
    );
    expect(attempt).toMatchObject({
      state: 'succeeded',
      pool_state: 'settled',
      remote_outcome: 'completed',
      remote_cost_cents: 58,
    });
    expect(await row(db, sql`select asset_id from content.reel_orders where asset_id is not null`)).toHaveLength(1);
    expect(await row(db, sql`select script_name from content.reel_imports`)).toEqual([{ script_name: 'stars-fusion' }]);

    // Doing it all again changes nothing: one asset, one settlement, no second POST.
    const postCount = world.cutroom.posts.length;
    expect(await operator.follow({ scriptName: 'stars-fusion', until: 'video' })).toMatchObject({
      kind: 'finished',
      settled: true,
    });
    expect(
      await operator.order({ scriptName: 'stars-fusion', until: 'video', ceilingCents: 75, retake: false }),
    ).toMatchObject({
      kind: 'refused',
      code: 'already_published',
    });
    expect(world.cutroom.posts).toHaveLength(postCount);
    expect(await row(db, sql`select id from content.assets where kind = 'reel'`)).toHaveLength(1);
    expect(await world.pool.orders()).toHaveLength(1);
    const [media] = await row(db, sql`select logical_key, size_bytes from content.media_objects`);
    expect((await stat(join(mediaRoot, media!['logical_key'] as string))).size).toBe(Number(media!['size_bytes']));
  });

  it('settles a stopped run at its real cost, redacts what Cutroom said and retakes only when told to', async () => {
    const { operator, db } = await dev('stars-fusion');
    await operator.order({ scriptName: 'stars-fusion', until: 'video', ceilingCents: 75, retake: false });
    world.cutroom.finishStopped(requestIdOf('stars-fusion', 'video'), 66);
    const stopped = await operator.follow({ scriptName: 'stars-fusion', until: 'video' });
    expect(stopped).toMatchObject({ kind: 'finished', outcome: 'stopped', costCents: 66, settled: true });
    const detail = (stopped as { detail: string }).detail;
    expect(detail).toContain('rule gate-5 at video');
    expect(detail).not.toContain('example.invalid');
    expect(detail).not.toContain('/srv/');
    expect(await world.pool.orders()).toMatchObject([{ state: 'settled', outcome: 'stopped', spent_cents: 66 }]);
    expect(await row(db, sql`select id from content.assets where kind = 'reel'`)).toHaveLength(0);

    expect(
      await operator.order({ scriptName: 'stars-fusion', until: 'video', ceilingCents: 75, retake: false }),
    ).toMatchObject({
      kind: 'refused',
      code: 'last_attempt_ended',
      detail: 'stopped',
    });
    expect(world.cutroom.posts).toHaveLength(1);

    const retake = await operator.order({ scriptName: 'stars-fusion', until: 'video', ceilingCents: 75, retake: true });
    expect(retake).toMatchObject({ kind: 'sent', attempt: { take: 2, poolState: 'claimed' } });
    expect(world.cutroom.posts).toHaveLength(2);
    expect(new Set(world.cutroom.posts.map((post) => (JSON.parse(post) as { requestId: string }).requestId)).size).toBe(
      2,
    );
  });

  it('follows a failed run into the continuation Cutroom makes and settles the sum of both', async () => {
    const { operator } = await dev('black-hole-horizon');
    await operator.order({ scriptName: 'black-hole-horizon', until: 'video', ceilingCents: 75, retake: false });
    const requestId = requestIdOf('black-hole-horizon', 'video');
    const parent = world.cutroom.runOf(requestId);
    const child = world.cutroom.failAndResume(requestId, 34);

    // The failed run is not the end of the request while Cutroom is continuing it.
    expect(await operator.follow({ scriptName: 'black-hole-horizon', until: 'video' })).toMatchObject({
      kind: 'running',
      runIds: [parent.runId, child.runId],
    });
    expect(await world.pool.orders()).toMatchObject([{ state: 'claimed' }]);

    await world.cutroom.finishCompleted(requestId, { costCents: 12, resumes: parent.runId });
    const finished = await operator.follow({ scriptName: 'black-hole-horizon', until: 'video' });
    expect(finished).toMatchObject({ kind: 'finished', outcome: 'completed', costCents: 46, settled: true });
    expect(await world.pool.orders()).toMatchObject([
      { state: 'settled', outcome: 'completed', spent_cents: 46, final_run_id: child.runId },
    ]);
  });
});

describe('claim before order, and never the same money twice', () => {
  it('refuses a claim past the cap before anything is sent', async () => {
    const { operator, db } = await dev('stars-fusion');
    const left = (await world.pool.budget()).left_cents;
    expect(left).toBe(1017);
    // Leave 60 cents: the 75-cent ceiling no longer fits.
    for (let spent = 0; spent < 1017 - 60; spent += 75) await world.pool.seedSettled(Math.min(75, 1017 - 60 - spent));
    const refused = await operator.order({
      scriptName: 'stars-fusion',
      until: 'video',
      ceilingCents: 75,
      retake: false,
    });
    expect(refused).toMatchObject({
      kind: 'refused',
      code: 'pool_cap_exceeded',
      attempt: { state: 'not_sent', poolState: 'none' },
    });
    expect(world.cutroom.posts).toHaveLength(0);
    expect((await row(db, sql`select state, outcome_code from content.reel_attempts`))[0]).toEqual({
      state: 'not_sent',
      outcome_code: 'pool_cap_exceeded',
    });
    // A smaller ceiling that fits is allowed.
    expect(
      await operator.order({ scriptName: 'stars-fusion', until: 'video', ceilingCents: 60, retake: false }),
    ).toMatchObject({
      kind: 'sent',
      attempt: { ceilingCents: 60, poolState: 'claimed' },
    });
  });

  it('counts every open ceiling in full against the cap', async () => {
    const { operator } = await dev('stars-fusion', 'black-hole-horizon', 'exoplanet-transit');
    const budget = await world.pool.budget();
    expect(budget.cap_cents).toBe(1017);
    for (const script of ['stars-fusion', 'black-hole-horizon', 'exoplanet-transit'] as const)
      await operator.order({ scriptName: script, until: 'video', ceilingCents: 75, retake: false });
    expect((await world.pool.budget()).committed_cents).toBe(budget.committed_cents + 225);
    expect((await world.pool.budget()).left_cents).toBe(1017 - 225);
  });

  it('refuses to order a script another world has an open claim on, and says to receive it', async () => {
    const dev1 = await dev('stars-fusion');
    const stage = await world.join('stage');
    await seedTwinScroll(stage.db.db, twins['stars-fusion']);
    await dev1.operator.order({ scriptName: 'stars-fusion', until: 'video', ceilingCents: 75, retake: false });
    expect(
      await stage.operator.order({ scriptName: 'stars-fusion', until: 'video', ceilingCents: 75, retake: false }),
    ).toMatchObject({
      kind: 'refused',
      code: 'pool_already_ordered',
      detail: { orderedBy: 'dev' },
    });
    expect(world.cutroom.posts).toHaveLength(1);
    expect(await world.pool.orders()).toHaveLength(1);
  });

  it('refuses a ceiling above Cutroom’s own cap and one below a cent', async () => {
    const { operator } = await dev('stars-fusion');
    for (const ceilingCents of [76, 0, 1.5])
      expect(
        await operator.order({ scriptName: 'stars-fusion', until: 'video', ceilingCents, retake: false }),
      ).toMatchObject({
        kind: 'refused',
        code: 'ceiling_invalid',
      });
    expect(world.cutroom.posts).toHaveLength(0);
  });
});

describe('a request that may or may not have arrived', () => {
  it('is never resent: a run that exists is adopted, and the claim stays open meanwhile', async () => {
    const { operator } = await dev('stars-fusion');
    world.setPostMode('drop_after_run');
    const unknown = await operator.order({
      scriptName: 'stars-fusion',
      until: 'video',
      ceilingCents: 75,
      retake: false,
    });
    expect(unknown).toMatchObject({ kind: 'unknown', attempt: { state: 'unknown', poolState: 'claimed' } });
    world.setPostMode('accept');
    const again = await operator.order({ scriptName: 'stars-fusion', until: 'video', ceilingCents: 75, retake: false });
    expect(again).toMatchObject({ kind: 'in_progress', attempt: { state: 'reconciled' } });
    expect(world.cutroom.posts).toHaveLength(1);
    world.cutroom.finishStopped(requestIdOf('stars-fusion', 'video'), 10);
    expect(await operator.follow({ scriptName: 'stars-fusion', until: 'video' })).toMatchObject({
      kind: 'finished',
      outcome: 'stopped',
      costCents: 10,
    });
  });

  it('is never resent when no run is found, can be written off, and its claim stays counted', async () => {
    const { operator, db } = await dev('stars-fusion');
    const before = await world.pool.budget();
    world.setPostMode('drop_without_run');
    const unknown = await operator.order({
      scriptName: 'stars-fusion',
      until: 'video',
      ceilingCents: 75,
      retake: false,
    });
    expect(unknown).toMatchObject({ kind: 'unknown' });
    world.setPostMode('accept');
    expect(
      await operator.order({ scriptName: 'stars-fusion', until: 'video', ceilingCents: 75, retake: false }),
    ).toMatchObject({ kind: 'unknown' });
    expect(await operator.follow({ scriptName: 'stars-fusion', until: 'video' })).toMatchObject({ kind: 'unknown' });
    expect(world.cutroom.posts).toHaveLength(1);

    const attemptId = (unknown as { attempt: { attemptId: string } }).attempt.attemptId;
    expect(
      await operator.writeOff({ attemptId, reason: 'cli:test: engine log shows no run', releaseClaim: false }),
    ).toMatchObject({
      kind: 'written_off',
      attempt: { state: 'written_off', poolState: 'claimed' },
    });
    expect((await row(db, sql`select operator_note from content.reel_attempts`))[0]).toEqual({
      operator_note: 'cli:test: engine log shows no run',
    });
    expect((await world.pool.budget()).committed_cents).toBe(before.committed_cents + 75);
    // Another take cannot jump the open claim.
    expect(
      await operator.order({ scriptName: 'stars-fusion', until: 'video', ceilingCents: 75, retake: true }),
    ).toMatchObject({
      kind: 'refused',
      code: 'pool_already_ordered',
    });
    expect(world.cutroom.posts).toHaveLength(1);
    expect(await operator.writeOff({ attemptId, reason: 'again', releaseClaim: false })).toMatchObject({
      kind: 'refused',
      code: 'not_unknown',
    });
  });

  it('gives the claim back when Cutroom refuses the body outright', async () => {
    const { operator, db } = await dev('stars-fusion');
    const before = await world.pool.budget();
    world.setPostMode('refuse');
    const refused = await operator.order({
      scriptName: 'stars-fusion',
      until: 'video',
      ceilingCents: 75,
      retake: false,
    });
    expect(refused).toMatchObject({
      kind: 'refused',
      code: 'engine_refused',
      detail: 'invalid',
      attempt: { state: 'failed', poolState: 'released' },
    });
    expect(await world.pool.budget()).toEqual(before);
    expect(await world.pool.orders()).toMatchObject([{ state: 'released' }]);
    expect((await row(db, sql`select state, pool_state from content.reel_attempts`))[0]).toEqual({
      state: 'failed',
      pool_state: 'released',
    });
  });

  it('sends nothing and gives the claim back when Cutroom is not ready, then starts a new take', async () => {
    const { operator } = await dev('stars-fusion');
    world.cutroom.setReady(false);
    const before = await world.pool.budget();
    expect(
      await operator.order({ scriptName: 'stars-fusion', until: 'video', ceilingCents: 75, retake: false }),
    ).toMatchObject({
      kind: 'refused',
      code: 'engine_not_ready',
      attempt: { state: 'not_sent' },
    });
    expect(world.cutroom.posts).toHaveLength(0);
    expect(await world.pool.budget()).toEqual(before);
    world.cutroom.setReady(true);
    expect(
      await operator.order({ scriptName: 'stars-fusion', until: 'video', ceilingCents: 75, retake: false }),
    ).toMatchObject({
      kind: 'sent',
      attempt: { take: 2 },
    });
  });
});

describe('what a world checks before it orders', () => {
  it('needs the twin Scroll published here', async () => {
    const { operator } = await dev();
    expect(
      await operator.order({ scriptName: 'stars-fusion', until: 'plan', ceilingCents: 75, retake: false }),
    ).toMatchObject({
      kind: 'refused',
      code: 'scroll_not_published',
    });
    expect(world.cutroom.posts).toHaveLength(0);
  });

  it('refuses an unknown script and a script that repeats a Reel already here', async () => {
    const { operator, db } = await dev('stars-fusion');
    expect(
      await operator.order({ scriptName: 'no-such-script', until: 'plan', ceilingCents: 75, retake: false }),
    ).toMatchObject({
      kind: 'refused',
      code: 'script_unknown',
    });
    // A Reel from another source with the same narration and sources.
    const shipped = new URL(
      '../../../packages/backend/src/modules/content/approved/reels/stars-fusion.json',
      import.meta.url,
    );
    const { brief } = JSON.parse(await readFile(shipped, 'utf8')) as { brief: unknown };
    const otherAsset = '99999999-9999-4999-8999-999999999999';
    await sql`insert into content.assets (id, revision, kind, status) values (${otherAsset}::uuid, 1, 'reel', 'admitted')`.execute(
      db.db,
    );
    await sql`insert into content.asset_revisions (asset_id, revision, provenance_kind, document_version, document, document_sha256, explanation_unit_id, language, title, reading_facts)
      values (${otherAsset}::uuid, 1, 'cutroom_import', 'reel-document.v1', '{}'::jsonb, ${'1'.repeat(64)}, 'other-unit', 'en', '[Fixture] other', '{}'::jsonb)`.execute(
      db.db,
    );
    await sql`insert into content.asset_provenance (asset_id, revision, provenance_version, provenance)
      values (${otherAsset}::uuid, 1, 'reel-provenance.v1', ${JSON.stringify({ brief })}::jsonb)`.execute(db.db);
    expect(
      await operator.order({ scriptName: 'stars-fusion', until: 'video', ceilingCents: 75, retake: false }),
    ).toMatchObject({
      kind: 'refused',
      code: 'repetition',
      detail: { repetition: { label: otherAsset, shared: 'template' } },
    });
    expect(world.cutroom.posts).toHaveLength(0);
    expect(await world.pool.orders()).toHaveLength(0);
  });
});

describe('importing what Cutroom made', () => {
  async function completedOrder(options: { failTake?: boolean } = {}) {
    const joined = await dev('stars-fusion');
    await joined.operator.order({ scriptName: 'stars-fusion', until: 'video', ceilingCents: 75, retake: false });
    const requestId = requestIdOf('stars-fusion', 'video');
    const run = await world.cutroom.finishCompleted(requestId, { costCents: 55, ...options });
    return { ...joined, requestId, run };
  }

  it('keeps the claim open at its whole ceiling while the video cannot be read, then publishes and settles', async () => {
    const { operator, requestId, run } = await completedOrder();
    const video = (run.result as { video: { path: string } }).video.path;
    await rm(video);
    expect(await operator.follow({ scriptName: 'stars-fusion', until: 'video' })).toMatchObject({
      kind: 'held',
      code: 'artifact_not_readable',
    });
    expect(await world.pool.orders()).toMatchObject([{ request_id: requestId, state: 'claimed', ceiling_cents: 75 }]);
    await world.cutroom.finishCompleted(requestId, { costCents: 55 }).then(() => undefined);
    // finishCompleted rendered the same run again: the file is back and the follow can finish.
    expect(await operator.follow({ scriptName: 'stars-fusion', until: 'video' })).toMatchObject({
      kind: 'finished',
      settled: true,
      published: { created: true },
    });
  });

  it('settles as spent but publishes nothing when the engine’s own record does not attest the Reel', async () => {
    const { operator, db } = await completedOrder({ failTake: true });
    const result = await operator.follow({ scriptName: 'stars-fusion', until: 'video' });
    expect(result).toMatchObject({
      kind: 'finished',
      outcome: 'completed',
      costCents: 55,
      settled: true,
      reelRefused: 'record_take',
    });
    expect(await world.pool.orders()).toMatchObject([{ state: 'settled', outcome: 'completed', spent_cents: 55 }]);
    expect(await row(db, sql`select id from content.assets where kind = 'reel'`)).toHaveLength(0);
  });

  it('records a cost above the ceiling as it was, never clamped', async () => {
    const joined = await dev('stars-fusion');
    await joined.operator.order({ scriptName: 'stars-fusion', until: 'video', ceilingCents: 40, retake: false });
    world.cutroom.finishStopped(requestIdOf('stars-fusion', 'video'), 52);
    expect(await joined.operator.follow({ scriptName: 'stars-fusion', until: 'video' })).toMatchObject({
      kind: 'finished',
      costCents: 52,
      overCeiling: true,
    });
    expect(await world.pool.orders()).toMatchObject([{ spent_cents: 52 }]);
  });
});

describe('a second world receiving a Reel the first one paid for', () => {
  it('publishes the same Reel for nothing, once, without a claim or a POST', async () => {
    const devWorld = await dev('stars-fusion');
    const stage = await world.join('stage');
    await seedTwinScroll(stage.db.db, twins['stars-fusion']);
    expect(await stage.operator.receive({ scriptName: 'stars-fusion' })).toMatchObject({
      kind: 'refused',
      code: 'not_ordered',
    });

    await devWorld.operator.order({ scriptName: 'stars-fusion', until: 'video', ceilingCents: 75, retake: false });
    expect(await stage.operator.receive({ scriptName: 'stars-fusion' })).toMatchObject({
      kind: 'refused',
      code: 'still_running',
    });

    await world.cutroom.finishCompleted(requestIdOf('stars-fusion', 'video'), { costCents: 58 });
    expect(await devWorld.operator.follow({ scriptName: 'stars-fusion', until: 'video' })).toMatchObject({
      kind: 'finished',
      settled: true,
    });
    const pool = await world.pool.orders();
    const posts = world.cutroom.posts.length;

    const received = await stage.operator.receive({ scriptName: 'stars-fusion' });
    expect(received).toMatchObject({
      kind: 'received',
      created: true,
      orderedBy: 'dev',
      assetId: '53fcdbab-2ae5-4f40-a008-6f80fa4d0c61',
    });
    expect(await stage.operator.receive({ scriptName: 'stars-fusion' })).toMatchObject({
      kind: 'received',
      created: false,
    });
    expect(await world.pool.orders()).toEqual(pool);
    expect(world.cutroom.posts).toHaveLength(posts);
    const [provenance] = await row(stage.db, sql`select provenance from content.asset_provenance`);
    expect(provenance!['provenance']).toMatchObject({ orderedBy: 'dev', receivedBy: 'stage', reportedCostCents: 58 });
  });
});

describe('the ledger’s own guards', () => {
  it('refuse a move backwards, a paid attempt sent without a claim, and a delete', async () => {
    const { operator, db } = await dev('stars-fusion');
    await operator.order({ scriptName: 'stars-fusion', until: 'video', ceilingCents: 75, retake: false });
    const attempt = (await row(db, sql`select id from content.reel_attempts`))[0]!['id'] as string;
    await expect(
      sql`update content.reel_attempts set state = 'reserved' where id = ${attempt}::uuid`.execute(db.db),
    ).rejects.toThrow();
    await expect(
      sql`update content.reel_attempts set ceiling_cents = 1 where id = ${attempt}::uuid`.execute(db.db),
    ).rejects.toThrow();
    await expect(sql`delete from content.reel_attempts where id = ${attempt}::uuid`.execute(db.db)).rejects.toThrow();
    await expect(
      sql`insert into content.reel_attempts (id, order_id, take, paid, request_id, request_utf8, request_sha256, ceiling_cents, state, dispatched_at)
        select gen_random_uuid(), order_id, 9, true, 'ks-reel-${sql.raw('0'.repeat(32))}-9', 'x', encode(sha256(convert_to('x','UTF8')),'hex'), 75, 'dispatched', now()
        from content.reel_attempts`.execute(db.db),
    ).rejects.toThrow();
  });
});

describe('an attempt that provably never arrived', () => {
  const minutes = (count: number) => () => new Date(Date.now() + count * 60_000);

  it('gives its claim back only once Cutroom answers, has no run and the POST is long over', async () => {
    const { operator } = await world.join('dev', minutes(5)).then(async (joined) => {
      await seedTwinScroll(joined.db.db, twins['stars-fusion']);
      return joined;
    });
    const before = await world.pool.budget();
    world.setPostMode('drop_without_run');
    const unknown = await operator.order({
      scriptName: 'stars-fusion',
      until: 'video',
      ceilingCents: 75,
      retake: false,
    });
    const attemptId = (unknown as { attempt: { attemptId: string } }).attempt.attemptId;
    world.setPostMode('accept');

    world.cutroom.setReady(false);
    expect(await operator.writeOff({ attemptId, reason: 'test', releaseClaim: true })).toMatchObject({
      kind: 'refused',
      code: 'engine_unreachable',
    });
    world.cutroom.setReady(true);
    expect(await operator.writeOff({ attemptId, reason: 'test', releaseClaim: true })).toMatchObject({
      kind: 'written_off',
      attempt: { state: 'written_off', poolState: 'released' },
    });
    expect(await world.pool.budget()).toEqual(before);
    // The script can be ordered again as a new take: a new request id, so Cutroom sees it fresh.
    expect(
      await operator.order({ scriptName: 'stars-fusion', until: 'video', ceilingCents: 75, retake: true }),
    ).toMatchObject({
      kind: 'sent',
      attempt: { take: 2, poolState: 'claimed' },
    });
    expect(world.cutroom.posts).toHaveLength(2);
  });

  it('refuses inside the quiet period, and when Cutroom has a run for the request', async () => {
    const { operator } = await dev('stars-fusion');
    world.setPostMode('drop_without_run');
    const unknown = await operator.order({
      scriptName: 'stars-fusion',
      until: 'video',
      ceilingCents: 75,
      retake: false,
    });
    const attemptId = (unknown as { attempt: { attemptId: string } }).attempt.attemptId;
    expect(await operator.writeOff({ attemptId, reason: 'test', releaseClaim: true })).toMatchObject({
      kind: 'refused',
      code: 'not_quiet_yet',
    });

    const other = await world.join('stage');
    await seedTwinScroll(other.db.db, twins['exoplanet-transit']);
    world.setPostMode('drop_after_run');
    const made = await other.operator.order({
      scriptName: 'exoplanet-transit',
      until: 'video',
      ceilingCents: 75,
      retake: false,
    });
    const madeId = (made as { attempt: { attemptId: string } }).attempt.attemptId;
    expect(await other.operator.writeOff({ attemptId: madeId, reason: 'test', releaseClaim: true })).toMatchObject({
      kind: 'refused',
      code: 'run_exists',
    });
    expect(await world.pool.orders()).toMatchObject([{ state: 'claimed' }, { state: 'claimed' }]);
  });
});

describe('a Reel that is made but not published', () => {
  it('stays held, with its claim open, when the engine’s record disagrees with its result, until a person settles it', async () => {
    const { operator, db } = await dev('stars-fusion');
    await operator.order({ scriptName: 'stars-fusion', until: 'video', ceilingCents: 75, retake: false });
    await world.cutroom.finishCompleted(requestIdOf('stars-fusion', 'video'), { costCents: 61, mismatchRecord: true });
    const held = await operator.follow({ scriptName: 'stars-fusion', until: 'video' });
    expect(held).toMatchObject({ kind: 'held', code: 'record_shots' });
    expect(await world.pool.orders()).toMatchObject([{ state: 'claimed', ceiling_cents: 75 }]);

    expect(await operator.settleUnpublished({ scriptName: 'stars-fusion', until: 'video' })).toMatchObject({
      kind: 'settled',
      costCents: 61,
      attempt: { poolState: 'settled' },
    });
    expect(await world.pool.orders()).toMatchObject([{ state: 'settled', outcome: 'completed', spent_cents: 61 }]);
    expect(await operator.settleUnpublished({ scriptName: 'stars-fusion', until: 'video' })).toMatchObject({
      kind: 'refused',
      code: 'not_settleable',
    });
    expect(await operator.follow({ scriptName: 'stars-fusion', until: 'video' })).toMatchObject({
      kind: 'finished',
      settled: true,
      reelRefused: 'not_published',
    });
    expect(await row(db, sql`select id from content.assets where kind = 'reel'`)).toHaveLength(0);
  });
});
