import { describe, expect, it } from 'vitest';
import { catalogueCommand } from './catalogue-operator.js';

/** The arguments the catalogue command refuses before it opens a database. */
describe('the catalogue operator command refuses bad usage first', () => {
  it('knows `sync` and `status` and nothing else', async () => {
    for (const subcommand of [undefined, '', 'import', 'SYNC', 'retire']) {
      const printed: Record<string, unknown>[] = [];
      const code = await catalogueCommand(
        { subcommand, dryRun: false },
        (result) => printed.push(result),
        () => undefined,
      );
      expect(code).toBe(2);
      expect(printed).toEqual([
        { result: 'usage', usage: 'content catalogue sync [--dry-run] | content catalogue status' },
      ]);
    }
  });
});
