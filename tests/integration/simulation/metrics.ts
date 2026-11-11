import type { PersonaResult } from './run.js';

/** What one persona's session measured. Every number comes from the run or the database, none from a threshold. */
export interface PersonaMetrics {
  readonly persona: string;
  readonly title: string;
  readonly encounters: number;
  readonly qualifiedEncounters: number;
  readonly moves: number;
  /** Moves the system answered with no offer (exhausted, pending or refused). */
  readonly emptyOffers: number;
  /** First offers of discover and vertical moves that were an explanation the person had already met, over all of them. */
  readonly repeatRate: number;
  /** Offered slots that were already met, over all slots the system offered. */
  readonly alreadyMetRate: number;
  /** Met offers made while an unseen explanation was left out (what I1 forbids). */
  readonly repeatsWhileUnseen: number;
  /** Met offers made when nothing unseen was left to offer (allowed, counted). */
  readonly lastResortRepeats: number;
  readonly unitsMet: number;
  readonly libraryUnits: number;
  readonly distinctTopics: number;
  readonly distinctSystems: number;
  /** Distinct topics (systems) over activated encounters: 1 means every encounter was somewhere new. */
  readonly topicDiversity: number;
  readonly systemDiversity: number;
  /** Encounters completed when the first system (planet) showed on the person's map; null when none did. */
  readonly offersUntilFirstSystem: number | null;
  readonly offersUntilFirstPlanet: number | null;
  readonly places: { readonly systems: number; readonly planets: number; readonly regions: number };
  readonly decisions: number;
  readonly decisionKiBMean: number;
  readonly geographyRuns: number;
  /** Geography runs by `status/outcome`, so a new outcome shows in the report. */
  readonly geographyOutcomes: Readonly<Record<string, number>>;
  readonly plannerRuns: number;
  readonly plannerOpportunities: { readonly existing: number; readonly missingSupply: number };
  readonly supplyRows: Readonly<Record<string, number>>;
  /** Jobs a Planner demand queued for model production, which the lab does not run. */
  readonly productionJobsQueued: number;
  readonly jobsHandled: Readonly<Record<string, number>>;
  readonly jobFailures: number;
  readonly millis: {
    readonly session: number;
    readonly navigateMean: number;
    readonly navigateP95: number;
    readonly activateMean: number;
    readonly ingestMean: number;
    readonly drainMean: number;
    readonly settleDrains: number;
  };
}

const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0);
const ratio = (part: number, whole: number) => (whole === 0 ? 0 : Math.round((part / whole) * 1000) / 1000);
const round = (value: number) => Math.round(value);
const percentile = (values: readonly number[], p: number) => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)]!;
};

export function metricsOf(result: PersonaResult, libraryUnits: number): PersonaMetrics {
  const { run, db } = result;
  const chosen = run.moves.filter(
    (move) => move.status === 'ready' && (move.move === 'discover' || move.move === 'vertical'),
  );
  const slots = chosen.flatMap((move) => move.offers.map((offer) => ({ move, offer })));
  const firstOffers = chosen.map((move) => move.offers[0]!);
  const topics = new Set(run.encounters.map((encounter) => encounter.offer.topicId));
  const systems = new Set(run.encounters.map((encounter) => encounter.offer.systemId));
  const encounters = run.encounters.length;
  const lastFormation = run.formation[run.formation.length - 1];
  const firstWith = (pick: (point: (typeof run.formation)[number]) => number) =>
    run.formation.find((point) => pick(point) > 0)?.encounter ?? null;
  const navigateTimes = run.moves.map((move) => move.millis);
  const supplyRows: Record<string, number> = {};
  for (const row of db.supplyRows) supplyRows[`${row.origin}:${row.state}`] = row.n;
  return {
    persona: run.spec.id,
    title: run.spec.title,
    encounters,
    qualifiedEncounters: run.encounters.filter((encounter) => encounter.qualification === 'qualified').length,
    moves: run.moves.length,
    emptyOffers: run.moves.filter((move) => move.status !== 'ready').length,
    repeatRate: ratio(firstOffers.filter((offer) => offer.alreadyMet).length, firstOffers.length),
    alreadyMetRate: ratio(slots.filter((slot) => slot.offer.alreadyMet).length, slots.length),
    repeatsWhileUnseen: slots.filter((slot) => slot.offer.alreadyMet && slot.move.unseenLeftOut > 0).length,
    lastResortRepeats: slots.filter((slot) => slot.offer.alreadyMet && slot.move.unseenLeftOut === 0).length,
    unitsMet: run.met.size,
    libraryUnits,
    distinctTopics: topics.size,
    distinctSystems: systems.size,
    topicDiversity: ratio(topics.size, encounters),
    systemDiversity: ratio(systems.size, encounters),
    offersUntilFirstSystem: firstWith((point) => point.systems),
    offersUntilFirstPlanet: firstWith((point) => point.planets),
    places: {
      systems: lastFormation?.systems ?? 0,
      planets: lastFormation?.planets ?? 0,
      regions: lastFormation?.regions ?? 0,
    },
    decisions: db.decisions,
    decisionKiBMean: db.decisions === 0 ? 0 : Math.round(db.decisionBytes / db.decisions / 1024),
    geographyRuns: sum(db.geographyRuns.map((row) => row.n)),
    geographyOutcomes: Object.fromEntries(
      db.geographyRuns.map((row) => [`${row.status}/${row.outcome ?? 'none'}`, row.n]),
    ),
    plannerRuns: sum(db.plannerRuns.map((row) => row.n)),
    plannerOpportunities: db.plannerOpportunities,
    supplyRows,
    productionJobsQueued: sum(db.productionJobs.map((row) => row.n)),
    jobsHandled: run.drains.handled,
    jobFailures: sum(Object.values(run.drains.failures)),
    millis: {
      session: round(result.millis),
      navigateMean: round(sum(navigateTimes) / Math.max(1, navigateTimes.length)),
      navigateP95: round(percentile(navigateTimes, 0.95)),
      activateMean: round(run.timings.activate / Math.max(1, encounters)),
      ingestMean: round(run.timings.ingest / Math.max(1, encounters)),
      drainMean: round(run.timings.drain / Math.max(1, encounters)),
      settleDrains: result.settleDrains,
    },
  };
}
