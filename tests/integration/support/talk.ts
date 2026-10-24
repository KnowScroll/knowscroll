/** Labelled fixtures for conversation and share-link tests: real use cases over the test database, no HTTP. */
import { createHash, randomUUID } from 'node:crypto';
import { sql, type Kysely, type KyselyPlugin, type PluginTransformResultArgs, type UnknownRow } from 'kysely';
import { expect } from 'vitest';
import type { PublicPersonRef } from '@knowscroll/contracts';
import { makeWithPersonalScope, type Database } from '@knowscroll/backend/infrastructure/postgres';
import { accountAccessUseCases } from '@knowscroll/backend/modules/identity/nest-providers';
import {
  makeReadPublicContent,
  readContentSequence,
  readShareableContent,
  resolveSnippetAnchor,
  validateSnippetAnchor,
} from '@knowscroll/backend/modules/content/nest-providers';
import { readVisitedAssets } from '@knowscroll/backend/modules/experience/nest-providers';
import { conversationUseCases, socialUseCases, threadUseCases } from '@knowscroll/backend/modules/social/nest-providers';
import { seedPerson, type FixturePerson } from './fixtures.js';

export type Friends = ReturnType<typeof socialUseCases>;
export type Talk = ReturnType<typeof conversationUseCases>;
export type Threads = ReturnType<typeof threadUseCases>;
export type Friend = FixturePerson & { readonly person: PublicPersonRef };

/** Friends and Talk use cases over one database; `clock.now` can be moved to test expiry. */
export function talkCases(db: Kysely<Database>, clock: { now: Date } = { now: new Date('2026-10-24T08:00:00Z') }) {
  const access = accountAccessUseCases({ db, lockTimeoutMs: 10_000 });
  const deps = {
    withScope: makeWithPersonalScope(db, { lockTimeoutMs: 10_000 }),
    fencePair: access.fenceAccountPair,
    fenceOwn: access.fenceOwnAccount,
    now: () => clock.now,
  };
  return {
    clock,
    friends: socialUseCases(deps),
    talk: conversationUseCases({
      ...deps,
      db,
      readContent: readShareableContent,
      readPublicContent: makeReadPublicContent(db),
    }),
    threads: threadUseCases({
      ...deps,
      readContent: readShareableContent,
      readSequence: readContentSequence,
      readVisited: readVisitedAssets,
      validateSnippet: validateSnippetAnchor,
      resolveSnippet: resolveSnippetAnchor,
    }),
  };
}

/**
 * A Kysely plugin that runs `action` once, right after the Talk inbox's first statement (the one that
 * lists conversations) has returned its rows and before the next statement. It stands in for a
 * message that commits in the middle of a read, which READ COMMITTED allows.
 */
export function afterInboxRows(action: () => Promise<void>): KyselyPlugin {
  let fired = false;
  return {
    transformQuery: ({ node }) => node,
    async transformResult({ result }: PluginTransformResultArgs) {
      const listed = result.rows.some((row: UnknownRow) => 'own_membership_id' in row);
      if (listed && !fired) {
        fired = true;
        await action();
      }
      return result;
    },
  };
}

/** A person with a claimed public profile. */
export async function seedFriend(db: Kysely<Database>, friends: Friends): Promise<Friend> {
  const person = await seedPerson(db);
  const handle = `ci.${person.accountId.replaceAll('-', '').slice(0, 14)}`;
  const set = await friends.setProfile(person.authority, {
    version: 'sharing.v1',
    commandId: randomUUID(),
    expectedProfileRevision: 0,
    handle,
    displayName: 'Fixture friend',
  });
  expect(set.kind).toBe('ok');
  const read = await friends.readProfile(person.authority);
  if (read.kind !== 'ok' || read.value.status !== 'claimed') throw new Error('CI profile');
  return { ...person, person: read.value.person };
}

async function pairOf(friends: Friends, actor: Friend, peer: Friend) {
  const result = await friends.readPair(actor.authority, { version: 'sharing.v1', peerPersonId: peer.person.personId });
  if (result.kind !== 'ok' || result.value.status !== 'available') throw new Error('CI pair');
  return result.value.pair;
}

