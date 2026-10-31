import type { Page } from '@playwright/test';
import { LAUNCH_HOST } from '@knowscroll/contracts';
import { id } from './encounter-fixture';
import { DECK } from './rooms-launch-fixture';
import { room } from './rooms-fixture';

/**
 * The quiet room (v3 R-7) over labelled HTTP fixtures, for two people who share one room: Ravi, alone, replays a Launch that Kenji and
 * Asha played and leaves a question; Lena, in another browser, finds it waiting and answers it; Ravi is told when he comes back.
 * The world keeps the server's rules in a test's own words: the questions go out without a key, the key comes with each answer, the
 * answers are the recorded ones of the two people who played, nothing about the replaying person is kept, a question stays open
 * until a person answers it and its asker is told once. Authored people and questions: never product data, never a model's words.
 */
export type Who = 'ravi' | 'lena';
const PEOPLE = {
  ravi: { kind: 'person' as const, personId: id(10), handle: 'ci.ravi', displayName: 'Ravi' },
  asha: { kind: 'person' as const, personId: id(11), handle: 'ci.asha', displayName: 'Asha' },
  kenji: { kind: 'person' as const, personId: id(12), handle: 'ci.kenji', displayName: 'Kenji' },
  lena: { kind: 'person' as const, personId: id(13), handle: 'ci.lena', displayName: 'Lena' },
};
const launchId = id(950);
const questionId = id(951);
const questionMessageId = id(952);
const DAY = 86_400_000;

/** What Kenji and Asha answered last time, and how long it took: Kenji is right on all five and quick; Asha is right on three. */
const RECORDED = {
  kenji: { right: [true, true, true, true, true], ms: 2_000 },
  asha: { right: [true, true, true, false, false], ms: 3_000 },
} as const;

interface QuestionMessage {
  readonly messageId: string;
  readonly by: Who | 'nova';
  readonly text: string;
  readonly at: string;
}

export class QuietWorld {
  readonly day = '2026-10-31';
  /** The question Ravi left, once he did. */
  question:
    | {
        readonly title: string;
        readonly askedAt: number;
        notify: boolean;
        noticed: boolean;
        readonly messages: QuestionMessage[];
      }
    | undefined;
  readonly calls: { who: Who; path: string; body: Record<string, unknown> }[] = [];

  /** The replay strip of the room view: Ravi did not play, so he may replay it; so may Lena. */
  strip(): Record<string, unknown> {
    return { day: this.day };
  }

  /** What a member's view says of questions: how many wait, and whether a person answered the caller's own. */
  questionsFor(who: Who): Record<string, unknown> | undefined {
    const question = this.question;
    if (question === undefined) return undefined;
    const answer = question.messages.find((message) => message.by !== 'nova' && message.by !== 'ravi');
    const waiting = answer === undefined ? 1 : 0;
    const replies =
      who === 'ravi' && answer !== undefined && question.notify && !question.noticed
        ? [
            {
              discussionId: questionId,
              title: question.title,
              by: PEOPLE[answer.by as 'lena'],
              askedAt: new Date(question.askedAt).toISOString(),
              at: answer.at,
            },
          ]
        : [];
    return waiting === 0 && replies.length === 0 ? undefined : { waiting, replies };
  }

  /** The five questions, without a key. */
  replay() {
    return {
      launchId,
      day: this.day,
      played: 2,
      questions: DECK.map((question, index) => ({
        round: index + 1,
        prompt: question.prompt,
        options: question.options,
      })),
      answerSeconds: 8,
    };
  }

  /** One question answered: the key, the reason, and the recorded answers of the two people who played. */
  round(round: number, choice: number | undefined, elapsedMs: number | undefined) {
    const question = DECK[round - 1]!;
    const answered = (['kenji', 'asha'] as const).filter((who) => RECORDED[who].right.length >= round);
    const right = answered.filter((who) => RECORDED[who].right[round - 1]);
    const quicker =
      choice === question.answer && elapsedMs !== undefined
        ? right.filter((who) => RECORDED[who].ms < elapsedMs).length
        : undefined;
    return {
      launchId,
      round,
      correct: question.answer,
      explain: question.explain,
      locked: answered.length,
      right: right.length,
      calledIt: right.map((who) => ({ person: PEOPLE[who], you: false })),
      ...(quicker === undefined ? {} : { quicker }),
    };
  }

  leave(body: Record<string, unknown>): 'queued' | 'not_asked' {
    const title = String(body['text']);
    const asked = body['askNow'] === true ? 'queued' : 'not_asked';
    const askedAt = Date.now();
    const messages: QuestionMessage[] = [
      { messageId: questionMessageId, by: 'ravi', text: title, at: new Date(askedAt).toISOString() },
    ];
    // A resident answers an asked question at once, labelled AI: it does not close the question.
    if (asked === 'queued')
      messages.push({
        messageId: id(953),
        by: 'nova',
        text: 'Nearby stars shift against far ones as Earth moves: that shift is parallax.',
        at: new Date(askedAt + 5_000).toISOString(),
      });
    this.question = { title, askedAt, notify: body['notify'] === true, noticed: false, messages };
    return asked;
  }

  /** Lena answers, two days and twenty minutes later than the question was left. */
  answer(who: Who, text: string): string {
    const at = new Date(this.question!.askedAt + 2 * DAY + 20 * 60_000).toISOString();
    const messageId = id(954);
    this.question!.messages.push({ messageId, by: who, text, at });
    return messageId;
  }

