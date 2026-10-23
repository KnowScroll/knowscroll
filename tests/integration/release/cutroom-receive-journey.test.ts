/** Actions-only installed normal worker/API and TWO disposable worlds. Synthetic labelled media,
 * real isolated origin settlement, target has no pool/provider/Cutroom dependency. */
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { sql } from 'kysely';
import { describe, expect, it } from 'vitest';
import { scopeClaimOf, type KeepEntryRef } from '@knowscroll/contracts';
import { createDatabase, type Database } from '@knowscroll/backend/infrastructure/postgres';
import type { CommissionReceivePayload } from '@knowscroll/backend/modules/content';
import { createEmptyDatabase } from '../support/empty-database.js';
import { TEST_DATABASE_PREFIX } from '../support/admin.js';
import { receiveFixture, type ReceivingFixture } from '../support/commission-receive-fixture.js';
import { seedPerson } from '../support/fixtures.js';
import { seedKeepSessions } from '../support/keep-fixture.js';
import { apiClient } from '../support/api-client.js';
import { textCapabilities } from '../support/scroll.js';
import {
  releaseDirectory,
  startReleaseProcess,
  freePort,
  waitForHttp,
  type ReleaseProcess,
} from '../support/processes.js';
const execute = promisify(execFile);
async function installedWorld(label: string) {
  const empty = await createEmptyDatabase(`receive_${label}`);
  expect(await startReleaseProcess('api', 'migrate', { DATABASE_URL: empty.url, KS_WORLD: 'ci' }).exited()).toBe(0);
  const settings = {
    url: empty.url,
    applicationName: `fixture-receive-${label}`,
    poolMax: 5,
    statementTimeoutMs: 20000,
  };
  const handle = createDatabase<Database>(settings, { onIdleClientError: () => undefined });
  return {
    ...handle,
    name: empty.name,
    settings,
    drop: async () => {
      await handle.close();
      await empty.drop();
    },
  };
}
describe('CF62 receiving through installed normal processes', () => {
  it('receives exact origin public bytes at0c, restarts/replays, opens normal exposure/media and exact fractional Keep place in BOTH source kinds', async () => {
    let f: ReceivingFixture | undefined, worker: ReleaseProcess | undefined;
    const apis: ReleaseProcess[] = [],
      outputs: string[] = [],
      directory = `/etc/knowscroll/receive-ci-${randomUUID()}`,
      packetPath = directory + '/approved.json';
    try {
      const origin = await installedWorld('origin'),
        target = await installedWorld('target');
      f = await receiveFixture('installed', {
        originWorld: origin,
        targetWorld: target,
        runPrefix: TEST_DATABASE_PREFIX,
      });
      expect(f.envelope).toBeDefined();
      const envelope = f.envelope!,
        p = JSON.parse(envelope.payloadUtf8) as CommissionReceivePayload;
      const binding = f.bind(envelope);
      await f.transfer(envelope);
      const setup = {
        version: 'cutroom-receiving-setup.v1',
        worldId: 'stage',
        generation: 1,
        bindings: [binding],
        envelope,
      };
      await execute('sudo', ['install', '-d', '-m', '0755', directory]);
      const local = join(f.root, 'approved.json');
      await writeFile(local, JSON.stringify(setup), { mode: 0o600 });
      await execute('sudo', ['install', '-m', '0644', local, packetPath]);
      const env = {
        NODE_ENV: 'test',
        KS_WORLD: 'stage',
        DATABASE_URL: target.settings.url,
        KS_REASONING_PROVIDER: 'none',
        KS_CUTROOM_RECEIVING_ENABLED: '1',
        KS_CUTROOM_RECEIVING_PACKET: packetPath,
        KS_CUTROOM_RECEIVING_STAGING_ROOT: f.stagingRoot,
        KS_CUTROOM_RECEIVING_MEDIA_ROOT: f.mediaRoot,
        KS_SHUTDOWN_GRACE_SECONDS: '5',
      };
      async function stage(expectedCode = 0, flags: readonly string[] = []) {
        const child = spawn(process.execPath, ['dist/operator.js', 'cutroom', 'receive', ...flags], {
          cwd: join(releaseDirectory(), 'worker'),
          env: { PATH: process.env['PATH'] ?? '', ...env },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '',
          stderr = '';
        child.stdout.on('data', (b: Buffer) => (stdout += b.toString()));
        child.stderr.on('data', (b: Buffer) => (stderr += b.toString()));
        const code = await new Promise<number | null>((resolve) => child.once('exit', resolve));
        outputs.push(stdout, stderr);
        expect(code, stderr).toBe(expectedCode);
        return JSON.parse(stdout) as { result: { kind: string } };
      }
      const originFinance = (
        await sql<{
          v: unknown;
        }>`select jsonb_build_object('attempts',(select jsonb_agg(to_jsonb(x) order by id) from reasoning.cutroom_attempts x),'settlements',(select jsonb_agg(to_jsonb(x) order by id) from reasoning.cutroom_settlements x),'receipts',(select jsonb_agg(to_jsonb(x) order by settlement_id) from reasoning.cutroom_settlement_receipts x)) v`.execute(
          origin.db,
        )
      ).rows;
      expect(await stage(2, ['--dry-run'])).toMatchObject({ result: 'usage' });
      expect((await sql`select 1 from content.cutroom_receive_receipts`.execute(target.db)).rows).toEqual([]);
      expect(await stage()).toMatchObject({ result: { kind: 'pending' } });
      worker = startReleaseProcess('worker', 'main', env);
      await worker.waitForEvent('process.started');
      await expect
        .poll(
          async () =>
            (
              await sql<{
                state: string;
              }>`select state from content.cutroom_receive_receipts where handoff_id=${p.handoffId}::uuid`.execute(
                target.db,
              )
            ).rows[0]?.state,
          { timeout: 30000 },
        )
        .toBe('admitted');
      expect(await worker.stop()).toBe(0);
      worker = undefined;
      const before = (
        await sql<{
          v: unknown;
        }>`select to_jsonb(x) v from content.cutroom_receive_receipts x where handoff_id=${p.handoffId}::uuid`.execute(
          target.db,
        )
      ).rows;
      worker = startReleaseProcess('worker', 'main', env);
      await worker.waitForEvent('process.started');
      expect(await stage()).toMatchObject({ result: { kind: 'admitted' } });
      expect(
        (
          await sql<{
            v: unknown;
          }>`select to_jsonb(x) v from content.cutroom_receive_receipts x where handoff_id=${p.handoffId}::uuid`.execute(
            target.db,
          )
        ).rows,
      ).toEqual(before);
      async function normalJourney(world: typeof target, mediaRoot: string, assetId: string) {
        const person = await seedPerson(world.db),
          tokens = await seedKeepSessions(world.db, person),
          port = await freePort(),
          url = `http://127.0.0.1:${port}`;
        const api = startReleaseProcess('api', 'main', {
          NODE_ENV: 'test',
          KS_WORLD: 'ci',
          DATABASE_URL: world.settings.url,
          PORT: String(port),
          KS_PUBLIC_ORIGIN: url,
          KS_AUTH_ADAPTER: 'session',
          KS_MAIL_SENDER: 'fixture',
          AGENTMAIL_API_KEY: 'fixture-not-a-key',
          AGENTMAIL_INBOX_ID: 'fixture@agentmail.invalid',
          KS_MEDIA_ROOT: mediaRoot,
        });
        apis.push(api);
        await api.waitForEvent('process.started');
        await waitForHttp(url + '/health');
        const scope = scopeClaimOf({ accountId: person.accountId, privacyEpoch: 1 }),
          client = apiClient(url, `Bearer ${tokens.native}`, scope),
          ref = { assetId, assetRevision: 1 };
        const opened = await client.experience.openExposure({
          commandId: randomUUID(),
          target: { kind: 'reel', assetId },
          origin: { kind: 'direct' },
          capabilities: textCapabilities,
        });
        if (opened.status !== undefined) throw new Error('FIXTURE_DIRECT_REEL_UNAVAILABLE');
        expect(opened.kind).toBe('reel');
        await client.experience.activateExposure({ commandId: randomUUID(), exposureId: opened.exposureId });
        const granted = await client.media.grant({ exposureId: opened.exposureId });
        expect(granted.document).toMatchObject({ assetId, fixture: true, mediaKey: p.media.key });
        await sql`update content.media_objects set size_bytes=size_bytes+1 where logical_key=${p.media.key}`.execute(
          world.db,
        );
        try {
          await expect(client.media.grant({ exposureId: opened.exposureId })).rejects.toThrow();
        } finally {
          await sql`update content.media_objects set size_bytes=size_bytes-1 where logical_key=${p.media.key}`.execute(
            world.db,
          );
        }
        expect((await client.media.grant({ exposureId: opened.exposureId })).document).toEqual(granted.document);
        const range = await fetch(url + granted.path, {
          headers: { authorization: `Bearer ${tokens.native}`, 'x-ks-scope': scope, range: 'bytes=0-31' },
        });
        expect(range.status).toBe(206);
        expect((await range.arrayBuffer()).byteLength).toBe(32);
        expect(range.headers.get('cache-control')).toContain('no-store');
        expect(
          await client.experience.applyAction({
            commandId: randomUUID(),
            kind: 'save',
            target: ref,
            exposureId: opened.exposureId,
          }),
        ).toMatchObject({ saved: true });
        const snapshot = await client.keep.read({ version: 'keep-place.v1', target: ref });
        expect(snapshot.status).toBe('available');
        if (snapshot.status !== 'available') throw new Error('FIXTURE_KEEP_UNAVAILABLE');
        const entry: KeepEntryRef = snapshot.entry,
          command = {
            version: 'keep-place.v1' as const,
            commandId: randomUUID(),
            entry,
            expectedPlaceRevision: 0,
            position: { kind: 'reel' as const, positionMs: 19167.769 },
          };
        expect(await client.keep.setPlace(command)).toMatchObject({ outcome: 'accepted', acceptedPlaceRevision: 1 });
        expect(await client.keep.setPlace(command)).toMatchObject({ replayed: true, acceptedPlaceRevision: 1 });
        expect(await client.keep.read({ version: 'keep-place.v1', target: ref })).toMatchObject({
          status: 'available',
          entry,
          place: { status: 'set', placeRevision: 1, position: command.position },
        });
        expect(
          (
            await sql`select 1 from evidence.observations where universe_id=${person.universeId}::uuid`.execute(
              world.db,
            )
          ).rows,
        ).toEqual([]);
        outputs.push(api.rawOutput());
        expect(api.rawOutput()).not.toContain(tokens.native);
        expect(api.rawOutput()).not.toContain(granted.path);
      }
      await normalJourney(target, f.mediaRoot, p.document.assetId);
      // Existing normal commissioned publication has no legacy reel_imports row either.
      await normalJourney(origin, f.published.media.mediaRoot, f.published.published.assetId);
      for (const table of [
        'reasoning.cutroom_attempts',
        'reasoning.cutroom_settlements',
        'reasoning.cutroom_financial_reports',
        'content.reel_commissions',
        'content.cutroom_publications',
        'content.reel_imports',
      ])
        expect((await sql`select 1 from ${sql.table(table)}`.execute(target.db)).rows, table).toEqual([]);
      expect(
        (
          await sql<{
            v: unknown;
          }>`select jsonb_build_object('attempts',(select jsonb_agg(to_jsonb(x) order by id) from reasoning.cutroom_attempts x),'settlements',(select jsonb_agg(to_jsonb(x) order by id) from reasoning.cutroom_settlements x),'receipts',(select jsonb_agg(to_jsonb(x) order by settlement_id) from reasoning.cutroom_settlement_receipts x)) v`.execute(
            origin.db,
          )
        ).rows,
      ).toEqual(originFinance);
      const output = outputs.join('') + worker.rawOutput();
      for (const canary of [f.stagingRoot, f.mediaRoot, packetPath, 'Bearer test.', 'FIXTURE_PRIVATE_PROVIDER'])
        expect(output).not.toContain(canary);
    } finally {
      for (const api of apis) await api.stop();
      await worker?.stop();
      await f?.close();
      await execute('sudo', ['rm', '-rf', '--', directory]);
      await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    }
  }, 180000);
});
