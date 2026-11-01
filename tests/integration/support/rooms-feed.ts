/** Labelled fixtures for the residents' feed and memory tests (v3 R-8): library assets, the heartbeat over a fixture model. */
import { randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import type { Database } from '@knowscroll/backend/infrastructure/postgres';
import { importEditorialScrollUseCase, makeReadLibraryFinds } from '@knowscroll/backend/modules/content/nest-providers';
import { CONCEPTS, type ReadLibraryFinds } from '@knowscroll/backend/modules/content';
import { composeFeedHeartbeat } from '@knowscroll/backend/modules/rooms/nest-providers';
import { fixtureModel } from './fixture-model.js';
import type { FixtureCall, FixtureModelPort, FixtureScenario } from './fixture-model-port.js';
import { roomScope, unwrap, type RoomWorld } from './rooms.js';
import { starterSource } from './scroll.js';
import type { Friend } from './talk.js';
import { seedReel } from './thread-fixtures.js';

const version = 'rooms.v1' as const;
export const never = new AbortController().signal;

/** A planet of the Machine learning system: an asset whose primary topic it is belongs to that system's rooms. */
export const PLANET = CONCEPTS.find((concept) => concept.parent === 'machine-learning')!.id;

type StarterSource = {
  assetId: string;
  publication: { explanationUnitId: string };
  draft: { title: string; dek: string; sections: { blocks: { id: string; data: { spans: unknown } }[] }[] };
};

/** An authored CI fixture Scroll (the shipped starter under another identity). */
function scrollSource(assetId: string, unit: string, title: string): StarterSource {
  const source = starterSource() as unknown as StarterSource;
  source.assetId = assetId;
  source.publication.explanationUnitId = unit;
  source.draft.title = title;
  return source;
}

/** Admits a CI Scroll as a library asset of the Machine learning system, `minutesAgo` minutes old. Returns its ID. */
export async function libraryScroll(db: Kysely<Database>, title: string, minutesAgo = 0): Promise<string> {
  const assetId = randomUUID();
  const result = await importEditorialScrollUseCase(db)(scrollSource(assetId, `ci-feed-${assetId.slice(0, 8)}`, title));
  if (result.kind !== 'imported') throw new Error('the CI Scroll must import: ' + JSON.stringify(result));
  await underTopic(db, assetId, minutesAgo);
  return assetId;
}

/** Admits a CI Reel as a library asset of the Machine learning system. Returns its ID. */
export async function libraryReel(db: Kysely<Database>, title: string, minutesAgo = 0): Promise<string> {
  const reel = await seedReel(db, { title });
  await underTopic(db, reel.assetId, minutesAgo);
  return reel.assetId;
}

async function underTopic(db: Kysely<Database>, assetId: string, minutesAgo: number): Promise<void> {
  await db
    .insertInto('content.encounter_topics')
    .values({ asset_id: assetId, asset_revision: 1, topic_id: PLANET, role: 'primary', weight: 0.8 })
    .execute();
  // Newest first is how finds are offered, so a test says how old each asset is.
  await sql`update content.assets set created_at = now() - (${minutesAgo} * interval '1 minute') where id = ${assetId}::uuid`.execute(
    db,
  );
}

export const FIND_NOTE = 'Worth a look: a short walk through how a model turns words into pieces it can count.';
export const find = (text = FIND_NOTE): FixtureScenario => ({
  kind: 'success',
  text: JSON.stringify({ kind: 'find', text }),
});
export const MEMORY_TEXT = 'People compared how models are run.\nOne question about batching is still open.';
export const memory = (text = MEMORY_TEXT): FixtureScenario => ({
  kind: 'success',
  text: JSON.stringify({ kind: 'memory', text }),
});
export const NOTHING: FixtureScenario = { kind: 'success', text: JSON.stringify({ kind: 'nothing_to_add', text: '' }) };

/** What a call asked the model, as the words of its context items: the room, the find, what is remembered, the messages. */
export function requestText(call: FixtureCall): string {
  const { user } = JSON.parse(Buffer.from(call.bytes).toString('utf8')) as { user: string };
  return user;
}

/** Whether a call is the one that writes a find's note (by the context items it carries). */
export const isFindCall = (call: FixtureCall): boolean => /<context-item ref="find"/.test(requestText(call));

/**
 * The residents' heartbeat over a fixture model: what the worker's job and the operator command build, with the clock the
 * test moves. `script` plays every call; the default answers a find call with a find and a memory call with a memory.
 */
export function feedHeartbeat(
  world: RoomWorld,
  script: (sequence: number, call: FixtureCall) => FixtureScenario | Promise<FixtureScenario> = (_sequence, call) =>
    isFindCall(call) ? find() : memory(),
  options: { readonly readFinds?: ReadLibraryFinds } = {},
) {
  const model: FixtureModelPort = fixtureModel(script, { label: 'rooms-feed' });
  const { harness, withScope } = roomScope(world.db, model);
  const heartbeat = composeFeedHeartbeat({
    db: world.db,
    harness,
    withRoomScope: withScope,
    readFinds: options.readFinds ?? makeReadLibraryFinds(world.db),
    model: model.model,
    generation: 1,
    now: () => world.clock.now,
  });
  return {
    heartbeat,
    model,
    look: async (slug: string) => heartbeat.lookAt((await heartbeat.roomBySlug(slug))!, never),
  };
}

/** The room's feed as this person reads it. */
export const readFeed = async (world: RoomWorld, person: Friend, roomId: string) => {
  const feed = unwrap(await world.rooms.feed(person.authority, { version, readId: randomUUID(), roomId }));
  if (feed.status !== 'ready') throw new Error('expected a ready feed');
  return feed;
};

/** A moderator replaces what the residents remember (text), or clears it (null), under a fresh command ID. */
export const replaceMemory = (world: RoomWorld, moderator: Friend, roomId: string, text: string | null) =>
  world.rooms.replaceMemory(moderator.authority, { version, commandId: randomUUID(), roomId, text });

/** The room's ledger rows of residents' own finds and memory refreshes, oldest first. */
export const feedTurns = (db: Kysely<Database>, roomId: string) =>
  db
    .selectFrom('rooms.ai_turns')
    .selectAll()
    .where('room_id', '=', roomId)
    .where('trigger', 'in', ['feed_find', 'memory_refresh'])
    .orderBy('created_at')
    .execute();

export const memoryRow = (db: Kysely<Database>, roomId: string) =>
  db.selectFrom('rooms.room_memory').selectAll().where('room_id', '=', roomId).executeTakeFirst();
