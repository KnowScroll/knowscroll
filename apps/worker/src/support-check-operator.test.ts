import { describe, expect, it } from 'vitest';
import { supportCheckReplayCommand, type SupportCheckReplayOptions } from './support-check-operator.js';

/**
 * The options of `content support-check-replay` are checked before anything else is touched: no configuration is read, no database is
 * opened and no model is called for a command that gives no cap, a bad cap, a bad limit or a bad date. A replay is paid for, so the cap is required.
 */
describe('content support-check-replay refuses what it cannot run, before touching anything', () => {
  const options = (over: Partial<SupportCheckReplayOptions>): SupportCheckReplayOptions => ({
    since: undefined,
    limit: undefined,
    maxRequests: '60',
    dispatchedBy: 'cli:ci',
    ...over,
  });
  async function run(over: Partial<SupportCheckReplayOptions>) {
    const printed: Record<string, unknown>[] = [];
    const code = await supportCheckReplayCommand(
      options(over),
      (line) => void printed.push(line),
      () => {
        throw new Error('CI: a refused command must not log or touch anything');
      },
    );
    return { code, printed };
  }

  it.each([
    ['no cap on spend', { maxRequests: undefined }],
    ['a cap that is not a whole number', { maxRequests: '6.5' }],
    ['a negative cap', { maxRequests: '-1' }],
    ['a cap above the most a replay may spend', { maxRequests: '1001' }],
    ['a limit of zero', { limit: '0' }],
    ['a limit above the most a replay reads', { limit: '501' }],
    ['a limit that is not a number', { limit: 'all' }],
    ['a date that is not an ISO date', { since: 'last week' }],
    ['an impossible date', { since: '2026-13-45' }],
  ] as const)('prints the usage and exits 2 for %s', async (_name, over) => {
    const { code, printed } = await run(over);
    expect(code).toBe(2);
    expect(printed).toEqual([
      {
        result: 'usage',
        usage: 'content support-check-replay [--since <ISO date>] [--limit <1-500>] --max-requests <0-1000>',
      },
    ]);
  });
});
