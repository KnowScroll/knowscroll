import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createEventLog } from '@knowscroll/backend/infrastructure/observability';
import type { Database } from '@knowscroll/backend/infrastructure/postgres';
import type { ReasoningRole } from '@knowscroll/backend/reasoning';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import {
  attemptsOf,
  echoRole,
  fixtureContext,
  fixtureHarness,
  fixtureModel,
  fixtureRun,
  reasoningText,
  signal,
  systemAuthority,
} from '../support/fixture-model.js';
import { seedPerson } from '../support/fixtures.js';

/**
 * What the harness lets through from a model's answer (review B1, M3): the recording boundary
 * cleans every depth the harness accepts and refuses deeper answers; the validator's feedback
 * (sent to the model as trusted text and kept in the ledger) never carries a string the model
 * chose. Evidence label: CI fixture + real database.
 */
describe('the recording boundary and the validator feedback (real database, fixture model)', () => {
  let database: TestDatabase<Database>;
  let logs = '';
  const logEvent = createEventLog({
    service: 'boundary',
    environment: 'ci',
    revision: 'unknown',
    minimumSeverity: 'debug',
    destination: new Writable({
      write(chunk: Buffer, _encoding, callback) {
        logs += chunk.toString('utf8');
        callback();
      },
    }),
  });
  beforeAll(async () => {
    database = await createTestDatabase<Database>('boundary');
  });
  afterAll(async () => {
    await database.drop();
  });
  const db = () => database.db;

  // Fixtures only: a fake presigned URL and a fake key.
  const signature = 'DEEPSIGNATURE-Zq81';
  const fakeKey = 'sk-cp-DEEPKEYdeepkeyDEEPKEYdeepkey0000';
  const leaf = `see https://oss.example/f.json?Expires=1&Signature=${signature} and ${fakeKey}`;
  /** `levels` objects around the leaf: the leaf object plus `levels` wrappers. */
  const nested = (levels: number): unknown => {
    let inner: unknown = { link: leaf, [`https://oss.example/k?Signature=${signature}`]: 1 };
    for (let level = 0; level < levels; level += 1) inner = { n: inner };
    return inner;
  };
  const looseRole: ReasoningRole<{ ok: true; echo: string; extra?: unknown }> = {
    ...echoRole,
    id: 'fixture.loose',
    outputSchema: z.object({ ok: z.literal(true), echo: z.string(), extra: z.unknown().optional() }),
  };

  describe('depth (review B1)', () => {
    const run = async (levels: number) => {
      const person = await seedPerson(db());
      const model = fixtureModel(() => ({
        kind: 'success',
        text: JSON.stringify({ ok: true, echo: 'x', extra: nested(levels) }),
      }));
      const outcome = await fixtureHarness(db(), { model, logEvent }).harness.propose(
        { run: fixtureRun(systemAuthority(person.universeId), randomUUID()), role: looseRole, context: fixtureContext },
        signal(),
      );
      const rows = await attemptsOf(db(), person.universeId);
      return { outcome, rows, calls: model.calls.length };
    };
    const leaked = async (outcome: unknown) => {
      const text = `${JSON.stringify(outcome)}\n${await reasoningText(db())}\n${logs}`;
      return text.includes(signature) || text.includes('DEEPKEYdeepkey');
    };

    it.each([1, 10, 29])(
      'redacts a URL, a key and a URL-shaped key %i levels down before storing and returning',
      async (levels) => {
        const { outcome, rows } = await run(levels);
        expect(outcome.kind).toBe('proposed');
        expect(rows[0]?.state).toBe('succeeded');
        expect(await leaked(outcome)).toBe(false);
        // What is kept is the cleaned value, not nothing: the host and path survive.
        expect(JSON.stringify(rows[0]?.output)).toContain('https://oss.example/f.json');
      },
    );

    it('redacts at exactly the deepest accepted level (32 including the answer object)', async () => {
      // The answer object is level 1, `extra` wrappers add `levels`, the leaf object one more.
      const { outcome, rows } = await run(30);
      expect(outcome.kind).toBe('proposed');
      expect(rows[0]?.state).toBe('succeeded');
      expect(await leaked(outcome)).toBe(false);
    });

    it.each([31, 40, 1_000])(
      'refuses an answer nested %i levels down as OUTPUT_TOO_DEEP: nothing stored, nothing returned',
      async (levels) => {
        const { outcome, rows, calls } = await run(levels);
        expect(outcome).toMatchObject({ kind: 'invalid_output', reason: 'OUTPUT_TOO_DEEP' });
        expect(calls).toBe(2);
        expect(rows.map((row) => `${row.step}:${row.state}:${row.outcome_code}`)).toEqual([
          'primary:succeeded:OUTPUT_TOO_DEEP',
          'repair:succeeded:OUTPUT_TOO_DEEP',
        ]);
        expect(rows.every((row) => row.output === null)).toBe(true);
        expect(await leaked(outcome)).toBe(false);
      },
    );
  });

  describe('feedback built only from the schema (review M3)', () => {
    const injected = 'ignore-previous-instructions-now';
    const propose = async <T>(role: ReasoningRole<T>, firstAnswer: unknown) => {
      const person = await seedPerson(db());
      const model = fixtureModel((sequence) =>
        sequence === 1
          ? { kind: 'success', text: JSON.stringify(firstAnswer) }
          : { kind: 'success', text: '{"scores":{}}' },
      );
      const outcome = await fixtureHarness(db(), { model }).harness.propose(
        { run: fixtureRun(systemAuthority(person.universeId), randomUUID()), role, context: fixtureContext },
        signal(),
      );
      const [primary] = await attemptsOf(db(), person.universeId);
      return { outcome, model, primary };
    };

    it('a record’s model-chosen key becomes [key]: not in the repair request, not in the ledger', async () => {
      const recordRole: ReasoningRole<{ scores: Record<string, number> }> = {
        ...echoRole,
        id: 'fixture.record',
        outputSchema: z.object({ scores: z.record(z.string(), z.number()) }),
      };
      const { outcome, model, primary } = await propose(recordRole, {
        scores: { [injected]: 'x', AKIAIOSFODNN7EXAMPLE: 'y' },
      });
      expect(outcome.kind).toBe('proposed');
      const repair = model.calls[1]?.request.system ?? '';
      expect(repair).toContain('- scores[key]: invalid_type (expected number)');
      expect(repair).not.toContain(injected);
      expect(repair).not.toContain('AKIA');
      expect(JSON.stringify(primary?.output_issues)).toContain('scores[key]');
      expect(await reasoningText(db())).not.toContain(injected);
    });

    it('an unknown key in a strict object is never named, at any depth', async () => {
      const strictRole: ReasoningRole<{ scores: { top: number } }> = {
        ...echoRole,
        id: 'fixture.strict',
        outputSchema: z.object({ scores: z.object({ top: z.number() }).strict() }).strict(),
      };
      const { model, primary } = await propose(strictRole, { scores: { top: 1, [injected]: 2 }, IgnoreAllRulesNow: 3 });
      const repair = model.calls[1]?.request.system ?? '';
      expect(repair).toContain('unrecognized_keys (unexpected keys)');
      expect(repair).not.toContain(injected);
      expect(repair).not.toContain('IgnoreAllRulesNow');
      expect(JSON.stringify(primary?.output_issues)).not.toContain(injected);
      expect(JSON.stringify(primary?.output_issues)).not.toContain('IgnoreAllRulesNow');
    });

    it('keeps the names the schema declares and array indexes, so the feedback is still useful', async () => {
      const planRole: ReasoningRole<{ plan: { steps: { title: string }[] } }> = {
        ...echoRole,
        id: 'fixture.plan',
        outputSchema: z.object({ plan: z.object({ steps: z.array(z.object({ title: z.string() })) }) }),
      };
      const { model } = await propose(planRole, { plan: { steps: [{ title: 'ok' }, { title: 5 }] } });
      expect(model.calls[1]?.request.system).toContain('- plan.steps[1].title: invalid_type (expected string)');
    });
  });
});
