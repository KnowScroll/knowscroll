/**
 * `ks` — the KnowScroll server tool (#201; v2 releases #228, docs/v2/operations/environments.md).
 * Installed by ops/vps/ansible as /usr/local/bin/ks and run as root with Node's own type stripping.
 * Every command takes v1 releases (release.json without `schema`) as before and `ks-release.v2`
 * releases as #228 describes; a world switches generation when it is deployed.
 *
 *   ks deploy <world> <commit>    release tarball on stdin
 *   ks promote <world> <commit>   reuse the release already on the server (no rebuild)
 *   ks has-release <commit>       exit 0 if the server already holds that release
 *   ks rollback <world>
 *   ks status
 *   ks cleanup [--emergency]
 *   ks disk-guard
 *   ks run <world> <program> [args...]   generation-cli or publication, as the world (#199)
 *   ks cutroom-install <commit>          Cutroom's source tree on stdin (#199)
 *   ks cutroom-restart                   refused while a paid order is open (#199)
 *
 * #250: direct deploy/promote require a private managed-consumer ticket. SSH submits only
 * request-deploy; the independent ks-deploy@UUID service owns the actual operation. Root-only
 * prepare-deployment/deployment-status accept bounded closed metadata, never arbitrary commands.
 *
 * #228 (m2, m7): deploy, promote, rollback, cleanup and an order-claiming `ks run` hold the deploy
 * lock (/run/knowscroll/deploy.lock). ks-gate already runs deploy and promote under it; otherwise
 * ks re-runs itself under `flock`. The disk guard never waits for it: while a deploy holds it, the
 * guard does everything except deleting releases.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { DEPLOY_LOCK, lockNeeded } from './plan.ts';
import {
  requestDeployment,
  managedDeployment,
  prepareDeploymentIntent,
  deploymentStatus,
  cleanup,
  cutroomInstall,
  cutroomRestart,
  deploy,
  diskGuard,
  hasRelease,
  holdsDeployLock,
  Refusal,
  rollback,
  runProgram,
  status,
} from './system.ts';

const [command, ...args] = process.argv.slice(2);
const BUSY = 75;

/** True when this process holds the deploy lock (re-running itself under flock if needed);
 * false only in `try` mode when someone else holds it. */
function underDeployLock(mode: 'wait' | 'try'): boolean {
  if (holdsDeployLock()) return true;
  if (process.env.KS_UNDER_DEPLOY_LOCK === '1')
    throw new Refusal('ks re-ran under flock but cannot see the deploy lock held; refusing to go on without it');
  mkdirSync('/run/knowscroll', { recursive: true });
  const result = spawnSync(
    '/usr/bin/flock',
    [
      ...(mode === 'wait' ? ['--timeout', '1800'] : ['--nonblock', '--conflict-exit-code', String(BUSY)]),
      DEPLOY_LOCK,
      process.execPath,
      ...process.execArgv,
      process.argv[1] as string,
      ...process.argv.slice(2),
    ],
    { stdio: 'inherit', env: { ...process.env, KS_UNDER_DEPLOY_LOCK: '1' } },
  );
  if (mode === 'try' && result.status === BUSY) return false;
  process.exit(result.status ?? 1);
}

try {
  const lock = lockNeeded(command ?? '', args);
  const holdsLock = lock === 'none' ? false : underDeployLock(lock);
  switch (command) {
    case 'request-deploy':
      if (args.length !== 3) throw new Refusal('deployment_request_invalid');
      await requestDeployment(args[0] ?? '', args[1] ?? '', args[2] ?? '');
      break;
    case 'managed-deploy':
      if (args.length !== 1) throw new Refusal('deployment_request_invalid');
      await managedDeployment(args[0] ?? '');
      break;
    case 'deployment-status':
      if (args.length !== 1) throw new Refusal('deployment_request_invalid');
      process.stdout.write(`${JSON.stringify(deploymentStatus(args[0] ?? ''))}\n`);
      break;
    case 'prepare-deployment': {
      if (args.length !== 1) throw new Refusal('deployment_request_invalid');
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of process.stdin) {
        const bytes = Buffer.from(chunk as Uint8Array);
        size += bytes.length;
        if (size > 8192) throw new Refusal('deployment_intent_invalid');
        chunks.push(bytes);
      }
      const text = Buffer.concat(chunks).toString('utf8').trim();
      const intent: unknown = JSON.parse(text);
      if (JSON.stringify(intent) !== text) throw new Refusal('deployment_intent_not_canonical');
      prepareDeploymentIntent(args[0] ?? '', intent);
      break;
    }
    case 'deploy':
      await deploy(args[0] ?? '', args[1] ?? '', 'stdin');
      break;
    case 'promote':
      await deploy(args[0] ?? '', args[1] ?? '', 'existing');
      break;
    case 'has-release':
      process.exitCode = hasRelease(args[0] ?? '') ? 0 : 1;
      break;
    case 'rollback':
      await rollback(args[0] ?? '');
      break;
    case 'status':
      process.stdout.write(`${JSON.stringify(await status(), null, 2)}\n`);
      break;
    case 'cleanup':
      cleanup(args.includes('--emergency'));
      break;
    case 'disk-guard':
      diskGuard(holdsLock);
      break;
    case 'run':
      process.exitCode = runProgram(args[0] ?? '', args[1] ?? '', args.slice(2));
      break;
    case 'cutroom-install':
      cutroomInstall(args[0] ?? '');
      break;
    case 'cutroom-restart':
      cutroomRestart();
      break;
    default:
      process.stderr.write(
        'usage: ks deploy|promote <world> <commit> | has-release <commit> | rollback <world> | status | cleanup [--emergency] | disk-guard | run <world> <program> [args] | cutroom-install <commit> | cutroom-restart\n',
      );
      process.exitCode = 2;
  }
} catch (error) {
  process.stderr.write(
    `${JSON.stringify({
      refused: error instanceof Refusal,
      reason: ['request-deploy', 'managed-deploy', 'prepare-deployment', 'deployment-status'].includes(command ?? '')
        ? 'deployment_incomplete_inspect_fixed_status'
        : (error as Error).message,
    })}\n`,
  );
  process.exitCode = error instanceof Refusal ? 3 : 1;
}