/** The caller's current view revision of the friendship, as a client holds it. */
export async function pairRevision(friends: Friends, actor: Friend, peer: Friend): Promise<number> {
  return (await pairOf(friends, actor, peer)).pairRevision;
}

/** Request and accept: two people who are now friends. */
export async function befriend(friends: Friends, a: Friend, b: Friend): Promise<void> {
  const request = await friends.command(a.authority, 'request', {
    version: 'sharing.v1',
    commandId: randomUUID(),
    expectedPeerPersonId: b.person.personId,
    expectedPairRevision: await pairRevision(friends, a, b),
    target: { kind: 'handle', handle: b.person.handle },
  });
  expect(request.kind).toBe('ok');
  const incoming = await pairOf(friends, b, a);
  if (incoming.state !== 'incoming') throw new Error('CI incoming request');
  const accept = await friends.command(b.authority, 'accept', {
    version: 'sharing.v1',
    commandId: randomUUID(),
    peerPersonId: a.person.personId,
    expectedPairRevision: incoming.pairRevision,
    requestId: incoming.requestId,
  });
  expect(accept.kind).toBe('ok');
}

/** A friend command (remove, block, unblock) by `actor` on `peer`. */
export async function friendCommand(
  friends: Friends,
  actor: Friend,
  peer: Friend,
  operation: 'remove' | 'block' | 'unblock',
) {
  return friends.command(actor.authority, operation, {
    version: 'sharing.v1',
    commandId: randomUUID(),
    peerPersonId: peer.person.personId,
    expectedPairRevision: await pairRevision(friends, actor, peer),
  });
}

export async function seedFriends(db: Kysely<Database>, friends: Friends) {
  const a = await seedFriend(db, friends);
  const b = await seedFriend(db, friends);
  await befriend(friends, a, b);
  return { a, b };
}

/** An admitted content asset with public metadata for each revision, written straight to the content tables. */
export async function seedContent(
  db: Kysely<Database>,
  options: { readonly kind?: 'reel' | 'scroll'; readonly title?: string; readonly revisions?: number } = {},
) {
  const assetId = randomUUID();
  const revisions = options.revisions ?? 1;
  await db
    .insertInto('content.assets')
    .values({ id: assetId, revision: 1, kind: options.kind ?? 'reel', status: 'admitted' })
    .execute();
  for (let revision = 1; revision <= revisions; revision++) await addRevision(db, assetId, revision, options.title);
  if (revisions > 1)
    await db.updateTable('content.assets').set({ revision: revisions }).where('id', '=', assetId).execute();
  return { assetId, revisions };
}

async function addRevision(db: Kysely<Database>, assetId: string, revision: number, title = 'Fixture explainer') {
  const label = revision === 1 ? title : `${title} (revision ${String(revision)})`;
  await db
    .insertInto('content.asset_revisions')
    .values({
      asset_id: assetId,
      revision,
      provenance_kind: 'authored_editorial',
      document_version: 'scroll-document.v1',
      // The discovery row (title and summary shown on cards) is projected from this by a trigger.
      document: JSON.stringify({ summary: `Summary of ${label}` }),
      document_sha256: createHash('sha256')
        .update(`${assetId}:${String(revision)}`)
        .digest('hex'),
      explanation_unit_id: `ci-${assetId.slice(0, 8)}`,
      language: 'en',
      title: label,
      reading_facts: JSON.stringify({}),
    })
    .execute();
}

export const withdraw = (db: Kysely<Database>, assetId: string) =>
  db.updateTable('content.assets').set({ status: 'withdrawn' }).where('id', '=', assetId).execute();

/** Rows in the evidence and experience tables: sending, receiving and sharing must add none. */
export async function consumptionRows(db: Kysely<Database>): Promise<number> {
  const result = await sql<{ total: string }>`
    select (
      (select count(*) from experience.exposures) + (select count(*) from experience.offers) +
      (select count(*) from evidence.observations) + (select count(*) from evidence.encounter_evidence) +
      (select count(*) from experience.saved_items) + (select count(*) from experience.actions)
    )::text as total`.execute(db);
  return Number(result.rows[0]?.total ?? 0);
}
