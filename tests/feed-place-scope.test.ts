/**
 * ADR-0051 — `GET /v1/feed?place=` over the real Fastify app and database. A reader who asks from a
 * star is offered only what the Atlas counts as that star's or its worlds' (a region's sub-regions
 * included); the same Composer decides, the decision records the place the reader asked from, and
 * exposure, Keep, why, export, Clear and Reset treat it as any other decision. Only a live planet or
 * region of the caller's own universe scopes a feed. A scoped decision observes exhaustion only for
 * the places it was asked from (ADR-0046).
 */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import type { SubstrateSeed } from '@knowscroll/contracts/semantic';
import { COMPOSER_SIGNALS_V2 } from '@knowscroll/core/composer/signals';
import { pool, provisionIdentity, transaction } from '@knowscroll/db';
import { loadSubstrateSeed } from '@knowscroll/db/semantic/seed';
import { buildApp } from '../apps/api/src/app.ts';
import { projectOne } from '../apps/worker/src/project.ts';
import { mintGatedTestReel } from '../scripts/fixtures/gated-reel.ts';
import { formPlaces, insertScroll } from './helpers/inquiry-fixture.ts';

if (
  !new URL(process.env.DATABASE_URL!).pathname.startsWith('/knowscroll_test_')
)
  throw new Error(
    'Feed scope tests require a disposable knowscroll_test_* database',
  );
const app = buildApp(randomBytes(32).toString('hex'));
const signalsApp = buildApp(randomBytes(32).toString('hex'), {
  composerPolicy: COMPOSER_SIGNALS_V2,
});
await app.ready();
await signalsApp.ready();
after(async () => {
  await app.close();
  await signalsApp.close();
  await pool.end();
});

type Identity = Awaited<ReturnType<typeof provisionIdentity>>;
const h = (i: Identity) => ({ authorization: `Bearer ${i.token}` });

/**
 * A unique substrate (knowledge rows are global, so every call mints its own codes):
 *
 *   root ─ star ─ world ─ deep          star, world and deep become a planet, a region, a sub-region
 *        │      ├ edge                  no place of its own: its Scroll's home is the star
 *        │      ├ split                 a sighting of the star (star explains split)
 *        │      ├ gone                  a region the reader sets aside: its Scroll falls back to the star
 *        │      └ a ─ b ─ far           three hops below the star: its own free planet
 *        ├ other                        another star
 *        └ empty                        a star with no Scroll at all
 */
type Code =
  | 'root'
  | 'star'
  | 'world'
  | 'deep'
  | 'edge'
  | 'split'
  | 'gone'
  | 'a'
  | 'ab'
  | 'far'
  | 'other'
  | 'empty';
type ScrollName =
  | 'root'
  | 'star'
  | 'world'
  | 'deep'
  | 'edge'
  | 'split'
  | 'gone'
  | 'far'
  | 'other';
type Fixture = {
  codes: Record<Code, string>;
  scrolls: Record<ScrollName, string>;
};

