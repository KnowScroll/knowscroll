import {
  DEFAULT_GAP_POLICY,
  SIGNAL_WINDOW_DAYS,
  gapIdentity,
  mayReopen,
  mergeDemand,
  newReadersOf,
  nextRound,
  priorityOf,
  settleCommissioned,
  structuralGaps,
  type GapCandidate,
  type GapKind,
  type GapTarget,
  type PlanetFacts,
} from '../domain/gaps.js';
import { catalogueTopics, utcDay } from './gap-signals.js';
import type { GapScanPorts, GapScanResult, ScanGaps } from './gap-ports.js';

const DAY_MS = 86_400_000;

/**
 * The scheduled scan (#674, D-414, `supply.scan-gaps`, every fifteen minutes): SQL only, no model. It counts the readers' new marks
 * into the daily counters, finds the structural holes of the library (a planet with fewer than three released explanations or two
 * covered facets, a facet with none, a planet below the depth target) and merges the counted signals into them, then makes the table
 * say the same: a hole with no open gap gets one (one for each key, never two), a gap whose hole is gone is closed, a gap whose
 * recipes were released is closed, and one whose recipes did not get released goes back (a rejected take that may be taken again: to
 * `briefed`, so the stored recipe is commissioned again with no model call; every recipe ended: to `open`) with a failed production round
 * counted, and past the bound (`maxRounds`) it is rejected as `production_rejected`. A key rejected before is
 * opened again only by readers who pointed to it since, when the reason allows and the cooldown has passed. It also deletes what is past
 * its retention. One scan runs at a time (an advisory lock), and a second one finds the first's work done.
 *
 * Nothing here is evidence: no ranking, plan or place reads the gaps or the counters.
 */
export function makeScanGaps(ports: GapScanPorts): ScanGaps {
  return async (): Promise<GapScanResult> => {
    if (!ports.enabled) return { kind: 'disabled' };
    const now = ports.now();
    const catalogue = catalogueTopics();
    const coverage = await ports.readCoverage();
    const facts = new Map<string, PlanetFacts>(
      coverage.planets.map((planet) => [
        planet.topicId,
        { units: planet.units, facets: new Map(planet.facets.map((facet) => [facet.facetId, facet.units])) },
      ]),
    );
    const structural = structuralGaps(catalogue, facts, { ...DEFAULT_GAP_POLICY, depthTarget: ports.depthTarget });
    const outcome = await ports.store.exclusively(async (tx) => {
      const counted = await tx.rollUpMarks();
      const sinceDay = utcDay(new Date(now.getTime() - (SIGNAL_WINDOW_DAYS - 1) * DAY_MS));
      const signals = await tx.readSignals(sinceDay);
      const demand = new Map<string, { planet: string; facet?: string; readers: number }>();
      for (const signal of signals) {
        const key = `${signal.planet}\u0000${signal.facet ?? ''}`;
        const previous = demand.get(key);
        demand.set(key, {
          planet: signal.planet,
          ...(signal.facet === undefined ? {} : { facet: signal.facet }),
          readers: (previous?.readers ?? 0) + signal.readers,
        });
      }
      const candidates = mergeDemand(catalogue, structural, [...demand.values()]);
      const live = await tx.readLiveGaps();
      const rejected = await tx.readLastRejected(candidates);
      let opened = 0;
      let refreshed = 0;
      let closed = 0;
      let reopened = 0;
      let rebriefed = 0;
      let rejectedNow = 0;
      /** The holes whose gap the circuit breaker just rejected: they do not open a fresh gap in this scan. */
      const exhausted = new Set<string>();
      const same = (gap: GapTarget & { readonly kind: GapKind }, candidate: GapCandidate) =>
        gap.kind === candidate.kind && gap.planet === candidate.planet && gap.facet === candidate.facet;
      // First what the library has settled: a gap whose hole is gone is closed, and a commissioned gap whose recipes were released
      // is closed, or goes back to open (every recipe ended) or to briefed (a take was rejected and another may start) with the round counted. A key whose hole remains then gets a fresh gap.
      const found = new Set(candidates.map((candidate) => gapIdentity(candidate.kind, candidate)));
      const states = await ports.readRecipeStates(
        live.filter((gap) => gap.status === 'commissioned').flatMap((gap) => gap.recipes),
      );
      const standing = new Set<string>();
      for (const gap of live) {
        const holeRemains = found.has(gapIdentity(gap.kind, gap));
        if (gap.status === 'commissioned') {
          const next = settleCommissioned(gap.recipes.map((key) => states.get(key)));
          if (next === 'close') {
            await tx.closeGap(gap.id, 'released', now);
            closed += 1;
            continue;
          }
          if (!holeRemains) {
            await tx.closeGap(gap.id, 'filled', now);
            closed += 1;
            continue;
          }
          if (next === 'rebrief' || next === 'reopen') {
            // A failed production round: counted, and past the bound the gap is rejected instead of tried again.
            const round = nextRound(gap.rounds, ports.maxRounds);
            if (round.exhausted) {
              await tx.rejectGap(gap.id, 'production_rejected', round.rounds, now);
              exhausted.add(gapIdentity(gap.kind, gap));
              rejectedNow += 1;
              continue;
            }
            await tx.endRound(gap.id, next === 'rebrief' ? 'briefed' : 'open', round.rounds, now);
            if (next === 'rebrief') rebriefed += 1;
            else reopened += 1;
          }
        } else if (!holeRemains) {
          await tx.closeGap(gap.id, 'filled', now);
          closed += 1;
          continue;
        }
        standing.add(gap.id);
      }
      for (const candidate of candidates) {
        const priority = priorityOf(candidate.severity, candidate.readers);
        if (exhausted.has(gapIdentity(candidate.kind, candidate))) continue;
        const existing = live.find((gap) => standing.has(gap.id) && same(gap, candidate));
        if (existing) {
          await tx.refreshGap(existing.id, candidate, priority, now);
          refreshed += 1;
          continue;
        }
        const before = rejected.find((row) => same(row, candidate));
        if (before && !mayReopen(before, newReadersOf(signals, candidate, utcDay(before.endedAt)), now)) continue;
        if (await tx.createGap(candidate, priority, ports.newId(), now)) opened += 1;
      }
      const purged = await tx.purge(now);
      return {
        counted,
        opened,
        refreshed,
        closed,
        reopened,
        rebriefed,
        rejected: rejectedNow,
        purged: purged.marks + purged.signals + purged.gaps,
      };
    });
    return outcome === undefined ? { kind: 'busy' } : { kind: 'scanned', ...outcome };
  };
}
