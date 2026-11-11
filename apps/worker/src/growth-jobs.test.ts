import { describe, expect, it } from 'vitest';
import { releaseQueues } from '@knowscroll/backend/job-queues';
import { briefGapQueue, scanGapsQueue } from '@knowscroll/backend/modules/supply';
import { settleGapCommand, supplyGapsCommand } from './supply-operator.js';

describe('the gap loop’s two scheduled jobs', () => {
  it('are declared release queues that run on a schedule with a payload of their version only', () => {
    expect(releaseQueues.find((queue) => queue.name === scanGapsQueue.name)?.schedule).toEqual({
      cron: '3,18,33,48 * * * *',
      payload: { v: 1 },
    });
    expect(releaseQueues.find((queue) => queue.name === briefGapQueue.name)?.schedule).toEqual({
      cron: '9,39 * * * *',
      payload: { v: 1 },
    });
    // They name no person, no planet and no gap: each finds its own work.
    for (const queue of [scanGapsQueue, briefGapQueue]) {
      expect(queue.payload.safeParse({ v: 1 }).success).toBe(true);
      expect(queue.payload.safeParse({ v: 1, planet: 'earth.tides' }).success).toBe(false);
      expect(queue.payload.safeParse({ v: 1, universeId: 'x' }).success).toBe(false);
    }
  });

  it('give the brief pass a claim that covers every proposing attempt of a pass at the largest provider deadline', () => {
    // Three gaps, each one request and one repair at 300 s plus the waits around them: far longer than the scan's five minutes.
    expect(briefGapQueue.policy.expireInSeconds).toBeGreaterThan(3 * 2 * 300);
    expect(scanGapsQueue.policy.expireInSeconds).toBe(300);
    expect(briefGapQueue.policy.deadLetter).toBe(true);
  });
});

describe('the operator’s list of the gaps', () => {
  it('accepts only a status a gap can have, and refuses the rest before it opens a database', async () => {
    const printed: Record<string, unknown>[] = [];
    const code = await supplyGapsCommand(
      { status: 'finished' },
      (result) => printed.push(result),
      () => undefined,
    );
    expect(code).toBe(2);
    expect(printed).toEqual([
      {
        result: 'usage',
        usage: 'supply gaps [--status open|briefed|commissioned|closed|rejected|blocked_unknown]',
      },
    ]);
  });
});

describe('settling a blocked gap', () => {
  const usage = 'supply gaps settle --key <64 hex characters> [--reopen | --close]';
  const settle = async (options: { key: string | undefined; reopen: boolean; close: boolean }) => {
    const printed: Record<string, unknown>[] = [];
    const code = await settleGapCommand(
      options,
      (result) => printed.push(result),
      () => undefined,
    );
    return { code, printed };
  };

  it('needs a key of 64 hex characters, and one action at most, and refuses before it opens a database', async () => {
    for (const key of [undefined, '', 'abc', 'g'.repeat(64), 'A'.repeat(64)])
      expect(await settle({ key, reopen: false, close: false }), String(key)).toEqual({
        code: 2,
        printed: [{ result: 'usage', usage }],
      });
    const both = await settle({ key: 'a'.repeat(64), reopen: true, close: true });
    expect(both).toEqual({ code: 2, printed: [{ result: 'usage', usage }] });
  });
});
