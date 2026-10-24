/**
 * A labelled in-memory server for the sharing settings, availability and the friend visit, answering
 * with contract-shaped JSON through a scope's `fetch`. It keeps the rules the clients rely on (a
 * revision that must match, one answer for every refusal) and nothing else. Never product data.
 */
import { createAccountScope, memoryStore, type AccountScope } from '../account-scope';

export const id = (n: number) => `0199a000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const account = { accountId: id(1), universeId: id(2), privacyEpoch: 1, email: 'visit@fixture.test' };
const scopeEnvelope = { accountId: account.accountId, privacyEpoch: 1 };
export const friend = {
  kind: 'person' as const,
  personId: id(11),
  handle: 'fixture.ravi',
  displayName: 'Ravi fixture',
};
const secondFriend = {
  kind: 'person' as const,
  personId: id(12),
  handle: 'fixture.meera',
  displayName: 'Meera fixture',
};
export const friends = [friend, secondFriend];

type Body = Record<string, unknown>;
export type Failure = 'network' | 'server';
type Availability =
  { state: 'unknown' } | { state: 'online' | 'recently_active'; expiryRevision: number; validForMs: number };

export interface FixtureSystem {
  readonly publicSystemId: string;
  readonly label: string;
  readonly planets: readonly { publicPlanetId: string; label: string }[];
}

export function visitServer() {
  const own = {
    audience: { mode: 'nobody' } as { mode: string; personIds?: string[] },
    revision: 1,
    systems: [
      { systemId: id(100), label: 'Earth and climate', shared: false },
      { systemId: id(101), label: 'Space', shared: false },
    ],
  };
  const presence = { preference: 'hidden', revision: 1 };
  let allowed = true;
  let world: FixtureSystem[] = [
    {
      publicSystemId: id(200),
      label: 'Machine learning',
      planets: [
        { publicPlanetId: id(201), label: 'Inference and serving' },
        { publicPlanetId: id(202), label: 'Hardware' },
      ],
    },
  ];
  const availability = new Map<string, Availability>();
  const requests: { path: string; body: Body }[] = [];
  const failures = new Map<string, Failure[]>();
  let projection = 1;

  const problem = (status: number, code: string) =>
    new Response(JSON.stringify({ type: `https://knowscroll.space/problems/${code}`, title: code, status, code }), {
      status,
      headers: { 'content-type': 'application/problem+json' },
    });
  const base = { version: 'sharing.v1', scope: scopeEnvelope };
  const accepted = (body: Body, operation: string, extra: Body) => ({
    ...base,
    commandId: body['commandId'],
    recordedAt: '2026-10-24T08:00:00.000Z',
    replayed: false,
    outcome: 'accepted',
    operation,
    ...extra,
  });

  function handle(path: string, method: string, body: Body): unknown {
    switch (`${method} ${path}`) {
      case 'GET /v1/social/visibility':
        return { ...base, visibilityRevision: own.revision, audience: own.audience, systems: own.systems };
      case 'POST /v1/social/visibility': {
        if (body['expectedVisibilityRevision'] !== own.revision) return problem(409, 'SHARING_REVISION_STALE');
        const shared = new Set(body['sharedSystemIds'] as string[]);
        const before = own.revision;
        own.audience = body['audience'] as typeof own.audience;
        own.systems = own.systems.map((system) => ({ ...system, shared: shared.has(system.systemId) }));
        own.revision += 1;
        return accepted(body, 'visibility.set', {
          baseVisibilityRevision: before,
          acceptedVisibilityRevision: own.revision,
        });
      }
      case 'GET /v1/social/presence/preference':
        return { ...base, presencePreferenceRevision: presence.revision, preference: presence.preference };
      case 'POST /v1/social/presence/preference': {
        if (body['expectedPresencePreferenceRevision'] !== presence.revision)
          return problem(409, 'SHARING_REVISION_STALE');
        const before = presence.revision;
        presence.preference = String(body['preference']);
        presence.revision += 1;
        return accepted(body, 'presence.preference.set', {
          basePresencePreferenceRevision: before,
          acceptedPresencePreferenceRevision: presence.revision,
        });
      }
      case 'POST /v1/social/visits/read': {
        const answer = { ...base, target: body['target'], capabilities: body['capabilities'] };
        if (!allowed) return { ...answer, status: 'unavailable' };
        return {
          ...answer,
          status: 'available',
          owner: friend,
          authority: { pairRevision: 3, publishedProjectionRevision: projection },
          projection: { presentation: 'list.v1', systems: world },
        };
      }
      case 'POST /v1/social/friends/page':
        return {
          version: 'friend-pages.v2',
          requestId: body['requestId'],
          scope: scopeEnvelope,
          filter: 'friends',
          snapshotRevision: 1,
          items: friends.map((peer) => ({
            state: 'friends',
            peer,
            pairRevision: 3,
            availability: availability.get(peer.personId) ?? { state: 'unknown' },
          })),
        };
      default:
        return problem(404, 'NOT_FOUND');
    }
  }

  const scope: AccountScope = createAccountScope({
    account: { ...account },
    baseUrl: 'https://visit.fixture.test',
    authorization: () => undefined,
    store: memoryStore(),
    fetch: async (request) => {
      const path = new URL(request.url).pathname;
      const body = request.method === 'GET' ? {} : ((await request.json()) as Body);
      requests.push({ path, body });
      const failure = failures.get(path)?.shift();
      if (failure === 'network') throw new TypeError('fetch failed');
      if (failure === 'server') return problem(500, 'INTERNAL');
      const answer = handle(path, request.method, body);
      return answer instanceof Response ? answer : Response.json(answer);
    },
  });

  return {
    scope,
    requests,
    own,
    presence,
    /** The next request to `path` fails this way. */
    failNext(path: string, ...kinds: Failure[]) {
      failures.set(path, [...(failures.get(path) ?? []), ...kinds]);
    },
    /** What the visit read answers: allowed, or the one answer for every refusal. */
    setAllowed(value: boolean) {
      allowed = value;
    },
    setWorld(systems: FixtureSystem[]) {
      world = systems;
      projection += 1;
    },
    /** Another device changes the settings behind this one's back. */
    changeElsewhere() {
      own.revision += 1;
      own.audience = { mode: 'all_friends' };
    },
    setAvailability(personId: string, value: Availability) {
      availability.set(personId, value);
    },
    countOf: (path: string) => requests.filter((request) => request.path === path).length,
  };
}
