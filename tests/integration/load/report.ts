import type { Explained, Summary } from './measure.js';

/** A budget the issue's design target is judged against (milliseconds, on the stated statistic). */
export interface Budget {
  readonly label: string;
  readonly limitMs: number;
  readonly statistic: 'p95' | 'max';
}

export interface PathResult {
  readonly name: string;
  readonly summary: Summary;
  readonly budget?: Budget;
  /** Extra facts of the path: outcome counts, sizes, what a read answered. */
  readonly notes: readonly string[];
  readonly explain?: Explained;
}

const fmt = (value: number) => (Number.isFinite(value) ? (value < 10 ? value.toFixed(2) : value.toFixed(0)) : 'n/a');

export function verdict(result: PathResult): 'pass' | 'FAIL' | 'n/a' {
  if (!result.budget) return 'n/a';
  const value = result.summary[result.budget.statistic];
  return Number.isFinite(value) && value <= result.budget.limitMs ? 'pass' : 'FAIL';
}

export function table(results: readonly PathResult[]): string {
  const rows = results.map((result) => {
    const s = result.summary;
    const b = result.budget;
    return `| ${result.name} | ${String(s.n)} | ${fmt(s.p50)} | ${fmt(s.p95)} | ${fmt(s.max)} | ${
      b ? `${b.label}: ${b.statistic} ≤ ${String(b.limitMs)} ms` : '-'
    } | ${verdict(result)} |`;
  });
  return [
    '| Path | n | p50 ms | p95 ms | max ms | Budget | Result |',
    '| --- | ---: | ---: | ---: | ---: | --- | --- |',
    ...rows,
  ].join('\n');
}

export function explainBlock(result: PathResult, maxLines = 28): string {
  const e = result.explain;
  if (!e) return '';
  const head = [
    `**${result.name}: slowest statement** (${fmt(e.capturedMs)} ms as the path saw it, one of ${String(e.queriesInPath)} statements)`,
    '',
    '```sql',
    e.sql.length > 700 ? `${e.sql.slice(0, 700)} …` : e.sql,
    '```',
    '',
    `Replayed under \`EXPLAIN (ANALYZE, BUFFERS)\`: ${e.executionMs === undefined ? 'n/a' : `${fmt(e.executionMs)} ms execution`}, ${
      e.planningMs === undefined ? '' : `${fmt(e.planningMs)} ms planning, `
    }${e.rows === undefined ? '' : `${String(e.rows)} rows at the top node, `}${
      e.sharedHit === undefined ? '' : `${String(e.sharedHit)} shared buffers hit, `
    }${e.sharedRead === undefined ? '' : `${String(e.sharedRead)} read`}.`,
    '',
    `Where the sample's statement time went (${String(e.queriesInPath)} statements, ${fmt(e.totalStatementMs)} ms in all, by statement shape):`,
    '',
    ...e.shapes.map(
      (shape) =>
        `- ${fmt(shape.totalMs)} ms over ${String(shape.count)} calls: \`${shape.shape}${shape.shape.length >= 110 ? ' …' : ''}\``,
    ),
    '',
    '```text',
    ...e.plan.slice(0, maxLines),
    ...(e.plan.length > maxLines ? [`… (${String(e.plan.length - maxLines)} more lines)`] : []),
    '```',
  ];
  return head.join('\n');
}
