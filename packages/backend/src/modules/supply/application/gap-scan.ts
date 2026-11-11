import {
  DEFAULT_GAP_POLICY,
  SIGNAL_WINDOW_DAYS,
  gapIdentity,
  mayReopen,
  mergeDemand,
  newReadersOf,
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
 * recipes were released is closed, and one whose recipes all ended without a release goes back to `open`. A key rejected before is
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
      const same = (gap: GapTarget & { readonly kind: GapKind }, candidate: GapCandidate) =>
        gap.kind === candidate.kind && gap.planet === candidate.planet && gap.facet === candidate.facet;
      // First what the library has settled: a gap whose hole is gone is closed, and a commissioned gap whose recipes were released
      // is closed, or goes back to open when every one of them ended without a release. A key whose hole remains then gets a fresh gap.
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
          if (next === 'reopen' && holeRemains) {
            await tx.reopenGap(gap.id, now);
            reopened += 1;
          } else if (!holeRemains) {
            await tx.closeGap(gap.id, 'filled', now);
            closed += 1;
            continue;
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
      return { counted, opened, refreshed, closed, reopened, purged: purged.marks + purged.signals + purged.gaps };
    });
    return outcome === undefined ? { kind: 'busy' } : { kind: 'scanned', ...outcome };
  };
}
