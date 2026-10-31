import { id } from './encounter-fixture';
import { partyWorld, type Who } from './thread-party-fixture';

/**
 * The party thread of `thread-party-fixture.ts` with What if on top, served over labelled HTTP fixtures to two browser
 * pages at once (no backend): Asha asks, Ravi reads what the thread shows. It keeps the real server's rules for
 * branches (D-049, D-076, D-211): only members read or ask; a what-if starts with its short answer being made, and
 * the answer lands only when the test says the writer finished; five branches per thread per UTC day, and the sixth
 * is refused with the closed "too many requests" problem; a removed branch is a bare placeholder that keeps nothing
 * it said. Branch text, premises and answers are authored fixture words, never product data or provider output.
 */
type Person = { kind: 'person'; personId: string; handle: string; displayName: string };
// The same people and accounts as the party fixture (it does not export them): Asha is account 1, Ravi account 3.
const people: Record<Who, Person> = {
  asha: { kind: 'person', personId: id(10), handle: 'ci.asha', displayName: 'Asha fixture' },
  ravi: { kind: 'person', personId: id(11), handle: 'ci.ravi', displayName: 'Ravi fixture' },
};
const accounts: Record<Who, { accountId: string; privacyEpoch: number }> = {
  asha: { accountId: id(1), privacyEpoch: 1 },
  ravi: { accountId: id(3), privacyEpoch: 1 },
};

/** What a short answer says once written: authored words that pass the card's own rules in spirit, not provider output. */
export const FIXTURE_ANSWER = {
  assumption: 'We read “twice the size” as twice as wide, about the same rock.',
  answer:
    'Tides would likely be much stronger, because a heavier moon pulls harder on the sea. A coast near two metres today could see a far larger swing.',
  numbers: [{ label: 'Typical range today', value: 'about 2 m' }],
};

const CHANGE = { subject: 'Moon', statement: 'The Moon is twice as wide as it is' };
const KEPT = { subject: 'Orbit', statement: 'Its distance, Earth’s spin and the Sun’s pull stay the same' };

type Answer =
  | { status: 'making' }
  | { status: 'unavailable' }
  | {
      status: 'ready';
      readyAt: string;
      assumption: string;
      answer: string;
      numbers: { label: string; value: string }[];
    };

interface Node {
  nodeId: string;
  title: string;
  startedBy: Who;
  createdAt: string;
  status: 'preparing' | 'ready' | 'failed' | 'removed';
  revision: number;
  answer: Answer | undefined;
}

const problem = (status: number, code: string, title: string) => ({
  status,
  json: { type: `tag:knowscroll.space,2026:problem:${code.toLowerCase().replaceAll('_', '-')}`, title, status, code },
});

/** The first millisecond of the UTC day: what "five a day" counts from. */
const startOfUtcDay = () => {
  const now = new Date();
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
};

