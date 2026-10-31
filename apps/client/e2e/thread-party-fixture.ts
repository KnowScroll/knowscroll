import type { Page } from '@playwright/test';
import seasons from '@knowscroll/scroll-model/fixtures/seasons-stage-ci.json';
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

const episodesOf = (kind: 'reel' | 'scroll') =>
  [1, 2, 3].map((part) => ({
    assetId: id(300 + part),
    assetRevision: 1,
    kind,
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

/**
 * The call before Part 2 (D-155): a labelled fixture question, as a Scroll's authored Call it would be. The real
 * server finds it in the part's Scroll; this fixture's parts are Reels the browser can play to the end, so it says
 * which part has one.
 */
export const PARTY_CALL = {
  part: 2,
  prompt: 'CI fixture: when are tides biggest?',
  options: ['CI full and new moon', 'CI half moon', 'CI always the same'],
  answer: 0,
  explain: 'CI fixture explanation: spring tides come at full and new moon.',
  twist: 'CI fixture twist: half moon gives the smaller neap tides.',
} as const;

/**
 * `call`: the thread has a call before Part 2 (D-155). The places-only tests of T-D leave it off, so their layout is unchanged.
 * `scrolls`: the three parts are Scrolls (the labelled v2 fixture `seasons-stage-ci`, which the thread's reader draws as the
 * Stage + Spine reader) instead of Reels.
 */
export function partyWorld(options: { readonly call?: boolean; readonly scrolls?: boolean } = {}) {
  const episodes = episodesOf(options.scrolls === true ? 'scroll' : 'reel');
  const places = new Map<Member, StoredPlace>();
  const hidden: Record<Member, boolean> = { asha: false, ravi: false, meera: false };
  /** Whose recording is paused (D-057): the policy the device reads says so. */
  const paused: Record<Who, boolean> = { asha: false, ravi: false };
  const calls: { who: Who; path: string; body: Record<string, unknown> }[] = [];
  /** What each member locked on the call before Part 2: an option, and nothing else (D-156). */
  const locks = new Map<Member, number>();
  const everyone = ['asha', 'ravi', 'meera'] as const;
  /**
   * What the real server shows one member of the call (D-155), by the same rule: hidden until they lock, and the reveal
   * waits for every member who shares where they are to finish the part. The clock rule is not modelled: the fixture's
   * day does not move.
   */
  function callOf(who: Member) {
    const sharing = everyone.filter((member) => !hidden[member] && places.has(member));
    const partyDone =
      sharing.length > 0 && sharing.every((member) => progress(places.get(member)!) >= PARTY_CALL.part * 2 + 1);
    const revealed = locks.size > 0 && partyDone;
    const base = {
      part: PARTY_CALL.part,
      assetId: episodes[PARTY_CALL.part - 1]!.assetId,
      assetRevision: 1,
      prompt: PARTY_CALL.prompt,
      options: [...PARTY_CALL.options],
      called: locks.size,
      of: everyone.length,
    };
    const own = locks.get(who);
    if (own === undefined) {
      const ownPlace = places.get(who);
      if (revealed) return { ...base, stage: 'closed', reason: 'revealed' };
      if (ownPlace !== undefined && !hidden[who] && progress(ownPlace) >= PARTY_CALL.part * 2)
        return { ...base, stage: 'closed', reason: 'started' };
      return { ...base, stage: 'open' };
    }
    if (!revealed) return { ...base, stage: 'locked', option: own };
    const right = own === PARTY_CALL.answer;
    const picks = [...locks]
      .map(([member, option]) => ({
        person: people[member],
        you: member === who,
        option,
        right: option === PARTY_CALL.answer,
      }))
      .toSorted((a, b) => a.option - b.option || a.person.displayName.localeCompare(b.person.displayName));
    return {
      ...base,
      stage: 'revealed',
      option: own,
      answer: PARTY_CALL.answer,
      explain: PARTY_CALL.explain,
      ...(right ? {} : { twist: PARTY_CALL.twist }),
      right,
      picks,
      rightCount: picks.filter((pick) => pick.right).length,
    };
  }
  const world = {
    calls,
    /** What a member locked on the call before Part 2, as the server holds it. */
    lockOf: (member: Member) => locks.get(member),
    /** Gives a member with no browser (Meera) a lock, as their own client would have. */
    lock(member: Member, option: number) {
      if (!locks.has(member)) locks.set(member, option);
    },
    /** The requests this page made to the call routes, so a test can say what was sent and what was not. */
    callCalls: (who: Who, name: 'calls/read' | 'calls/lock') =>
      calls.filter((call) => call.who === who && call.path === `/v1/social/threads/${name}`),
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
                  metadata: {
                    kind: episodes[0]!.kind,
                    title: 'CI part 1',
                    summary: 'Fixture summary.',
                    language: 'en',
                  },
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
          case '/v1/social/threads/calls/read':
            return {
              json: {
                ...base(body),
                status: 'ready',
                thread: membership(who),
                calls: options.call === true ? [callOf(who)] : [],
              },
            };
          case '/v1/social/threads/calls/lock': {
            if (paused[who])
              return {
                json: {
                  version: 'content-thread.v1',
                  scope,
                  operation: 'thread.call-lock',
                  recorded: false,
                  reason: 'recording_paused',
                  currentGeneration: 2,
                },
              };
            const stage = (callOf(who) as { stage: string }).stage;
            // The pick names the revision of the question on the card (D-233); the fixture's call is about revision 1.
            const result =
              body['assetRevision'] !== 1
                ? 'changed'
                : stage === 'open'
                  ? 'locked'
                  : stage === 'closed'
                    ? 'closed'
                    : 'stands';
            if (result === 'locked') locks.set(who, Number(body['option']));
            return {
              json: {
                version: 'content-thread.v1',
                scope,
                operation: 'thread.call-lock',
                recorded: true,
                thread: membership(who),
                part: body['part'],
                result,
              },
            };
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
          // A part opened from the thread: open, media grant (a Reel) or document (a Scroll), activate, then the recorder's batches.
          case '/v1/experience/open': {
            const assetId = (body['target'] as { assetId: string }).assetId;
            const part = episodes.findIndex((episode) => episode.assetId === assetId) + 1;
            return {
              json: {
                commandId: body['commandId'],
                exposureId: id(400 + part),
                assetId,
                assetRevision: 1,
                kind: options.scrolls === true ? 'scroll' : 'reel',
                revision: 1,
                replayed: false,
              },
            };
          }
          case '/v1/play/results/read':
            return { json: { assetId: body['assetId'], revision: body['revision'], calls: [], sparks: 0, combo: 0 } };
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
                exposureId: body['exposureId'],
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
          default: {
            // A Scroll's document, for the exposure the open above made: the part's title over the labelled v2 fixture.
            const document = /^\/v1\/experience\/exposures\/([^/]+)\/document$/.exec(path);
            if (document !== null && options.scrolls === true) {
              const part = Number(document[1]!.slice(-12)) - 400;
              const episode = episodes[part - 1]!;
              return {
                json: {
                  exposureId: document[1],
                  assetId: episode.assetId,
                  assetRevision: 1,
                  document: { ...seasons, assetId: episode.assetId, title: episode.title },
                  degradedEssential: [],
                },
              };
            }
            return { status: 404, json: {} };
          }
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
