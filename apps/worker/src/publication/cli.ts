/**
 * ADR-0024 — the publication-gate "worker": a one-shot process (no queue table exists for this
 * slice; a gate decision is requested for one named generated Reel, not polled for). Run as
 * `pnpm exec tsx apps/worker/src/publication/cli.ts evaluate --reel-id <uuid> --policy <version>
 * [--decide test_eligible] [--media-root <absolute path>]`. Holds no provider credentials; makes no
 * network call; every DB row it touches is named on its own command line, never discovered. Prints
 * one JSON line and exits 0 on success, 1 on a typed refusal or error — matching
 * `scripts/generation.ts`'s own operator-CLI convention.
 */
import { pool } from '../../../../packages/db/src/index.ts';
import { evaluatePublicationGates, PublicationEvaluationError } from './evaluate.ts';

function flags(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token?.startsWith('--')) {
      const key = token.slice(2);
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`Missing value for --${key}`);
      out[key] = value;
      i += 1;
    }
  }
  return out;
}
function required(values: Record<string, string>, key: string): string {
  const value = values[key];
  if (value === undefined) throw new Error(`--${key} is required`);
  return value;
}
function mediaRootSetting(explicit: string | undefined): string {
  if (explicit !== undefined) {
    if (!explicit.startsWith('/')) throw new Error('--media-root must be an absolute path');
    return explicit;
  }
  const raw = process.env.KS_MEDIA_ROOT;
  if (raw !== undefined && raw !== '') {
    if (!raw.startsWith('/')) throw new Error('KS_MEDIA_ROOT must be an absolute path');
    return raw;
  }
  const devRoot = process.env.KS_DEV_ROOT;
  if (devRoot === undefined || devRoot === '' || !devRoot.startsWith('/')) {
    throw new Error('pass --media-root, or set KS_MEDIA_ROOT / KS_DEV_ROOT, before evaluating gates');
  }
  return `${devRoot}/media`;
}
function decideFlag(value: string | undefined): 'auto' | 'test_eligible' {
  if (value === undefined || value === 'auto') return 'auto';
  if (value === 'test_eligible') return 'test_eligible';
  throw new Error('--decide must be "auto" or "test_eligible"');
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const args = flags(rest);
  if (command !== 'evaluate') {
    throw new Error(`Unknown command "${String(command)}". Expected: evaluate.`);
  }
  const result = await evaluatePublicationGates(pool, {
    generatedReelId: required(args, 'reel-id'),
    policyVersion: required(args, 'policy'),
    mediaRoot: mediaRootSetting(args['media-root']),
    decide: decideFlag(args['decide']),
  });
  console.log(JSON.stringify({ service: 'publication-worker', event: 'evaluated', ...result }));
}

try {
  await main();
} catch (error) {
  if (error instanceof PublicationEvaluationError) {
    console.log(JSON.stringify({ service: 'publication-worker', event: 'refused', code: error.code, detail: error.message }));
    process.exitCode = 1;
  } else {
    console.error(JSON.stringify({ service: 'publication-worker', event: 'error', detail: error instanceof Error ? error.message : String(error) }));
    process.exitCode = 1;
  }
} finally {
  await pool.end();
}
