import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, type Database, type DatabaseHandle } from '@knowscroll/backend/infrastructure/postgres';
import { createEmptyDatabase } from '../support/empty-database.js';
import { releaseDirectory, startReleaseProcess } from '../support/processes.js';

/**
 * The release policy's commands from the built worker tree (#674, D-418), as an operator runs them on a server: what they refuse before they touch
 * anything, a sensitive topic, an approval and its revocation, and the counts the status prints, with the policy's switch off as it is in every world.
 */
describe('the release policy commands from the built release', () => {
  let database: Awaited<ReturnType<typeof createEmptyDatabase>>;
  let handle: DatabaseHandle<Database>;
  const operatorName = 'ci-reviewer';

  beforeAll(async () => {
    database = await createEmptyDatabase('release_policy');
    expect(await startReleaseProcess('api', 'migrate', { DATABASE_URL: database.url, KS_WORLD: 'ci' }).exited()).toBe(
      0,
    );
    handle = createDatabase<Database>(
      { url: database.url, applicationName: 'policy-fixture', poolMax: 2, statementTimeoutMs: 10_000 },
      { onIdleClientError: () => undefined },
    );
  });
  afterAll(async () => {
    await handle.close();
    await database.drop();
  });

  async function operator(args: readonly string[], env: Record<string, string> = {}, world = 'ci') {
    const child = spawn(process.execPath, [join('dist', 'operator.js'), 'content', 'policy', ...args], {
      cwd: join(releaseDirectory(), 'worker'),
      env: {
        PATH: process.env['PATH'] ?? '',
        KS_WORLD: world,
        DATABASE_URL: database.url,
        SUDO_USER: operatorName,
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    const code = await new Promise<number | null>((resolve) => child.once('exit', resolve));
    return { code, stdout, stderr };
  }
  /** The diagnostic records on stderr (one JSON object a line). */
  const records = (stderr: string) =>
    stderr
      .split('\n')
      .filter((line) => line.startsWith('{'))
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  const lastLine = (stdout: string) => JSON.parse(stdout.trim().split('\n').at(-1) ?? '') as Record<string, unknown>;
  const approvals = () =>
    handle.db
      .selectFrom('content.release_topic_approvals')
      .select(['topic_id', 'approved_by', 'revoked_by', 'revoked_for'])
      .orderBy('approved_at')
      .execute();

  it('refuses a call it cannot act on with exit status 2 and writes nothing', async () => {
    for (const args of [
      ['approve-topic'],
      ['approve-topic', '--topic', 'Earth Seasons'],
      ['revoke-topic'],
      ['withdraw', '--asset', 'not-a-uuid', '--revision', '1'],
      ['withdraw', '--asset', '8a7d48fe-0397-4e00-91a8-b4700630880f'],
    ]) {
      const refused = await operator(args);
      expect(refused.code, args.join(' ')).toBe(2);
      expect(lastLine(refused.stdout)).toMatchObject({ result: 'usage' });
    }
    expect(await approvals()).toEqual([]);
  });

  it('does not run in a world that is not an operator world', async () => {
    const refused = await operator(['approve-topic', '--topic', 'earth.seasons'], {}, 'live');
    expect(refused.code).toBe(1);
    expect(await approvals()).toEqual([]);
  });

  it('refuses a sensitive topic and one the catalogue does not hold as a topic, with the reason and no approval', async () => {
    const sensitive = await operator(['approve-topic', '--topic', 'human-body.immune-system']);
    expect(sensitive.code).toBe(2);
    expect(lastLine(sensitive.stdout)).toMatchObject({
      command: 'content policy approve-topic',
      result: 'refused',
      reason: 'sensitive_topic',
      categories: ['medicine', 'health'],
    });
    expect(records(sensitive.stderr)).toContainEqual(
      expect.objectContaining({
        event: 'content.release_policy_changed',
        level: 'warn',
        outcome: 'refused',
        reasonCode: 'sensitive_topic',
      }),
    );
    for (const topic of ['earth', 'earth.seasons.axial-tilt', 'astrology.signs']) {
      const unknown = await operator(['approve-topic', '--topic', topic]);
      expect(unknown.code, topic).toBe(2);
      expect(lastLine(unknown.stdout)).toMatchObject({ result: 'refused', reason: 'unknown_topic' });
    }
    expect(await approvals()).toEqual([]);
  });

  it('approves a topic once, records who, and answers a repeat without changing anything', async () => {
    const approved = await operator(['approve-topic', '--topic', 'earth.seasons']);
    expect(approved.code).toBe(0);
    expect(lastLine(approved.stdout)).toMatchObject({
      command: 'content policy approve-topic',
      result: 'approved',
      topicId: 'earth.seasons',
    });
    expect(records(approved.stderr)).toContainEqual(
      expect.objectContaining({
        event: 'content.release_policy_changed',
        level: 'info',
        context: 'earth.seasons',
        outcome: 'approved',
      }),
    );
    expect(await approvals()).toEqual([
      { topic_id: 'earth.seasons', approved_by: `cli:${operatorName}`, revoked_by: null, revoked_for: null },
    ]);
    const again = await operator(['approve-topic', '--topic', 'earth.seasons']);
    expect(again.code).toBe(0);
    expect(lastLine(again.stdout)).toMatchObject({ result: 'already_approved' });
    expect(await approvals()).toHaveLength(1);
  });

  it('prints counts only, and the switch and the cap as the shell’s environment says them: off unless the owner sets it', async () => {
    const off = await operator(['status']);
    expect(off.code).toBe(0);
    expect(lastLine(off.stdout)).toMatchObject({
      command: 'content policy status',
      policy: 'approved-topic-supported.v1',
      autoRelease: { enabled: false, dailyCap: 5 },
      counts: { approvedTopics: 1, revokedApprovals: 0, held: 0, releasedByPolicy: 0, releasedToday: 0, raises: 0 },
      held: { evaluated: 0, wouldRelease: 0, byReason: {} },
    });
    expect(off.stdout).not.toContain('earth.seasons');
    const on = await operator(['status'], {
      KS_CONTENT_AUTO_RELEASE_ENABLED: '1',
      KS_CONTENT_AUTO_RELEASE_DAILY_CAP: '3',
    });
    expect(lastLine(on.stdout)).toMatchObject({ autoRelease: { enabled: true, dailyCap: 3 } });
    // A switch that is not exactly 0 or 1 is refused, so it cannot be read as on by accident.
    const bad = await operator(['status'], { KS_CONTENT_AUTO_RELEASE_ENABLED: 'true' });
    expect(bad.code).toBe(1);
  });

  it('revokes the approval, keeps the row, and answers a repeat and a topic never approved', async () => {
    const revoked = await operator(['revoke-topic', '--topic', 'earth.seasons']);
    expect(revoked.code).toBe(0);
    expect(lastLine(revoked.stdout)).toMatchObject({ result: 'revoked', topicId: 'earth.seasons' });
    expect(await approvals()).toEqual([
      {
        topic_id: 'earth.seasons',
        approved_by: `cli:${operatorName}`,
        revoked_by: `cli:${operatorName}`,
        revoked_for: 'operator',
      },
    ]);
    const again = await operator(['revoke-topic', '--topic', 'earth.seasons']);
    expect(again.code).toBe(0);
    expect(lastLine(again.stdout)).toMatchObject({ result: 'already_revoked' });
    const never = await operator(['revoke-topic', '--topic', 'space.stars']);
    expect(never.code).toBe(2);
    expect(lastLine(never.stdout)).toMatchObject({ result: 'refused', reason: 'never_approved' });
  });

  it('refuses to withdraw a Scroll that does not exist', async () => {
    const missing = await operator(['withdraw', '--asset', '8a7d48fe-0397-4e00-91a8-b4700630880f', '--revision', '1']);
    expect(missing.code).toBe(2);
    expect(lastLine(missing.stdout)).toMatchObject({
      command: 'content policy withdraw',
      result: 'refused',
      reason: 'not_found',
    });
  });
});
