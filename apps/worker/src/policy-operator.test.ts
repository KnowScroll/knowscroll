import { describe, expect, it } from 'vitest';
import { approveTopicCommand, revokeTopicCommand, withdrawCommand } from './policy-operator.js';

/**
 * The options of `content policy` commands are checked before anything else is touched: no configuration is read, no database is opened
 * and nothing is logged for a command that names no topic, a topic that is not an id, a bad asset or a bad revision.
 */
describe('content policy commands refuse what they cannot run, before touching anything', () => {
  async function run(command: () => Promise<number>, printed: Record<string, unknown>[]) {
    return { code: await command(), printed };
  }
  const refuse = () => {
    throw new Error('CI: a refused command must not log or touch anything');
  };

  it.each([
    ['no topic', undefined],
    ['a topic that is not an id', 'Earth Seasons'],
    ['a topic with a slash', 'earth/seasons'],
    ['an empty topic', ''],
  ] as const)('approve-topic and revoke-topic print the usage and exit 2 for %s', async (_name, topic) => {
    const approved: Record<string, unknown>[] = [];
    const revoked: Record<string, unknown>[] = [];
    const approve = await run(
      () =>
        approveTopicCommand(
          { ...(topic === undefined ? {} : { topic }), decidedBy: 'cli:ci' },
          (line) => void approved.push(line),
          refuse,
        ),
      approved,
    );
    const revoke = await run(
      () =>
        revokeTopicCommand(
          { ...(topic === undefined ? {} : { topic }), decidedBy: 'cli:ci' },
          (line) => void revoked.push(line),
          refuse,
        ),
      revoked,
    );
    expect(approve.code).toBe(2);
    expect(approve.printed).toEqual([
      { result: 'usage', usage: 'content policy approve-topic --topic <catalogue topic id>' },
    ]);
    expect(revoke.code).toBe(2);
    expect(revoke.printed).toEqual([{ result: 'usage', usage: 'content policy revoke-topic --topic <topic id>' }]);
  });

  it.each([
    ['no asset', { revision: '1' }],
    ['an asset that is not a uuid', { asset: 'seasons', revision: '1' }],
    ['no revision', { asset: '8a7d48fe-0397-4e00-91a8-b4700630880f' }],
    ['a revision of zero', { asset: '8a7d48fe-0397-4e00-91a8-b4700630880f', revision: '0' }],
    ['a revision that is not a whole number', { asset: '8a7d48fe-0397-4e00-91a8-b4700630880f', revision: '1.5' }],
  ] as const)('withdraw prints the usage and exits 2 for %s', async (_name, options) => {
    const printed: Record<string, unknown>[] = [];
    const code = await withdrawCommand({ ...options, decidedBy: 'cli:ci' }, (line) => void printed.push(line), refuse);
    expect(code).toBe(2);
    expect(printed).toEqual([{ result: 'usage', usage: 'content policy withdraw --asset <uuid> --revision <n>' }]);
  });
});
