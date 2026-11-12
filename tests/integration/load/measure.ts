import pg from 'pg';
import { databaseUrl } from '../support/admin.js';

/** Percentiles by nearest rank, in milliseconds. */
export interface Summary {
  readonly n: number;
  readonly p50: number;
  readonly p95: number;
  readonly max: number;
  readonly mean: number;
}

export function summarise(samples: readonly number[]): Summary {
  if (samples.length === 0) return { n: 0, p50: Number.NaN, p95: Number.NaN, max: Number.NaN, mean: Number.NaN };
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = (p: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))]!;
  return {
    n: sorted.length,
    p50: rank(0.5),
    p95: rank(0.95),
    max: sorted[sorted.length - 1]!,
    mean: sorted.reduce((sum, value) => sum + value, 0) / sorted.length,
  };
}

/** Times `fn` in milliseconds. */
export async function timed<T>(fn: () => Promise<T>): Promise<{ readonly value: T; readonly ms: number }> {
  const startedAt = performance.now();
  const value = await fn();
  return { value, ms: performance.now() - startedAt };
}

/** One statement the application sent to PostgreSQL while a path ran. */
export interface Captured {
  readonly text: string;
  readonly values: readonly unknown[] | undefined;
  readonly ms: number;
}

let sink: Captured[] | undefined;
let patched = false;

type QueryFn = (this: pg.Client, ...args: unknown[]) => unknown;

/**
 * Records every statement the application's connections send while `fn` runs (text, parameters, wall time as the driver saw it), by
 * wrapping `pg.Client.prototype.query` once. It is the way to find "the slowest query of a path" without `pg_stat_statements`, which a
 * disposable server need not preload. One capture at a time.
 */
export async function capturing<T>(
  fn: () => Promise<T>,
): Promise<{ readonly value: T; readonly queries: readonly Captured[] }> {
  if (!patched) {
    patched = true;
    // eslint-disable-next-line @typescript-eslint/unbound-method -- the wrapper below applies it with the caller's `this`
    const original = pg.Client.prototype.query as unknown as QueryFn;
    (pg.Client.prototype as unknown as { query: QueryFn }).query = function (this: pg.Client, ...args: unknown[]) {
      const target = sink;
      if (target === undefined) return original.apply(this, args);
      const config = args[0];
      const text = typeof config === 'string' ? config : ((config as { text?: string } | null)?.text ?? '');
      const values =
        typeof config === 'string' ? (args[1] as unknown[] | undefined) : (config as { values?: unknown[] }).values;
      const startedAt = performance.now();
      const out: unknown = original.apply(this, args);
      if (out !== null && typeof out === 'object' && 'then' in out && typeof out.then === 'function') {
        const done = () => {
          target.push({ text, values, ms: performance.now() - startedAt });
        };
        (out as Promise<unknown>).then(done, done);
      }
      return out;
    };
  }
  const mine: Captured[] = [];
  sink = mine;
  try {
    const value = await fn();
    return { value, queries: mine };
  } finally {
    sink = undefined;
  }
}

const NOISE = /^\s*(begin|commit|rollback|set |select set_config|savepoint|release|show |lock |select pg_advisory)/i;
const EXPLAINABLE = /^\s*(select|with|insert|update|delete)\b/i;

/** The statement that took longest, ignoring transaction plumbing. */
export function slowest(queries: readonly Captured[]): Captured | undefined {
  return queries
    .filter((query) => !NOISE.test(query.text) && EXPLAINABLE.test(query.text))
    .reduce<Captured | undefined>(
      (best, query) => (best === undefined || query.ms > best.ms ? query : best),
      undefined,
    );
}

