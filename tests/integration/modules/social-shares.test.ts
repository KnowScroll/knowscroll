/** Managed share links over real PostgreSQL: one-time token, access decisions, revoke, expiry. */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DirectConversationRef } from '@knowscroll/contracts';
import type { Database } from '@knowscroll/backend/infrastructure/postgres';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import {
  consumptionRows,
  friendCommand,
  pairRevision,
  seedContent,
  seedFriend,
  seedFriends,
  talkCases,
  withdraw,
  type Friend,
  type Friends,
  type Talk,
} from '../support/talk.js';

const version = 'content-share.v1' as const;
const DAY = 24 * 60 * 60 * 1000;

function unwrap<T>(result: { kind: 'ok'; value: T } | { kind: 'refused'; code: string }): T {
  if (result.kind !== 'ok') throw new Error(`refused: ${result.code}`);
  return result.value;
}

describe('managed share links (real PostgreSQL)', () => {
  let database: TestDatabase<Database>;
  let clock: { now: Date };
  let talk: Talk;
  let friends: Friends;

  beforeAll(async () => {
    database = await createTestDatabase<Database>('social_shares');
    const cases = talkCases(database.db);
    clock = cases.clock;
    talk = cases.talk;
    friends = cases.friends;
  });
  afterAll(async () => {
    await database.drop();
  });

  const create = (actor: Friend, body: { target: object; audience: object }, commandId = randomUUID()) =>
    talk.shares.create(actor.authority, { version, commandId, ...body });
  const publicLink = (actor: Friend, target: object, commandId?: ReturnType<typeof randomUUID>) =>
    create(actor, { target, audience: { kind: 'public_metadata' } }, commandId);
  const preview = (token: string) => talk.shares.previewPublic({ version, readId: randomUUID(), token });
  const resolve = (actor: Friend, token: string) =>
    talk.shares.resolve(actor.authority, { version, readId: randomUUID(), token });
  const revoke = (actor: Friend, shareId: string, commandId = randomUUID()) =>
    talk.shares.revoke(actor.authority, { version, commandId, shareId });
  const readOwn = (actor: Friend, selector: object) =>
    talk.shares.readOwn(actor.authority, { version, readId: randomUUID(), selector });
  const list = (actor: Friend) => talk.shares.list(actor.authority, { version, readId: randomUUID() });

  async function newLink(actor: Friend, title = 'Why the sky is blue') {
    const content = await seedContent(database.db, { title });
    const target = { assetId: content.assetId, assetRevision: 1 };
    const result = unwrap(await publicLink(actor, target));
    if (result.delivery.status !== 'available') throw new Error('CI token');
    return { content, target, shareId: result.acceptance.shareId, token: result.delivery.token };
  }

  async function conversation(a: Friend, b: Friend): Promise<DirectConversationRef> {
    const started = unwrap(
      await talk.conversations.start(a.authority, {
        version: 'direct-conversation.v1',
        commandId: randomUUID(),
        peerPersonId: b.person.personId,
        expectedPairRevision: await pairRevision(friends, a, b),
      }),
    );
    return started.conversation;
  }

  it('delivers the token once, recovers the same link without it on retry, and refuses a changed body', async () => {
    const a = await seedFriend(database.db, friends);
    const content = await seedContent(database.db);
    const target = { assetId: content.assetId, assetRevision: 1 };
    const commandId = randomUUID();
    const first = unwrap(await publicLink(a, target, commandId));
    expect(first.delivery).toMatchObject({
      status: 'available',
      token: expect.stringMatching(/^kssh_[A-Za-z0-9_-]{43}$/),
    });
    expect(first.acceptance).toMatchObject({ replayed: false, audience: { kind: 'public_metadata' } });
    expect(Date.parse(first.acceptance.expiresAt) - Date.parse(first.acceptance.recordedAt)).toBe(30 * DAY);

    const retry = unwrap(await publicLink(a, target, commandId));
    expect(retry.delivery).toEqual({ status: 'unavailable' });
    expect(retry.acceptance).toMatchObject({ shareId: first.acceptance.shareId, replayed: true });
    const other = await seedContent(database.db);
    expect(await publicLink(a, { assetId: other.assetId, assetRevision: 1 }, commandId)).toEqual({
      kind: 'refused',
      code: 'command_key_reused',
    });

    // Only the token's hash is stored.
    if (first.delivery.status !== 'available') throw new Error('CI token');
    const stored = await database.db
      .selectFrom('social.content_shares')
      .select('token_hash')
      .where('share_id', '=', first.acceptance.shareId)
      .executeTakeFirstOrThrow();
    expect(stored.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(stored)).not.toContain(first.delivery.token);

    // The creating command can be found again by its own caller, and by nobody else.
    const own = unwrap(await readOwn(a, { kind: 'command', commandId }));
    expect(own).toMatchObject({ status: 'available', shareId: first.acceptance.shareId, state: 'active' });
    const stranger = await seedFriend(database.db, friends);
    expect(unwrap(await readOwn(stranger, { kind: 'share', shareId: first.acceptance.shareId })).status).toBe(
      'unavailable',
    );
  });

  it('refuses a link for withdrawn or unknown content', async () => {
    const a = await seedFriend(database.db, friends);
    const content = await seedContent(database.db);
    await withdraw(database.db, content.assetId);
    for (const target of [
      { assetId: content.assetId, assetRevision: 1 },
      { assetId: randomUUID(), assetRevision: 1 },
    ])
      expect(await publicLink(a, target)).toEqual({ kind: 'refused', code: 'unavailable' });
  });

  it('previews a public link to anyone with public metadata only, and to a signed-in person the same', async () => {
    const a = await seedFriend(database.db, friends);
    const b = await seedFriend(database.db, friends);
    const { token, target } = await newLink(a, 'Why the sky is blue');
    const visitor = unwrap(await preview(token));
    expect(visitor).toMatchObject({
      status: 'public_metadata',
      content: {
        status: 'available',
        target,
        metadata: { kind: 'reel', title: 'Why the sky is blue', language: 'en' },
      },
    });
    expect(JSON.stringify(visitor)).not.toMatch(/sender|conversation|document|owner|account|person/i);
    const signedIn = unwrap(await resolve(b, token));
    expect(signedIn).toMatchObject({ status: 'public_metadata', content: { status: 'available' } });
    expect(JSON.stringify(signedIn)).not.toMatch(/person|account|owner/i);
  });

  it('answers an unknown token and a malformed one with the same unavailable', async () => {
    const a = await seedFriend(database.db, friends);
    const unknown = `kssh_${'A'.repeat(43)}`;
    expect(unwrap(await preview(unknown))).toMatchObject({ status: 'unavailable' });
    expect(await talk.shares.previewPublic({ version, readId: randomUUID(), token: 'kssh_short' })).toEqual({
      kind: 'refused',
      code: 'invalid_input',
    });
    expect(unwrap(await resolve(a, unknown))).toMatchObject({ status: 'unavailable' });
  });

  it('stops answering after revoke, for visitors and signed-in people, and revoking again changes nothing', async () => {
    const a = await seedFriend(database.db, friends);
    const b = await seedFriend(database.db, friends);
    const { token, shareId } = await newLink(a);
    expect(unwrap(await preview(token)).status).toBe('public_metadata');
    const commandId = randomUUID();
    const revoked = unwrap(await revoke(a, shareId, commandId));
    expect(revoked).toMatchObject({ operation: 'content-share.revoke', shareId, replayed: false });
    expect(unwrap(await preview(token))).toMatchObject({ status: 'unavailable' });
    expect(unwrap(await resolve(b, token))).toMatchObject({ status: 'unavailable' });
    expect(unwrap(await revoke(a, shareId, commandId))).toMatchObject({ replayed: true });
    expect(unwrap(await revoke(a, shareId))).toMatchObject({ replayed: false });
    expect(unwrap(await readOwn(a, { kind: 'share', shareId }))).toMatchObject({ state: 'revoked' });
    // Nobody else can revoke it.
    const { shareId: otherShare } = await newLink(a);
    expect(await revoke(b, otherShare)).toEqual({ kind: 'refused', code: 'unavailable' });
  });

  it('expires thirty days after creation and reads as expired to its owner', async () => {
    const a = await seedFriend(database.db, friends);
    const { token, shareId } = await newLink(a);
    clock.now = new Date(clock.now.getTime() + 30 * DAY - 1);
    expect(unwrap(await preview(token)).status).toBe('public_metadata');
    clock.now = new Date(clock.now.getTime() + 1);
    expect(unwrap(await preview(token)).status).toBe('unavailable');
    expect(unwrap(await readOwn(a, { kind: 'share', shareId }))).toMatchObject({ state: 'expired' });
    expect(unwrap(await list(a)).items).toEqual([]);
  });

  it('shows the corrected revision honestly and hides withdrawn content', async () => {
    const a = await seedFriend(database.db, friends);
    const content = await seedContent(database.db, { title: 'Attention cost', revisions: 2 });
    const target = { assetId: content.assetId, assetRevision: 1 };
    const link = unwrap(await publicLink(a, target));
    if (link.delivery.status !== 'available') throw new Error('CI token');
    const shown = unwrap(await preview(link.delivery.token));
    expect(shown).toMatchObject({
      status: 'public_metadata',
      content: { status: 'corrected', target, current: { assetRevision: 2 } },
    });
    await withdraw(database.db, content.assetId);
    expect(unwrap(await preview(link.delivery.token)).status).toBe('unavailable');
  });

  it('keeps a private conversation link to its members, and ends it with the friendship', async () => {
    const { a, b } = await seedFriends(database.db, friends);
    const ref = await conversation(a, b);
    const stranger = await seedFriend(database.db, friends);
    const content = await seedContent(database.db);
    const target = { assetId: content.assetId, assetRevision: 1 };
    // Only a member may make a private link, with their own membership reference.
    expect(await create(stranger, { target, audience: { kind: 'conversation', conversation: ref } })).toEqual({
      kind: 'refused',
      code: 'unavailable',
    });
    const made = unwrap(await create(a, { target, audience: { kind: 'conversation', conversation: ref } }));
    if (made.delivery.status !== 'available') throw new Error('CI token');
    const token = made.delivery.token;

    expect(unwrap(await preview(token)).status).toBe('unavailable');
    expect(unwrap(await resolve(stranger, token)).status).toBe('unavailable');
    const member = unwrap(await resolve(b, token));
    if (member.status !== 'conversation') throw new Error('CI member');
    expect(member.conversation.conversationId).toBe(ref.conversationId);
    expect(member.content).toMatchObject({ status: 'available', target });
    expect(unwrap(await resolve(a, token)).status).toBe('conversation');

    expect(unwrap(await list(a)).items).toHaveLength(1);
    unwrap(await friendCommand(friends, b, a, 'block'));
    expect(unwrap(await resolve(b, token)).status).toBe('unavailable');
    expect(unwrap(await resolve(a, token)).status).toBe('unavailable');
    expect(unwrap(await list(a)).items).toEqual([]);
  });

  it('lists the owner’s live links newest first, without revoked ones', async () => {
    const a = await seedFriend(database.db, friends);
    const first = await newLink(a, 'First');
    clock.now = new Date(clock.now.getTime() + 1000);
    const second = await newLink(a, 'Second');
    clock.now = new Date(clock.now.getTime() + 1000);
    const third = await newLink(a, 'Third');
    unwrap(await revoke(a, second.shareId));
    const items = unwrap(await list(a)).items;
    expect(items.map((item) => item.shareId)).toEqual([third.shareId, first.shareId]);
    expect(items[0]).toMatchObject({
      audience: { kind: 'public_metadata' },
      content: { status: 'available', metadata: { title: 'Third' } },
    });
    await withdraw(database.db, first.content.assetId);
    expect(unwrap(await list(a)).items[1]?.content.status).toBe('unavailable');
  });

  it('never creates consumption evidence by creating, previewing, resolving or revoking', async () => {
    const before = await consumptionRows(database.db);
    const a = await seedFriend(database.db, friends);
    const b = await seedFriend(database.db, friends);
    const { token, shareId } = await newLink(a);
    await preview(token);
    await resolve(b, token);
    await revoke(a, shareId);
    expect(await consumptionRows(database.db)).toBe(before);
  });
});
