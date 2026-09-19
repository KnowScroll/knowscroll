/** ADR-0023 operator CLI: register/retire an engine, add/approve a brief, create a grant, create
 * a job, request cancellation, and show job/attempt status. No public HTTP route exists for any
 * of this — it is a local operator/coordinator tool, run as
 * `pnpm exec tsx scripts/generation.ts <command> --flag value ...`. */
import {pool} from '../packages/db/src/index.ts';
import * as operator from '../apps/worker/src/generation/operator.ts';

function flags(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token?.startsWith('--')) {
      const key = token.slice(2);
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`Missing value for --${key}`);
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
  if (value !== 'standin' && value !== 'live') throw new Error('--provider-mode/--mode must be "standin" or "live"');
  return value;
}
function stage(value: string): 'plan' | 'stills' | 'video' {
  if (value !== 'plan' && value !== 'stills' && value !== 'video') throw new Error('--until must be "plan", "stills" or "video"');
  return value;
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const args = flags(rest);
  let result: operator.OperatorResult;
  switch (command) {
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
      result = await operator.addBriefFromFile(pool, required(args, 'file'), required(args, 'authored-by'));
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
      throw new Error(`Unknown command "${command}". Expected one of: register-engine, retire-engine, add-brief, approve-brief, create-grant, create-job, cancel-job, job-status.`);
  }
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}

try {
  await main();
} finally {
  await pool.end();
}
