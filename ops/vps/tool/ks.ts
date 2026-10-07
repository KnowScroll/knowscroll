/**
 * `ks` — the KnowScroll server tool (#201, docs/operations/environments.md). Installed by
 * ops/vps/ansible as /usr/local/bin/ks and run as root with Node's own type stripping.
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
 */

import {
  cleanup,
  cutroomInstall,
  cutroomRestart,
  deploy,
  diskGuard,
  hasRelease,
  Refusal,
  rollback,
  runProgram,
  status,
} from './system.ts';

const [command, ...args] = process.argv.slice(2);

try {
  switch (command) {
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
      diskGuard();
      break;
    case 'run':
      process.exitCode = runProgram(
        args[0] ?? '',
        args[1] ?? '',
        args.slice(2),
      );
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
    `${JSON.stringify({ refused: error instanceof Refusal, reason: (error as Error).message })}\n`,
  );
  process.exitCode = error instanceof Refusal ? 3 : 1;
}
