import {
  ReadFriendsPageSchema,
  ReadFriendRequestsPageSchema,
  FriendPagesPageSchema,
  type FriendPairView,
} from '@knowscroll/contracts';
import type { PersonalAuthority } from '../../identity/public.js';
import { ownEnvelope, refuse, type Result, type SocialPorts } from './ports.js';
import type { z } from 'zod';
const SCAN_LIMIT = 250;
/** Live eligible hydration over a revision-bound public membership index. Empty continuation is
 * honest bounded progress through unavailable candidates, never end-of-list. No per-item roots. */
export function makeReadRoster(p: SocialPorts, requests: boolean) {
  return async (
    authority: PersonalAuthority,
    input: unknown,
  ): Promise<Result<z.infer<typeof FriendPagesPageSchema>>> => {
    const parsed = (requests ? ReadFriendRequestsPageSchema : ReadFriendsPageSchema).safeParse(input);
    if (!parsed.success) return refuse('invalid_input');
    const q = parsed.data;
    const result = await p.withScope(authority, async (scope) => {
      const gate = await p.fenceOwn(scope);
      if (gate.kind !== 'active') return refuse('unavailable');
      const revision = await p.rosters.head(scope, q.filter),
        now = p.now(),
        time = now.getTime();
      const c = q.cursor ? p.cursor.decode(q.cursor.token) : undefined;
      if (
        q.cursor &&
        (!c ||
          c.accountId !== gate.owner.accountId ||
          c.universeId !== authority.universeId ||
          c.epoch !== authority.privacyEpoch ||
          c.filter !== q.filter ||
          c.limit !== q.limit ||
          c.revision !== revision ||
          q.cursor.snapshotRevision !== revision ||
          q.cursor.scope.accountId !== gate.owner.accountId ||
          q.cursor.scope.privacyEpoch !== authority.privacyEpoch ||
          time >= c.until ||
          time < c.started)
      )
        return refuse('unavailable');
      const ceiling = c?.ceiling ?? (await p.rosters.ceiling(scope, q.filter));
      const rows = ceiling ? await p.rosters.scan(scope, q.filter, c?.after, ceiling, SCAN_LIMIT + 1) : [],
        items: FriendPairView[] = [];
      let after = c?.after,
        more = rows.length > SCAN_LIMIT;
      for (const r of rows.slice(0, SCAN_LIMIT)) {
        const eligible = r.eligible && (!r.expiresAt || Date.parse(r.expiresAt) > time);
        if (eligible && items.length === q.limit) {
          more = true;
          break;
        }
        after = r.person.personId;
        if (!eligible) continue;
        if (q.filter === 'incoming' || q.filter === 'outgoing') {
          if (!r.requestId) throw new Error('SOCIAL_ROSTER_BINDING');
          items.push({ state: q.filter, peer: r.person, pairRevision: r.revision, requestId: r.requestId });
        } else if (q.filter === 'friends')
          items.push({
            state: 'friends',
            peer: r.person,
            pairRevision: r.revision,
            availability: { state: 'unknown' },
          });
        else items.push({ state: 'blocked', peer: r.person, pairRevision: r.revision });
      }
      const deadline = await p.rosters.deadline(scope, q.filter, now),
        until = c?.until ?? Math.min(time + 300000, deadline?.getTime() ?? Infinity);
      const envelope = ownEnvelope(scope);
      return {
        kind: 'ok' as const,
        value: FriendPagesPageSchema.parse({
          ...envelope,
          version: 'friend-pages.v2',
          requestId: q.requestId,
          filter: q.filter,
          snapshotRevision: revision,
          items,
          ...(more && after && ceiling
            ? {
                next: {
                  scope: envelope.scope,
                  filter: q.filter,
                  snapshotRevision: revision,
                  token: p.cursor.encode({
                    accountId: gate.owner.accountId,
                    universeId: authority.universeId,
                    epoch: authority.privacyEpoch,
                    filter: q.filter,
                    revision,
                    limit: q.limit,
                    after,
                    ceiling,
                    started: c?.started ?? time,
                    until,
                  }),
                },
              }
            : {}),
        }),
      };
    });
    return result.kind === 'entered' ? result.value : refuse('unavailable');
  };
}
