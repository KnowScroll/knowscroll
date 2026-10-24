import type { AccountAccess, PersonalScopeTx } from '../../identity/public.js';
import type { MemberRow, RoomLock, RoomPorts, Standing } from './ports.js';

/** A room the caller may act in: gates passed and the room row loaded under its lock. */
export interface EnteredRoom {
  readonly lock: RoomLock;
  readonly owner: AccountAccess;
  readonly standing: Standing;
  /** The caller's member row when it is open; none for an outsider, a person who left or was removed. */
  readonly member: MemberRow | undefined;
}

/**
 * Enters one room inside the caller's personal scope in the lock order of the blueprint: the personal
 * root (already held), the caller's own account gate, then the room's own root (FOR UPDATE for
 * commands that change who is in, the status or the roles, FOR SHARE for everything else). It answers
 * `undefined`, and nothing else, for every refusal: an unknown room, an inactive account. Whether the
 * caller is a member is a separate fact (`member`), because a preview and a join are for outsiders.
 */
export async function enterRoom(
  p: RoomPorts,
  scope: PersonalScopeTx,
  roomId: string,
  mode: 'read' | 'write',
): Promise<EnteredRoom | undefined> {
  if (scope.authority.actor.kind !== 'account') return undefined;
  const gate = await p.fenceOwn(scope);
  if (gate.kind !== 'active') return undefined;
  const lock = await p.rooms.lock(scope, roomId, mode);
  if (!lock) return undefined;
  const standing = await p.rooms.standing(lock, gate.owner.accountId);
  const member = standing.own?.endedBy === null ? standing.own : undefined;
  return { lock, owner: gate.owner, standing, member };
}
