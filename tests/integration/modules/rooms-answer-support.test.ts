/**
 * A resident's answer passes the support check before it is posted (v3 #620, D-298) over real PostgreSQL, the real reasoning
 * harness and ledger, and a CI fixture model (never provider output) that plays the writer and the checker. The library is a
 * labelled fixture of invented Scroll text, read through the real choice of passages. An answer that states a fact rests on
 * passages chosen by code and cites them; a figure no cited passage writes is caught by code; an unsupported sentence earns one
 * rewrite; a draft that is still flagged becomes a fixed honest line (a member who asked) or silence (a resident that spoke on
 * its own); an idle room makes no call.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '@knowscroll/backend/infrastructure/postgres';
import type { LibraryPassageSource, ReadLibraryPassages } from '@knowscroll/backend/modules/content';
import { CONCEPTS } from '@knowscroll/backend/modules/content';
import {
  importEditorialScrollUseCase,
  makeReadLibraryPassages,
} from '@knowscroll/backend/modules/content/nest-providers';
import { holdCast, makeReadGround } from '@knowscroll/backend/modules/rooms/nest-providers';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import { attemptsOf, fixtureModel, receiptClassesOf } from '../support/fixture-model.js';
import type { FixtureCall, FixtureModelPort, FixtureScenario } from '../support/fixture-model-port.js';
import { fixtureRecordingHarness } from '../support/recording-harness.js';
import {
  ask,
  joined,
  memberView,
  readDiscussion,
  roomScope,
  roomWorld,
  say,
  seedRoom,
  setPresence,
  startTopic,
  unwrap,
  type RoomWorld,
} from '../support/rooms.js';
import { starterSource } from '../support/scroll.js';
import type { Friend } from '../support/talk.js';

const version = 'rooms.v1' as const;
// Ten o'clock UTC on the day the test runs: the job port refuses a start more than a day ahead of the real clock.
const today = new Date();
const START = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate(), 10, 0, 0));
const MINUTE = 60_000;

const NOT_COVERED = "The library doesn't cover that yet. Ask from here on a Scroll to have one made.";

/** CI FIXTURE: invented Scroll text about an invented-sounding drift, never library content. */
const DRIFT_ASSET = '00000000-0000-4000-8000-000000000a01';
const TIDES_ASSET = '00000000-0000-4000-8000-000000000a02';
const LIBRARY: readonly LibraryPassageSource[] = [
  {
    assetId: DRIFT_ASSET,
    assetRevision: 1,
    title: 'CI fixture Scroll about the Moon drifting',
    summary: '',
    blocks: [
      {
        blockId: 'drift',
        text: "The Moon is slowly drifting away from Earth. It moves away by about 3.8 centimetres every year. Scientists know this because laser pulses sent to mirrors left on the Moon's surface take a little longer to return each year.",
      },
    ],
  },
  {
    assetId: TIDES_ASSET,
    assetRevision: 1,
    title: 'CI fixture Scroll about tides',
    summary: '',
    blocks: [
      {
        blockId: 'tides',
        text: 'Tides rise and fall because the Moon pulls on the water of Earth. There are two bulges, one facing the Moon and one on the far side of Earth.',
      },
    ],
  },
];
const readLibrary: ReadLibraryPassages = () => Promise.resolve(LIBRARY);

const MOON_QUESTION = 'How do scientists know the Moon is slowly drifting away from Earth?';
const SUPPORTED_ANSWER =
  "The Moon moves away from Earth by about 3.8 centimetres every year. Scientists know this because laser pulses sent to mirrors on the Moon's surface take longer to return each year.";
/** The mistake dev made on 1 Nov, in other words: a speed no passage writes, in the passage's own subject. */
const INVENTED_FIGURE = 'The Moon moves away from Earth by about 1.25 million metres each second.';
const SUN_CLAIM = 'The Moon drifts away because the Sun pulls on it.';
const SUN_CLAIM_AGAIN = 'The Moon drifts away faster each year because the Sun pulls on it.';

const writes = (text: string, cites: readonly string[] = ['e1'], kind = 'explanation'): FixtureScenario => ({
  kind: 'success',
  text: JSON.stringify({ kind, text, cites }),
});

const isCheck = (call: FixtureCall) => call.request.system.includes('You check one thing');
const isRewrite = (call: FixtureCall) => call.request.system.includes('REVISION AFTER A SUPPORT CHECK');

