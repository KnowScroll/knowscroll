import type { Page } from '@playwright/test';
import { id } from './encounter-fixture';

/**
 * One content thread on a series of three Reels, with three labelled people, served over HTTP fixtures to
 * browser pages for two of them at once (no backend): Asha and Ravi each open the thread in their own
 * browser context and what one reports the other reads. It keeps the real server's rules for places (D-065):
 * a place is a part, `on` or `finished`, and a day; only the member's own command writes it; it only moves
 * forward; hiding deletes it and writes nothing while it is on; a read lists only members who share, and
 * carries nothing finer than a day. Meera is a third member with no browser, whose place a test sets
 * directly. Authored names, never product data.
 */
export type Who = 'asha' | 'ravi';
type Member = Who | 'meera';
type PlaceState = 'on' | 'finished';

const person = (n: number, name: string) => ({
  kind: 'person' as const,
  personId: id(10 + n),
  handle: `ci.${name.toLowerCase()}`,
  displayName: `${name} fixture`,
});
const people: Record<Member, ReturnType<typeof person>> = {
  asha: person(0, 'Asha'),
  ravi: person(1, 'Ravi'),
  meera: person(2, 'Meera'),
};
const accounts = {
  asha: { accountId: id(1), universeId: id(2), privacyEpoch: 1, email: 'asha@fixture.test' },
  ravi: { accountId: id(3), universeId: id(4), privacyEpoch: 1, email: 'ravi@fixture.test' },
};
const membership = (who: Who) => ({
  threadId: id(60),
  membershipId: id(who === 'asha' ? 61 : 62),
  membershipRevision: 1,
});
export const partyAddress = (who: Who) => {
  const ref = membership(who);
  return `/threads/${ref.threadId}?m=${ref.membershipId}&r=1`;
};

const episodes = [1, 2, 3].map((part) => ({
  assetId: id(300 + part),
  assetRevision: 1,
  kind: 'reel' as const,
  part,
  title: `CI part ${String(part)}`,
  state: 'ready' as const,
  visited: false,
}));
const cursor = (n: number) => `kcc1_${'A'.repeat(25)}${String(n)}`;
const text = (sequence: number, author: (typeof people)[Member], value: string) => ({
  messageId: id(100 + sequence),
  sequence,
  status: 'available' as const,
  author,
  recordedAt: '2026-10-24T08:00:00.000Z',
  body: { kind: 'text' as const, text: value },
});
const messages = [
  text(1, people.ravi, 'Part 1 was better than I thought.'),
  text(2, people.meera, 'Starting it tonight.'),
];

/** The Reel is a few seconds long so a test can play it to the end in real time. */
export const PARTY_REEL_MS = 3000;

interface StoredPlace {
  part: number;
  state: PlaceState;
  day: string;
}

const progress = (place: { part: number; state: PlaceState }) => place.part * 2 + (place.state === 'finished' ? 1 : 0);

