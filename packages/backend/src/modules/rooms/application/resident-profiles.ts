import type { RoomResidentProfile } from '@knowscroll/contracts';
import type { CastMember } from '../domain/cast.js';
import type { AiLevel } from '../domain/membership.js';
import { RESIDENT_CHARACTERS, nextPostAfter } from '../domain/residents.js';
import type { RoomLock, RoomPorts } from './ports.js';

/**
 * One profile for each resident of the room (T3 "Nova's profile", v3 R-8b, D-277): who made it (the product), what it cares about,
 * how long the room it lives in has been there, when it last spoke, when it may next post and its latest posts. The words are the
 * catalogue's and the times are the room's ledger's, so no model writes any of it and a resident that has said nothing has no
 * "last". `nextAfter` is only a time still ahead: a resident free to post has none, and the screen does not promise a post.
 *
 * A reader whose AI is Off is told nothing of what residents do on their own (D-249, D-276), so their profile keeps who made it, what
 * it cares about, the room's age and whether it was introduced, and carries no last time, no next time and no latest posts.
 */
export async function residentProfiles(
  p: RoomPorts,
  lock: RoomLock,
  cast: readonly CastMember[],
  now: Date,
  readerAiLevel: AiLevel,
): Promise<RoomResidentProfile[]> {
  const hearsOfResidents = readerAiLevel !== 'off';
  const profiles: RoomResidentProfile[] = [];
  for (const member of cast) {
    const facts = await p.feed.residentFacts(lock, member.inhabitant);
    const after = nextPostAfter(facts.lastFindAt, now);
    profiles.push({
      inhabitant: member.inhabitant,
      madeBy: 'KnowScroll',
      caresAbout: [...RESIDENT_CHARACTERS[member.inhabitant].interests],
      roomSince: facts.roomSince.toISOString(),
      ...(!hearsOfResidents || facts.lastAt === undefined ? {} : { lastAt: facts.lastAt.toISOString() }),
      ...(!hearsOfResidents || after === undefined ? {} : { nextAfter: after.toISOString() }),
      introduced: facts.introduced,
      recent: hearsOfResidents
        ? facts.recent.map((post) => ({
            discussionId: post.discussionId,
            messageId: post.messageId,
            title: post.title,
            postedAt: post.postedAt.toISOString(),
          }))
        : [],
    });
  }
  return profiles;
}
