#!/usr/bin/env node
// `pnpm lint:probe:network`: proves the ESLint rules that keep model calls behind the reasoning
// harness bite. Writes probe files (paths that must not exist yet) that use a global fetch and
// import Node's HTTP clients and an HTTP library, lints them with the repository configuration,
// and checks that
//   - in a module's application code, in a module's adapters and in an app, every form is reported
//     by `no-restricted-globals` / `no-restricted-imports` (a role cannot reach a model API around
//     the harness), and
//   - in the places that may hold network clients (infrastructure/ and the reasoning engine's
//     provider adapters) nothing is reported (the negative control, so the rule cannot pass by
//     matching everything).
// The probe files are removed again whatever happens. Run from the repository root (CI `static` job).
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { ESLint } from 'eslint';

const B = 'packages/backend/src';
const source = [
  "import { request } from 'node:https';",
  "import { get } from 'http';",
  "import { fetch as undiciFetch } from 'undici';",
  '',
  'export async function probe(): Promise<unknown> {',
  "  await fetch('https://api.minimax.io/anthropic/v1/messages');",
  '  return [request, get, undiciFetch];',
  '}',
  '',
].join('\n');

/** Files the rules must reject (`reported`: how many messages are expected at least) or allow (0). */
const probes = [
  { file: `${B}/modules/experience/application/zz-probe-network.ts`, reported: true },
  { file: `${B}/modules/experience/adapters/zz-probe-network.ts`, reported: true },
  { file: `${B}/reasoning/application/zz-probe-network.ts`, reported: true },
  { file: 'apps/worker/src/zz-probe-network.ts', reported: true },
  { file: `${B}/reasoning/adapters/zz-probe-network.ts`, reported: false },
  { file: `${B}/infrastructure/zz-probe-network/client.ts`, reported: false },
];
const createdDirectories = [`${B}/infrastructure/zz-probe-network`];

for (const { file } of probes)
  if (existsSync(file)) {
    console.error(`lint:probe:network: ${file} already exists; refusing to overwrite it`);
    process.exit(2);
  }
for (const directory of createdDirectories)
  if (existsSync(directory)) {
    console.error(`lint:probe:network: ${directory} already exists; refusing to touch it`);
    process.exit(2);
  }

let failures = 0;
try {
  for (const { file } of probes) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, source);
  }
  const results = await new ESLint().lintFiles(probes.map(({ file }) => file));
  for (const { file, reported } of probes) {
    const result = results.find((candidate) => candidate.filePath.endsWith(file));
    const messages = (result?.messages ?? []).filter((message) =>
      ['no-restricted-globals', 'no-restricted-imports'].includes(message.ruleId ?? ''),
    );
    const globals = messages.filter((message) => message.ruleId === 'no-restricted-globals').length;
    const imports = messages.filter((message) => message.ruleId === 'no-restricted-imports').length;
    if (reported ? globals < 1 || imports < 3 : messages.length > 0) {
      failures += 1;
      console.error(
        `lint:probe:network: ${file}: expected ${reported ? 'a global fetch and 3 restricted imports reported' : 'nothing reported'}, got ${globals} global(s) and ${imports} import(s)`,
      );
    } else console.log(`lint:probe:network: ${reported ? 'rejected' : 'allowed'} as expected: ${file}`);
  }
} finally {
  for (const { file } of probes) rmSync(file, { force: true });
  for (const directory of createdDirectories) rmSync(directory, { recursive: true, force: true });
}

if (failures > 0) process.exit(1);
console.log(`lint:probe:network: ${probes.length} placements behave as required`);
