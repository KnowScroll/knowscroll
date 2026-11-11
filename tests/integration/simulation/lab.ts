import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { simConfig, type SimConfig } from './config.js';
import { INVARIANTS, evaluate, type InvariantId, type Violation } from './invariants.js';
import { KNOWN_FAILURES, explainedBy } from './known-failures.js';
import { metricsOf, type PersonaMetrics } from './metrics.js';
import type { PersonaSpec } from './persona.js';
import { buildGroupReport, writeGroupReport } from './report.js';
import { runSideBySide, runSolo, type PersonaResult } from './run.js';
import { simulationWorld, type SimWorld } from './world.js';

/** One test file of the lab: a world, the personas that live in it, and how its config differs from the run's. */
export interface LabPlan {
  /** Names the report (`report-<group>.json`) and the database. */
  readonly group: string;
  /** Personas that each live a session alone, one after the other. */
  readonly solo?: readonly PersonaSpec[];
  /** Two personas that share the world and take turns, to check isolation. */
  readonly sideBySide?: readonly [PersonaSpec, PersonaSpec];
  readonly config?: (base: SimConfig) => SimConfig;
}

const ORDER = Object.keys(INVARIANTS) as InvariantId[];

/**
 * Registers a lab file: runs the plan's personas against the real modules once, judges every invariant, writes the
 * report, then reports one test per invariant and one per known failure.
 *
 * An invariant's test fails on any violation that no known failure explains, and prints it. A known failure's test
 * fails when its violations are gone ("now fixed"): the slice that fixes the behaviour deletes the entry from
 * `known-failures.ts`, and from then on the invariant is a plain gate.
 */
export function defineLab(plan: LabPlan): void {
  describe(`algorithm simulation lab: ${plan.group}`, () => {
    let world: SimWorld;
    const results: PersonaResult[] = [];
    const violations: Violation[] = [];

    beforeAll(async () => {
      const startedAt = performance.now();
      const config = plan.config ? plan.config(simConfig()) : simConfig();
      world = await simulationWorld(`sim_${plan.group}`, config);
      for (const spec of plan.solo ?? []) results.push(await runSolo(world, spec));
      if (plan.sideBySide) results.push(...(await runSideBySide(world, plan.sideBySide[0], plan.sideBySide[1])));
      for (const result of results) violations.push(...(await evaluate(world, result)));
      const personas: PersonaMetrics[] = results.map((result) => metricsOf(result, world.library.units.length));
      // The report is written before any assertion, so a failing run still leaves its numbers behind.
      writeGroupReport(
        buildGroupReport({
          group: plan.group,
          config,
          library: world.library,
          personas,
          violations,
          fixtureModelCalls: world.modelCalls(),
          seconds: (performance.now() - startedAt) / 1000,
        }),
      );
    }, 280_000);
    afterAll(async () => {
      await world?.close();
    });

    it('built a fixture library over the real catalogue and ran every persona', () => {
      expect(world.library.units.length).toBeGreaterThan(0);
      const ran = results.map((result) => result.run.spec.id).sort();
      const planned = [...(plan.solo ?? []), ...(plan.sideBySide ?? [])].map((spec) => spec.id).sort();
      expect(ran).toEqual(planned);
      for (const result of results) expect(result.run.encounters.length, result.run.spec.id).toBeGreaterThan(0);
    });

    if (plan.sideBySide)
      it('the isolation check can see: it fingerprints the personal tables and sees each person change their own rows', () => {
        for (const result of results.filter((entry) => entry.isolationControl !== undefined)) {
          expect(result.isolationControl!.tables, result.run.spec.id).toBeGreaterThan(5);
          expect(result.isolationControl!.ownChanged, result.run.spec.id).toBeGreaterThan(0);
        }
      });

    for (const id of ORDER)
      it(`${id} ${INVARIANTS[id].name}`, () => {
        const unexpected = violations.filter(
          (violation) => violation.invariant === id && explainedBy(violation) === undefined,
        );
        expect(
          unexpected.slice(0, 20).map((violation) => `${violation.code}: ${violation.message}`),
          `${INVARIANTS[id].statement}\n${String(unexpected.length)} violation(s) that no known failure explains`,
        ).toEqual([]);
      });

    for (const entry of KNOWN_FAILURES) {
      // Which personas live in this file is known from the plan, before any of them has run.
      const here = [...(plan.solo ?? []), ...(plan.sideBySide ?? [])].map((spec) => spec.id);
      if (entry.personas !== undefined && !entry.personas.some((persona) => here.includes(persona))) continue;
      it(`known failure ${entry.id} (slice ${entry.slice}) still reproduces`, () => {
        const reproduced = violations.filter(
          (violation) =>
            violation.invariant === entry.invariant &&
            entry.matches(violation) &&
            (entry.personas === undefined || entry.personas.includes(violation.persona)),
        );
        expect(
          reproduced.length,
          `Known failure ${entry.id} did not reproduce, so slice ${entry.slice} may have fixed it: delete its entry from known-failures.ts so the invariant ${entry.invariant} becomes a gate.\nIt was: ${entry.reason}`,
        ).toBeGreaterThan(0);
      });
    }
  });
}
