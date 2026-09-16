/** Source-stamped evidence for the pure #54 model; never connects to a runtime. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import assert from 'node:assert/strict';

const output = process.argv[2];
if (!output || process.argv.length !== 3) {
  throw new Error('Usage: tsx scripts/capture-fairness-evidence.ts <output.json>');
}
const paths = [
  'scripts/fairness/model.ts',
  'scripts/fairness/scenarios.ts',
  'scripts/fairness/run.ts',
  'scripts/capture-fairness-evidence.ts',
  'tests/reasoning-fairness.test.ts',
  'tests/reasoning-fairness-adversarial.test.ts',
  'docs/decisions/0013-bounded-reasoning-fairness.md',
];
const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const hashes = Object.fromEntries(paths.map(path => [
  path, createHash('sha256').update(readFileSync(path)).digest('hex'),
]));
const run = () => execFileSync(process.execPath, [...process.execArgv, 'scripts/fairness/run.ts'], {
  encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
  env: { PATH: process.env.PATH, TZ: 'UTC' },
});
const first = run();
const second = run();
assert.equal(first, second, 'Repeated model runs must be byte-identical');
const model = JSON.parse(first) as unknown;
const evidence = {
  kind: 'knowscroll-fairness-model-evidence',
  observedAt: new Date().toISOString(),
  source: { revision: git('rev-parse', 'HEAD'), dirty: git('status', '--porcelain').length > 0, hashes },
  commands: ['tsx scripts/fairness/run.ts', 'tsx scripts/fairness/run.ts'],
  byteIdentical: true,
  outputSha256: createHash('sha256').update(first).digest('hex'),
  model,
  limits: 'Pure synthetic simulation; no SQL concurrency, provider execution, load or usefulness proof.',
};
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, JSON.stringify(evidence, null, 2) + '\n');
console.log(`Wrote ${output}; two model executions were byte-identical.`);
