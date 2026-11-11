import 'reflect-metadata';
import type { Provider } from '@nestjs/common';
import type { Kysely } from 'kysely';
import { describe, expect, it } from 'vitest';
import type { DryRunOperatorConfig } from '@knowscroll/backend/infrastructure/config';
import type { Database } from '@knowscroll/backend/infrastructure/postgres';
import { dryRunsFor, makeResolver } from './dry-run-wiring.js';
import { dryRunCommand } from './dry-run-operator.js';

const A = Symbol('a'),
  B = Symbol('b'),
  C = Symbol('c');

describe('building a value from a provider list without Nest', () => {
  it('uses a seeded value, a value provider, and a factory whose dependencies are built first, each once', () => {
    let built = 0;
    const providers: Provider[] = [
      { provide: A, useValue: 'from-value' },
      {
        provide: B,
        inject: [A, C],
        useFactory: (a: string, c: string) => {
          built += 1;
          return `${a}+${c}`;
        },
      },
    ];
    const resolve = makeResolver(providers, new Map<unknown, unknown>([[C, 'seeded']]));
    expect(resolve(B)).toBe('from-value+seeded');
    expect(resolve(B)).toBe('from-value+seeded');
    expect(built).toBe(1);
  });

  it('throws for a token nobody provides, a cycle, and a provider kind it does not build', () => {
    expect(() => makeResolver([], new Map())(A)).toThrow('DRY_RUN_PROVIDER_MISSING');
    const cycle: Provider[] = [
      { provide: A, inject: [B], useFactory: (b: unknown) => b },
      { provide: B, inject: [A], useFactory: (a: unknown) => a },
    ];
    expect(() => makeResolver(cycle, new Map())(A)).toThrow('DRY_RUN_PROVIDER_CYCLE');
    expect(() => makeResolver([{ provide: A, useExisting: B }], new Map())(A)).toThrow('DRY_RUN_PROVIDER_UNSUPPORTED');
  });
});

describe('the dry runs the worker builds (#674, D-411)', () => {
  const config: DryRunOperatorConfig = {
    world: 'ci',
    database: { url: 'postgres://ci', applicationName: 'ci', poolMax: 1, statementTimeoutMs: 1000 },
    cartographerEnabled: true,
    plannerEnabled: true,
    scopeLockTimeoutMs: 1000,
  };

  it('are built from the worker’s own providers, so they read what a real run reads', () => {
    // Nothing here touches the database: building a port only closes over it.
    const runs = dryRunsFor({} as Kysely<Database>, config, () => undefined);
    expect(typeof runs.geography).toBe('function');
    expect(typeof runs.planner).toBe('function');
  });

  it('refuses a missing universe argument and a malformed one before reading any configuration', async () => {
    const printed: Record<string, unknown>[] = [];
    const print = (result: Record<string, unknown>) => void printed.push(result);
    expect(await dryRunCommand(['geography', 'dry-run'], print, () => undefined)).toBe(2);
    expect(await dryRunCommand(['planner', 'dry-run', '--universe', 'not-a-uuid'], print, () => undefined)).toBe(2);
    expect(
      await dryRunCommand(
        ['geography', 'replay', '--universe', '11111111-1111-4111-8111-111111111111'],
        print,
        () => undefined,
      ),
    ).toBe(2);
    expect(
      await dryRunCommand(
        ['planner', 'dry-run', '--universe', '11111111-1111-4111-8111-111111111111', '--extra'],
        print,
        () => undefined,
      ),
    ).toBe(2);
    expect(printed).toHaveLength(4);
    for (const result of printed) expect(result).toMatchObject({ result: 'usage' });
  });
});