  /** The question topic as `viewer` reads it. */
  discussion(viewer: Who) {
    const question = this.question!;
    return {
      discussionId: questionId,
      kind: 'topic' as const,
      title: question.title,
      tag: 'question' as const,
      pinned: false,
      messages: question.messages.map((message, index) => ({
        messageId: message.messageId,
        sequence: index + 1,
        status: 'available' as const,
        author:
          message.by === 'nova'
            ? { kind: 'ai' as const, inhabitant: 'explainer' as const, name: 'Nova', label: 'AI · Explainer' }
            : PEOPLE[message.by],
        recordedAt: message.at,
        body: { kind: 'text' as const, text: message.text },
        ...(message.by === 'nova'
          ? {
              suggestion: 'explanation' as const,
              ask: { kind: 'about' as const, by: PEOPLE.ravi, about: questionMessageId },
            }
          : {}),
      })),
      you: PEOPLE[viewer],
    };
  }
}

const receipt = (body: Record<string, unknown>, scope: unknown, operation: string) => ({
  version: 'rooms.v1',
  scope,
  commandId: body['commandId'],
  recordedAt: new Date().toISOString(),
  replayed: false,
  outcome: 'accepted',
  operation,
  roomId: body['roomId'],
});

const cursor = `krc1_${'A'.repeat(26)}`;
const inhabitants = [
  { inhabitant: 'explainer' as const, name: 'Nova', label: 'AI · Explainer', blurb: 'Answers when asked' },
  { inhabitant: 'skeptic' as const, name: 'Halley', label: 'AI · Skeptic', blurb: 'Pushes back on claims' },
];

/**
 * Answers the replay and question routes (and the question topic) for one person. Register it after `roomFixture`: its routes are
 * matched first and everything else falls through to the room's own fixture.
 */
export async function quietRoutes(
  page: Page,
  world: QuietWorld,
  who: Who,
  scope: { accountId: string; privacyEpoch: number },
) {
  await page.route('**/v1/rooms/replay/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    const body = (route.request().postDataJSON() ?? {}) as Record<string, unknown>;
    world.calls.push({ who, path, body });
    const base = { version: 'rooms.v1', readId: body['readId'], scope };
    if (path.endsWith('/read'))
      return route.fulfill({ json: { ...base, status: 'ready', host: LAUNCH_HOST, replay: world.replay() } });
    const answer = world.round(
      body['round'] as number,
      body['choice'] as number | undefined,
      body['elapsedMs'] as number | undefined,
    );
    return route.fulfill({ json: { ...base, status: 'ready', ...answer } });
  });
  await page.route('**/v1/rooms/questions/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    const body = (route.request().postDataJSON() ?? {}) as Record<string, unknown>;
    world.calls.push({ who, path, body });
    if (path.endsWith('/leave')) {
      const asked = world.leave(body);
      return route.fulfill({
        json: { ...receipt(body, scope, 'question.leave'), discussionId: questionId, asked },
      });
    }
    const question = world.question!;
    if (body['notify'] !== undefined) question.notify = body['notify'] === true;
    if (body['noticed'] === true) question.noticed = true;
    return route.fulfill({
      json: { ...receipt(body, scope, 'question.notice'), discussionId: questionId, notify: question.notify },
    });
  });
  // The shelf: questions that wait for a person.
  await page.route('**/v1/rooms/topics/list', (route) => {
    const body = (route.request().postDataJSON() ?? {}) as Record<string, unknown>;
    if (body['tag'] !== 'question') return route.fallback();
    const question = world.question;
    const open = question !== undefined && !question.messages.some((m) => m.by !== 'ravi' && m.by !== 'nova');
    return route.fulfill({
      json: {
        version: 'rooms.v1',
        readId: body['readId'],
        scope,
        status: 'ready',
        roomId: room.roomId,
        sort: body['sort'],
        canPost: true,
        topics: open
          ? [
              {
                discussionId: questionId,
                kind: 'topic',
                title: question.title,
                tag: 'question',
                pinned: false,
                lastActivityAt: new Date(question.askedAt).toISOString(),
                replyCount: question.messages.length,
                startedBy: PEOPLE.ravi,
                usefulCount: 0,
                answered: false,
                waiting: true,
              },
            ]
          : [],
      },
    });
  });
  // The question topic itself, for whoever opens it; every other discussion is the room fixture's.
  await page.route('**/v1/rooms/discussions/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    const body = (route.request().postDataJSON() ?? {}) as Record<string, unknown>;
    if (body['discussionId'] !== questionId || world.question === undefined) return route.fallback();
    const base = { version: 'rooms.v1', readId: body['readId'], scope };
    if (path.endsWith('/send')) {
      const text = (body['body'] as { text?: string } | undefined)?.text ?? '';
      world.calls.push({ who, path, body });
      const messageId = world.answer(who, text);
      return route.fulfill({
        json: {
          ...receipt(body, scope, 'discussion.send'),
          discussionId: questionId,
          messageId,
          messageSequence: world.question.messages.length,
        },
      });
    }
    if (path.endsWith('/changes'))
      return route.fulfill({
        json: {
          ...base,
          status: 'ready',
          limit: body['limit'],
          requestCursor: body['cursor'],
          changes: [],
          continuation: { kind: 'caught_up', cursor },
        },
      });
    if (!path.endsWith('/read')) return route.fallback();
    const view = world.discussion(who);
    return route.fulfill({
      json: {
        ...base,
        status: 'ready',
        room,
        role: 'member',
        you: view.you,
        discussion: {
          discussionId: view.discussionId,
          kind: view.kind,
          title: view.title,
          tag: view.tag,
          pinned: false,
        },
        canPost: true,
        inhabitants: inhabitants.map((entry) => ({ ...entry, ask: 'available' })),
        latestMessageSequence: view.messages.length,
        messages: view.messages,
        limit: body['limit'],
        history: { kind: 'end' },
        catchUpCursor: cursor,
      },
    });
  });
}
