#!/usr/bin/env node
// `pnpm boundaries:manifests`: production code may import a workspace package (`@knowscroll/*`)
// only if its package.json lists it under `dependencies`. dependency-cruiser cannot see this
// (workspace links resolve outside node_modules), and `pnpm deploy --prod` would silently drop a
// workspace package listed only under `devDependencies`. Test files are exempt.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const packages = [
  'apps/api',
  'apps/worker',
  'apps/client',
  'packages/backend',
  'packages/contracts',
  'packages/client-core',
  'packages/design-tokens',
  'packages/ui',
  'migrations',
];
const testFile = /\.test\.tsx?$/;
const workspaceImport = /from\s+'(@knowscroll\/[a-z-]+)(?:\/[^']*)?'/g;

function sourceFiles(directory) {
  let entries;
  try {
    entries = readdirSync(directory);
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    const path = join(directory, entry);
    if (entry === 'node_modules' || entry === 'dist') return [];
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(?:ts|tsx)$/.test(entry) && !testFile.test(entry) ? [path] : [];
  });
}

let problems = 0;
for (const folder of packages) {
  const manifest = JSON.parse(readFileSync(join(folder, 'package.json'), 'utf8'));
  const declared = new Set(Object.keys(manifest.dependencies ?? {}));
  const roots = folder === 'apps/client' ? ['app', 'features', 'platform', 'theme'] : ['src'];
  for (const file of roots.flatMap((root) => sourceFiles(join(folder, root)))) {
    for (const match of readFileSync(file, 'utf8').matchAll(workspaceImport)) {
      const name = match[1];
      if (name !== manifest.name && !declared.has(name)) {
        problems += 1;
        console.error(`${file} imports ${name}, which ${folder}/package.json does not list under dependencies`);
      }
    }
  }
}
if (problems > 0) process.exit(1);
console.log(
  `boundaries:manifests: every workspace import in production code is a declared dependency (${packages.length} packages)`,
);