export function whatIfWorld() {
  const party = partyWorld();
  const nodes: Node[] = [];
  const drafts = new Map<string, { who: Who; text: string }>();
  const requests: { who: Who; path: string; body: Record<string, unknown> }[] = [];
  let serial = 0;

  const card = (node: Node) => {
    if (node.status === 'removed')
      return {
        nodeId: node.nodeId,
        kind: 'what_if',
        origin: 'root',
        title: 'Removed',
        changes: [],
        kept: [],
        hypothetical: true,
        speculative: false,
        assumptions: [],
        status: 'removed',
        revision: node.revision,
        createdAt: node.createdAt,
      };
    return {
      nodeId: node.nodeId,
      kind: 'what_if',
      origin: 'root',
      title: node.title,
      changes: [CHANGE],
      kept: [KEPT],
      hypothetical: true,
      speculative: false,
      assumptions: [CHANGE],
      startedBy: people[node.startedBy],
      status: node.status,
      revision: node.revision,
      ...(node.answer === undefined ? {} : { answer: node.answer }),
      createdAt: node.createdAt,
    };
  };

  function scenarioRoute(who: Who, path: string, body: Record<string, unknown>) {
    const scope = accounts[who];
    const base = { version: 'scenario.v1', scope };
    const receipt = (operation: string) => ({
      ...base,
      commandId: body['commandId'],
      recordedAt: new Date().toISOString(),
      replayed: false,
      outcome: 'accepted',
      operation,
    });
    switch (path) {
      case '/v1/social/scenarios/list':
        return {
          json: {
            ...base,
            readId: body['readId'],
            status: 'ready',
            cards: nodes.map(card),
            suggestions: [],
            // "Opened by you" is the caller's own history; this fixture opens nothing for anyone.
            opened: [],
          },
        };
      case '/v1/social/scenarios/draft': {
        const draftId = id(7000 + (serial += 1));
        drafts.set(draftId, { who, text: String(body['text']) });
        return { json: { ...receipt('scenario.draft'), draftId } };
      }
      case '/v1/social/scenarios/draft/read': {
        const draft = drafts.get(String(body['draftId']));
        if (draft === undefined || draft.who !== who)
          return { json: { ...base, readId: body['readId'], status: 'unavailable' } };
        return {
          json: {
            ...base,
            readId: body['readId'],
            status: 'ready',
            draft: { draftId: body['draftId'], kind: 'what_if', text: draft.text, createdAt: new Date().toISOString() },
            mode: 'direct',
            options: [
              {
                optionId: 'o1',
                title: 'What if the Moon were twice its current size?',
                explanation: 'Shows what a heavier moon would do to the tides.',
                changes: [CHANGE],
                kept: [KEPT],
                speculative: false,
                needsConfirmation: false,
              },
            ],
          },
        };
      }
      case '/v1/social/scenarios/choose': {
        const today = nodes.filter((node) => Date.parse(node.createdAt) >= startOfUtcDay()).length;
        // Five per thread per UTC day, removed ones counted: the sixth is refused and writes nothing (D-076).
        if (today >= 5) return problem(429, 'TOO_MANY_REQUESTS', 'Too many requests; try again shortly.');
        const node: Node = {
          nodeId: id(8000 + (serial += 1)),
          title: 'What if the Moon were twice its current size?',
          startedBy: who,
          createdAt: new Date().toISOString(),
          status: 'preparing',
          revision: 1,
          answer: { status: 'making' },
        };
        nodes.push(node);
        return { json: { ...receipt('scenario.choose'), node: card(node), reused: false } };
      }
      case '/v1/social/scenarios/remove': {
        const node = nodes.find((candidate) => candidate.nodeId === body['nodeId']);
        if (node === undefined || node.startedBy !== who) return problem(409, 'SHARING_UNAVAILABLE', 'Unavailable.');
        node.status = 'removed';
        node.revision += 1;
        node.answer = undefined;
        return { json: { ...receipt('scenario.remove'), nodeId: node.nodeId, revision: node.revision } };
      }
      default:
        return { status: 404, json: {} };
    }
  }

  return {
    ...party,
    nodes,
    requests,
    /** A branch the thread made earlier today, for the cap: ready, with its answer. */
    seedToday(count: number) {
      for (let index = 0; index < count; index += 1)
        nodes.push({
          nodeId: id(9000 + (serial += 1)),
          title: `What if the Moon were ${['half', 'three times', 'four times', 'five times'][index] ?? 'much'} its size?`,
          startedBy: 'ravi',
          createdAt: new Date().toISOString(),
          status: 'ready',
          revision: 2,
          answer: { status: 'ready', readyAt: new Date().toISOString(), ...FIXTURE_ANSWER },
        });
    },
    /** The writer finished: the answer is what the card shows, and the full Scroll is still being made. */
    finishAnswer(nodeId: string, patch: Partial<Extract<Answer, { status: 'ready' }>> = {}) {
      const node = nodes.find((candidate) => candidate.nodeId === nodeId);
      if (node?.answer?.status !== 'making') throw new Error('no answer is being made');
      node.answer = { status: 'ready', readyAt: new Date().toISOString(), ...FIXTURE_ANSWER, ...patch };
    },
    /** The writer gave up: there will be no short answer. */
    endAnswer(nodeId: string) {
      const node = nodes.find((candidate) => candidate.nodeId === nodeId);
      if (node !== undefined) node.answer = { status: 'unavailable' };
    },
    /** The full Scroll is admitted: Open appears. */
    bindScroll(nodeId: string) {
      const node = nodes.find((candidate) => candidate.nodeId === nodeId);
      if (node !== undefined) node.status = 'ready';
    },
    handler(who: Who) {
      const answer = party.handler(who);
      return (path: string, body: Record<string, unknown>) => {
        requests.push({ who, path, body });
        return path.startsWith('/v1/social/scenarios/') ? scenarioRoute(who, path, body) : answer(path, body);
      };
    },
  };
}

export type WhatIfWorld = ReturnType<typeof whatIfWorld>;