const itemOf = (call: FixtureCall, ref: string): string =>
  new RegExp(`<context-item ref="${ref}"[^>]*>\\n([\\s\\S]*?)\\n</context-item>`, 'u').exec(call.request.user)?.[1] ??
  '';

/** The sentence of the cited passages that shares the most words with `sentence`: a quote that is really there. */
function quoteFor(sentence: string, passages: string): string {
  const words = new Set(sentence.toLowerCase().match(/[a-z]{4,}/gu));
  const candidates = passages
    .split('\n')
    .flatMap((line) => line.replace(/^\[e\d\] /u, '').split(/(?<=\.)\s+/u))
    .filter((candidate) => candidate.length > 0);
  const score = (candidate: string) =>
    (candidate.toLowerCase().match(/[a-z]{4,}/gu) ?? []).filter((w) => words.has(w)).length;
  return candidates.reduce((best, next) => (score(next) > score(best) ? next : best));
}

interface Playbook {
  /** The writer's replies in order: the first draft, then the rewrite. */
  readonly writer: readonly FixtureScenario[];
  /** Whether the checker finds a sentence unsupported. Default: it finds none. */
  readonly flags?: (sentence: string) => boolean;
  /** What the checker answers instead of verdicts, when a test needs it to fail. */
  readonly checker?: FixtureScenario;
}

/** A fixture model that plays the writer from a list and the checker from a rule, and tells them apart by their instructions. */
function playbook(options: Playbook, label: string): FixtureModelPort {
  let drafts = 0;
  return fixtureModel(
    (_sequence, call) => {
      if (!isCheck(call)) {
        const reply = options.writer[drafts];
        drafts += 1;
        if (reply === undefined)
          throw new Error(`the writer was asked for draft ${String(drafts)}, which the test did not script`);
        return reply;
      }
      if (options.checker !== undefined) return options.checker;
      const passages = itemOf(call, 'support:passages');
      const verdicts = itemOf(call, 'support:sentences')
        .split('\n')
        .map((line) => JSON.parse(line) as { n: number; text: string })
        .map(({ n, text }) =>
          options.flags?.(text) === true
            ? {
                n,
                verdict: 'unsupported',
                kind: 'not_stated',
                problem: 'CI fixture: the checker finds this sentence unsupported.',
              }
            : { n, verdict: 'supported', quote: quoteFor(text, passages) },
        );
      return { kind: 'success', text: JSON.stringify({ sentences: verdicts }) };
    },
    { label },
  );
}