export interface Explained {
  readonly sql: string;
  readonly capturedMs: number;
  readonly queriesInPath: number;
  /** The statement shapes (parameters and whitespace removed) that took the most time in all, over the whole sample. */
  readonly shapes: readonly { readonly shape: string; readonly count: number; readonly totalMs: number }[];
  /** All the sample's statement time in milliseconds, as the driver saw it. */
  readonly totalStatementMs: number;
  readonly plan: readonly string[];
  readonly planningMs?: number;
  readonly executionMs?: number;
  readonly rows?: number;
  readonly sharedHit?: number;
  readonly sharedRead?: number;
}

/**
 * `EXPLAIN (ANALYZE, BUFFERS)` of a captured statement with its own parameters, in a transaction that is rolled back (so a write
 * leaves nothing), on its own connection. The plan is of the same statement against the same data, run once more after the path:
 * its timings are those of a warm repeat, and the captured wall time is what the path saw.
 */
function shapesOf(queries: readonly Captured[]): Pick<Explained, 'shapes' | 'totalStatementMs'> {
  const byShape = new Map<string, { count: number; totalMs: number }>();
  for (const query of queries) {
    if (NOISE.test(query.text)) continue;
    const shape = query.text.replaceAll(/\$\d+/g, '$').replaceAll(/\s+/g, ' ').trim().slice(0, 110);
    const seen = byShape.get(shape) ?? { count: 0, totalMs: 0 };
    byShape.set(shape, { count: seen.count + 1, totalMs: seen.totalMs + query.ms });
  }
  return {
    shapes: [...byShape]
      .map(([shape, v]) => ({ shape, ...v }))
      .sort((a, b) => b.totalMs - a.totalMs)
      .slice(0, 4),
    totalStatementMs: queries.reduce((sum, query) => sum + query.ms, 0),
  };
}

export async function explain(databaseName: string, query: Captured, sample: readonly Captured[]): Promise<Explained> {
  const queriesInPath = sample.length;
  const { shapes, totalStatementMs } = shapesOf(sample);
  const client = new pg.Client({
    connectionString: databaseUrl(databaseName),
    application_name: 'knowscroll-load-explain',
  });
  await client.connect();
  try {
    await client.query('begin');
    await client.query("set local statement_timeout = '120s'");
    const result = await client.query<{ 'QUERY PLAN': string }>(
      `explain (analyze, buffers) ${query.text}`,
      query.values as unknown[] | undefined,
    );
    await client.query('rollback');
    const plan = result.rows.map((row) => row['QUERY PLAN']);
    const top = plan[0] ?? '';
    const rows = /actual time=[\d.]+\.\.[\d.]+ rows=(\d+)/.exec(top)?.[1];
    const buffers = plan.find((line) => line.trim().startsWith('Buffers:'));
    const hit = buffers === undefined ? undefined : /shared hit=(\d+)/.exec(buffers)?.[1];
    const read = buffers === undefined ? undefined : /read=(\d+)/.exec(buffers)?.[1];
    const planning = plan.find((line) => line.startsWith('Planning Time:'))?.match(/([\d.]+) ms/)?.[1];
    const execution = plan.find((line) => line.startsWith('Execution Time:'))?.match(/([\d.]+) ms/)?.[1];
    return {
      sql: query.text.replaceAll(/\s+/g, ' ').trim(),
      capturedMs: query.ms,
      queriesInPath,
      shapes,
      totalStatementMs,
      plan,
      ...(planning === undefined ? {} : { planningMs: Number(planning) }),
      ...(execution === undefined ? {} : { executionMs: Number(execution) }),
      ...(rows === undefined ? {} : { rows: Number(rows) }),
      ...(hit === undefined ? {} : { sharedHit: Number(hit) }),
      ...(read === undefined ? {} : { sharedRead: Number(read) }),
    };
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    return {
      sql: query.text.replaceAll(/\s+/g, ' ').trim(),
      capturedMs: query.ms,
      queriesInPath,
      shapes,
      totalStatementMs,
      plan: [`EXPLAIN failed: ${error instanceof Error ? error.message.slice(0, 200) : 'unknown'}`],
    };
  } finally {
    await client.end();
  }
}
