import {
  ReadVisitorWorldSchema,
  VisitorWorldSnapshotSchema,
  isPublicLabel,
  type PublicPersonRef,
} from '@knowscroll/contracts';
import type { z } from 'zod';
import type { PersonalAuthority } from '../../identity/public.js';
import { atTime, sideOf } from '../domain/friends.js';
import { audienceAllows, planPublication, publicationChanged, type Audience } from '../domain/visibility.js';
import { ownEnvelope, refuse, type Result } from './ports.js';
import { nextPublication } from './visibility-settings.js';
import { readOwnPlaces, type RefreshPorts, type VisibilityPorts } from './visibility-ports.js';
import type { ChosenFriend, StoredVisibility } from './visibility-store.js';

type Snapshot = z.infer<typeof VisitorWorldSnapshotSchema>;

function audienceOf(stored: StoredVisibility, chosen: readonly ChosenFriend[]): Audience {
  if (stored.audience === 'all_friends') return { mode: 'all_friends' };
  if (stored.audience === 'chosen_friends')
    return { mode: 'chosen_friends', friendAccountIds: new Set(chosen.map((friend) => friend.accountId)) };
  return { mode: 'nobody' };
}

/**
 * A friend's published universe: systems and planets under public identities, as the owner chose to
 * share them (U06).
 *
 * Authority: the visitor's own account, a current friendship in both directions with neither side
 * blocking, and the owner's current audience, all checked in the same transaction on every read, so a
 * revocation, a removal or a block takes effect on the next read. The answer is built from the
 * published copy the owner's own commands and refreshes wrote: this never enters the owner's personal
 * root and never reads their Geography. An unknown person, a stranger, an ended friendship, a block, an
 * audience that does not include the caller and a revoked world all give the same `unavailable`
 * answer. Visiting is a read: it writes no evidence, no exposure, no record that anyone visited, and
 * the owner is told nothing.
 */
export function makeReadVisit(p: VisibilityPorts) {
  return async (authority: PersonalAuthority, input: unknown): Promise<Result<Snapshot>> => {
    const parsed = ReadVisitorWorldSchema.safeParse(input);
    if (!parsed.success) return refuse('invalid_input');
    const { target, capabilities } = parsed.data;
    const result = await p.withScope(authority, async (scope): Promise<Result<Snapshot>> => {
      const envelope = { ...ownEnvelope(scope), target, capabilities };
      const unavailable = (): Result<Snapshot> => ({
        kind: 'ok',
        value: VisitorWorldSnapshotSchema.parse({ ...envelope, status: 'unavailable' }),
      });
      if (scope.authority.actor.kind !== 'account') return refuse('unavailable');
      const host = await p.store.profile(
        scope,
        target.kind === 'person' ? { personId: target.personId } : { handle: target.handle },
      );
      if (!host || host.accountId === scope.authority.actor.accountId) return unavailable();
      // `owner` of the fence is the caller (the visitor); `peer` is the person being visited.
      const gate = await p.fencePair(scope, host.accountId);
      if (gate.kind !== 'active') return unavailable();
      const visitorId = gate.owner.accountId;
      const hostId = gate.peer.accountId;
      const locked = await p.store.lockPair(scope, visitorId, hostId, false);
      if (!locked) return unavailable();
      const pair = atTime(locked.pair, p.now().getTime());
      const visitorSide = sideOf(pair, visitorId);
      const friends = [visitorSide, sideOf(pair, hostId)].every((side) => side.state === 'friends' && !side.blocked);
      if (!friends) return unavailable();
      const stored = await p.visibility.settings(locked.shared, hostId);
      const chosen = await p.visibility.chosenFriends(locked.shared, hostId);
      if (!audienceAllows(audienceOf(stored, chosen), visitorId)) return unavailable();
      const published = await p.visibility.publication(locked.shared, gate.peer.universeId);
      const person: PublicPersonRef = host.person;
      return {
        kind: 'ok',
        value: VisitorWorldSnapshotSchema.parse({
          ...envelope,
          status: 'available',
          owner: person,
          authority: {
            pairRevision: visitorSide.revision,
            publishedProjectionRevision: published?.projectionRevision ?? 1,
          },
          projection: {
            presentation: 'list.v1',
            systems: (published?.systems ?? []).map((system) => ({
              publicSystemId: system.publicSystemId,
              label: system.label,
              planets: system.planets.map((planet) => ({ publicPlanetId: planet.publicPlanetId, label: planet.label })),
            })),
          },
        }),
      };
    });
    return result.kind === 'entered' ? result.value : refuse('unavailable');
  };
}

/** The job that follows a new scene projection: which universe, at which privacy epoch. */
export interface RefreshVisitJob {
  readonly universeId: string;
  readonly privacyEpoch: number;
}

/**
 * Redraws a universe's published copy from its owner's current Geography, so planets formed after the
 * owner chose their systems reach visitors. Runs as a system worker for one universe and rechecks
 * authority itself: a stale epoch, a deleted or suspended account and a universe that is not readable
 * all do nothing. A universe that shares nothing has nothing to refresh. The choice of systems is the
 * owner's own rows; this never widens it. Idempotent: an unchanged world writes nothing.
 */
export function makeRefreshVisit(p: RefreshPorts) {
  return async (job: RefreshVisitJob): Promise<'refreshed' | 'unchanged' | 'skipped'> => {
    const result = await p.withScope(
      {
        universeId: job.universeId,
        privacyEpoch: job.privacyEpoch,
        actor: { kind: 'system', purpose: 'social.refresh-visit' },
      },
      async (scope) => {
        const before = await p.visibility.publication(scope, job.universeId);
        if (before === undefined || before.systems.length === 0) return 'skipped' as const;
        const own = await readOwnPlaces(p, scope);
        if (own === undefined) return 'skipped' as const;
        const planned = planPublication(
          own.places,
          new Set(before.systems.map((system) => system.systemId)),
          before.systems,
          isPublicLabel,
          p.newPublicId,
        );
        const changed = publicationChanged(before.systems, planned);
        if (!changed && before.geographyRevision === own.geographyRevision) return 'unchanged' as const;
        await p.visibility.savePublication(scope, job.universeId, {
          ...nextPublication(before, planned, own.geographyRevision, changed),
          refreshedAt: p.now(),
        });
        return changed ? ('refreshed' as const) : ('unchanged' as const);
      },
    );
    return result.kind === 'entered' ? result.value : 'skipped';
  };
}
