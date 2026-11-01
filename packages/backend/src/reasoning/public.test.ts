import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/** Production source files under `packages/backend/src` (tests excluded), as repository-relative paths. */
function sourceFiles(directory: string, found: string[] = []): string[] {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) sourceFiles(path, found);
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) found.push(path);
  }
  return found;
}

const backendSource = fileURLToPath(new URL('../', import.meta.url));

describe('what the reasoning engine exposes (review m9, m10)', () => {
  it('exports no way for a module to build its own harness, ledger or transport', () => {
    const text = readFileSync(join(backendSource, 'reasoning', 'public.ts'), 'utf8');
    for (const forbidden of [
      'makeReasoningHarness',
      'makeReasoningOperator',
      'makeAttemptLedger',
      'guardedModelPort',
      'HarnessPorts',
      'HarnessSettings',
      'AttemptLedger',
      'ModelPort',
      'ModelReply',
      'ModelRequest',
      'ModelRejectedError',
      'ModelNotSentError',
      'ModelOutcomeUnknownError',
      './application/ports.js',
      './application/operator.js',
      './adapters/',
    ])
      expect(text, `public.ts must not mention ${forbidden}`).not.toContain(forbidden);
    // What a module does get: the harness type to call, its inputs and outcomes, the injection token.
    for (const wanted of ['type ReasoningHarness', 'type ProposeOutcome', 'RECORDING_REASONING_HARNESS'])
      expect(text, `public.ts should export ${wanted}`).toContain(wanted);
  });

  it('ships no fixture model in the backend package (fixtures live in test support only)', () => {
    const offenders = sourceFiles(backendSource).filter((file) =>
      /fixtureModelPort|FixtureScenario/.test(readFileSync(file, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });
});
