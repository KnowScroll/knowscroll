// Runs ESLint over the repository in parts, one Node process per part.
//
// Typed rules load a TypeScript program for every project they meet, so one process over the whole tree grows with
// the code until it no longer fits a heap. Each part lints the folders it names; the last part lints the rest
// of the tree with those folders ignored. Every file is therefore linted exactly once, with the same config, and a
// folder added later falls into the last part instead of being skipped. Every part runs even after a failure, so one
// run shows every finding; the command fails if any part fails.
//
// Arguments are passed to every part (for example `pnpm lint --fix`).
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PARTS = [
  ['apps/client'],
  ['apps/api', 'apps/worker'],
  ['packages/backend'],
  ['packages/ui', 'packages/client-core'],
  ['packages/contracts', 'packages/design-tokens', 'packages/scene-core', 'packages/scroll-model'],
  ['tests'],
];

const HEAP = '--max-old-space-size=6144';
const root = fileURLToPath(new URL('..', import.meta.url));
const eslint = fileURLToPath(new URL('../node_modules/eslint/bin/eslint.js', import.meta.url));
const passed = process.argv.slice(2);

function runPart(label, targets) {
  console.log(`\nlint: ${label}`);
  const result = spawnSync(process.execPath, [HEAP, eslint, '--max-warnings', '0', ...passed, ...targets], {
    cwd: root,
    stdio: 'inherit',
  });
  if (result.error) console.error(result.error);
  return result.status === 0;
}

const named = PARTS.map((folders) => runPart(folders.join(', '), folders));
const restIgnores = PARTS.flat().flatMap((folder) => ['--ignore-pattern', `${folder}/`]);
const rest = runPart('the rest of the tree', [...restIgnores, '.']);
const failed = [...named, rest].filter((ok) => !ok).length;

if (failed > 0) {
  console.error(`\nlint: ${failed} part(s) failed`);
  process.exit(1);
}
console.log('\nlint: every part passed');
