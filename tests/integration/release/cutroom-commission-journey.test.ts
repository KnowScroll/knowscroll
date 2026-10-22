/** Actions-only installed worker/operator, real disposable world/pool/pg-boss and synthetic
 * ffmpeg video. No paid provider, actual human approval, owner corpus or runtime activation. */
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'kysely';
import { describe, expect, it } from 'vitest';
import { createDatabase, type Database } from '@knowscroll/backend/infrastructure/postgres';
import { CUTROOM_CHAIN_UPSTREAM_REVISION } from '@knowscroll/backend/modules/content';
import { createEmptyDatabase } from '../support/empty-database.js';
import { TEST_DATABASE_PREFIX } from '../support/admin.js';
import {
  commissionFixture,
  fixtureReview,
  fixtureCorpusManifest,
  installCutroomEvidenceFixture,
  hash,
  type CommissionFixture,
} from '../support/commission-fixture.js';
import { cutroomFixture } from '../support/cutroom-fixture.js';
import { releaseDirectory, startReleaseProcess, type ReleaseProcess } from '../support/processes.js';
const execute = promisify(execFile);
describe('connected Cutroom through the installed worker release', () => {
  it('commits approved reservation, safely holds for real binding preflight, sends once, restarts and verifies/imports/settles exact chain', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ks-release-cutroom-')),
      directory = `/etc/knowscroll/cutroom-ci-${randomUUID()}`,
      packetPath = directory + '/approved.json';
    let f: CommissionFixture | undefined,
      worker: ReleaseProcess | undefined,
      media: Awaited<ReturnType<typeof cutroomFixture>> | undefined,
      server: ReturnType<typeof createServer> | undefined;
    const outputs: string[] = [],
      posts: string[] = [];
    try {
      const empty = await createEmptyDatabase('connected_cutroom');
      expect(await startReleaseProcess('api', 'migrate', { DATABASE_URL: empty.url, KS_WORLD: 'ci' }).exited()).toBe(0);
      const settings = {
          url: empty.url,
          applicationName: 'fixture-connected-cutroom',
          poolMax: 5,
          statementTimeoutMs: 20000,
        },
        handle = createDatabase<Database>(settings, { onIdleClientError: () => undefined });
      f = await commissionFixture('installed', {
        runPrefix: TEST_DATABASE_PREFIX,
        world: {
          ...handle,
          name: empty.name,
          settings,
          drop: async () => {
            await handle.close();
            await empty.drop();
          },
        },
      });
      const pin = await installCutroomEvidenceFixture(f),
        cmd = f.command('installed', 75, true),
        reviewed = await fixtureReview(f, cmd.input);
      media = await cutroomFixture(root);
      media.status.requestId = cmd.prepared.requestId;
      media.result.requestId = cmd.prepared.requestId;
      media.result.costCents = 34;
      const upstream = media;
      server = createServer((request, response) => {
        if (request.method === 'POST' && request.url === '/v1/runs') {
          const chunks: Buffer[] = [];
          request.on('data', (chunk: Buffer) => chunks.push(chunk));
          request.on('end', () => {
            posts.push(Buffer.concat(chunks).toString('utf8'));
            response.writeHead(202, { 'content-type': 'application/json' }).end(
              JSON.stringify({
                contractVersion: 1,
                outcome: 'accepted',
                requestId: cmd.prepared.requestId,
                runId: upstream.status.runId,
                replayed: false,
              }),
            );
          });
          return;
        }
        if (request.method !== 'GET') {
          response.writeHead(405).end();
          return;
        }
        void fetch(upstream.origin + (request.url ?? '/'), { signal: AbortSignal.timeout(10000) })
          .then(async (r) => {
            response.writeHead(r.status, { 'content-type': 'application/json' }).end(await r.text());
          })
          .catch(() => response.destroy());
      });
      await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('FIXTURE_BIND');
      const origin = `http://127.0.0.1:${address.port}`,
        env = {
          NODE_ENV: 'test',
          KS_WORLD: 'dev',
          DATABASE_URL: empty.url,
          KS_REASONING_PROVIDER: 'none',
          KS_CUTROOM_COMMISSIONING_ENABLED: '1',
          KS_CUTROOM_APPROVAL_PACKET: packetPath,
          KS_CUTROOM_ORIGIN: origin,
          KS_CUTROOM_ARTIFACT_ROOT: media.artifactRoot,
          KS_CUTROOM_MEDIA_ROOT: media.mediaRoot,
          KS_CUTROOM_EVIDENCE_FUNCTION_SHA256: pin,
          KS_CUTROOM_POOL_DATABASE_URL: f.pool.options.connectionString!,
          KS_SHUTDOWN_GRACE_SECONDS: '5',
        };
      const profile = () => {
        const now = Date.now();
        return {
          upstreamRevision: CUTROOM_CHAIN_UPSTREAM_REVISION,
          soleWriterEvidenceSha256: hash('fixture-sole-writer'),
          observedAtMs: now - 1,
          expiresAtMs: now + 29999,
        };
      };
      const setup = {
        version: 'cutroom-commissioning-setup.v1',
        worldId: 'dev',
        generation: 1,
        approvals: [cmd.approval],
        humanApprovals: [reviewed.human],
        manifests: [fixtureCorpusManifest()],
        preflights: [] as unknown[],
        profile: profile(),
        command: cmd.input,
        reviewPacket: reviewed.packet,
        poolWork: undefined as unknown,
      };
      await execute('sudo', ['install', '-d', '-m', '0755', directory]);
      async function packet() {
        const path = join(root, 'packet.json');
        await writeFile(path, JSON.stringify(setup), { mode: 0o600 });
        await execute('sudo', ['install', '-m', '0644', path, packetPath]);
      }
      async function operator(command: string) {
        const child = spawn(process.execPath, ['dist/operator.js', 'cutroom', command], {
          cwd: join(releaseDirectory(), 'worker'),
          env: { PATH: process.env['PATH'] ?? '', ...env },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let out = '',
          err = '';
        child.stdout.on('data', (b: Buffer) => {
          out += b.toString();
        });
        child.stderr.on('data', (b: Buffer) => {
          err += b.toString();
        });
        const code = await new Promise<number | null>((resolve) => child.once('exit', resolve));
        outputs.push(out, err);
        expect(code, err).toBe(0);
        return JSON.parse(out) as Record<string, unknown>;
      }
      await packet();
      const accepted = await operator('commission');
      expect(accepted).toMatchObject({ kind: 'pending', poolState: 'pending' });
      const attemptId = String(accepted['attemptId']);
      worker = startReleaseProcess('worker', 'main', env);
      await worker.waitForEvent('process.started');
      await expect
        .poll(
          async () =>
            (
              await f!.world.db
                .selectFrom('reasoning.cutroom_attempts')
                .select('pool_state')
                .where('id', '=', attemptId)
                .executeTakeFirst()
            )?.pool_state,
          { timeout: 15000 },
        )
        .toBe('claimed');
      outputs.push(worker.rawOutput());
      await worker.stop();
      worker = undefined;
      expect(posts).toHaveLength(0);
      const a = await f.world.db
        .selectFrom('reasoning.cutroom_attempts')
        .select(['fence', 'binding_id'])
        .where('id', '=', attemptId)
        .executeTakeFirstOrThrow();
      const receipt = (
        await sql<{
          claimedAt: string;
          boundAt: string;
        }>`select to_char(claimed_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') "claimedAt",to_char(bound_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') "boundAt" from reasoning.cutroom_attempts where id=${attemptId}::uuid`.execute(
          f.world.db,
        )
      ).rows[0]!;
      const op = await f.world.db
        .selectFrom('reasoning.cutroom_pool_operations')
        .select('id')
        .where('attempt_id', '=', attemptId)
        .where('kind', '=', 'claim')
        .executeTakeFirstOrThrow();
      const now = new Date();
      setup.profile = profile();
      setup.preflights = [
        {
          attemptId,
          requestSha256: cmd.prepared.requestSha256,
          fence: a.fence,
          profileSha256: hash('fixture-engine'),
          soleWriterEvidenceSha256: hash('fixture-sole-writer'),
          fundsEvidenceSha256: hash('fixture-no-paid-funds'),
          observedAt: now.toISOString(),
          expiresAt: new Date(now.getTime() + 30000).toISOString(),
          availableCents: 200,
          poolReceipt: { bindingId: a.binding_id, ...receipt },
        },
      ];
      setup.poolWork = { v: 1, worldId: 'dev', generation: 1, attemptId, operationId: op.id };
      await packet();
      expect(await operator('process-pool')).toMatchObject({
        mode: 'root_immediate_existing_operation',
        result: 'post_observed',
      });
      expect(posts).toEqual([cmd.prepared.requestUtf8]);
      worker = startReleaseProcess('worker', 'main', env);
      await worker.waitForEvent('process.started');
      await expect
        .poll(
          async () =>
            (
              await sql<{
                state: string;
              }>`select state from reasoning.cutroom_settlements where attempt_id=${attemptId}::uuid`.execute(
                f!.world.db,
              )
            ).rows[0]?.state,
          { timeout: 30000 },
        )
        .toBe('confirmed');
      expect(posts).toHaveLength(1);
      const asset = await f.world.db
        .selectFrom('content.asset_revisions')
        .select(['title', 'document'])
        .where('asset_id', '=', cmd.input.businessRunId)
        .executeTakeFirstOrThrow();
      expect(asset.title).toContain('[Fixture]');
      expect(
        (await f.owner.query<{ state: string; spent_cents: number }>('select state,spent_cents from public.pool_order'))
          .rows,
      ).toEqual([{ state: 'settled', spent_cents: 34 }]);
      outputs.push(worker.rawOutput());
      await worker.stop();
      worker = undefined;
      // Immediate old operation replay is safely held; it cannot mint a second POST permit.
      const replay = spawn(process.execPath, ['dist/operator.js', 'cutroom', 'process-pool'], {
        cwd: join(releaseDirectory(), 'worker'),
        env: { PATH: process.env['PATH'] ?? '', ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      replay.stdout.on('data', (b: Buffer) => {
        out += b.toString();
      });
      expect(await new Promise<number | null>((resolve) => replay.once('exit', resolve))).toBe(2);
      expect(JSON.parse(out)).toMatchObject({ result: 'held' });
      expect(posts).toHaveLength(1);
      expect(outputs.join('\n')).not.toContain(cmd.prepared.requestUtf8);
      expect(outputs.join('\n')).not.toContain(env.KS_CUTROOM_POOL_DATABASE_URL);
    } finally {
      if (worker) await worker.stop();
      if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
      await media?.close();
      await f?.close();
      await execute('sudo', ['rm', '-rf', '--', directory]);
      await rm(root, { recursive: true, force: true });
    }
  }, 180000);
});
