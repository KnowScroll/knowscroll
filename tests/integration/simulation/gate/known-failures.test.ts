import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { KNOWN_FAILURES } from '../known-failures.js';
import { outputDirectory, type GroupReport } from '../report.js';

/**
 * Every known failure must still be reproduced by the lab run as a whole. It runs after the lab files, on their reports
 * (`pnpm test:simulation` runs both), so a failure that one file happened to see no instance of cannot fail it: only a
 * run in which no file reproduced it, which is what a fix looks like. It needs no database.
 */
const directory = outputDirectory();
const reports: GroupReport[] = existsSync(directory)
  ? readdirSync(directory)
      .filter((name) => /^report-.*\.json$/.test(name))
      .sort()
      .map((name) => JSON.parse(readFileSync(join(directory, name), 'utf8')) as GroupReport)
  : [];

/**
 * The groups a full lab run writes, one per file of the lab: `readers` holds the Reel personas, `formation` the exoplanets
 * reader, `binge` the binge reader. A renamed file or persona must not let a known failure go unjudged without a word, so
 * a full run (always in CI) has to have all of them.
 */
const EXPECTED_GROUPS = ['binge', 'formation', 'readers'];
const groups = new Set(reports.map((report) => report.group));
const ran = new Set(reports.flatMap((report) => report.personas.map((persona) => persona.persona)));
const requireFullRun = (process.env['CI'] ?? '') !== '' || EXPECTED_GROUPS.every((group) => groups.has(group));

describe('known failures of the current code', () => {
  it('has the reports of a lab run to judge', () => {
    expect(
      reports.length,
      `no report-<group>.json in ${directory}: run the lab first (pnpm test:simulation)`,
    ).toBeGreaterThan(0);
  });

  it.skipIf(!requireFullRun)('has the report of every file of the lab when the run was meant to be whole', () => {
    expect(
      EXPECTED_GROUPS.filter((group) => !groups.has(group)),
      `lab files that wrote no report (a renamed file or group, or a partial run in CI): ${[...groups].join(', ') || 'none'} wrote one`,
    ).toEqual([]);
  });

  for (const entry of KNOWN_FAILURES) {
    // An entry with a scenario is judged when a persona of it ran. In a whole run (CI always) it must have: a renamed
    // persona or file would otherwise skip the entry silently. A partial local run is not blamed for what it skipped.
    const scenario = entry.reproducedBy ?? entry.personas;
    const scenarioRan = scenario === undefined || scenario.some((persona) => ran.has(persona));
    it.skipIf(reports.length === 0 || (!scenarioRan && !requireFullRun))(
      `${entry.id} (slice ${entry.slice}) still reproduces in the lab run`,
      () => {
        expect(
          scenarioRan,
          `The scenario of known failure ${entry.id} did not run (${(scenario ?? []).join(', ')}): was a persona or lab file renamed?`,
        ).toBe(true);
        const reproduced = reports
          .flatMap((report) => report.invariants)
          .flatMap((summary) => summary.known)
          .filter((known) => known.id === entry.id)
          .reduce((total, known) => total + known.reproduced, 0);
        expect(
          reproduced,
          `Known failure ${entry.id} was not reproduced by any lab file, so slice ${entry.slice} may have fixed it: delete its entry from known-failures.ts so invariant ${entry.invariant} becomes a gate.\nIt was: ${entry.reason}`,
        ).toBeGreaterThan(0);
      },
    );
  }
});
