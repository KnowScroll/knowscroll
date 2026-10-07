/** ADR-0023 operator CLI: register/retire an engine, add/approve a brief, create a grant, create
 * a job, request cancellation, and show job/attempt status. No public HTTP route exists for any
 * of this — it is a local operator/coordinator tool, run as
 * `pnpm exec tsx scripts/generation.ts <command> --flag value ...`.
 *
 * #199 adds the shared Reel pool: `order` (claim in the pool, then create the job), `pool-status`
 * and `set-live-cap`. The pool is the database at `KS_POOL_DATABASE_URL`; this world's name in it
 * is `KS_WORLD` (or `--world`). */
import { pool } from '@knowscroll/db';
import { createPoolLedger } from '@knowscroll/db/pool/ledger';
import pg from 'pg';
import * as operator from '../apps/worker/src/generation/operator.ts';

function flags(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token?.startsWith('--')) {
      const key = token.slice(2);
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--'))
        throw new Error(`Missing value for --${key}`);
      out[key] = value;
      i += 1;
    }
  }
  return out;
}
function required(values: Record<string, string>, key: string): string {
  const value = values[key];
  if (value === undefined) throw new Error(`--${key} is required`);
  return value;
}
function providerMode(value: string): 'standin' | 'live' {
  if (value !== 'standin' && value !== 'live')
    throw new Error('--provider-mode/--mode must be "standin" or "live"');
  return value;
}
function stage(value: string): 'plan' | 'stills' | 'video' {
  if (value !== 'plan' && value !== 'stills' && value !== 'video')
    throw new Error('--until must be "plan", "stills" or "video"');
  return value;
}

const opened: { poolDb: pg.Pool | null } = { poolDb: null };
function sharedPool() {
  const url = process.env.KS_POOL_DATABASE_URL;
  if (!url)
    throw new Error('KS_POOL_DATABASE_URL is required for the shared pool');
  opened.poolDb ??= new pg.Pool({ connectionString: url, max: 2 });
  return createPoolLedger(opened.poolDb);
}
function world(values: Record<string, string>): string {
  const name = values.world ?? process.env.KS_WORLD;
  if (!name) throw new Error('--world (or KS_WORLD) is required');
  return name;
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const args = flags(rest);
  let result: operator.OperatorResult;
  switch (command) {
    case 'order':
      result = await operator.orderShared(pool, sharedPool(), {
        world: world(args),
        briefId: required(args, 'brief-id'),
        grantId: required(args, 'grant-id'),
        until: stage(args.until ?? 'video'),
        ...(args['ceiling-cents'] === undefined
          ? {}
          : { ceilingCents: Number(args['ceiling-cents']) }),
        approvalRef: required(args, 'approval-ref'),
        deadlineAt:
          args['deadline-at'] ??
          new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString(),
      });
      break;
    case 'pool-status':
      result = await operator.poolStatus(sharedPool());
      break;
    case 'set-live-cap':
      result = await operator.setLiveCap(pool, {
        capCents: Number(required(args, 'cap-cents')),
        setBy: required(args, 'set-by'),
      });
      break;
    case 'register-engine':
      result = await operator.registerEngine(pool, {
        origin: required(args, 'origin'),
        contractRevision: required(args, 'contract-revision'),
        artifactRoot: required(args, 'artifact-root'),
        providerMode: providerMode(required(args, 'provider-mode')),
        declaredBy: required(args, 'declared-by'),
      });
      break;
    case 'retire-engine':
      result = await operator.retireEngine(pool, required(args, 'engine-id'));
      break;
    case 'add-brief':
      result = await operator.addBriefFromFile(
        pool,
        required(args, 'file'),
        required(args, 'authored-by'),
      );
      break;
    case 'approve-brief':
      result = await operator.approveBrief(pool, required(args, 'brief-id'));
      break;
    case 'create-grant':
      result = await operator.createGrant(pool, {
        mode: providerMode(required(args, 'mode')),
        capCents: Number(required(args, 'cap-cents')),
        authorizationRef: args['authorization-ref'],
        expiresAt: required(args, 'expires-at'),
      });
      break;
    case 'create-job':
      result = await operator.createJob(pool, {
        briefId: required(args, 'brief-id'),
        engineId: required(args, 'engine-id'),
        grantId: required(args, 'grant-id'),
        until: stage(required(args, 'until')),
        budgetCents: Number(required(args, 'budget-cents')),
        deadlineAt: required(args, 'deadline-at'),
      });
      break;
    case 'cancel-job':
      result = await operator.requestCancel(pool, required(args, 'job-id'));
      break;
    case 'job-status':
      result = await operator.jobStatus(pool, required(args, 'job-id'));
      break;
    default:
      throw new Error(
        `Unknown command "${command}". Expected one of: register-engine, retire-engine, add-brief, approve-brief, create-grant, create-job, order, pool-status, set-live-cap, cancel-job, job-status.`,
      );
  }
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}

try {
  await main();
} finally {
  await pool.end();
  await opened.poolDb?.end();
}
