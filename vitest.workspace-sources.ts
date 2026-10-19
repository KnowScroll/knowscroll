import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Vite plugin for every Vitest config in the workspace: resolves `@knowscroll/*` imports to the
 * TypeScript source named by the `@knowscroll/source` export condition, in every Vite environment
 * (tests, global setup and config loading alike), so tests never depend on a previous build.
 */
const workspacePackages: Readonly<Record<string, string>> = {
  '@knowscroll/backend': 'packages/backend',
  '@knowscroll/contracts': 'packages/contracts',
  '@knowscroll/migrations': 'migrations',
};

const repositoryRoot = fileURLToPath(new URL('.', import.meta.url));

interface SourceResolver {
  readonly name: string;
  readonly enforce: 'pre';
  resolveId(id: string): string | null;
}

export function workspaceSources(): SourceResolver {
  return {
    name: 'knowscroll:workspace-sources',
    enforce: 'pre',
    resolveId(id) {
      const name = Object.keys(workspacePackages).find(
        (candidate) => id === candidate || id.startsWith(`${candidate}/`),
      );
      if (name === undefined) return null;
      const directory = join(repositoryRoot, workspacePackages[name] ?? '');
      const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as {
        exports?: Record<string, Record<string, string> | undefined>;
      };
      const source = manifest.exports?.[`.${id.slice(name.length)}`]?.['@knowscroll/source'];
      if (source === undefined) throw new Error(`${id} is not an exported entry of ${name}`);
      return join(directory, source);
    },
  };
}
