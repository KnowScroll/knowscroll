import { describe, expect, it } from 'vitest';
import {
  AssumptionSchema,
  ChooseScenarioSchema,
  MAX_SCENARIO_TEXT,
  ScenarioAnswerSchema,
  ScenarioCardSchema,
  MAX_SCENARIO_SUGGESTIONS,
  ScenarioDraftViewSchema,
  ScenarioListSchema,
  ScenarioOptionSchema,
  ScenarioSuggestionSchema,
  StartScenarioDraftSchema,
} from './scenarios.js';

const id = (n: number) => `0199a000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const ref = { threadId: id(2), membershipId: id(3), membershipRevision: 1 };
const scope = { accountId: id(1), privacyEpoch: 1 };
const traffic = { subject: 'Traffic', statement: 'Traffic is ten times higher than in the original' };
const person = { kind: 'person' as const, personId: id(10), handle: 'ci.asha', displayName: 'Asha' };

describe('starting a draft', () => {
  const base = {
    version: 'scenario.v1',
    commandId: id(5),
    thread: ref,
    kind: 'what_if',
    origin: { kind: 'root' },
    parent: { kind: 'root', assetRevision: 1 },
    text: 'What if traffic increases tenfold?',
  };
  it('takes a request from the root or from one message, and a parent with the revision the member saw', () => {
    expect(StartScenarioDraftSchema.safeParse(base).success).toBe(true);
    expect(StartScenarioDraftSchema.safeParse({ ...base, origin: { kind: 'message', messageId: id(7) } }).success).toBe(
      true,
    );
    expect(
      StartScenarioDraftSchema.safeParse({ ...base, parent: { kind: 'node', nodeId: id(8), revision: 3 } }).success,
    ).toBe(true);
  });
  it('refuses a blank, padded, control-character or over-long request, a parent with no revision and unknown fields', () => {
    for (const patch of [
      { text: '' },
      { text: ' padded ' },
      { text: 'two\nlines' },
      { text: 'x'.repeat(MAX_SCENARIO_TEXT + 1) },
      { parent: { kind: 'node', nodeId: id(8) } },
      { parent: { kind: 'root' } },
      { origin: { kind: 'snippet', messageId: id(7) } },
      { kind: 'series_step' },
      { admin: true },
    ])
      expect(StartScenarioDraftSchema.safeParse({ ...base, ...patch }).success, JSON.stringify(patch)).toBe(false);
  });
  it('lets a request mention a web address in the member’s own words', () => {
    expect(StartScenarioDraftSchema.safeParse({ ...base, text: 'What if openai.com were down?' }).success).toBe(true);
  });
});

describe('assumptions', () => {
  it('are short, plain statements; the text that reaches a Scroll may not name a web address', () => {
    expect(AssumptionSchema.safeParse(traffic).success).toBe(true);
    expect(AssumptionSchema.safeParse({ ...traffic, statement: 'See openai.com for the numbers' }).success).toBe(false);
    expect(AssumptionSchema.safeParse({ ...traffic, subject: 'x' }).success).toBe(false);
    expect(AssumptionSchema.safeParse({ ...traffic, statement: 'x'.repeat(161) }).success).toBe(false);
    expect(AssumptionSchema.safeParse({ ...traffic, statement: ' padded ' }).success).toBe(false);
  });
});

describe('choosing', () => {
  const base = { version: 'scenario.v1', commandId: id(5), thread: ref, draftId: id(6) };
  it('takes one of the draft’s directions by ID, or the member’s own complete request', () => {
    expect(ChooseScenarioSchema.safeParse({ ...base, selection: { kind: 'suggestion', optionId: 'o2' } }).success).toBe(
      true,
    );
    expect(
      ChooseScenarioSchema.safeParse({
        ...base,
        selection: { kind: 'own', changes: [traffic], kept: [] },
      }).success,
    ).toBe(true);
    expect(
      ChooseScenarioSchema.safeParse({
        ...base,
        selection: { kind: 'own', changes: [], kept: [], lens: 'the operator’s view' },
      }).success,
    ).toBe(true);
  });
  it('lets an edit name the direction it came from, and only a direction of the draft', () => {
    const edit = (fromOptionId: unknown) =>
      ChooseScenarioSchema.safeParse({
        ...base,
        selection: { kind: 'own', changes: [traffic], kept: [], fromOptionId },
      }).success;
    expect(edit('o2')).toBe(true);
    expect(edit('o4')).toBe(false);
    expect(edit('first')).toBe(false);
    // A suggestion has no use for it: the direction is the choice.
    expect(
      ChooseScenarioSchema.safeParse({
        ...base,
        selection: { kind: 'suggestion', optionId: 'o1', fromOptionId: 'o1' },
      }).success,
    ).toBe(false);
  });
  it('refuses an option the planner cannot name, too many changes or kept things, and unknown fields', () => {
    for (const selection of [
      { kind: 'suggestion', optionId: 'o4' },
      { kind: 'suggestion', optionId: 'first' },
      { kind: 'own', changes: [traffic, traffic, traffic], kept: [] },
      { kind: 'own', changes: [traffic], kept: [traffic, traffic, traffic, traffic] },
      { kind: 'own', changes: [], kept: [], extra: 1 },
      { kind: 'text', text: 'hello' },
    ])
      expect(ChooseScenarioSchema.safeParse({ ...base, selection }).success, JSON.stringify(selection)).toBe(false);
    expect(
      ChooseScenarioSchema.safeParse({ ...base, selection: { kind: 'suggestion', optionId: 'o1' }, admin: true })
        .success,
    ).toBe(false);
  });
});

describe('what a draft and a branch show', () => {
  const summary = {
    draftId: id(6),
    kind: 'what_if',
    text: 'What if traffic grew?',
    createdAt: '2026-10-24T10:00:00.000Z',
  };
  const option = {
    optionId: 'o1',
    title: 'What does batching change?',
    explanation: 'Shows how batching holds the cost down.',
    changes: [traffic],
    kept: [],
    speculative: false,
    needsConfirmation: false,
  };
  it('describes a ready draft with one to three directions only', () => {
    const view = { version: 'scenario.v1', readId: id(9), scope, status: 'ready', draft: summary, mode: 'options' };
    expect(ScenarioDraftViewSchema.safeParse({ ...view, options: [option] }).success).toBe(true);
    expect(ScenarioDraftViewSchema.safeParse({ ...view, options: [] }).success).toBe(false);
    expect(ScenarioDraftViewSchema.safeParse({ ...view, options: [option, option, option, option] }).success).toBe(
      false,
    );
    expect(ScenarioOptionSchema.safeParse({ ...option, optionId: 'o9' }).success).toBe(false);
  });
  it('says apart that a direction is speculative and that it needs confirming, and names what a change replaces', () => {
    expect(ScenarioOptionSchema.safeParse({ ...option, speculative: true, needsConfirmation: true }).success).toBe(
      true,
    );
    const { speculative: _omitted, ...withoutFlag } = option;
    expect(ScenarioOptionSchema.safeParse(withoutFlag).success).toBe(false);
    const replacing = { ...option, changes: [{ ...traffic, subject: 'Load', replaces: 'Traffic' }] };
    expect(ScenarioOptionSchema.safeParse(replacing).success).toBe(true);
    expect(ScenarioOptionSchema.safeParse({ ...option, changes: [{ ...traffic, replaces: 'T' }] }).success).toBe(false);
    expect(ScenarioOptionSchema.safeParse({ ...option, changes: [{ ...traffic, extra: 1 }] }).success).toBe(false);
  });
  it('says a failed draft failed in one of two ways, and an unavailable one nothing else', () => {
    const base = { version: 'scenario.v1', readId: id(9), scope };
    expect(
      ScenarioDraftViewSchema.safeParse({ ...base, status: 'failed', draft: summary, reason: 'could_not_suggest' })
        .success,
    ).toBe(true);
    expect(
      ScenarioDraftViewSchema.safeParse({ ...base, status: 'failed', draft: summary, reason: 'quota' }).success,
    ).toBe(false);
    expect(ScenarioDraftViewSchema.safeParse({ ...base, status: 'unavailable', draft: summary }).success).toBe(false);
  });
  it('gives a branch card no field for anyone’s position, current branch or seen marker', () => {
    const card = {
      nodeId: id(8),
      kind: 'what_if',
      origin: 'root',
      title: 'What happens at ten times the traffic?',
      changes: [traffic],
      kept: [],
      hypothetical: true,
      speculative: false,
      assumptions: [traffic],
      startedBy: person,
      status: 'preparing',
      revision: 1,
      createdAt: '2026-10-24T10:00:00.000Z',
    };
    expect(ScenarioCardSchema.safeParse(card).success).toBe(true);
    for (const extra of [{ currentlyWatching: true }, { seen: true }, { position: 12 }, { visited: ['x'] }])
      expect(ScenarioCardSchema.safeParse({ ...card, ...extra }).success, JSON.stringify(extra)).toBe(false);
  });
});

describe('what the member was offered and has not made', () => {
  const suggestion = {
    draftId: id(20),
    optionId: 'o1',
    kind: 'what_if',
    title: 'What if the Sun became a black hole?',
    speculative: true,
  };
  const list = { version: 'scenario.v1', readId: id(9), scope, status: 'ready', cards: [], opened: [] };

  it('is a title, a kind and where it would continue, with no number and no branch of its own', () => {
    expect(ScenarioSuggestionSchema.safeParse(suggestion).success).toBe(true);
    expect(ScenarioSuggestionSchema.safeParse({ ...suggestion, parentNodeId: id(8) }).success).toBe(true);
    for (const extra of [{ part: 3 }, { nodeId: id(8) }, { episode: 2 }, { startedBy: person }])
      expect(ScenarioSuggestionSchema.safeParse({ ...suggestion, ...extra }).success, JSON.stringify(extra)).toBe(
        false,
      );
  });

  it('is part of every ready list, and is bounded', () => {
    expect(ScenarioListSchema.safeParse({ ...list, suggestions: [suggestion] }).success).toBe(true);
    expect(ScenarioListSchema.safeParse(list).success).toBe(false);
    // "Opened by you" is a list of the caller's own, by card, and every ready list says it.
    expect(ScenarioListSchema.safeParse({ ...list, suggestions: [], opened: [id(8)] }).success).toBe(true);
    expect(ScenarioListSchema.safeParse({ ...list, suggestions: [], opened: undefined }).success).toBe(false);
    expect(ScenarioListSchema.safeParse({ ...list, suggestions: [], opened: ['not-an-id'] }).success).toBe(false);
    const tooMany = Array.from({ length: MAX_SCENARIO_SUGGESTIONS + 1 }, () => suggestion);
    expect(ScenarioListSchema.safeParse({ ...list, suggestions: tooMany }).success).toBe(false);
    expect(
      ScenarioListSchema.safeParse({ version: 'scenario.v1', readId: id(9), scope, status: 'unavailable' }).success,
    ).toBe(true);
  });
});

describe('the short answer of a what-if (D-211)', () => {
  const ready = {
    status: 'ready',
    madeBy: 'knowscroll',
    assumption: 'We read “ten times the traffic” as ten times the requests each second.',
    answer:
      'Each instance would see about ten times the requests, so waiting would likely grow unless more instances join.',
    numbers: [{ label: 'Typical answer time', value: 'about 200 ms' }],
    readyAt: '2026-10-24T10:00:30.000Z',
  };
  const card = {
    nodeId: id(8),
    kind: 'what_if',
    origin: 'root',
    title: 'What happens at ten times the traffic?',
    changes: [traffic],
    kept: [],
    hypothetical: true,
    speculative: false,
    assumptions: [traffic],
    startedBy: person,
    status: 'preparing',
    revision: 1,
    createdAt: '2026-10-24T10:00:00.000Z',
  };

  it('is making, unavailable or ready, and a card may carry it or not', () => {
    for (const answer of [{ status: 'making' }, { status: 'unavailable' }, ready])
      expect(ScenarioCardSchema.safeParse({ ...card, answer }).success, JSON.stringify(answer)).toBe(true);
    expect(ScenarioCardSchema.safeParse(card).success).toBe(true);
  });

  it('is always labelled as made by KnowScroll and never ready without its assumption line', () => {
    expect(ScenarioAnswerSchema.safeParse({ ...ready, madeBy: 'someone' }).success).toBe(false);
    const { madeBy: _label, ...unlabelled } = ready;
    expect(ScenarioAnswerSchema.safeParse(unlabelled).success).toBe(false);
    const { assumption: _line, ...withoutAssumption } = ready;
    expect(ScenarioAnswerSchema.safeParse(withoutAssumption).success).toBe(false);
    expect(ScenarioAnswerSchema.safeParse({ ...ready, assumption: '' }).success).toBe(false);
  });

  it('is plain text, at most three figures, and carries no sources, scores or model fields', () => {
    expect(
      ScenarioAnswerSchema.safeParse({ ...ready, answer: 'See https://example.com for why this holds up.' }).success,
    ).toBe(false);
    expect(ScenarioAnswerSchema.safeParse({ ...ready, numbers: Array(4).fill(ready.numbers[0]) }).success).toBe(false);
    for (const extra of [{ sources: ['e1'] }, { cites: ['e1'] }, { model: 'x' }, { score: 0.9 }, { prompt: 'x' }])
      expect(ScenarioAnswerSchema.safeParse({ ...ready, ...extra }).success, JSON.stringify(extra)).toBe(false);
    expect(ScenarioAnswerSchema.safeParse({ status: 'making', model: 'x' }).success).toBe(false);
  });
});
