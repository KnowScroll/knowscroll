import type { Kysely } from 'kysely';
import type { Database } from '../../../infrastructure/postgres/database.js';
import { uuidv7 } from '../../../infrastructure/ids/index.js';
import type { RoomSeed } from '../application/seeds.js';

/**
 * Creates the rooms that do not exist yet, by slug, and leaves existing ones as they are. It writes
 * only room rows: no member, no message and no moderator, so a seeded room is empty until people come.
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
        inhabitants: [...seed.inhabitants],
        created_at: now,
      })
      .onConflict((conflict) => conflict.column('slug').doNothing())
      .returning('slug')
      .executeTakeFirst();
    (inserted === undefined ? existing : created).push(seed.slug);
  }
  return { created, existing };
}

export type ModeratorOutcome = 'set' | 'removed' | 'unknown_room' | 'unknown_account';

/**
 * Names an account a moderator of a room, or takes the role back (the account stays a member). The
 * operator runs it; the role is the only thing here that is granted rather than chosen, so it
 * is never done by a person's command. The account must exist and be active.
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
  await db
    .insertInto('rooms.members')
    .values({
      room_id: room.room_id,
      account_id: input.accountId,
      role: input.moderator ? 'moderator' : 'member',
      joined_at: input.now,
    })
    .onConflict((conflict) =>
      conflict
        .columns(['room_id', 'account_id'])
        .doUpdateSet({ role: input.moderator ? 'moderator' : 'member', ended_at: null, ended_by: null }),
    )
    .execute();
  return input.moderator ? 'set' : 'removed';
}
