import { describe, expect, it } from 'vitest';
import { CLEANUP_WORLDS } from './old-scroll-cleanup.js';
import { CLEANUP_USAGE, cleanupOldScrollsCommand } from './old-scroll-cleanup-operator.js';

/** What the cleanup command refuses before it reads the database settings or opens a connection. */
async function run(argv: readonly string[], env: NodeJS.ProcessEnv) {
  const printed: Record<string, unknown>[] = [];
  const code = await cleanupOldScrollsCommand(
    argv,
    (result) => printed.push(result),
    () => undefined,
    env,
  );
  return { code, printed };
}

describe('the cleanup operator command refuses first', () => {
  const base = ['content', 'cleanup-old-scrolls'];

  it('needs exactly one of --dry-run and --run, and nothing it does not know', async () => {
    for (const argv of [
      base,
      [...base, '--dry-run', '--run'],
      [...base, '--force'],
      ['content', 'other', '--run'],
      [...base, 'extra', '--run'],
    ]) {
      expect(await run(argv, { KS_WORLD: 'dev' })).toEqual({
        code: 2,
        printed: [{ result: 'usage', usage: CLEANUP_USAGE }],
      });
    }
  });

  it('runs only in local, ci and dev', () => {
    expect(CLEANUP_WORLDS).toEqual(['local', 'ci', 'dev']);
  });

  it('refuses every other world, and a missing one, with a code and no database', async () => {
    for (const world of ['stage', 'production', 'live', 'prod', 'DEV', '']) {
      for (const flag of ['--dry-run', '--run']) {
        // The database URL names nothing that exists: a refusal never reaches it.
        const { code, printed } = await run([...base, flag], {
          KS_WORLD: world,
          DATABASE_URL: 'postgres://nobody@127.0.0.1:1/none',
        });
        expect(code).toBe(2);
        expect(printed).toEqual([
          {
            command: 'content cleanup-old-scrolls',
            mode: flag === '--run' ? 'run' : 'dry_run',
            world,
            result: 'refused',
            code: 'world_not_allowed',
          },
        ]);
      }
    }
    expect((await run([...base, '--run'], {})).printed).toMatchObject([
      { result: 'refused', code: 'world_not_allowed' },
    ]);
  });
});