export function partyWorld() {
  const places = new Map<Member, StoredPlace>();
  const hidden: Record<Member, boolean> = { asha: false, ravi: false, meera: false };
  /** Whose recording is paused (D-057): the policy the device reads says so. */
  const paused: Record<Who, boolean> = { asha: false, ravi: false };
  const calls: { who: Who; path: string; body: Record<string, unknown> }[] = [];
  const world = {
    calls,
    /** The stored place of a member, as the server holds it. */
    placeOf: (member: Member) => places.get(member),
    isHidden: (member: Member) => hidden[member],
    pauseRecording(who: Who, value: boolean) {
      paused[who] = value;
    },
    /** Gives a member with no browser (Meera) a place, as their own client would have. */
    setPlace(member: Member, part: number, state: PlaceState) {
      places.set(member, { part, state, day: '2026-10-24' });
    },
    hide(member: Member, value: boolean) {
      hidden[member] = value;
      if (value) places.delete(member);
    },
    /** Requests this page made to the places routes, so a test can say what was sent and what was not. */
    placeCalls: (who: Who, name: 'places/read' | 'places/set' | 'places/hide') =>
      calls.filter((call) => call.who === who && call.path === `/v1/social/threads/${name}`),
    handler(who: Who) {
      const scope = { accountId: accounts[who].accountId, privacyEpoch: 1 };
      const base = (body: Record<string, unknown>) => ({ version: 'content-thread.v1', readId: body['readId'], scope });
      /** What a place command answers: the scope and what it did, and no time (D-152: no receipt is kept). */
      const answered = (operation: string) => ({
        version: 'content-thread.v1',
        scope,
        operation,
        thread: membership(who),
      });
      /** What a thread message command answers, for the mark-read the thread screen sends. */
      const receipt = (body: Record<string, unknown>, operation: string) => ({
        version: 'content-thread.v1',
        scope,
        commandId: body['commandId'],
        recordedAt: '2026-10-24T08:00:00.000Z',
        replayed: false,
        outcome: 'accepted',
        operation,
        thread: membership(who),
      });
      return (path: string, body: Record<string, unknown>): { json: unknown } | { status: number; json: unknown } => {
        calls.push({ who, path, body });
        switch (path) {
          case '/v1/social/threads/read':
            return {
              json: {
                ...base(body),
                status: 'ready',
                thread: membership(who),
                name: 'CI series',
                root: {
                  status: 'available',
                  target: { assetId: episodes[0]!.assetId, assetRevision: 1 },
                  metadata: { kind: 'reel', title: 'CI part 1', summary: 'Fixture summary.', language: 'en' },
                },
                participants: (['asha', 'ravi', 'meera'] as const).map((member) => ({
                  person: people[member],
                  role: member === 'asha' ? 'starter' : 'member',
                  joined: true,
                  you: member === who,
                })),
                sequence: { kind: 'series', total: 3 },
                episodes,
                own: { readThroughSequence: messages.length, muted: false },
                latestMessageSequence: messages.length,
                messages,
                limit: 30,
                history: { kind: 'end' },
                catchUpCursor: cursor(messages.length),
              },
            };
          case '/v1/social/threads/changes':
            return {
              json: {
                ...base(body),
                status: 'ready',
                thread: membership(who),
                limit: 50,
                requestCursor: body['cursor'],
                fromChangeSequence: messages.length,
                throughChangeSequence: messages.length,
                changes: [],
                continuation: { kind: 'caught_up', cursor: cursor(messages.length) },
              },
            };
          case '/v1/social/threads/mark-read':
            return {
              json: {
                ...receipt(body, 'thread.read'),
                requestedThroughSequence: messages.length,
                acceptedThroughSequence: messages.length,
              },
            };
          case '/v1/social/threads/inbox':
            return { json: { ...base(body), status: 'ready', limit: body['limit'], viewRevision: 1, items: [] } };
          case '/v1/social/threads/places/read':
            return {
              json: {
                ...base(body),
                status: 'ready',
                thread: membership(who),
                hidden: hidden[who],
                places: (['asha', 'ravi', 'meera'] as const).flatMap((member) => {
                  const place = places.get(member);
                  return place === undefined || hidden[member]
                    ? []
                    : [{ person: people[member], you: member === who, ...place }];
                }),
              },
            };
          case '/v1/social/threads/places/set': {
            const wanted = { part: Number(body['part']), state: body['state'] as PlaceState };
            const current = places.get(who);
            let result: 'stored' | 'unchanged' | 'hidden' = 'stored';
            if (hidden[who]) result = 'hidden';
            else if (current !== undefined && progress(wanted) <= progress(current)) result = 'unchanged';
            else places.set(who, { ...wanted, day: '2026-10-24' });
            return { json: { ...answered('thread.place'), result } };
          }
          case '/v1/social/threads/places/hide': {
            const wanted = body['hidden'] === true;
            const changed = hidden[who] !== wanted;
            world.hide(who, wanted);
            return { json: { ...answered('thread.place-hidden'), hidden: wanted, changed } };
          }
          case '/v1/privacy/recording/read':
            return {
              json: {
                version: 'recording-policy.v1',
                ...body,
                scope,
                revision: 0,
                // An odd generation is recording on, an even one is paused (the contract's rule).
                policy: { on: !paused[who], generation: paused[who] ? 2 : 1 },
              },
            };
          // A Reel opened from the thread: open, media grant, activate, then the recorder's batches.
          case '/v1/experience/open':
            return {
              json: {
                commandId: body['commandId'],
                exposureId: id(400),
                assetId: (body['target'] as { assetId: string }).assetId,
                assetRevision: 1,
                kind: 'reel',
                revision: 1,
                replayed: false,
              },
            };
          case '/v1/media/grants':
            return {
              json: {
                document: {
                  schemaVersion: 'reel-document.v1',
                  assetId: episodes[0]!.assetId,
                  revision: 1,
                  title: 'CI part 1',
                  summary: 'CI playback fixture',
                  language: 'en',
                  truthLabel: 'generated',
                  fixture: true,
                  captions: 'burned_in',
                  mediaKey: `sha256/aa/${'a'.repeat(64)}.mp4`,
                  durationMs: PARTY_REEL_MS,
                  width: 1080,
                  height: 1920,
                },
                path: '/media/talk-fixture',
                expiresAt: '2099-10-24T18:00:00.000Z',
              },
            };
          case '/v1/experience/activate':
            return {
              json: {
                commandId: body['commandId'],
                exposureId: id(400),
                activatedAt: '2026-10-24T10:00:00.000Z',
                revision: 1,
                replayed: false,
              },
            };
          case '/v1/observations/recording-batch': {
            const events = body['events'] as { eventId: string }[];
            return {
              json: {
                version: 'observation-batch.v2',
                result: 'processed',
                recordingGeneration: body['recordingGeneration'],
                currentGeneration: body['recordingGeneration'],
                scope,
                accepted: events.length,
                duplicates: 0,
                rejected: 0,
                results: events.map((event) => ({ eventId: event.eventId, status: 'accepted' })),
                revision: 1,
              },
            };
          }
          default:
            return { status: 404, json: {} };
        }
      };
    },
  };
  return world;
}

export type PartyWorld = ReturnType<typeof partyWorld>;

/** Signs the page in as `who`, answers its requests from the shared world and opens the thread. */
export async function openParty(page: Page, world: PartyWorld, who: Who, viewport: { width: number; height: number }) {
  await page.setViewportSize(viewport);
  await page.route('**/auth/session', (route) =>
    route.fulfill({ json: { account: accounts[who], client: 'web', expiresAt: '2099-10-24T00:00:00.000Z' } }),
  );
  const answer = world.handler(who);
  await page.route('**/v1/**', (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    return route.fulfill(answer(path, (request.postDataJSON() ?? {}) as Record<string, unknown>));
  });
  await page.goto(partyAddress(who));
}
