import { describe, expect, it } from 'vitest';
import { proposeRecipesCommand, recipesCommand } from './recipes-operator.js';

const run = async <T>(call: (print: (result: Record<string, unknown>) => void) => Promise<T>) => {
  const printed: Record<string, unknown>[] = [];
  const code = await call((result) => printed.push(result));
  return { code, printed };
};

/** The arguments the recipe commands refuse before they open a database or call a provider. */
describe('the recipe operator commands refuse bad usage first', () => {
  it('propose-recipes needs a planet', async () => {
    for (const topic of [undefined, '']) {
      const { code, printed } = await run((print) =>
        proposeRecipesCommand(
          { topic, facet: undefined, dryRun: true, dispatchedBy: 'cli:ci' },
          print,
          () => undefined,
        ),
      );
      expect(code).toBe(2);
      expect(printed).toEqual([
        {
          result: 'usage',
          usage: 'content propose-recipes --topic <planet id> [--facet <facet id>] [--retry <1-2>] [--dry-run]',
        },
      ]);
    }
  });

  it('propose-recipes refuses an empty facet rather than treat it as none', async () => {
    const { code, printed } = await run((print) =>
      proposeRecipesCommand(
        { topic: 'earth.tides', facet: '', dryRun: true, dispatchedBy: 'cli:ci' },
        print,
        () => undefined,
      ),
    );
    expect(code).toBe(2);
    expect(printed[0]).toMatchObject({ result: 'usage' });
  });

  it('propose-recipes accepts a retry of 0 to 2 and nothing else', async () => {
    for (const retry of ['3', '-1', '1.5', 'x']) {
      const { code, printed } = await run((print) =>
        proposeRecipesCommand(
          { topic: 'earth.tides', facet: undefined, retry, dryRun: true, dispatchedBy: 'cli:ci' },
          print,
          () => undefined,
        ),
      );
      expect(code, retry).toBe(2);
      expect(printed[0], retry).toMatchObject({ result: 'usage' });
    }
  });

  it('recipes accepts only the four statuses', async () => {
    const { code, printed } = await run((print) => recipesCommand({ status: 'published' }, print, () => undefined));
    expect(code).toBe(2);
    expect(printed).toEqual([{ result: 'usage', usage: 'content recipes [--status checked|queued|produced|retired]' }]);
  });
});
