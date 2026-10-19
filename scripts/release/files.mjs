// Shared by scripts/release/build.mjs and smoke.mjs (#228). Reading a release folder or archive is
// the server tool's own module (ops/vps/tool/tree.ts, re-exported unchanged, so the builder, the CI
// smoke test and `ks deploy` apply one implementation; ops/vps/tool/tree.test.ts checks this file
// re-exports the same functions). Only finding a GNU tar for the builder lives here.

import { spawnSync } from 'node:child_process';

export {
  checkTarFile,
  hashReleaseTree,
  readTarEntries,
  requireRealFolder,
  sha256File,
  sha256Stream,
  TreeError,
} from '../../ops/vps/tool/tree.ts';

/** GNU tar (as `tar` on Linux, `gtar` from Homebrew on a Mac), or null. */
export function gnuTar() {
  for (const bin of ['tar', 'gtar']) {
    const result = spawnSync(bin, ['--version'], { encoding: 'utf8' });
    if (result.status === 0 && /GNU tar/.test(result.stdout)) return bin;
  }
  return null;
}
