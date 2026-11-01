import { ORPCError } from '@orpc/client';
import { describe, expect, it } from 'vitest';
import { problemDetails, type ContentThreadRef, type ScenarioCard } from '@knowscroll/contracts';
import type { AccountScope } from './account-scope';
import {
  chipText,
  createScenarioBoard,
  createScenarioComposer,
  describeOption,
  statementsInWords,
  kindedTitle,
  replacedPremises,
  ownSelection,
  subjectOfStatement,
} from './scenarios';

const id = (n: number) => `0199a000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const thread: ContentThreadRef = { threadId: id(1), membershipId: id(2), membershipRevision: 1 };
const scope = { accountId: id(3), privacyEpoch: 1 };
const traffic = { subject: 'Traffic', statement: 'Traffic is ten times higher than in the original' };
const model = { subject: 'Model', statement: 'The same model serves every request' };
const option = {
  optionId: 'o1' as const,
  title: 'What does batching change?',
  explanation: 'Shows how batching holds the cost down.',
  changes: [traffic],
  kept: [model],
  speculative: false,
  needsConfirmation: false,
};
const card = (patch: Partial<ScenarioCard> = {}): ScenarioCard => ({
  nodeId: id(9),
  kind: 'what_if',
  origin: 'root',
  title: 'What does batching change?',
  changes: [traffic],
  kept: [],
  hypothetical: true,
  speculative: false,
  assumptions: [traffic],
  status: 'preparing',
  revision: 1,
  createdAt: '2026-10-24T10:00:00.000Z',
  ...patch,
});
const ask = {
  kind: 'what_if' as const,
  origin: { kind: 'root' as const },
  parent: { kind: 'root' as const, assetRevision: 1 },
  text: 'What if traffic increases tenfold?',
};

const problem = (
  code:
    | 'TOO_MANY_REQUESTS'
    | 'UNPROCESSABLE_REQUEST'
    | 'INVALID_REQUEST'
    | 'SHARING_UNAVAILABLE'
    | 'SHARING_REVISION_STALE',
) => new ORPCError(code, { status: 400, data: problemDetails(code) });

type Api = Record<string, (input: never) => Promise<unknown>>;
function scopeOf(api: Api): AccountScope & { calls: { name: string; input: Record<string, unknown> }[] } {
  const calls: { name: string; input: Record<string, unknown> }[] = [];
  const wrapped = Object.fromEntries(
    Object.entries(api).map(([name, handler]) => [
      name,
      (input: never) => {
        calls.push({ name, input });
        return handler(input);
      },
    ]),
  );
  return { active: true, api: { scenarios: wrapped }, calls } as unknown as AccountScope & {
    calls: { name: string; input: Record<string, unknown> }[];
  };
}
let counter = 1000;
const newId = () => id(counter++);

describe('the thread’s branches', () => {
  it('reads the cards, and says unavailable without them when the place ended', async () => {
    let answer: unknown = {
      status: 'ready',
      scope,
      readId: id(1),
      version: 'scenario.v1',
      cards: [card()],
      suggestions: [],
      opened: [id(9)],
    };
    const board = createScenarioBoard({ scope: scopeOf({ list: () => Promise.resolve(answer) }), thread, newId });
    expect(board.getState().phase).toBe('loading');
    await board.load();
    expect(board.getState()).toMatchObject({
      phase: 'ready',
      offline: false,
      cards: [{ nodeId: id(9) }],
      opened: [id(9)],
    });
    answer = { status: 'unavailable', scope, readId: id(1), version: 'scenario.v1' };
    await board.load();
    expect(board.getState()).toMatchObject({ phase: 'unavailable', cards: [], opened: [] });
  });

  it('keeps what it has and says so when a later read does not arrive', async () => {
    let fail = false;
    const board = createScenarioBoard({
      scope: scopeOf({
        list: () =>
          fail
            ? Promise.reject(new Error('network'))
            : Promise.resolve({
                status: 'ready',
                scope,
                readId: id(1),
                version: 'scenario.v1',
                cards: [card()],
                suggestions: [],
                opened: [],
              }),
      }),
      thread,
      newId,
    });
    await board.load();
    fail = true;
    await board.load();
    expect(board.getState()).toMatchObject({ phase: 'ready', offline: true, cards: [{ nodeId: id(9) }] });
  });

  it('removes a branch under one command until the server answers, then reads again', async () => {
    let removed = 0;
    const api = scopeOf({
      list: () =>
        Promise.resolve({
          status: 'ready',
          scope,
          readId: id(1),
          version: 'scenario.v1',
          cards: [card()],
          suggestions: [],
          opened: [],
        }),
      remove: () => (removed++ === 0 ? Promise.reject(new Error('network')) : Promise.resolve({ revision: 2 })),
    });
    const board = createScenarioBoard({ scope: api, thread, newId });
    expect(await board.remove(card())).toBe(false);
    expect(await board.remove(card())).toBe(true);
    const commands = api.calls.filter((call) => call.name === 'remove').map((call) => call.input['commandId']);
    expect(commands[0]).toBe(commands[1]);
  });
});

describe('what the member was offered', () => {
  const offered = {
    draftId: id(7),
    optionId: 'o1',
    kind: 'what_if',
    title: 'What if the Sun became a black hole?',
    speculative: true,
  };

  it('is kept beside the cards, and gone with them when the place ended', async () => {
    let answer: unknown = {
      status: 'ready',
      scope,
      readId: id(1),
      version: 'scenario.v1',
      cards: [card()],
      suggestions: [offered],
    };
    const board = createScenarioBoard({ scope: scopeOf({ list: () => Promise.resolve(answer) }), thread, newId });
    await board.load();
    expect(board.getState()).toMatchObject({ suggestions: [{ title: 'What if the Sun became a black hole?' }] });
    answer = { status: 'unavailable', scope, readId: id(1), version: 'scenario.v1' };
    await board.load();
    expect(board.getState()).toMatchObject({ phase: 'unavailable', suggestions: [] });
  });

  it('comes back as directions to choose from when the composer picks the draft up, without asking again', async () => {
    const api = scopeOf({
      readDraft: () => Promise.resolve({ status: 'ready', mode: 'options', options: [option] }),
      choose: () => Promise.resolve({ node: card(), reused: false }),
    });
    const composer = createScenarioComposer({ scope: api, thread, newId });
    await composer.attach(id(7));
    expect(composer.getState()).toMatchObject({ phase: 'ready', mode: 'options', options: [option] });
    expect(api.calls.map((call) => call.name)).toEqual(['readDraft']);
    await composer.choose({ kind: 'suggestion', optionId: 'o1' });
    expect(api.calls.at(-1)).toMatchObject({ name: 'choose', input: { draftId: id(7) } });
    expect(composer.getState()).toMatchObject({ phase: 'chosen' });
  });

  it('says it is not available when the draft is gone', async () => {
    const api = scopeOf({ readDraft: () => Promise.resolve({ status: 'unavailable' }) });
    const composer = createScenarioComposer({ scope: api, thread, newId });
    await composer.attach(id(7));
    expect(composer.getState()).toMatchObject({ phase: 'blocked', block: 'unavailable' });
  });
});

describe('the composer', () => {
  const ready = { status: 'ready', mode: 'direct', options: [option] };
  it('asks, waits for the directions and chooses one: the choice is the only command that commissions', async () => {
    let draftReads = 0;
    const api = scopeOf({
      draft: () => Promise.resolve({ draftId: id(7) }),
      readDraft: () => Promise.resolve(draftReads++ === 0 ? { status: 'thinking' } : ready),
      choose: () => Promise.resolve({ node: card(), reused: false }),
    });
    const composer = createScenarioComposer({ scope: api, thread, newId });
    await composer.begin(ask);
    expect(composer.getState()).toMatchObject({ phase: 'thinking' });
    expect(api.calls.map((call) => call.name)).toEqual(['draft', 'readDraft']);
    await composer.refresh();
    expect(composer.getState()).toMatchObject({ phase: 'ready', mode: 'direct', options: [option] });
    expect(api.calls.map((call) => call.name)).not.toContain('choose');
    await composer.choose({ kind: 'suggestion', optionId: 'o1' });
    expect(composer.getState()).toMatchObject({ phase: 'chosen', chosen: { reused: false, card: { nodeId: id(9) } } });
  });

  it('shows a failed draft honestly and still takes the member’s own complete request', async () => {
    const api = scopeOf({
      draft: () => Promise.resolve({ draftId: id(7) }),
      readDraft: () => Promise.resolve({ status: 'failed', reason: 'could_not_suggest' }),
      choose: () => Promise.resolve({ node: card(), reused: false }),
    });
    const composer = createScenarioComposer({ scope: api, thread, newId });
    await composer.begin(ask);
    expect(composer.getState()).toMatchObject({ phase: 'failed', failure: 'could_not_suggest', options: [] });
    await composer.choose({ kind: 'own', changes: [traffic], kept: [] });
    expect(composer.getState().phase).toBe('chosen');
  });

  it('lets the member submit their own request while the model still thinks', async () => {
    const api = scopeOf({
      draft: () => Promise.resolve({ draftId: id(7) }),
      readDraft: () => Promise.resolve({ status: 'thinking' }),
      choose: () => Promise.resolve({ node: card(), reused: false }),
    });
    const composer = createScenarioComposer({ scope: api, thread, newId });
    await composer.begin(ask);
    await composer.choose({ kind: 'own', changes: [traffic], kept: [] });
    expect(composer.getState().phase).toBe('chosen');
  });

  it('sends the same command again after a lost answer, so one ask is one draft and one choice one branch', async () => {
    let drafts = 0;
    let chooses = 0;
    const api = scopeOf({
      draft: () => (drafts++ === 0 ? Promise.reject(new Error('network')) : Promise.resolve({ draftId: id(7) })),
      readDraft: () => Promise.resolve({ status: 'ready', mode: 'options', options: [option] }),
      choose: () =>
        chooses++ === 0 ? Promise.reject(new Error('network')) : Promise.resolve({ node: card(), reused: false }),
    });
    const composer = createScenarioComposer({ scope: api, thread, newId });
    await composer.begin(ask);
    expect(composer.getState()).toMatchObject({ phase: 'blocked', block: 'offline' });
    await composer.retry();
    expect(composer.getState().phase).toBe('ready');
    const asked = api.calls.filter((call) => call.name === 'draft').map((call) => call.input['commandId']);
    expect(asked[0]).toBe(asked[1]);

    await composer.choose({ kind: 'suggestion', optionId: 'o1' });
    expect(composer.getState()).toMatchObject({ phase: 'blocked', block: 'offline', options: [option] });
    await composer.retry();
    expect(composer.getState().phase).toBe('chosen');
    const chosen = api.calls.filter((call) => call.name === 'choose').map((call) => call.input['commandId']);
    expect(chosen[0]).toBe(chosen[1]);
  });

  it('says why a refusal stopped it, in the few ways a screen treats differently', async () => {
    for (const [code, block] of [
      ['TOO_MANY_REQUESTS', 'budget'],
      ['UNPROCESSABLE_REQUEST', 'unsupported'],
      ['INVALID_REQUEST', 'invalid'],
      ['SHARING_REVISION_STALE', 'stale'],
      ['SHARING_UNAVAILABLE', 'unavailable'],
    ] as const) {
      const composer = createScenarioComposer({
        scope: scopeOf({ draft: () => Promise.reject(problem(code)) }),
        thread,
        newId,
      });
      await composer.begin(ask);
      expect(composer.getState(), code).toMatchObject({ phase: 'blocked', block });
    }
  });

  it('starts over with a new command for a new ask, and is idle after reset', async () => {
    const api = scopeOf({
      draft: () => Promise.resolve({ draftId: id(7) }),
      readDraft: () => Promise.resolve({ status: 'thinking' }),
    });
    const composer = createScenarioComposer({ scope: api, thread, newId });
    await composer.begin(ask);
    await composer.begin({ ...ask, text: 'And another thought?' });
    const asked = api.calls.filter((call) => call.name === 'draft').map((call) => call.input['commandId']);
    expect(asked[0]).not.toBe(asked[1]);
    composer.reset();
    expect(composer.getState()).toMatchObject({ phase: 'idle', options: [], ask: undefined });
  });
});

describe('words', () => {
  it('names the subject of a sentence by its first words, never empty', () => {
    expect(subjectOfStatement('Traffic is ten times higher than in the original')).toBe('Traffic is ten');
    expect(subjectOfStatement('  Gravity   stays  ')).toBe('Gravity stays');
    expect(subjectOfStatement('x')).toBe('This idea');
    expect(subjectOfStatement('A'.repeat(80)).length).toBeLessThanOrEqual(40);
  });

  it('says a chip and an option as a screen reader should read them', () => {
    expect(chipText('Changed', traffic)).toBe('Changed: traffic is ten times higher than in the original');
    expect(describeOption(option)).toBe(
      'Changed: traffic is ten times higher than in the original. Kept: the same model serves every request.',
    );
    expect(describeOption({ ...option, changes: [], kept: [], lens: 'the operator’s view' })).toBe(
      'Another perspective: the operator’s view.',
    );
  });

  it('never doubles a full stop when a statement already ends in one', () => {
    const stated = (statement: string) => ({ subject: 'Orbit', statement });
    expect(statementsInWords([stated('Its shape stays the same.'), stated('The year stays the same..')])).toBe(
      'Its shape stays the same. The year stays the same',
    );
    expect(chipText('Kept', stated('The year stays the same.'))).toBe('Kept: the year stays the same');
    expect(
      describeOption({
        changes: [stated('Traffic is ten times higher.')],
        kept: [stated('The model stays.')],
        lens: undefined,
      }),
    ).toBe('Changed: traffic is ten times higher. Kept: the model stays.');
  });

  describe('what an option would drop', () => {
    const axis = { subject: 'Axis tilt', statement: 'Earth’s axis is tilted' };
    const spin = { subject: 'Spin', statement: 'Earth turns once a day' };
    const gravity = { subject: 'Gravity', statement: 'Gravity pushes away from the Sun', replaces: 'axis TILT' };

    it('is the premise a change names, whatever its own subject, or else the premise of its own subject', () => {
      expect(replacedPremises({ changes: [gravity] }, [axis, spin])).toEqual([axis]);
      expect(
        replacedPremises({ changes: [{ subject: ' spin ', statement: 'Earth turns twice a day' }] }, [axis, spin]),
      ).toEqual([spin]);
      expect(replacedPremises({ changes: [traffic] }, [axis, spin])).toEqual([]);
      expect(replacedPremises({ changes: [gravity] }, [])).toEqual([]);
    });

    it('lists each premise once, and reads aloud what is dropped', () => {
      expect(replacedPremises({ changes: [gravity, { ...gravity, subject: 'Pull' }] }, [axis])).toEqual([axis]);
      expect(describeOption({ changes: [gravity], kept: [], lens: undefined }, [axis, spin])).toBe(
        'Changed: gravity pushes away from the Sun. Replaces: earth’s axis is tilted.',
      );
      expect(chipText('Replaces', axis)).toBe('Replaces: earth’s axis is tilted');
    });
  });
});

describe('the member’s own request', () => {
  const twenty = 'Traffic is twenty times higher than in the original';

  it('keeps the subject of an edited suggestion, so it replaces the premise of that subject', () => {
    expect(
      ownSelection({
        kind: 'what_if',
        changes: [{ subject: 'Traffic', statement: `  ${twenty}  ` }],
        kept: [],
        lens: '',
      }),
    ).toEqual({ kind: 'own', changes: [{ subject: 'Traffic', statement: twenty }], kept: [] });
  });

  it('names a new line by its first words, so it adds a premise instead of replacing one', () => {
    const selection = ownSelection({ kind: 'what_if', changes: [{ statement: twenty }], kept: [], lens: '' });
    expect(selection?.changes).toEqual([{ subject: 'Traffic is twenty', statement: twenty }]);
  });

  it('drops lines too short to be a sentence, and is nothing until something changes', () => {
    expect(ownSelection({ kind: 'what_if', changes: [{ statement: 'ok' }], kept: [], lens: '' })).toBeUndefined();
    const selection = ownSelection({
      kind: 'what_if',
      changes: [{ statement: twenty }],
      kept: [{ statement: '' }, { statement: 'The same model serves every request' }],
      lens: 'ignored',
    });
    expect(selection?.kept).toEqual([{ subject: 'The same model', statement: 'The same model serves every request' }]);
    expect(selection).not.toHaveProperty('lens');
  });

  it('names the direction an edit came from, and nothing when it came from nowhere', () => {
    const edited = ownSelection({
      kind: 'what_if',
      changes: [{ statement: twenty }],
      kept: [],
      lens: '',
      fromOptionId: 'o2',
    });
    expect(edited).toMatchObject({ kind: 'own', fromOptionId: 'o2' });
    expect(ownSelection({ kind: 'what_if', changes: [{ statement: twenty }], kept: [], lens: '' })).not.toHaveProperty(
      'fromOptionId',
    );
    expect(ownSelection({ kind: 'perspective', changes: [], kept: [], lens: 'cost', fromOptionId: 'o1' })).toEqual({
      kind: 'own',
      changes: [],
      kept: [],
      lens: 'cost',
      fromOptionId: 'o1',
    });
  });

  it('takes only the lens for a perspective', () => {
    expect(ownSelection({ kind: 'perspective', changes: [{ statement: twenty }], kept: [], lens: '  cost  ' })).toEqual(
      {
        kind: 'own',
        changes: [],
        kept: [],
        lens: 'cost',
      },
    );
    expect(ownSelection({ kind: 'perspective', changes: [], kept: [], lens: ' ' })).toBeUndefined();
  });
});

describe('a branch named with its kind', () => {
  it('says the kind once: not before a title that already says it', () => {
    expect(kindedTitle({ kind: 'what_if', title: 'What if Earth had no axial tilt?' })).toBe(
      'What if Earth had no axial tilt?',
    );
    expect(kindedTitle({ kind: 'what_if', title: 'Earth with no tilt' })).toBe('What if · Earth with no tilt');
    expect(kindedTitle({ kind: 'perspective', title: 'The seasons through sunlight geometry' })).toBe(
      'Another perspective · The seasons through sunlight geometry',
    );
  });
});
