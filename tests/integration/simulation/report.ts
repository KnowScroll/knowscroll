import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SimConfig } from './config.js';
import { INVARIANTS, type InvariantId, type Violation } from './invariants.js';
import { KNOWN_FAILURES, explainedBy } from './known-failures.js';
import type { Library } from './library.js';
import type { PersonaMetrics } from './metrics.js';

/** The directory the reports go to: a CI artifact. `KS_SIM_OUTPUT` overrides it. */
export function outputDirectory(env: NodeJS.ProcessEnv = process.env): string {
  return env['KS_SIM_OUTPUT'] ?? join(dirname(fileURLToPath(import.meta.url)), 'output');
}

export interface InvariantSummary {
  readonly id: InvariantId;
  readonly name: string;
  readonly violations: number;
  readonly unexpected: number;
  /** Known failures of this invariant and how many violations of the run each explains. */
  readonly known: readonly { readonly id: string; readonly slice: string; readonly reproduced: number }[];
}

/** What one test file (one world, one library) measured. */
export interface GroupReport {
  readonly group: string;
  readonly lab: {
    readonly version: 1;
    readonly size: string;
    readonly seed: number;
    readonly composerPolicy: string;
    readonly commit: string | null;
  };
  readonly library: {
    readonly units: number;
    readonly scrolls: number;
    readonly reels: number;
    readonly topics: number;
  };
  /** Calls the labelled fixture model answered for the Planner and the Cartographer. None left the process. */
  readonly fixtureModelCalls: { readonly planner: number; readonly cartographer: number };
  readonly personas: readonly PersonaMetrics[];
  readonly invariants: readonly InvariantSummary[];
  /** The first violations of each code, with their messages, so a reader can see why without the run. */
  readonly examples: readonly {
    readonly invariant: InvariantId;
    readonly code: string;
    readonly cause?: string;
    readonly count: number;
    readonly message: string;
  }[];
  readonly seconds: number;
}

export function summariseInvariants(violations: readonly Violation[]): InvariantSummary[] {
  return (Object.keys(INVARIANTS) as InvariantId[]).map((id) => {
    const mine = violations.filter((violation) => violation.invariant === id);
    return {
      id,
      name: INVARIANTS[id].name,
      violations: mine.length,
      unexpected: mine.filter((violation) => explainedBy(violation) === undefined).length,
      known: KNOWN_FAILURES.filter((entry) => entry.invariant === id).map((entry) => ({
        id: entry.id,
        slice: entry.slice,
        reproduced: mine.filter((violation) => entry.matches(violation)).length,
      })),
    };
  });
}

const causeOf = (violation: Violation): string | undefined => {
  const cause = violation.detail['cause'];
  return typeof cause === 'string' ? cause : undefined;
};

export function examplesOf(violations: readonly Violation[]): GroupReport['examples'] {
  const byCode = new Map<string, Violation[]>();
  for (const violation of violations) {
    const key = `${violation.invariant}/${violation.code}/${causeOf(violation) ?? ''}`;
    byCode.set(key, [...(byCode.get(key) ?? []), violation]);
  }
  return [...byCode.values()].map((group) => ({
    invariant: group[0]!.invariant,
    code: group[0]!.code,
    ...(causeOf(group[0]!) === undefined ? {} : { cause: causeOf(group[0]!)! }),
    count: group.length,
    message: group[0]!.message,
  }));
}

export function buildGroupReport(input: {
  readonly group: string;
  readonly config: SimConfig;
  readonly library: Library;
  readonly personas: readonly PersonaMetrics[];
  readonly violations: readonly Violation[];
  readonly fixtureModelCalls: GroupReport['fixtureModelCalls'];
  readonly seconds: number;
}): GroupReport {
  return {
    group: input.group,
    lab: {
      version: 1,
      size: input.config.size,
      seed: input.config.seed,
      composerPolicy: input.config.composerPolicy,
      commit: process.env['GITHUB_SHA'] ?? null,
    },
    library: {
      units: input.library.units.length,
      scrolls: input.library.scrollCount,
      reels: input.library.reelCount,
      topics: input.library.topics.length,
    },
    fixtureModelCalls: input.fixtureModelCalls,
    personas: input.personas,
    invariants: summariseInvariants(input.violations),
    examples: examplesOf(input.violations),
    seconds: Math.round(input.seconds),
  };
}

