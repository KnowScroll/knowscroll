import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { releaseDirectory } from '../support/processes.js';

/**
 * The deployed release trees must contain exactly the package versions of `pnpm-lock.yaml`
 * (D-014: `pnpm deploy` with injected workspace packages installs from the shared lockfile). Each
 * tree's own `node_modules/.pnpm/lock.yaml` records what was installed; every third-party
 * package in it must appear in the workspace lockfile with the same resolution (integrity).
 */
function lockedPackages(text: string): Map<string, string> {
  const start = text.indexOf('\npackages:\n');
  const end = text.indexOf('\nsnapshots:\n');
  if (start < 0 || end < 0) throw new Error('lockfile without packages/snapshots sections');
  const entries = new Map<string, string>();
  let key: string | undefined;
  for (const line of text.slice(start, end).split('\n')) {
    const name = /^ {2}(\S.*):$/.exec(line);
    if (name?.[1] !== undefined) {
      key = name[1].replace(/^'|'$/g, '');
      continue;
    }
    const resolution = /^ {4}resolution: \{(.*)\}$/.exec(line);
    if (resolution?.[1] !== undefined && key !== undefined) {
      entries.set(key, resolution[1]);
      key = undefined;
    }
  }
  return entries;
}

const workspaceLockfile = fileURLToPath(new URL('../../../pnpm-lock.yaml', import.meta.url));

describe('the deployed release trees', () => {
  for (const app of ['api', 'worker'] as const) {
    it(`install ${app}/ exactly from the workspace lockfile`, () => {
      const workspace = lockedPackages(readFileSync(workspaceLockfile, 'utf8'));
      const deployed = lockedPackages(
        readFileSync(join(releaseDirectory(), app, 'node_modules', '.pnpm', 'lock.yaml'), 'utf8'),
      );
      const thirdParty = [...deployed].filter(([, resolution]) => !resolution.includes('directory:'));
      expect(thirdParty.length).toBeGreaterThan(50);
      const drift = thirdParty.filter(([key, resolution]) => workspace.get(key) !== resolution).map(([key]) => key);
      expect(drift).toEqual([]);
    });
  }
});
