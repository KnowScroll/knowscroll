import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, type Database, type DatabaseHandle } from '@knowscroll/backend/infrastructure/postgres';
import {
  fixtureAuthoredV2,
  fixtureResearchPageV2,
} from '../../../packages/backend/src/modules/content/production/spike-v2/writer-v2.fixture.js';
import { TOPICS } from '../../../packages/backend/src/modules/content/production/topics.js';
import { createEmptyDatabase } from '../support/empty-database.js';
import { signal } from '../support/fixture-model.js';
import { answerWith, enableProductionScope, fixtureProduction } from '../support/generated-scroll.js';
import { releaseDirectory, startReleaseProcess } from '../support/processes.js';

/**
 * The review gate's commands from the built worker tree (D-138), as an operator runs them on a server:
 * list what is held, read it, decide, and what each command refuses. The held Scroll is the labelled
 * Orrin fixture produced through the real production job; no provider is called.
 */
describe('the review gate commands from the built release', () => {
  let database: Awaited<ReturnType<typeof createEmptyDatabase>>;
  let handle: DatabaseHandle<Database>;
  const recipe = TOPICS['seasons-hemispheres'];
  const operatorName = 'ci-reviewer';
  let firstStopText = '';

  beforeAll(async () => {
    database = await createEmptyDatabase('release_review');
    expect(await startReleaseProcess('api', 'migrate', { DATABASE_URL: database.url, KS_WORLD: 'ci' }).exited()).toBe(
      0,
    );
    handle = createDatabase<Database>(
      { url: database.url, applicationName: 'review-fixture', poolMax: 2, statementTimeoutMs: 10_000 },
      { onIdleClientError: () => undefined },
    );
    await enableProductionScope(handle.db);
    const produced = await fixtureProduction(
      handle.db,
      () => answerWith(fixtureAuthoredV2()),
      () => fixtureResearchPageV2,
    ).produce('seasons-hemispheres', false, signal());
    expect(produced).toMatchObject({ outcome: 'published', held: true, assetId: recipe.assetId, revision: 1 });
    const stored = await handle.db
      .selectFrom('content.asset_revisions')
      .select('document')
      .where('asset_id', '=', recipe.assetId)
      .executeTakeFirstOrThrow();
    firstStopText = (stored.document as { stops: { blocks: { text: string }[] }[] }).stops[0]!.blocks[0]!.text;
  });
  afterAll(async () => {
    await handle.close();
    await database.drop();
  });

  async function operator(args: readonly string[], world = 'ci') {
    const child = spawn(process.execPath, [join('dist', 'operator.js'), 'content', ...args], {
      cwd: join(releaseDirectory(), 'worker'),
      env: { PATH: process.env['PATH'] ?? '', KS_WORLD: world, DATABASE_URL: database.url, SUDO_USER: operatorName },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    const code = await new Promise<number | null>((resolve) => child.once('exit', resolve));
    return { code, stdout, stderr };
  }
  const lastLine = (stdout: string) => JSON.parse(stdout.trim().split('\n').at(-1) ?? '') as Record<string, unknown>;

  it('lists the held Scroll with its counts and none of its text', async () => {
    const listed = await operator(['review-list']);
    expect(listed.code).toBe(0);
    expect(lastLine(listed.stdout)).toMatchObject({
      command: 'content review-list',
      count: 1,
      revisions: [
        { assetId: recipe.assetId, recipe: 'seasons-hemispheres', revision: 1, state: 'held', coverage: 'mapped' },
      ],
    });
    expect(listed.stdout).not.toContain(firstStopText.slice(0, 40));
  });

  it('prints the Scroll to read, with the passages it cites on request, and logs none of it', async () => {
    const shown = await operator(['review-show', '--asset', recipe.assetId, '--sources']);
    expect(shown.code).toBe(0);
    expect(shown.stdout).toContain(firstStopText);
    expect(shown.stdout).toContain('source passage:');
    expect(shown.stdout.split('\n')[0]).toContain('seasons-hemispheres');
    expect(shown.stderr).not.toContain(firstStopText.slice(0, 40));
  });

  it('refuses a call it cannot act on with exit status 2 and writes nothing', async () => {
    for (const args of [
      ['review-show'],
      ['review-show', '--asset', 'not-a-uuid'],
      ['release', '--asset', recipe.assetId],
      ['release', '--asset', recipe.assetId, '--revision', '0'],
      ['release', '--asset', recipe.assetId, '--revision', '9'],
      ['reject', '--asset', recipe.assetId, '--revision', '1'],
      ['reject', '--asset', recipe.assetId, '--revision', '1', '--reason', '   '],
    ]) {
      const refused = await operator(args);
      expect(refused.code, args.join(' ')).toBe(2);
    }
    expect(
      await handle.db
        .selectFrom('content.revision_reviews')
        .select('state')
        .where('asset_id', '=', recipe.assetId)
        .execute(),
    ).toEqual([{ state: 'held' }]);
  });

  it('does not run in a world that is not an operator world', async () => {
    const refused = await operator(['release', '--asset', recipe.assetId, '--revision', '1'], 'live');
    expect(refused.code).toBe(1);
    expect(
      await handle.db
        .selectFrom('content.revision_reviews')
        .select('state')
        .where('asset_id', '=', recipe.assetId)
        .execute(),
    ).toEqual([{ state: 'held' }]);
  });

  it('releases the revision once, records who, and answers a repeat without changing anything', async () => {
    const released = await operator(['release', '--asset', recipe.assetId, '--revision', '1']);
    expect(released.code).toBe(0);
    expect(lastLine(released.stdout)).toMatchObject({ command: 'content release', result: 'released', revision: 1 });
    const row = await handle.db
      .selectFrom('content.revision_reviews')
      .select(['state', 'decided_by', 'decided_at'])
      .where('asset_id', '=', recipe.assetId)
      .executeTakeFirstOrThrow();
    expect(row).toMatchObject({ state: 'released', decided_by: `cli:${operatorName}` });

    const again = await operator(['release', '--asset', recipe.assetId, '--revision', '1']);
    expect(again.code).toBe(0);
    expect(lastLine(again.stdout)).toMatchObject({ result: 'already_released' });
    expect(
      await handle.db
        .selectFrom('content.revision_reviews')
        .select('decided_at')
        .where('asset_id', '=', recipe.assetId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ decided_at: row.decided_at });

    const late = await operator(['reject', '--asset', recipe.assetId, '--revision', '1', '--reason', 'too late']);
    expect(late.code).toBe(2);
    expect(lastLine(late.stdout)).toMatchObject({ result: 'refused', reason: 'revision_released' });
    const audit = await operator(['review-list', '--all']);
    expect(lastLine(audit.stdout)).toMatchObject({
      count: 1,
      revisions: [{ state: 'released', decidedBy: `cli:${operatorName}` }],
    });
  });
});
