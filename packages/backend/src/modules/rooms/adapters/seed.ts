import type { Kysely } from 'kysely';
import type { Database } from '../../../infrastructure/postgres/database.js';
import { uuidv7 } from '../../../infrastructure/ids/index.js';
import type { RoomSeed } from '../application/seeds.js';
import { castProblem } from '../domain/cast.js';

/**
 * Gives a room its General discussion if it has none: the place a member lands, made with the room. It is an
 * empty discussion with no starter, so a seeded room still has no message and no person in it.
 */
async function ensureGeneral(db: Kysely<Database>, roomId: string, now: Date): Promise<void> {
  await db
    .insertInto('rooms.discussions')
    .values({
      discussion_id: uuidv7(),
      room_id: roomId,
      kind: 'general',
      title: 'General',
      last_activity_at: now,
      created_at: now,
    })
    .onConflict((conflict) => conflict.column('room_id').where('kind', '=', 'general').doNothing())
    .execute();
}

/** Gives a room its residents if it has none: the cast of its seed, by role, leaving any name a room already has. */
async function ensureCast(db: Kysely<Database>, roomId: string, seed: RoomSeed): Promise<void> {
  const problem = castProblem(seed.cast);
  if (problem !== undefined) throw new Error(`ROOMS_CAST_INVALID: ${problem}`);
  await db
    .insertInto('rooms.room_cast')
    .values(
      seed.cast.map((member, index) => ({
        room_id: roomId,
        inhabitant: member.inhabitant,
        name: member.name,
        position: index + 1,
      })),
    )
    .onConflict((conflict) => conflict.columns(['room_id', 'inhabitant']).doNothing())
    .execute();
}

/**
 * Creates the rooms that do not exist yet, by slug, and leaves existing ones as they are, except that a room
 * without a General or a cast gets them. It writes only room, General and cast rows: no member, no message and no
 * moderator, so a seeded room is empty until people come.
 */
export async function seedRooms(
  db: Kysely<Database>,
  seeds: readonly RoomSeed[],
  now: Date,
): Promise<{ readonly created: readonly string[]; readonly existing: readonly string[] }> {
  const created: string[] = [];
  const existing: string[] = [];
  for (const seed of seeds) {
    const inserted = await db
      .insertInto('rooms.rooms')
      .values({
        room_id: uuidv7(),
        slug: seed.slug,
        name: seed.name,
        description: seed.description,
        guidelines: seed.guidelines,
        topic_kind: seed.topic.kind,
        topic_id: seed.topic.id,
        join_rule: seed.joinRule,
        created_at: now,
      })
      .onConflict((conflict) => conflict.column('slug').doNothing())
      .returning(['slug', 'room_id'])
      .executeTakeFirst();
    const roomId =
      inserted?.room_id ??
      (await db.selectFrom('rooms.rooms').select('room_id').where('slug', '=', seed.slug).executeTakeFirstOrThrow())
        .room_id;
    await ensureGeneral(db, roomId, now);
    await ensureCast(db, roomId, seed);
    (inserted === undefined ? existing : created).push(seed.slug);
  }
  return { created, existing };
}

export type ModeratorOutcome =
  | 'set'
  | 'removed'
  | 'unknown_room'
  | 'unknown_account'
  /** A moderator shows by name, so the account needs a claimed sharing profile. */
  | 'profile_needed'
  /** Taking the role back from someone who is not a current member does nothing. */
  | 'not_a_member'
  /** A moderator removed this person from the room; the operator does not undo that by naming them. */
  | 'removed_from_room';

/**
 * Names an account a moderator of a room, or takes the role back (the account stays a member). The
 * operator runs it; the role is the only thing here that is granted rather than chosen, so it
 * is never done by a person's command. The account must exist, be active and have a claimed profile
 * (members show by name). Naming someone who left makes them a member again, as a moderator; naming
 * someone a moderator removed does nothing, and taking the role back never brings a person who left
 * back in.
 */
export async function setRoomModerator(
  db: Kysely<Database>,
  input: { readonly slug: string; readonly accountId: string; readonly moderator: boolean; readonly now: Date },
): Promise<ModeratorOutcome> {
  const room = await db.selectFrom('rooms.rooms').select('room_id').where('slug', '=', input.slug).executeTakeFirst();
  if (room === undefined) return 'unknown_room';
  const account = await db
    .selectFrom('identity.accounts')
    .select('id')
    .where('id', '=', input.accountId)
    .where('status', '=', 'active')
    .executeTakeFirst();
  if (account === undefined) return 'unknown_account';
  if (!input.moderator) {
    const taken = await db
      .updateTable('rooms.members')
      .set({ role: 'member' })
      .where('room_id', '=', room.room_id)
      .where('account_id', '=', input.accountId)
      .where('ended_at', 'is', null)
      .executeTakeFirst();
    return taken.numUpdatedRows > 0n ? 'removed' : 'not_a_member';
  }
  const profile = await db
    .selectFrom('social.profiles')
    .select('account_id')
    .where('account_id', '=', input.accountId)
    .executeTakeFirst();
  if (profile === undefined) return 'profile_needed';
  const earlier = await db
    .selectFrom('rooms.members')
    .select('ended_by')
    .where('room_id', '=', room.room_id)
    .where('account_id', '=', input.accountId)
    .executeTakeFirst();
  if (earlier?.ended_by === 'removed') return 'removed_from_room';
  await db
    .insertInto('rooms.members')
    .values({ room_id: room.room_id, account_id: input.accountId, role: 'moderator', joined_at: input.now })
    .onConflict((conflict) =>
      conflict.columns(['room_id', 'account_id']).doUpdateSet({ role: 'moderator', ended_at: null, ended_by: null }),
    )
    .execute();
  return 'set';
}