describe('a resident’s answer passes the support check (real PostgreSQL, CI fixture model)', () => {
  let database: TestDatabase<Database>;
  let world: RoomWorld;
  /** The words every ground read was made for, so a test can show an idle room reads nothing. */
  const reads: string[] = [];

  beforeAll(async () => {
    database = await createTestDatabase<Database>('rooms_answer_support');
    const choose = makeReadGround(readLibrary);
    world = await roomWorld(
      database,
      { now: START },
      {
        residentsEnabled: true,
        realSupport: true,
        ground: (topic, about) => {
          reads.push(about);
          return choose(topic, about);
        },
      },
    );
  });
  afterAll(async () => {
    await world.close();
    await database.drop();
  });

  const turnOf = (turnId: string) =>
    world.db.selectFrom('rooms.ai_turns').selectAll().where('turn_id', '=', turnId).executeTakeFirstOrThrow();
  const turnsOf = (roomId: string) =>
    world.db.selectFrom('rooms.ai_turns').selectAll().where('room_id', '=', roomId).orderBy('created_at').execute();

  const textsOf = async (person: Friend, roomId: string, discussionId: string) => {
    const read = await readDiscussion(world, person, roomId, discussionId);
    if (read.status !== 'ready') throw new Error('expected ready');
    return read.messages.flatMap((message) =>
      message.status === 'available' && message.body.kind === 'text'
        ? [{ ai: message.author.kind === 'ai', text: message.body.text, suggestion: message.suggestion }]
        : [],
    );
  };

  /** A member of a room asks Nova a question in a topic; the job the ask queued is returned. */
  async function askNova(question: string, title = 'Moon drift') {
    const { roomId } = await seedRoom(world);
    const [asha] = (await joined(world, roomId, 1)) as [Friend];
    const discussionId = await startTopic(world, asha, roomId, title);
    unwrap(await say(world, asha, roomId, discussionId, question));
    const before = world.queued.length;
    unwrap(await ask(world, asha, roomId, discussionId, 'explainer'));
    expect(world.queued).toHaveLength(before + 1);
    return { roomId, asha, discussionId, job: world.queued[before]! };
  }

  /** The harness over a fixture model, and the worker's consumer that uses it. */
  function consumer(model: FixtureModelPort) {
    const { harness } = fixtureRecordingHarness(database.db, { model });
    return world.contribute(harness);
  }

  describe('a member’s ask', () => {
    it('is answered from passages chosen for the question, cites them, and is posted after one check', async () => {
      const { roomId, asha, discussionId, job } = await askNova(MOON_QUESTION);
      const model = playbook({ writer: [writes(SUPPORTED_ANSWER)] }, 'supported');
      await consumer(model)(job);

      // The writer was offered the passage that fits the question, under a handle, and the checker was shown it again.
      const [writer, checker] = model.calls;
      expect(model.calls).toHaveLength(2);
      expect(itemOf(writer!, 'passage:e1')).toContain('3.8 centimetres every year');
      expect(itemOf(checker!, 'support:passages')).toContain('[e1] The Moon is slowly drifting away from Earth.');

      const said = await textsOf(asha, roomId, discussionId);
      expect(said.at(-1)).toEqual({ ai: true, text: SUPPORTED_ANSWER, suggestion: 'explanation' });
      const turn = await turnOf(job.requestId);
      expect(turn.state).toBe('completed');
      expect(turn.role_version).toBe('inhabitant.3');
      // The turn keeps which passages the answer rested on, as IDs of public content and no word of it.
      expect(turn.answer_support).toEqual({
        policy: 'rooms-answer-support.v1',
        result: 'cleared',
        cited: [{ assetId: DRIFT_ASSET, assetRevision: 1, blockId: 'drift' }],
        flagged: [0],
      });
      // Both calls are on the ledger under the asker, the check under a role of its own.
      expect(await receiptClassesOf(world.db, asha.universeId)).toEqual([
        { role_id: 'rooms.explainer', background: false },
        { role_id: 'rooms.inhabitant-support', background: false },
      ]);
      expect((await attemptsOf(world.db, asha.universeId)).map((attempt) => attempt.state)).toEqual([
        'succeeded',
        'succeeded',
      ]);
    });

    it('catches a figure no passage writes, even when the checker lets it pass, and posts the one rewrite', async () => {
      const { roomId, asha, discussionId, job } = await askNova(MOON_QUESTION);
      const model = playbook({ writer: [writes(INVENTED_FIGURE), writes(SUPPORTED_ANSWER)] }, 'figure');
      await consumer(model)(job);

      const said = await textsOf(asha, roomId, discussionId);
      expect(said.at(-1)).toMatchObject({ ai: true, text: SUPPORTED_ANSWER });
      // The invented figure is nowhere in the room.
      expect(said.map((entry) => entry.text).join(' ')).not.toContain('1.25 million');
      expect(model.calls.map((call) => (isCheck(call) ? 'check' : isRewrite(call) ? 'rewrite' : 'write'))).toEqual([
        'write',
        'check',
        'rewrite',
        'check',
      ]);
      // The rewrite was told which sentence and why, in the words code owns.
      const problems = itemOf(model.calls[2]!, 'check:problems');
      expect(problems).toContain(`Sentence "${INVENTED_FIGURE}"`);
      expect(problems).toContain('a passage you cite writes that same number the same way');
      expect(problems).not.toContain('CI fixture');
      expect((await turnOf(job.requestId)).answer_support).toMatchObject({
        result: 'cleared_after_rewrite',
        flagged: [1, 0],
      });
    });

    it('rewrites a sentence the checker finds unsupported once, and says the library does not cover it when the rewrite fails too', async () => {
      const { roomId, asha, discussionId, job } = await askNova(MOON_QUESTION);
      const model = playbook(
        { writer: [writes(SUN_CLAIM), writes(SUN_CLAIM_AGAIN)], flags: (sentence) => sentence.includes('Sun pulls') },
        'refused',
      );
      await consumer(model)(job);

      // Four paid calls and no more: the draft, its check, one rewrite, its check.
      expect(model.calls).toHaveLength(4);
      const said = await textsOf(asha, roomId, discussionId);
      // The member is told plainly, in code's words, labelled as the Explainer; nothing the model wrote is in the room.
      expect(said.at(-1)).toEqual({ ai: true, text: NOT_COVERED, suggestion: 'explanation' });
      expect(said.map((entry) => entry.text).join(' ')).not.toContain('Sun pulls');
      const view = await readDiscussion(world, asha, roomId, discussionId);
      if (view.status !== 'ready') throw new Error('expected ready');
      expect(view.messages.at(-1)).toMatchObject({
        author: { kind: 'ai', inhabitant: 'explainer', label: 'AI · Explainer' },
      });
      const turn = await turnOf(job.requestId);
      expect(turn).toMatchObject({ state: 'completed', dispatched: true });
      expect(turn.answer_support).toEqual({
        policy: 'rooms-answer-support.v1',
        result: 'not_covered',
        cited: [],
        flagged: [1, 1],
      });
    });

    it('says the library does not cover it, with no model asked, when no passage fits the question', async () => {
      const { roomId, asha, discussionId, job } = await askNova(
        'How do volcanoes make obsidian glass?',
        'Volcano glass',
      );
      const model = playbook({ writer: [] }, 'no-ground');
      await consumer(model)(job);
      expect(model.calls).toHaveLength(0);
      expect((await textsOf(asha, roomId, discussionId)).at(-1)).toEqual({
        ai: true,
        text: NOT_COVERED,
        suggestion: 'explanation',
      });
      expect(await turnOf(job.requestId)).toMatchObject({
        state: 'completed',
        dispatched: true,
        answer_support: { result: 'no_ground', cited: [] },
      });
      expect(await receiptClassesOf(world.db, asha.universeId)).toEqual([]);
    });

    it('gives a Skeptic that was asked the same line when the library has nothing, labelled as the Skeptic', async () => {
      const { roomId } = await seedRoom(world);
      const [asha] = (await joined(world, roomId, 1)) as [Friend];
      const discussionId = await startTopic(world, asha, roomId, 'Volcano glass');
      unwrap(await say(world, asha, roomId, discussionId, 'Obsidian forms because lava cools slowly.'));
      const before = world.queued.length;
      unwrap(await ask(world, asha, roomId, discussionId, 'skeptic'));
      const model = playbook({ writer: [] }, 'skeptic-no-ground');
      await consumer(model)(world.queued[before]!);
      expect(model.calls).toHaveLength(0);
      const view = await readDiscussion(world, asha, roomId, discussionId);
      if (view.status !== 'ready') throw new Error('expected ready');
      expect(view.messages.at(-1)).toMatchObject({
        author: { kind: 'ai', inhabitant: 'skeptic', label: 'AI · Skeptic' },
        body: { kind: 'text', text: NOT_COVERED },
      });
    });

    it('says the library does not cover it when the writer itself says the passages do not', async () => {
      const { roomId, asha, discussionId, job } = await askNova(MOON_QUESTION);
      const model = playbook(
        { writer: [{ kind: 'success', text: JSON.stringify({ kind: 'not_covered', text: '', cites: [] }) }] },
        'writer-uncovered',
      );
      await consumer(model)(job);
      expect(model.calls).toHaveLength(1);
      expect((await textsOf(asha, roomId, discussionId)).at(-1)).toMatchObject({ ai: true, text: NOT_COVERED });
      expect((await turnOf(job.requestId)).answer_support).toMatchObject({ result: 'not_covered', flagged: [] });
    });

    it('posts nothing, and never the draft, when the checker gives no usable reply: the ask fails and stays counted', async () => {
      const { roomId, asha, discussionId, job } = await askNova(MOON_QUESTION);
      const model = playbook({ writer: [writes(SUPPORTED_ANSWER)], checker: { kind: 'malformed' } }, 'unchecked');
      await consumer(model)(job);
      // The draft, the check, and the harness's one repair of the check.
      expect(model.calls).toHaveLength(3);
      const said = await textsOf(asha, roomId, discussionId);
      expect(said.some((entry) => entry.ai)).toBe(false);
      expect(await turnOf(job.requestId)).toMatchObject({ state: 'failed', dispatched: true, answer_support: null });
    });

    it('does not resend a check whose outcome is unknown, and posts nothing', async () => {
      const { roomId, asha, discussionId, job } = await askNova(MOON_QUESTION);
      const model = playbook(
        { writer: [writes(SUPPORTED_ANSWER)], checker: { kind: 'timeout_after_dispatch' } },
        'unknown',
      );
      const run = consumer(model);
      await run(job);
      expect(model.calls).toHaveLength(2);
      expect((await textsOf(asha, roomId, discussionId)).some((entry) => entry.ai)).toBe(false);
      expect(await turnOf(job.requestId)).toMatchObject({ state: 'failed', dispatched: true });
      // A redelivery finds the turn settled and asks nothing.
      const again = playbook({ writer: [writes(SUPPORTED_ANSWER)] }, 'redelivered');
      await consumer(again)(job);
      expect(again.calls).toHaveLength(0);
    });

    it('answers a question left for people from the library, under the same check', async () => {
      const { roomId } = await seedRoom(world);
      const [asha, ravi] = (await joined(world, roomId, 2)) as [Friend, Friend];
      const before = world.queued.length;
      const left = unwrap(
        await world.rooms.leaveQuestion(asha.authority, {
          version,
          commandId: randomUUID(),
          roomId,
          text: MOON_QUESTION,
          askNow: true,
          notify: true,
        }),
      );
      expect(world.queued).toHaveLength(before + 1);
      const model = playbook({ writer: [writes(INVENTED_FIGURE), writes(SUPPORTED_ANSWER)] }, 'left-question');
      await consumer(model)(world.queued.at(-1)!);
      const said = await textsOf(ravi, roomId, left.discussionId);
      expect(said.map((entry) => entry.text)).toEqual([MOON_QUESTION, SUPPORTED_ANSWER]);
      // A resident's answer does not close a question: people still wait to answer it (D-242).
      expect((await memberView(world, ravi, roomId)).questions?.waiting).toBe(1);
    });

    it('is a Skeptic’s challenge under the same check', async () => {
      const { roomId } = await seedRoom(world);
      const [asha] = (await joined(world, roomId, 1)) as [Friend];
      const discussionId = await startTopic(world, asha, roomId, 'Moon drift');
      unwrap(await say(world, asha, roomId, discussionId, 'The Moon drifts away because of the Sun.'));
      const before = world.queued.length;
      unwrap(await ask(world, asha, roomId, discussionId, 'skeptic'));
      const model = playbook(
        {
          writer: [writes('Does that assume the Moon is drifting away because of the Sun?', ['e1'], 'assumption')],
        },
        'skeptic',
      );
      await consumer(model)(world.queued[before]!);
      const said = await textsOf(asha, roomId, discussionId);
      expect(said.at(-1)).toMatchObject({ ai: true, suggestion: 'assumption' });
      // A question states no fact: the checker may pass it as such, and it is posted after the same check.
      expect(model.calls.filter(isCheck)).toHaveLength(1);
    });
  });

  describe('a resident that speaks on its own', () => {
    /** Three people who have each spoken once, all with the room open. */
    async function gathering() {
      world.clock.now = START;
      const { roomId } = await seedRoom(world);
      const people = (await joined(world, roomId, 3)) as [Friend, Friend, Friend];
      const general = (await memberView(world, people[0], roomId)).general.discussionId;
      for (const person of people) {
        unwrap(await setPresence(world, person, roomId));
        unwrap(await say(world, person, roomId, general, 'Hello, glad to be here'));
      }
      return { roomId, general, people };
    }

    /** One member asks the room a question nobody answers; the router's check and the model call it queued are run. */
    async function unanswered(model: FixtureModelPort, question = MOON_QUESTION) {
      const room = await gathering();
      world.clock.now = new Date(START.getTime() + MINUTE);
      for (const person of room.people) unwrap(await setPresence(world, person, room.roomId));
      unwrap(await say(world, room.people[1], room.roomId, room.general, question));
      const check = world.castChecks.at(-1)!;
      world.clock.now = check.startAfter!;
      const passes = world.castPasses.length;
      await world.decide()(check.job);
      const { harness, withScope } = roomScope(world.db, model);
      if (world.castPasses.length > passes) await world.pass(harness, withScope)(world.castPasses.at(-1)!.job);
      return { ...room, queued: world.castPasses.length > passes };
    }

    const ambientReceipts = () =>
      world.db
        .selectFrom('reasoning.usage_receipts')
        .select(['role_id', 'ambient'])
        .where('role_id', 'in', ['rooms.ambient-explainer', 'rooms.ambient-support'])
        .execute();

    const spoken = async (room: { roomId: string; general: string; people: Friend[] }) =>
      (await textsOf(room.people[0]!, room.roomId, room.general)).filter((entry) => entry.ai);

    it('posts an answer that passed, with its passages kept on the turn, paid by the room as an ambient role', async () => {
      const model = playbook({ writer: [writes(SUPPORTED_ANSWER)] }, 'unprompted-supported');
      const receiptsBefore = await ambientReceipts();
      const room = await unanswered(model);
      expect(model.calls).toHaveLength(2);
      expect((await spoken(room)).map((entry) => entry.text)).toEqual([SUPPORTED_ANSWER]);
      const [turn] = await turnsOf(room.roomId);
      expect(turn).toMatchObject({ trigger: 'unanswered_question', state: 'completed', role_version: 'resident.2' });
      expect(turn!.answer_support).toMatchObject({ result: 'cleared', cited: [{ assetId: DRIFT_ASSET }] });
      // Paid by the rooms scope, never by a person: the writer's and the checker's receipts are both ambient.
      const after = await ambientReceipts();
      expect(after.filter((row) => row.role_id === 'rooms.ambient-explainer')).toHaveLength(
        receiptsBefore.filter((row) => row.role_id === 'rooms.ambient-explainer').length + 1,
      );
      expect(after.filter((row) => row.role_id === 'rooms.ambient-support')).toHaveLength(
        receiptsBefore.filter((row) => row.role_id === 'rooms.ambient-support').length + 1,
      );
      expect(after.every((row) => row.ambient)).toBe(true);
    });

    it('says nothing, and is counted, when its answer is still flagged after the one rewrite: no honest line is posted unasked', async () => {
      const model = playbook(
        { writer: [writes(SUN_CLAIM), writes(SUN_CLAIM_AGAIN)], flags: (sentence) => sentence.includes('Sun pulls') },
        'unprompted-refused',
      );
      const room = await unanswered(model);
      expect(model.calls).toHaveLength(4);
      expect(await spoken(room)).toEqual([]);
      const [turn] = await turnsOf(room.roomId);
      expect(turn).toMatchObject({ state: 'declined', dispatched: true });
      expect(turn!.answer_support).toMatchObject({ result: 'not_covered', flagged: [1, 1] });
      expect(JSON.stringify(await textsOf(room.people[0]!, room.roomId, room.general))).not.toContain(NOT_COVERED);
    });

    it('catches a figure no passage writes and posts only the rewrite', async () => {
      const model = playbook({ writer: [writes(INVENTED_FIGURE), writes(SUPPORTED_ANSWER)] }, 'unprompted-figure');
      const room = await unanswered(model);
      expect((await spoken(room)).map((entry) => entry.text)).toEqual([SUPPORTED_ANSWER]);
      expect(model.calls.map((call) => (isCheck(call) ? 'check' : 'write'))).toEqual([
        'write',
        'check',
        'write',
        'check',
      ]);
    });

    it('makes no call, and hands the turn back, when no passage fits what was asked', async () => {
      const model = playbook({ writer: [] }, 'unprompted-no-ground');
      const room = await unanswered(model, 'How do volcanoes make obsidian glass?');
      expect(room.queued).toBe(true);
      expect(model.calls).toHaveLength(0);
      expect(await spoken(room)).toEqual([]);
      const [turn] = await turnsOf(room.roomId);
      // Nothing reached the provider, so the turn no longer counts against the caps.
      expect(turn).toMatchObject({ state: 'failed', dispatched: false });
      expect(turn!.answer_support).toMatchObject({ result: 'no_ground' });
    });

    it('keeps its record when posting is put off for someone typing, and posts the checked words without a second call', async () => {
      const room = await gathering();
      world.clock.now = new Date(START.getTime() + MINUTE);
      for (const person of room.people) unwrap(await setPresence(world, person, room.roomId));
      unwrap(await say(world, room.people[1], room.roomId, room.general, MOON_QUESTION));
      const check = world.castChecks.at(-1)!;
      world.clock.now = check.startAfter!;
      await world.decide()(check.job);
      const delivery = world.castPasses.at(-1)!;
      // Someone is typing while the model works: the checked answer is held on the turn, with how it came out.
      const model = playbook({ writer: [writes(SUPPORTED_ANSWER)] }, 'held');
      const scope = roomScope(world.db, model);
      await holdCast(
        world.db,
        () => world.clock.now,
      )({
        accountId: room.people[2].accountId,
        roomId: room.roomId,
        discussionId: room.general,
      });
      await world.pass(scope.harness, scope.withScope)(delivery.job);
      expect(model.calls).toHaveLength(2);
      const [held] = await turnsOf(room.roomId);
      expect(held).toMatchObject({
        state: 'queued',
        dispatched: true,
        held_kind: 'explanation',
        held_text: SUPPORTED_ANSWER,
      });
      expect(held!.answer_support).toMatchObject({ result: 'cleared' });

      const again = world.castPasses.at(-1)!;
      world.clock.now = again.startAfter!;
      const idle = playbook({ writer: [writes('must not be asked')] }, 'held-redelivery');
      const next = roomScope(world.db, idle);
      await world.pass(next.harness, next.withScope)(again.job);
      expect(idle.calls).toHaveLength(0);
      expect((await spoken(room)).map((entry) => entry.text)).toEqual([SUPPORTED_ANSWER]);
      expect((await turnsOf(room.roomId))[0]).toMatchObject({
        state: 'completed',
        held_text: null,
        answer_support: { result: 'cleared' },
      });
    });
  });

  describe('the library read', () => {
    it('reads the admitted Scrolls under the room’s topic and offers the passage that fits the question', async () => {
      // An authored CI Scroll (the shipped starter under another identity), admitted through the real import and filed under a
      // planet of the room's system.
      const assetId = randomUUID();
      const source = starterSource() as unknown as {
        assetId: string;
        publication: { explanationUnitId: string };
      };
      source.assetId = assetId;
      source.publication.explanationUnitId = `ci-answer-${assetId.slice(0, 8)}`;
      expect((await importEditorialScrollUseCase(database.db)(source as never)).kind).toBe('imported');
      await database.db
        .insertInto('content.encounter_topics')
        .values({
          asset_id: assetId,
          asset_revision: 1,
          topic_id: CONCEPTS.find((concept) => concept.parent === 'machine-learning')!.id,
          role: 'primary',
          weight: 0.8,
        })
        .execute();

      const real = await roomWorld(
        database,
        { now: START },
        { realSupport: true, ground: makeReadGround(makeReadLibraryPassages(database.db)) },
      );
      try {
        const { roomId } = await seedRoom(real);
        const [asha] = (await joined(real, roomId, 1)) as [Friend];
        const discussionId = await startTopic(real, asha, roomId, 'Colours of the sky');
        unwrap(
          await say(real, asha, roomId, discussionId, 'Why does air scatter the short colours of sunlight so much?'),
        );
        unwrap(await ask(real, asha, roomId, discussionId, 'explainer'));
        const answerText =
          'Sunlight holds every colour, and air scatters the short colours far more than the long ones.';
        const model = playbook({ writer: [writes(answerText)] }, 'real-library');
        const { harness } = fixtureRecordingHarness(database.db, { model });
        await real.contribute(harness)(real.queued.at(-1)!);

        expect(itemOf(model.calls[0]!, 'passage:e1')).toContain('air scatters the short colours');
        expect((await textsOf(asha, roomId, discussionId)).at(-1)).toMatchObject({ ai: true, text: answerText });
        const turn = await turnOf(real.queued.at(-1)!.requestId);
        expect(turn.answer_support).toMatchObject({
          result: 'cleared',
          cited: [{ assetId, assetRevision: 1, blockId: 'intro-short-version' }],
        });
      } finally {
        await real.close();
      }
    });
  });

  describe('an idle room', () => {
    it('makes no call and reads no passage when nobody asks anything, and nothing a calm message says', async () => {
      world.clock.now = START;
      const { roomId } = await seedRoom(world);
      const people = (await joined(world, roomId, 2)) as [Friend, Friend];
      const general = (await memberView(world, people[0], roomId)).general.discussionId;
      const model = playbook({ writer: [writes(SUPPORTED_ANSWER)] }, 'idle');
      const readsBefore = reads.length;
      const checksBefore = world.castChecks.length;
      unwrap(await say(world, people[0], roomId, general, 'thanks, that helps a lot'));
      unwrap(await say(world, people[1], roomId, general, 'the tilt matters more than the distance'));
      world.clock.now = new Date(START.getTime() + 60 * MINUTE);
      expect(world.castChecks).toHaveLength(checksBefore);
      expect(reads).toHaveLength(readsBefore);
      expect(model.calls).toHaveLength(0);
      expect(await turnsOf(roomId)).toEqual([]);
    });
  });
});
