import { describe, expect, it } from 'vitest';
import { askCheckCommand, type AskCheckOptions } from './ask-check-operator.js';

/**
 * The options of `content ask-check` are checked before anything else is touched: no configuration is read, no database
 * is opened and no model is called for a command that names no answers, names them twice or names them badly.
 */
describe('content ask-check refuses what it cannot run, before touching anything', () => {
  const ASSET = '5d7a1a3e-52e5-4a4a-9a45-0b6bf6b3a222';
  const options = (over: Partial<AskCheckOptions>): AskCheckOptions => ({
    asset: undefined,
    recent: undefined,
    out: '/var/tmp/ks-ask-check.jsonl',
    dispatchedBy: 'cli:ci',
    ...over,
  });
  async function run(over: Partial<AskCheckOptions>) {
    const printed: Record<string, unknown>[] = [];
    const code = await askCheckCommand(
      options(over),
      (line) => void printed.push(line),
      () => {
        throw new Error('CI: a refused command must not log or touch anything');
      },
    );
    return { code, printed };
  }

  it.each([
    ['names no answers', {}],
    ['names answers twice', { asset: ASSET, recent: '3' }],
    ['names an asset that is not an ID', { asset: 'not-an-id' }],
    ['names one good ID and one bad', { asset: `${ASSET},12345` }],
    ['names more than twenty answers', { asset: Array.from({ length: 21 }, () => ASSET).join(',') }],
    ['asks for none of the newest', { recent: '0' }],
    ['asks for more than twenty of the newest', { recent: '21' }],
    ['asks for a fraction of the newest', { recent: '2.5' }],
    ['has no file for the detail', { asset: ASSET, out: undefined }],
  ])('refuses a command that %s with the usage line and exit status 2', async (_name, over) => {
    const { code, printed } = await run(over);
    expect(code).toBe(2);
    expect(printed).toEqual([
      expect.objectContaining({ result: 'usage', usage: expect.stringContaining('content ask-check') }),
    ]);
  });
});