export function writeGroupReport(report: GroupReport, directory = outputDirectory()): void {
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, `report-${report.group}.json`), `${JSON.stringify(report, null, 2)}\n`);
}

const percent = (value: number) => `${String(Math.round(value * 100))}%`;
const cell = (value: number | null) => (value === null ? 'never' : String(value));

/** A short markdown summary of one or more group reports, for the job summary and the artifact. */
export function markdownOf(reports: readonly GroupReport[]): string {
  const first = reports[0];
  if (first === undefined) return '# Algorithm simulation lab\n\nNo group report was written.\n';
  const lines: string[] = [
    '# Algorithm simulation lab',
    '',
    `Size \`${first.lab.size}\`, seed ${String(first.lab.seed)}, Composer policy \`${first.lab.composerPolicy}\`. Fixture library and a labelled fixture model: this measures the code, not real content or real people.`,
    '',
    '## Invariants',
    '',
    '| Invariant | Violations | Unexpected | Known failures reproduced (slice) |',
    '| --- | ---: | ---: | --- |',
  ];
  for (const id of Object.keys(INVARIANTS) as InvariantId[]) {
    const rows = reports.flatMap((report) => report.invariants.filter((entry) => entry.id === id));
    const known = new Map<string, { slice: string; reproduced: number }>();
    for (const row of rows)
      for (const entry of row.known)
        known.set(entry.id, {
          slice: entry.slice,
          reproduced: (known.get(entry.id)?.reproduced ?? 0) + entry.reproduced,
        });
    lines.push(
      `| ${id} ${INVARIANTS[id].name} | ${String(rows.reduce((total, row) => total + row.violations, 0))} | ${String(rows.reduce((total, row) => total + row.unexpected, 0))} | ${[...known].map(([name, entry]) => `${name} x${String(entry.reproduced)} (${entry.slice})`).join('; ') || 'none'} |`,
    );
  }
  lines.push('', '## Personas', '');
  lines.push(
    '| Persona | Encounters | Qualified | Repeat rate | Already met | Repeats while unseen | Last resort | Topics | Systems | First system | First planet | Empty | Decisions | Geography runs | Planner runs | Seconds |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  );
  for (const report of reports)
    for (const p of report.personas)
      lines.push(
        `| ${p.persona} | ${String(p.encounters)} | ${String(p.qualifiedEncounters)} | ${percent(p.repeatRate)} | ${percent(p.alreadyMetRate)} | ${String(p.repeatsWhileUnseen)} | ${String(p.lastResortRepeats)} | ${String(p.distinctTopics)} | ${String(p.distinctSystems)} | ${cell(p.offersUntilFirstSystem)} | ${cell(p.offersUntilFirstPlanet)} | ${String(p.emptyOffers)} | ${String(p.decisions)} | ${String(p.geographyRuns)} | ${String(p.plannerRuns)} | ${String(Math.round(p.millis.session / 1000))} |`,
      );
  lines.push('', '## Violations by code', '');
  const examples = reports.flatMap((report) => report.examples);
  if (examples.length === 0) lines.push('None.');
  for (const example of examples)
    lines.push(
      `- ${example.invariant} \`${example.code}\`${example.cause === undefined ? '' : ` (${example.cause})`} x${String(example.count)}: ${example.message}`,
    );
  lines.push('', '## Libraries', '');
  for (const report of reports)
    lines.push(
      `- ${report.group}: ${String(report.library.units)} explanation units (${String(report.library.scrolls)} Scrolls, ${String(report.library.reels)} Reel twins) over ${String(report.library.topics)} catalogue planets, ${String(report.seconds)} s.`,
    );
  lines.push('');
  return lines.join('\n');
}