async function makeFixture(): Promise<Fixture> {
  const tag = `f${randomBytes(5).toString('hex')}`;
  const codes: Record<Code, string> = {
    root: tag,
    star: `${tag}.star`,
    world: `${tag}.star.world`,
    deep: `${tag}.star.world.deep`,
    edge: `${tag}.star.edge`,
    split: `${tag}.star.split`,
    gone: `${tag}.star.gone`,
    a: `${tag}.star.a`,
    ab: `${tag}.star.a.b`,
    far: `${tag}.star.a.b.far`,
    other: `${tag}.other`,
    empty: `${tag}.empty`,
  };
  const parents: Record<Code, Code | null> = {
    root: null,
    star: 'root',
    world: 'star',
    deep: 'world',
    edge: 'star',
    split: 'star',
    gone: 'star',
    a: 'star',
    ab: 'a',
    far: 'ab',
    other: 'root',
    empty: 'root',
  };
  const scrolls = {} as Record<ScrollName, string>;
  // One source per Scroll, so the per-source cap never decides which of them a slate shows.
  for (const name of [
    'root',
    'star',
    'world',
    'deep',
    'edge',
    'split',
    'gone',
    'far',
    'other',
  ] as const)
    scrolls[name] = await insertScroll(
      pool,
      `${tag} About ${name}`,
      `Fixture source ${name}`,
      `https://example.test/${tag}/${name}`,
    );
  const quote = 'A verbatim passage long enough to be a quote.';
  const seed: SubstrateSeed = {
    version: `editorial-substrate-2026-10-16.${parseInt(randomBytes(3).toString('hex'), 16)}`,
    families: [
      {
        key: `fam.${tag}`,
        kind: 'publisher',
        description: 'Synthetic test publisher family',
      },
    ],
    sources: [
      {
        key: `src.${tag}`,
        url: `https://example.test/${tag}/source`,
        title: 'Scope fixture',
        publisher: 'Fixture',
        familyKey: `fam.${tag}`,
        retrievedAt: '2026-10-16',
        contentSha256: randomBytes(32).toString('hex'),
      },
    ],
    concepts: (Object.keys(codes) as Code[]).map((k) => ({
      code: codes[k],
      name: `Scope ${k}`,
      description: `The ${k} concept of a synthetic scope substrate`,
      kind: 'idea' as const,
      parentCode: parents[k] === null ? null : codes[parents[k]!],
    })),
    claims: [
      {
        key: `clm.${tag}.star_split`,
        statement:
          'The star concept explains the split concept in this fixture.',
        truthState: 'documented',
        concepts: [
          { code: codes.star, role: 'subject' },
          { code: codes.split, role: 'object' },
        ],
        support: [{ sourceKey: `src.${tag}`, quote, supportKind: 'supports' }],
      },
    ],
    relations: [
      {
        from: codes.star,
        to: codes.split,
        kind: 'explains',
        claimKey: `clm.${tag}.star_split`,
      },
    ],
    assets: (Object.keys(scrolls) as ScrollName[]).map((name) => ({
      assetId: scrolls[name],
      concepts: [{ code: codes[name], role: 'primary' as const }],
      claims: [],
    })),
    bridgeProposals: [],
  };
  assert.equal(
    (await transaction((c) => loadSubstrateSeed(c, JSON.stringify(seed))))
      .status,
    'loaded',
  );
  return { codes, scrolls };
}

type AtlasPlace = {
  placeId: string;
  kind: 'planet' | 'region' | 'sighting';
  parentPlaceId: string | null;
  anchor: { code: string };
  scrolls: { total: number; seen: number };
};

async function atlasOf(i: Identity): Promise<AtlasPlace[]> {
  const r = await app.inject({ url: '/v1/atlas', headers: h(i) });
  assert.equal(r.statusCode, 200, r.body);
  return r.json().places;
}

function placeOf(places: AtlasPlace[], code: string): AtlasPlace {
  const place = places.find((p) => p.anchor.code === code);
  assert.ok(
    place,
    `no live place for ${code}: ${JSON.stringify(places.map((p) => [p.anchor.code, p.kind]))}`,
  );
  return place!;
}

/** Forms the places the fixture describes by the real Cartographer, then sets `gone` aside. */
async function formFixturePlaces(
  i: Identity,
  f: Fixture,
  anchors: Code[] = ['star', 'world', 'deep', 'gone', 'far', 'other', 'empty'],
) {
  await formPlaces(
    i.scope.universeId,
    anchors.map((k) => f.codes[k]),
  );
  if (anchors.includes('gone')) {
    const gone = placeOf(await atlasOf(i), f.codes.gone);
    const rejected = await app.inject({
      method: 'POST',
      url: `/v1/atlas/places/${gone.placeId}/reject`,
      headers: h(i),
      payload: { expectedPrivacyEpoch: i.scope.privacyEpoch },
    });
    assert.equal(rejected.statusCode, 200, rejected.body);
  }
  const places = await atlasOf(i);
  return {
    places,
    byCode: (k: Code) => placeOf(places, f.codes[k]),
  };
}

type FeedBody = {
  decisionId: string;
  privacyEpoch: number;
  items: { assetId: string; kind: string }[];
};

async function feed(
  i: Identity,
  query: string,
  through = app,
): Promise<{ status: number; body: FeedBody & { error?: string } }> {
  const r = await through.inject({ url: `/v1/feed?${query}`, headers: h(i) });
  return { status: r.statusCode, body: r.json() };
}

