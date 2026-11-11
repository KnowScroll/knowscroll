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

describe('known failures of the current code', () => {
  it('has the reports of a lab run to judge', () => {
    expect(
      reports.length,
      `no report-<group>.json in ${directory}: run the lab first (pnpm test:simulation)`,
    ).toBeGreaterThan(0);
  });

  const ran = new Set(reports.flatMap((report) => report.personas.map((persona) => persona.persona)));
  for (const entry of KNOWN_FAILURES) {
    // An entry with a scenario is judged only when a persona of it ran, and one that needs a big library only when there
    // was one, so a partial or small run is not blamed for what it could not show.
    const scenario = entry.reproducedBy ?? entry.personas;
    const applicable =
      (scenario === undefined || scenario.some((persona) => ran.has(persona))) &&
      (entry.needs === undefined || reports.some((report) => entry.needs!(report)));
    it.skipIf(!applicable || reports.length === 0)(
      `${entry.id} (slice ${entry.slice}) still reproduces in the lab run`,
      () => {
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
