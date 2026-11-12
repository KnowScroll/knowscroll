import { describe, expect, it } from 'vitest';
import { releaseQueues } from '@knowscroll/backend/job-queues';
import { growTopicsQueue } from '@knowscroll/backend/modules/content';
import { briefGapQueue, scanGapsQueue } from '@knowscroll/backend/modules/supply';
import { proposeTopicCommand, topicCandidatesCommand, topicDecisionCommand } from './topic-operator.js';
import { topicGrowthRuns } from './topic-growth-jobs.js';

describe('the topic growth job', () => {
  it('is a declared release queue that runs on a schedule with a payload of its version only', () => {
    expect(releaseQueues.find((queue) => queue.name === growTopicsQueue.name)?.schedule).toEqual({
      cron: '24,54 * * * *',
      payload: { v: 1 },
    });
    // It names no person, no page and no candidate: it finds its own work.
    expect(growTopicsQueue.payload.safeParse({ v: 1 }).success).toBe(true);
    expect(growTopicsQueue.payload.safeParse({ v: 1, page: 'https://en.wikipedia.org/wiki/Tide' }).success).toBe(false);
    expect(growTopicsQueue.payload.safeParse({ v: 1, universeId: 'x' }).success).toBe(false);
  });

  it('is scheduled apart from the gap loop’s jobs, and gives a pass a claim that covers its reads and its one proposal', () => {
    for (const other of [scanGapsQueue, briefGapQueue])
      expect(releaseQueues.find((queue) => queue.name === other.name)?.schedule).not.toEqual(growTopicsQueue.schedule);
    // Seven research reads at their worst, and one request and one repair at the largest provider deadline.
    expect(growTopicsQueue.policy.expireInSeconds).toBeGreaterThan(7 * 100 + 2 * 300);
    expect(growTopicsQueue.policy.deadLetter).toBe(true);
    expect(growTopicsQueue.name).toBe('content.grow-topics');
  });
});

describe('what switches topic growth on', () => {
  const config = (supply: boolean, topic: boolean, production: boolean) => ({
    supplyGrowthEnabled: supply,
    topicGrowthEnabled: topic,
    reasoning: { productionEnabled: production },
  });
  it('needs the gap loop’s switch, its own and the production grant: any one off and it does nothing', () => {
    for (const supply of [false, true])
      for (const topic of [false, true])
        for (const production of [false, true])
          expect(
            topicGrowthRuns(config(supply, topic, production)),
            `${String(supply)} ${String(topic)} ${String(production)}`,
          ).toBe(supply && topic && production);
  });
});

describe('the operator’s topic commands', () => {
  it('refuse before they open a database: a page that is no https address, or none', async () => {
    for (const page of [
      undefined,
      '',
      'en.wikipedia.org/wiki/Tide',
      'http://en.wikipedia.org/wiki/Tide',
      'file:///etc/passwd',
    ]) {
      const printed: Record<string, unknown>[] = [];
      const code = await proposeTopicCommand(
        { page, dryRun: true, dispatchedBy: 'cli:test' },
        (result) => printed.push(result),
        () => undefined,
      );
      expect(code, String(page)).toBe(2);
      expect(printed).toEqual([
        { result: 'usage', usage: 'content propose-topic --page <https address of a candidate page> [--dry-run]' },
      ]);
    }
  });

  it('list only a status a candidate can have, and refuse the rest before they open a database', async () => {
    const printed: Record<string, unknown>[] = [];
    const code = await topicCandidatesCommand(
      { status: 'finished' },
      (result) => printed.push(result),
      () => undefined,
    );
    expect(code).toBe(2);
    expect(printed).toEqual([
      {
        result: 'usage',
        usage:
          'content topic-candidates [--status pending|eligible|rejected|proposed|refused|admitted|blocked_unknown]',
      },
    ]);
  });
});

describe('the owner’s decision on a topic that grew', () => {
  const usage = 'content topic approve --topic <topic id> | content topic reject --topic <topic id>';
  it('needs approve or reject and a topic id, and refuses anything else before it opens a database', async () => {
    const cases: readonly [string | undefined, string | undefined][] = [
      [undefined, 'earth.orrin-seas'],
      ['maybe', 'earth.orrin-seas'],
      ['approve', undefined],
      ['approve', ''],
      ['approve', 'Earth.Orrin Seas'],
      ['reject', 'earth'],
      ['reject', "earth.x'; drop table content.topic_candidates; --"],
    ];
    for (const [decision, topic] of cases) {
      const printed: Record<string, unknown>[] = [];
      const code = await topicDecisionCommand(
        { decision, topic, decidedBy: 'cli:test' },
        (result) => printed.push(result),
        () => undefined,
      );
      expect(code, `${String(decision)} ${String(topic)}`).toBe(2);
      expect(printed).toEqual([{ result: 'usage', usage }]);
    }
  });
});