async function scopedFeed(
  i: Identity,
  placeId: string,
  extra = '',
): Promise<FeedBody> {
  const r = await feed(i, `place=${placeId}${extra}`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
}

/** Every asset the decision considered, selected or gated (ADR-0032 §4). */
async function considered(decisionId: string): Promise<Set<string>> {
  return new Set(
    (
      await pool.query<{ asset_id: string }>(
        'SELECT DISTINCT asset_id FROM decision_candidate WHERE decision_id=$1',
        [decisionId],
      )
    ).rows.map((r) => r.asset_id),
  );
}

async function scopeOf(decisionId: string): Promise<string | null> {
  return (
    await pool.query<{ scope_place_id: string | null }>(
      'SELECT scope_place_id FROM decision WHERE id=$1',
      [decisionId],
    )
  ).rows[0]!.scope_place_id;
}

const decisionsOf = async (i: Identity) =>
  Number(
    (
      await pool.query('SELECT count(*) FROM decision WHERE universe_id=$1', [
        i.scope.universeId,
      ])
    ).rows[0].count,
  );

const sorted = (ids: Iterable<string>) => [...ids].sort();

async function expose(
  i: Identity,
  decisionId: string,
  assetId: string,
): Promise<string> {
  const r = await app.inject({
    method: 'POST',
    url: '/v1/exposures',
    headers: h(i),
    payload: { decisionId, assetId, clientExposureId: randomUUID() },
  });
  assert.equal(r.statusCode, 201, r.body);
  return r.json().exposureId;
}

/** Asks from a place, skipping what this trip already saw, until the target is offered; exposes it. */
async function exposeFrom(i: Identity, placeId: string, assetId: string) {
  const skipped: string[] = [];
  for (;;) {
    const body = await scopedFeed(
      i,
      placeId,
      skipped.length ? `&exclude=${skipped.join(',')}` : '',
    );
    if (body.items.length === 0)
      throw new Error(`The place never offered ${assetId}`);
    if (!body.items.some((x) => x.assetId === assetId)) {
      skipped.push(...body.items.map((x) => x.assetId));
      continue;
    }
    return {
      decisionId: body.decisionId,
      exposureId: await expose(i, body.decisionId, assetId),
    };
  }
}

test("a star's scope is its own Scrolls and its worlds', exactly as the Atlas counts them", async () => {
  const i = await provisionIdentity();
  const f = await makeFixture();
  const { places, byCode } = await formFixturePlaces(i, f);
  const star = byCode('star');
  const world = byCode('world');
  const deep = byCode('deep');
  // The Cartographer's own placing (ADR-0036): a region within two hops, else a free planet.
  assert.deepEqual(
    [
      star.kind,
      world.kind,
      deep.kind,
      byCode('far').kind,
      byCode('other').kind,
    ],
    ['planet', 'region', 'region', 'planet', 'planet'],
  );
  assert.equal(world.parentPlaceId, star.placeId);
  assert.equal(deep.parentPlaceId, world.placeId);
  const sighting = byCode('split');
  assert.equal(sighting.kind, 'sighting');
  assert.equal(sighting.parentPlaceId, star.placeId);
  assert.equal(
    places.some((p) => p.anchor.code === f.codes.gone),
    false,
    'a place set aside is no longer live',
  );

  const s = f.scrolls;
  const expected: [AtlasPlace, string[]][] = [
    // The star holds its own Scroll, the edge's (no place of its own), the set-aside region's, and
    // its worlds'. Not the sighting's (the Atlas counts it toward the sighting), not the free planet's.
    [star, [s.star, s.edge, s.gone, s.world, s.deep]],
    [world, [s.world, s.deep]],
    [deep, [s.deep]],
    [byCode('far'), [s.far]],
    [byCode('other'), [s.other]],
  ];
  for (const [place, ids] of expected) {
    const body = await scopedFeed(i, place.placeId);
    assert.deepEqual(
      sorted(await considered(body.decisionId)),
      sorted(ids),
      place.anchor.code,
    );
    assert.ok(body.items.length > 0, place.anchor.code);
    for (const item of body.items)
      assert.ok(ids.includes(item.assetId), place.anchor.code);
    assert.equal(await scopeOf(body.decisionId), place.placeId);
    // One source of truth: the scope is the place's own count plus its live regions' counts.
    const within = (p: AtlasPlace): AtlasPlace[] => [
      p,
      ...places
        .filter((c) => c.kind === 'region' && c.parentPlaceId === p.placeId)
        .flatMap(within),
    ];
    assert.equal(
      within(place).reduce((n, p) => n + p.scrolls.total, 0),
      ids.length,
      place.anchor.code,
    );
  }

  // The unscoped feed is unchanged and records no scope.
  const whole = await feed(i, 'kinds=Scroll');
  assert.equal(whole.status, 200);
  assert.equal(await scopeOf(whole.body.decisionId), null);
  assert.ok((await considered(whole.body.decisionId)).has(s.root));
});

test("only this universe's live planets and regions scope a feed: anything else is 404, a malformed or repeated place is 400", async () => {
  const i = await provisionIdentity();
  const other = await provisionIdentity();
  const f = await makeFixture();
  const { byCode } = await formFixturePlaces(i, f);
  const foreign = (await formFixturePlaces(other, f, ['star'])).byCode('star');
  const gone = (
    await pool.query<{ id: string }>(
      `SELECT p.id FROM atlas_place p JOIN concept c ON c.id = p.anchor_concept_id
       WHERE p.universe_id=$1 AND c.code=$2 AND p.state='rejected'`,
      [i.scope.universeId, f.codes.gone],
    )
  ).rows[0]!.id;
  const before = await decisionsOf(i);
  for (const placeId of [
    byCode('split').placeId, // a sighting is a possibility, not a place to read from
    gone, // set aside
    foreign.placeId, // another universe's star
    randomUUID(),
  ]) {
    const r = await feed(i, `place=${placeId}`);
    assert.equal(r.status, 404, `${placeId}: ${JSON.stringify(r.body)}`);
  }
  for (const query of [
    'place=not-a-uuid',
    'place=',
    `place=${byCode('star').placeId}&place=${byCode('world').placeId}`,
    `place=${byCode('star').placeId},${byCode('world').placeId}`,
  ]) {
    const r = await feed(i, query);
    assert.equal(r.status, 400, query);
    assert.equal(r.body.error, 'Invalid place parameter');
  }
  assert.equal(
    await decisionsOf(i),
    before,
    'a refused request decides nothing',
  );
  // An id is an id whatever its case, as for `exclude`.
  const upper = await feed(i, `place=${byCode('world').placeId.toUpperCase()}`);
  assert.equal(upper.status, 200);
  assert.equal(await scopeOf(upper.body.decisionId), byCode('world').placeId);
});

test('an empty place answers with no items and still records the decision it made', async () => {
  const i = await provisionIdentity();
  const f = await makeFixture();
  const { byCode } = await formFixturePlaces(i, f, ['star', 'empty']);
  const body = await scopedFeed(i, byCode('empty').placeId);
  assert.deepEqual(body.items, []);
  assert.equal(body.privacyEpoch, i.scope.privacyEpoch);
  assert.equal(await scopeOf(body.decisionId), byCode('empty').placeId);
  assert.equal((await considered(body.decisionId)).size, 0);
});

test('a scoped encounter is exposed, kept and explained like any other, and export carries where it was asked from', async () => {
  const i = await provisionIdentity();
  const f = await makeFixture();
  const { byCode } = await formFixturePlaces(i, f, ['star', 'world']);
  const world = byCode('world');
  const first = await scopedFeed(i, world.placeId);
  const served = first.items[0]!.assetId;
  const exposureId = await expose(i, first.decisionId, served);
  assert.equal(
    (
      await pool.query('SELECT decision_id FROM exposure WHERE id=$1', [
        exposureId,
      ])
    ).rows[0].decision_id,
    first.decisionId,
  );
  const kept = await app.inject({
    method: 'POST',
    url: '/v1/interactions',
    headers: h(i),
    payload: {
      clientEventId: randomUUID(),
      exposureId,
      assetId: served,
      kind: 'keep',
    },
  });
  assert.equal(kept.statusCode, 202, kept.body);
  await pool.query(
    "UPDATE job SET available_at='1990-01-01T00:00:00Z' WHERE id=$1",
    [kept.json().jobId],
  );
  assert.equal((await projectOne())?.status, 'completed');
  const why = await app.inject({
    url: `/v1/decisions/${first.decisionId}/why?assetId=${served}`,
    headers: h(i),
  });
  assert.equal(why.statusCode, 200, why.body);
  assert.equal(why.json().decisionId, first.decisionId);

  // The kept Scroll is gated in the next scoped decision, as anywhere (ADR-0032 §3).
  const next = await scopedFeed(i, world.placeId);
  assert.equal(
    next.items.some((x) => x.assetId === served),
    false,
  );
  assert.equal(
    (
      await pool.query(
        'SELECT gate FROM decision_candidate WHERE decision_id=$1 AND asset_id=$2 LIMIT 1',
        [next.decisionId, served],
      )
    ).rows[0].gate,
    'kept',
  );

  const exported = await app.inject({
    method: 'POST',
    url: '/v1/privacy/export',
    headers: h(i),
    payload: {
      requestId: randomUUID(),
      expectedPrivacyEpoch: i.scope.privacyEpoch,
    },
  });
  assert.equal(exported.statusCode, 200, exported.body);
  const rows = exported.json().decisions as {
    id: string;
    scope_place_id: string | null;
  }[];
  assert.equal(
    rows.find((d) => d.id === first.decisionId)?.scope_place_id,
    world.placeId,
  );
  const whole = await feed(i, 'kinds=Scroll');
  assert.equal(await scopeOf(whole.body.decisionId), null);
});

test('Clear and Reset erase scoped decisions with the places they name', async () => {
  const f = await makeFixture();
  for (const [url, confirmation] of [
    ['/v1/history/clear', 'clear-scroll-history'],
    ['/v1/privacy/reset', 'reset-personal-universe'],
  ] as const) {
    const i = await provisionIdentity();
    const { byCode } = await formFixturePlaces(i, f, ['star', 'world']);
    const star = byCode('star');
    const body = await scopedFeed(i, star.placeId);
    await expose(i, body.decisionId, body.items[0]!.assetId);
    const erased = await app.inject({
      method: 'POST',
      url,
      headers: h(i),
      payload: {
        requestId: randomUUID(),
        expectedPrivacyEpoch: i.scope.privacyEpoch,
        confirmation,
      },
    });
    assert.equal(erased.statusCode, 200, `${url}: ${erased.body}`);
    for (const table of ['decision', 'atlas_place']) {
      assert.equal(
        Number(
          (
            await pool.query(
              `SELECT count(*) FROM ${table} WHERE universe_id=$1`,
              [i.scope.universeId],
            )
          ).rows[0].count,
        ),
        0,
        `${url}: ${table}`,
      );
    }
    if (url === '/v1/history/clear') {
      // The place went with the history: asking from it again finds nothing there.
      const again = await feed(i, `place=${star.placeId}`);
      assert.equal(again.status, 404);
    }
  }
});

test("a Reel joins its Scroll's place only when the feed is asked for Reels", async () => {
  const i = await provisionIdentity();
  const f = await makeFixture();
  const { byCode } = await formFixturePlaces(i, f, ['star', 'world', 'other']);
  const reel = await mintGatedTestReel(pool, f.scrolls.world, {
    tag: `scope-${randomBytes(4).toString('hex')}`,
    title: 'A Reel about the world',
    summary: 'A test Reel over the world Scroll.',
  });
  const world = byCode('world').placeId;
  const both = await scopedFeed(i, world, '&kinds=Scroll,Reel');
  assert.deepEqual(
    sorted(await considered(both.decisionId)),
    sorted([f.scrolls.world, f.scrolls.deep, reel.assetId]),
  );
  const reels = await scopedFeed(i, world, '&kinds=Reel');
  assert.deepEqual(sorted(await considered(reels.decisionId)), [reel.assetId]);
  assert.deepEqual(
    reels.items.map((x) => [x.assetId, x.kind]),
    [[reel.assetId, 'Reel']],
  );
  const scrollsOnly = await scopedFeed(i, world);
  assert.deepEqual(
    sorted(await considered(scrollsOnly.decisionId)),
    sorted([f.scrolls.world, f.scrolls.deep]),
  );
  const elsewhere = await scopedFeed(i, byCode('other').placeId, '&kinds=Reel');
  assert.deepEqual(elsewhere.items, []);
});

test('a scoped decision records a need only for the places it was asked from (ADR-0046)', async () => {
  const i = await provisionIdentity();
  const f = await makeFixture();
  const { byCode } = await formFixturePlaces(i, f, ['star', 'world', 'other']);
  const [star, world, other] = [
    byCode('star'),
    byCode('world'),
    byCode('other'),
  ];
  const demandFor = async (code: string) =>
    (
      await pool.query<{
        causes: { kind: string; decisionId: string; placeId: string }[];
      }>(
        `SELECT d.causes FROM content_demand d JOIN concept c ON c.id = d.concept_id
         WHERE d.universe_id=$1 AND c.code=$2`,
        [i.scope.universeId, code],
      )
    ).rows[0];

  // Everything about `other` is shown; asked from the world, that is not the world's decision to record.
  await exposeFrom(i, other.placeId, f.scrolls.other);
  await exposeFrom(i, world.placeId, f.scrolls.world);
  await exposeFrom(i, world.placeId, f.scrolls.deep);
  assert.equal(await demandFor(f.codes.other), undefined);

  // Asked from the star, its exhausted world is a need; `other`, outside the star, is still not.
  const fromStar = await scopedFeed(i, star.placeId);
  const worldNeed = await demandFor(f.codes.world);
  assert.ok(worldNeed, 'the exhausted world inside the star is observed');
  assert.deepEqual(
    worldNeed!.causes.map((c) => [c.kind, c.decisionId, c.placeId]),
    [['exhaustion', fromStar.decisionId, world.placeId]],
  );
  assert.equal(await demandFor(f.codes.other), undefined);
  assert.equal(
    await demandFor(f.codes.star),
    undefined,
    'the star still holds unseen Scrolls',
  );

  // Asked from `other` itself, its need is recorded by that decision.
  const fromOther = await scopedFeed(i, other.placeId);
  assert.deepEqual(
    (await demandFor(f.codes.other))!.causes.map((c) => [
      c.kind,
      c.decisionId,
      c.placeId,
    ]),
    [['exhaustion', fromOther.decisionId, other.placeId]],
  );
});

test('composer-signals-v2 scopes and records the place the same way', async () => {
  const i = await provisionIdentity();
  const f = await makeFixture();
  const { byCode } = await formFixturePlaces(i, f, ['star', 'world', 'deep']);
  const world = byCode('world').placeId;
  const r = await feed(i, `place=${world}`, signalsApp);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(await scopeOf(r.body.decisionId), world);
  const ranked = (
    await pool.query<{ asset_id: string }>(
      'SELECT asset_id FROM decision_signal WHERE decision_id=$1',
      [r.body.decisionId],
    )
  ).rows.map((x) => x.asset_id);
  assert.deepEqual(sorted(ranked), sorted([f.scrolls.world, f.scrolls.deep]));
  assert.equal((await feed(i, 'place=nope', signalsApp)).status, 400);
});

test("the schema refuses a scope outside the decision's own universe's live planets and regions, and a changed scope", async () => {
  const i = await provisionIdentity();
  const other = await provisionIdentity();
  const f = await makeFixture();
  const { byCode } = await formFixturePlaces(i, f, ['star', 'world']);
  const foreign = (await formFixturePlaces(other, f, ['star'])).byCode('star');
  const insert = (placeId: string | null) =>
    transaction(async (client) => {
      const id = randomUUID();
      await client.query(
        `INSERT INTO decision(id,universe_id,account_revision,policy_version,candidates,privacy_epoch,scope_place_id)
         VALUES($1,$2,0,'scope-guard-test','[]'::jsonb,$3,$4)`,
        [id, i.scope.universeId, i.scope.privacyEpoch, placeId],
      );
      return id;
    });
  await assert.rejects(insert(foreign.placeId), /live planet or region/);
  await assert.rejects(
    insert(byCode('split').placeId),
    /live planet or region/,
  );
  await assert.rejects(insert(randomUUID()), /live planet or region/);
  const recorded = await insert(byCode('world').placeId);
  await assert.rejects(
    pool.query('UPDATE decision SET scope_place_id=$2 WHERE id=$1', [
      recorded,
      byCode('star').placeId,
    ]),
    /scope is fixed/,
  );
  await assert.rejects(
    pool.query('UPDATE decision SET scope_place_id=NULL WHERE id=$1', [
      recorded,
    ]),
    /scope is fixed/,
  );
  // An unscoped decision stays unscoped.
  const unscoped = await insert(null);
  await assert.rejects(
    pool.query('UPDATE decision SET scope_place_id=$2 WHERE id=$1', [
      unscoped,
      byCode('star').placeId,
    ]),
    /scope is fixed/,
  );
});
