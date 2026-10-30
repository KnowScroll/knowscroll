import { accountAccessUseCases } from '@knowscroll/backend/modules/identity/nest-providers';
import { randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import { z } from 'zod';
import type { LogEvent } from '@knowscroll/backend/infrastructure/observability';
import { makeWithPersonalScope, type Database } from '@knowscroll/backend/infrastructure/postgres';
import type { PersonalAuthority } from '@knowscroll/backend/modules/identity';
import type { ReasoningContext, ReasoningRole, ReasoningRun } from '@knowscroll/backend/reasoning';
import {
  guardedModelPort,
  makeReasoningHarness,
  postgresHarnessPorts,
  type HarnessPorts,
  type HarnessSettings,
  type ModelPort,
} from '@knowscroll/backend/reasoning/nest-providers';
import { fixtureModelPort, type FixtureModelPort, type FixtureScenario } from './fixture-model-port.js';

/**
 * CI fixtures for the reasoning harness: a labelled fixture model (`fixture-model-port.ts`,
 * wrapped by the same transaction guard as a real transport), generous default
 * settings, a tiny synthetic role and context, and helpers to read the ledger. Nothing here is
 * provider output.
 */
export const silent: LogEvent = () => undefined;

export const fixtureSettings: HarnessSettings = {
  caps: {
    global: { requestsPerDay: 10_000, tokensPerDay: 100_000_000 },
    scope: { requestsPerDay: 10_000, tokensPerDay: 100_000_000 },
    roleDefault: { requestsPerDay: 10_000, tokensPerDay: 100_000_000 },
  },
  // Nothing is kept back by default; tests of the split set their own share.
  backgroundSharePercent: 100,
  ambientSharePercent: 100,
  maxRequestBytes: 262_144,
  requestRetentionSeconds: 3_600,
  purgeIntervalMs: 60_000,
  dispatchedBy: 'ci-fixture',
};

/** A labelled fixture model whose every call plays `script` (default: one valid echo answer). */
export function fixtureModel(
  script: (sequence: number) => FixtureScenario | Promise<FixtureScenario> = () => ({
    kind: 'success',
    text: '{"ok": true, "echo": "lantern"}',
    remoteId: 'fixture-remote-1',
  }),
  options: { readonly quota?: Parameters<typeof fixtureModelPort>[0]['quota']; readonly label?: string } = {},
): FixtureModelPort {
  return guardedModelPort(
    fixtureModelPort({
      label: options.label ?? 'ci-fixture',
      script: (call) => script(call.sequence),
      ...(options.quota === undefined ? {} : { quota: options.quota }),
    }),
  );
}

/** A harness over the test database with the given (fixture) model and optional port overrides. */
export function fixtureHarness(
  db: Kysely<Database>,
  options: {
    readonly model: ModelPort | undefined;
    readonly settings?: HarnessSettings;
    readonly logEvent?: LogEvent;
    readonly overrides?: Partial<HarnessPorts>;
  },
) {
  const ports = postgresHarnessPorts({
    db,
    fenceOwn: accountAccessUseCases({ db, lockTimeoutMs: 5000 }).fenceOwnAccount,
    withPersonalScope: makeWithPersonalScope(db, { lockTimeoutMs: 5_000 }),
    model: options.model,
    logEvent: options.logEvent ?? silent,
    settings: options.settings ?? fixtureSettings,
    ...(options.overrides === undefined ? {} : { overrides: options.overrides }),
  });
  return { harness: makeReasoningHarness(ports), ports };
}

export const echoSchema = z.object({ ok: z.literal(true), echo: z.string().min(1).max(32) }).strict();

/** CI fixture role: echo the word named by the single context item. */
export const echoRole: ReasoningRole<z.infer<typeof echoSchema>> = {
  id: 'fixture.echo',
  version: 'v1',
  instructions: 'Return a JSON object of the form {"ok": true, "echo": "<the word named in the context item>"}.',
  outputSchema: echoSchema,
  maxOutputTokens: 256,
};

export const fixtureContext: ReasoningContext = {
  bundleRef: 'fixture.bundle:1',
  items: [{ ref: 'fixture:item-1', kind: 'evidence', text: 'The word is: lantern' }],
};

/** A worker-style system authority for a fixture universe. */
export function systemAuthority(universeId: string, privacyEpoch = 1): PersonalAuthority {
  return { universeId, privacyEpoch, actor: { kind: 'system', purpose: 'fixture.reasoning' } };
}

export function fixtureRun(authority: PersonalAuthority, id: string = randomUUID()): ReasoningRun {
  return { id, authority, ownerModule: 'fixture', purpose: 'fixture-echo', policyVersion: 'fixture.v1' };
}

export const signal = () => new AbortController().signal;

/** The ledger columns tests assert on. JSON columns are `unknown`: tests narrow what they read. */
export interface AttemptRecord {
  readonly id: string;
  readonly step: string;
  readonly state: string;
  readonly outcome_code: string | null;
  readonly remote_id: string | null;
  readonly causation_attempt_id: string | null;
  readonly request_hash: string;
  readonly output: unknown;
  readonly output_issues: unknown;
  readonly quota_observation: unknown;
  readonly settled_at: Date | null;
  readonly input_tokens: number | null;
  readonly output_tokens: number | null;
  readonly reserved_tokens: number;
  readonly written_off_reason: string | null;
  readonly written_off_by: string | null;
}

/** The universe's attempts, oldest first (columns tests assert on). */
export function attemptsOf(db: Kysely<Database>, universeId: string): Promise<AttemptRecord[]> {
  return db
    .selectFrom('reasoning.external_attempts')
    .select([
      'id',
      'step',
      'state',
      'outcome_code',
      'remote_id',
      'causation_attempt_id',
      'request_hash',
      'output',
      'output_issues',
      'quota_observation',
      'settled_at',
      'input_tokens',
      'output_tokens',
      'reserved_tokens',
      'written_off_reason',
      'written_off_by',
    ])
    .where('universe_id', '=', universeId)
    .orderBy('reserved_at')
    .orderBy('id')
    .execute();
}

/** Usage receipts of the given attempts. */
export function receiptsOf(db: Kysely<Database>, attemptIds: readonly string[]) {
  if (attemptIds.length === 0) return Promise.resolve([]);
  return db
    .selectFrom('reasoning.usage_receipts')
    .select(['attempt_id', 'state', 'reserved_tokens', 'input_tokens', 'output_tokens', 'late_usage'])
    .where('attempt_id', 'in', attemptIds)
    .execute();
}

/** The role and budget class (background or asked-for) of each usage receipt of a universe's attempts, oldest first. */
export function receiptClassesOf(db: Kysely<Database>, universeId: string) {
  return db
    .selectFrom('reasoning.usage_receipts as receipt')
    .innerJoin('reasoning.external_attempts as attempt', 'attempt.id', 'receipt.attempt_id')
    .select(['receipt.role_id', 'receipt.background'])
    .where('attempt.universe_id', '=', universeId)
    .orderBy('receipt.created_at')
    .orderBy('receipt.attempt_id')
    .execute();
}

/** Protected request rows of a universe (sizes and hashes; bytes only when asked). */
export function protectedRequestsOf(db: Kysely<Database>, universeId: string) {
  return db
    .selectFrom('reasoning.protected_requests')
    .select(['attempt_id', 'body', 'body_sha256', 'erasure_class'])
    .where('universe_id', '=', universeId)
    .execute();
}

/** Moves a universe's privacy epoch (what a privacy reset does to authority). */
export async function advanceEpoch(db: Kysely<Database>, universeId: string, to = 2): Promise<void> {
  await db.updateTable('identity.universes').set({ privacy_epoch: to }).where('id', '=', universeId).execute();
}

/** Every text value stored in the reasoning schema, for canary scans. */
export async function reasoningText(db: Kysely<Database>): Promise<string> {
  const rows = await sql<{ dump: string | null }>`
    select coalesce(string_agg(t::text, E'\\n'), '') as dump from (
      select to_jsonb(a) - 'request_hash' as t from reasoning.external_attempts a
      union all select to_jsonb(r) from reasoning.business_runs r
      union all select to_jsonb(u) from reasoning.usage_receipts u
    ) rows`.execute(db);
  return rows.rows[0]?.dump ?? '';
}

/** A promise the test resolves by hand, to hold a fixture call in flight. */
export function gate<T = void>(): { readonly promise: Promise<T>; open(value: T): void } {
  let open!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}
