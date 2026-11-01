import {
  AI_INHABITANT_LABELS,
  SCOUT_LABEL,
  type AiAuthor,
  type PublicPersonRef,
  type RoomFeedPerson,
  type ScoutAuthor,
} from '@knowscroll/contracts';
import type { PersonalScopeTx } from '../../identity/public.js';
import { nameOf, type CastMember } from '../domain/cast.js';
import type { InhabitantId } from '../domain/contribution.js';
import type { PostAuthor } from './feed-ports.js';
import type { RoomPorts } from './ports.js';

/** Who signs something in the Feed, as the contract draws them: a resident, a member's scout or a member. */
export type Signed = AiAuthor | ScoutAuthor | RoomFeedPerson;

/** A resident as the Feed shows it: its own name from the room's cast and the label every AI carries. */
export const residentOf = (cast: readonly CastMember[], inhabitant: InhabitantId): AiAuthor => ({
  kind: 'ai',
  inhabitant,
  name: nameOf(cast, inhabitant),
  label: AI_INHABITANT_LABELS[inhabitant],
});

/**
 * Who signs each of these, for this reader: the resident, the member whose scout it was, or the member who wrote it, each by their
 * public profile. A scout whose owner the reader blocked, a member the reader blocked and an account that cannot be named are nobody's
 * to show: the reader sees nothing from them (D-259). The reader is told nothing of who blocked them.
 */
export async function authorsOf(
  p: RoomPorts,
  scope: PersonalScopeTx,
  readerAccountId: string,
  cast: readonly CastMember[],
  rows: readonly { readonly author: PostAuthor }[],
): Promise<(row: { readonly author: PostAuthor }) => Signed | undefined> {
  const accounts = [
    ...new Set(
      rows.flatMap((row) =>
        row.author.kind === 'scout'
          ? [row.author.ownerAccountId]
          : row.author.kind === 'person'
            ? [row.author.accountId]
            : [],
      ),
    ),
  ];
  const people: ReadonlyMap<string, PublicPersonRef> =
    accounts.length === 0 ? new Map() : await p.people.byAccounts(scope, accounts);
  const blocked = accounts.length === 0 ? new Set<string>() : await p.blocked(scope, readerAccountId, accounts);
  return (row) => {
    if (row.author.kind === 'resident') return residentOf(cast, row.author.inhabitant);
    const accountId = row.author.kind === 'scout' ? row.author.ownerAccountId : row.author.accountId;
    const person = people.get(accountId);
    if (person === undefined || blocked.has(accountId)) return undefined;
    return row.author.kind === 'scout'
      ? { kind: 'agent', sentBy: person, label: SCOUT_LABEL }
      : { kind: 'person', person, you: accountId === readerAccountId };
  };
}
