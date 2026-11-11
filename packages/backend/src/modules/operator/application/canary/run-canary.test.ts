import { describe, expect, it } from 'vitest';
import {
  RecordingObservationBatchRequestSchema,
  type EncounterOffer,
  type InteractionEvent,
  type NavigationOutcome,
} from '@knowscroll/contracts';
import type { OperatorReads } from '../../domain/canary/evaluate.js';
import { canaryAddressFor, type PersonaId } from '../../domain/canary/personas.js';
import type { ReadingUnit } from '../../domain/canary/reading-plan.js';
import { CanaryApiError, type CanaryApi, type CanaryOptions, type CanaryPorts, type MintResult } from './ports.js';
import { CanaryRunFailed, runCanary } from './run-canary.js';

/**
 * The canary driven against a scripted world, on a virtual clock. The world plays the server's part where the
 * canary's honesty depends on it: it validates each batch against the real wire contract, bounds every claim by the
 * time since activation as the intake does, and qualifies a reading by the policy's own thresholds, so a canary that
 * claimed too much, too little or the wrong shape would fail here before it ever ran against dev.
 */

const ELAPSED_TOLERANCE_MS = 2_000;
const STOP_READ_SHARE = 0.4;

interface LibraryUnit {
  readonly unitId: string;
  readonly assetId: string;
  readonly format: 'scroll' | 'reel';
  readonly seriesId?: string;
  readonly part?: number;
}

const stops: readonly ReadingUnit[] = [
  { id: 'stop-a', kind: 'read', nominalMs: 40_000 },
  { id: 'stop-b', kind: 'read', nominalMs: 30_000 },
  { id: 'call-c', kind: 'call', nominalMs: 10_000 },
  { id: 'stop-d', kind: 'read', nominalMs: 25_000 },
];
const estimatedMs = 120_000;

let assetCounter = 0;
const uuid = (prefix: string): string => {
  assetCounter += 1;
  return `${prefix}-0000-4000-8000-${String(assetCounter).padStart(12, '0')}`;
};

const series = (id: string, parts: number): LibraryUnit[] =>
  Array.from({ length: parts }, (_, index) => ({
    unitId: `${id}-unit-${String(index + 1)}`,
    assetId: uuid('aaaaaaaa'),
    format: 'scroll' as const,
    seriesId: id,
    part: index + 1,
  }));

const reelTwin = (unit: LibraryUnit): LibraryUnit => ({ ...unit, assetId: uuid('bbbbbbbb'), format: 'reel' });

interface Exposure {
  readonly unit: LibraryUnit;
  readonly activatedAt: number;
  readonly activateId: string;
  readonly sequence: number[];
  covered: Map<string, number>;
  dwellMs: number;
  interactions: Set<string>;
}

/** The policy: every read stop visible for 40% of the time its words take; a call locked in; dwell at least 20% of the estimate. */
function qualification(exposure: Exposure): 'qualified' | 'not_qualified' {
  const readStops = stops.filter((stop) => stop.kind === 'read');
  const seen = readStops.every(
    (stop) => (exposure.covered.get(stop.id) ?? 0) >= Math.max(500, stop.nominalMs * STOP_READ_SHARE),
  );
  const called = exposure.interactions.has('call-c');
  return seen && called && exposure.dwellMs / estimatedMs >= 0.2 ? 'qualified' : 'not_qualified';
}

class World {
  now = 0;
  readonly accounts = new Set<string>();
  readonly deleted = new Set<string>();
  readonly batches: { universe: string; events: readonly InteractionEvent[] }[] = [];
  readonly problems: string[] = [];
  private counter = 0;
  /** Every injected failure the scenario wants: `activate`, `discover`... */
  failOn: string | undefined;
  /** The persona whose subject moves are served the unit it is already on, whatever it has met. */
  repeatFor: string | undefined;
  readonly reads: OperatorReads = {
    planner: [{ state: 'accepted', ended: true, ageSeconds: 1 }],
    geography: [{ state: 'accepted', ended: true, ageSeconds: 1 }],
    jobs: [],
    policies: [{ label: 'composer-policy.v2', count: 1 }],
  };

  /** The exposures each universe opened: what the operator view reads evidence from. */
  readonly exposures = new Map<string, Map<string, Exposure>>();

  constructor(readonly library: readonly LibraryUnit[]) {}

  evidence(universeId: string) {
    return [...(this.exposures.get(universeId) ?? new Map<string, Exposure>())].flatMap(([exposureId, exposure]) =>
      exposure.sequence.length === 0
        ? []
        : [
            {
              exposureId,
              revision: exposure.sequence.length,
              qualification: exposure.unit.format === 'reel' ? ('qualified' as const) : qualification(exposure),
            },
          ],
    );
  }

  id(): string {
    this.counter += 1;
    return `00000000-0000-4000-8000-${String(this.counter).padStart(12, '0')}`;
  }

  offer(unit: LibraryUnit, relation: EncounterOffer['relation']): EncounterOffer {
    const hasReel = this.library.some((other) => other.unitId === unit.unitId && other.format === 'reel');
    return {
      offerId: this.id(),
      decisionId: this.id(),
      assetId: unit.assetId,
      assetRevision: 1,
      explanationUnitId: unit.unitId,
      metadata: { kind: unit.format, title: 'Title', summary: 'Summary', language: 'en' },
      relation,
      variants:
        hasReel && unit.format === 'scroll'
          ? [{ status: 'ready', kind: 'reel', assetId: unit.assetId, assetRevision: 1 }]
          : [],
    };
  }
}

function fakeApi(world: World, accountId: string): CanaryApi {
  const universeId = `universe-${accountId}`;
  const met = new Set<string>();
  const exposures = new Map<string, Exposure>();
  world.exposures.set(universeId, exposures);
  const offers = new Map<string, LibraryUnit>();
  let session: string | undefined;
  let revision = 0;
  let current: LibraryUnit | undefined;
  let deletionPolls = 0;

  const discovery = { kind: 'discovery' } as const;
  const ready = (unit: LibraryUnit, relation: EncounterOffer['relation'] = discovery): NavigationOutcome => {
    const offer = world.offer(unit, relation);
    offers.set(offer.offerId, unit);
    session ??= world.id();
    revision += 1;
    return {
      status: 'ready',
      commandId: world.id(),
      sessionId: session,
      intentRevision: revision,
      revision: 0,
      decisionId: offer.decisionId,
      replayed: false,
      offer,
      bufferedOffers: [],
    };
  };
  const exhausted = (reason: 'no_eligible_content' | 'series_boundary'): NavigationOutcome => {
    session ??= world.id();
    // As the server does: an answer that offers nothing still advances the session's intent.
    revision += 1;
    return {
      status: 'exhausted',
      reason,
      commandId: world.id(),
      sessionId: session,
      intentRevision: revision,
      revision: 0,
      decisionId: world.id(),
      replayed: false,
    };
  };
  const repeats = world.repeatFor !== undefined && accountId.includes(world.repeatFor);
  const nextUnseen = (format?: 'scroll' | 'reel'): LibraryUnit | undefined =>
    world.library.find((unit) => !met.has(unit.unitId) && (format === undefined || unit.format === format)) ??
    world.library.find((unit) => !met.has(unit.unitId));
  const guardFailure = (route: string): void => {
    if (world.failOn === route) throw new CanaryApiError(`experience.${route}`, 409, 'CONFLICT');
  };

  return {
    account: { accountId, universeId, privacyEpoch: 1 },
    recordingPolicy: () => Promise.resolve({ on: true, generation: 1 }),
    discover() {
      guardFailure('discover');
      const unit = nextUnseen();
      return Promise.resolve(unit === undefined ? exhausted('no_eligible_content') : ready(unit));
    },
    navigate(input) {
      if (input.expectedIntentRevision !== revision)
        throw new CanaryApiError('experience.navigate', 409, 'INTENT_REVISION_STALE');
      if (input.intent.mode === 'series') {
        const from = current;
        const next = world.library.find(
          (unit) => unit.seriesId === from?.seriesId && unit.part === (from?.part ?? 0) + 1,
        );
        return Promise.resolve(
          next === undefined
            ? exhausted('series_boundary')
            : ready(next, {
                kind: 'series_step',
                seriesId: next.seriesId ?? '',
                seriesRevision: 1,
                part: next.part ?? 1,
              }),
        );
      }
      if (input.intent.mode === 'variant') {
        const twin = world.library.find((unit) => unit.unitId === current?.unitId && unit.format === 'reel');
        return Promise.resolve(
          twin === undefined ? exhausted('no_eligible_content') : ready(twin, { kind: 'format_variant' }),
        );
      }
      const format = input.intent.mode === 'vertical' ? input.intent.format : undefined;
      const unit = repeats && current !== undefined ? current : nextUnseen(format);
      return Promise.resolve(unit === undefined ? exhausted('no_eligible_content') : ready(unit));
    },
    activate(input) {
      guardFailure('activate');
      if (input.expectedIntentRevision !== revision)
        throw new CanaryApiError('experience.activate', 409, 'INTENT_REVISION_STALE');
      const unit = offers.get(input.offerId);
      if (unit === undefined) throw new CanaryApiError('experience.activate', 404, 'NOT_FOUND');
      met.add(unit.unitId);
      current = unit;
      const exposureId = world.id();
      exposures.set(exposureId, {
        unit,
        activatedAt: world.now,
        activateId: input.commandId,
        sequence: [],
        covered: new Map(),
        dwellMs: 0,
        interactions: new Set(),
      });
      revision += 1;
      return Promise.resolve({ exposureId, intentRevision: revision });
    },
    readingUnits: () => Promise.resolve(stops),
    reelGrant: () => Promise.resolve({ durationMs: 30_000, path: '/media/x' }),
    reelBytesServed: () => Promise.resolve(true),
    submitBatch(batch) {
      const parsed = RecordingObservationBatchRequestSchema.parse(batch);
      world.batches.push({ universe: universeId, events: parsed.events });
      for (const event of parsed.events) {
        const exposure = exposures.get(event.exposureId);
        if (
          exposure === undefined ||
          event.sessionId !== exposure.activateId ||
          event.assetId !== exposure.unit.assetId
        ) {
          world.problems.push('lineage');
          continue;
        }
        const cap = world.now - exposure.activatedAt + ELAPSED_TOLERANCE_MS;
        exposure.sequence.push(event.deviceSequence);
        if (event.kind === 'scroll.block_coverage')
          for (const block of event.payload.blocks)
            for (const [from, to] of block.intervalsMs) {
              if (to > cap) world.problems.push('claim_beyond_wall_clock');
              exposure.covered.set(block.blockId, (exposure.covered.get(block.blockId) ?? 0) + (to - from));
            }
        if (event.kind === 'scroll.active_dwell')
          for (const [from, to] of event.payload.activeIntervalsMs) {
            if (to > cap) world.problems.push('claim_beyond_wall_clock');
            exposure.dwellMs += to - from;
          }
        if (event.kind === 'scroll.block_interaction') exposure.interactions.add(event.payload.blockId);
        if (event.kind === 'reel.playback')
          for (const sample of event.payload.samples)
            if (sample.activeMs[1] > cap) world.problems.push('claim_beyond_wall_clock');
      }
      return Promise.resolve({
        version: 'observation-batch.v2' as const,
        result: 'processed' as const,
        recordingGeneration: 1,
        currentGeneration: 1,
        scope: { accountId, privacyEpoch: 1 },
        revision: 0,
        accepted: parsed.events.length,
        duplicates: 0,
        rejected: 0,
        results: parsed.events.map((event) => ({ eventId: event.eventId, status: 'accepted' as const })),
      });
    },
    formation() {
      const qualifiedBySeries = new Map<string, number>();
      for (const exposure of exposures.values())
        if (
          exposure.unit.seriesId !== undefined &&
          exposure.unit.format === 'scroll' &&
          qualification(exposure) === 'qualified'
        )
          qualifiedBySeries.set(exposure.unit.seriesId, (qualifiedBySeries.get(exposure.unit.seriesId) ?? 0) + 1);
      const depth = Math.max(0, ...qualifiedBySeries.values());
      return Promise.resolve({
        reading: {
          dust: depth > 0 ? 1 : 0,
          systems: depth >= 2 ? 1 : 0,
          planets: depth >= 3 ? 1 : 0,
          regions: depth >= 3 ? 1 : 0,
        },
        regions: depth >= 3 ? [{ regionId: world.id(), expectedObjectRevision: 1, expectedGeographyRevision: 1 }] : [],
      });
    },
    openRegion() {
      const unit = nextUnseen('scroll');
      return Promise.resolve(unit === undefined ? { status: 'unavailable' as const } : ready(unit));
    },
    deleteAccount() {
      world.deleted.add(accountId);
      return Promise.resolve();
    },
    deletionState() {
      deletionPolls += 1;
      return Promise.resolve(deletionPolls > 1 ? ('completed' as const) : ('in_progress' as const));
    },
    retryDeletion: () => Promise.resolve(),
  };
}

function portsFor(
  world: World,
  mint: (address: string) => MintResult = () => ({ kind: 'issued', link: 'link' }),
): CanaryPorts {
  return {
    accounts: {
      mint: (address) => {
        const minted = mint(address);
        if (minted.kind === 'issued') world.accounts.add(address);
        return Promise.resolve(minted);
      },
      signIn: () => Promise.resolve(fakeApi(world, [...world.accounts].at(-1) ?? 'none')),
    },
    reads: {
      read: () => Promise.resolve(world.reads),
      evidence: (universeId) => Promise.resolve(world.evidence(universeId)),
    },
    pacer: {
      nowMs: () => world.now,
      sleep: (ms) => {
        world.now += ms;
        return Promise.resolve();
      },
    },
    newId: () => world.id(),
  };
}

const options = (personas: readonly PersonaId[], extra: Partial<CanaryOptions> = {}): CanaryOptions => ({
  personas,
  speed: { kind: 'max' },
  manyReads: 3,
  keep: false,
  waitSeconds: 30,
  addressFor: (persona) => canaryAddressFor('*@test.example', 'abcd1234', persona) ?? '',
  ...extra,
});

describe('runCanary on a scripted world', () => {
  it('drives cold-start and deep-reader honestly, judges them green and deletes both accounts', async () => {
    const world = new World([...series('s1', 3), ...series('s2', 2)]);
    const report = await runCanary(portsFor(world), options(['cold-start', 'deep-reader']));
    expect(report.evaluation.violations).toEqual([]);
    expect(report.evaluation.passed).toBe(true);
    expect(report.pacing).toBe('wall_clock');
    // Nothing the canary claimed went past the wall clock, and every batch was in the real wire shape.
    expect(world.problems).toEqual([]);
    expect(world.batches.length).toBeGreaterThan(2);
    const [cold, deep] = report.evaluation.personas;
    expect(cold).toMatchObject({ persona: 'cold-start', qualified: 2, observations: { rejected: 0 } });
    expect(deep?.seriesDepth).toBeGreaterThanOrEqual(2);
    // Both accounts were deleted through the deletion flow, and the report says so.
    expect(world.deleted).toEqual(world.accounts);
    expect(report.cleanup).toEqual({ kept: false, requested: 2, completed: 2 });
    // Real-time pacing: the virtual clock moved by at least the quickest honest reading.
    expect(world.now).toBeGreaterThan(60_000);
  });

  it('reads at the quickest honest pace and is still counted, and slower is counted too', async () => {
    for (const speed of [{ kind: 'max' }, { kind: 'persona' }, { kind: 'factor', value: 3 }] as const) {
      const world = new World(series('s1', 4));
      const report = await runCanary(portsFor(world), options(['deep-reader'], { speed }));
      expect(report.evaluation.personas[0]?.qualified, JSON.stringify(speed)).toBeGreaterThanOrEqual(3);
      expect(report.evaluation.passed).toBe(true);
    }
  });

  it('keeps the accounts with --keep, and says nothing was deleted', async () => {
    const world = new World(series('s1', 3));
    const report = await runCanary(portsFor(world), options(['cold-start'], { keep: true }));
    expect(world.deleted.size).toBe(0);
    expect(report.cleanup).toEqual({ kept: true, requested: 0, completed: 0 });
    expect(report.evaluation.passed).toBe(true);
  });

  it('watches a Reel for more than 60% of its length, in samples the intake accepts', async () => {
    const [first, second] = series('s1', 2);
    const world = new World([first!, reelTwin(first!), second!]);
    const report = await runCanary(portsFor(world), options(['reel-watcher']));
    expect(report.evaluation.passed).toBe(true);
    expect(report.evaluation.personas[0]?.encounters.reel).toBeGreaterThanOrEqual(1);
    const reelEvents = world.batches.flatMap((batch) => batch.events).filter((event) => event.kind === 'reel.playback');
    const watchedMs = reelEvents.reduce(
      (total, event) =>
        event.kind === 'reel.playback'
          ? total + event.payload.samples.reduce((sum, sample) => sum + (sample.mediaMs[1] - sample.mediaMs[0]), 0)
          : total,
      0,
    );
    expect(watchedMs / 30_000).toBeGreaterThan(0.6);
    expect(world.problems).toEqual([]);
  });

  it('reports a repeat served while unseen content exists, and still deletes the accounts', async () => {
    const world = new World(series('s1', 3));
    world.repeatFor = 'many-reads';
    const report = await runCanary(portsFor(world), options(['many-reads', 'cold-start']));
    expect(report.evaluation.passed).toBe(false);
    expect(report.evaluation.violations.map((violation) => violation.code)).toContain('repeat_while_unseen_exists');
    expect(world.deleted).toEqual(world.accounts);
  });

  it('records a refused route as api_refused, ends only that step, and still cleans up', async () => {
    const world = new World(series('s1', 3));
    world.failOn = 'activate';
    const report = await runCanary(portsFor(world), options(['cold-start']));
    expect(report.evaluation.violations.map((violation) => violation.code)).toContain('api_refused');
    expect(world.deleted).toEqual(world.accounts);
  });

  it('stops with a code when the mint is refused, and deletes the accounts it had already made', async () => {
    const world = new World(series('s1', 3));
    let minted = 0;
    const ports = portsFor(world, () =>
      ++minted === 2 ? { kind: 'refused', reason: 'address_not_allowed' } : { kind: 'issued', link: 'link' },
    );
    const failure = await runCanary(ports, options(['cold-start', 'deep-reader'])).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(CanaryRunFailed);
    expect(failure).toMatchObject({ code: 'mint_refused', reason: 'address_not_allowed' });
    expect(world.deleted.size).toBe(1);
  });

  it('fails the run when the operator reads cannot be made', async () => {
    const world = new World(series('s1', 3));
    const ports = portsFor(world);
    const report = await runCanary(
      { ...ports, reads: { ...ports.reads, read: () => Promise.reject(new Error('db down')) } },
      options(['cold-start']),
    );
    expect(report.evaluation.violations.map((violation) => violation.code)).toContain('operator_reads_failed');
  });

  it('reports a reading whose evidence never appears as not projected, after waiting its bound', async () => {
    const world = new World(series('s1', 3));
    const ports = portsFor(world);
    const report = await runCanary(
      { ...ports, reads: { ...ports.reads, evidence: () => Promise.resolve([]) } },
      options(['cold-start'], { waitSeconds: 20 }),
    );
    const codes = report.evaluation.violations.map((violation) => violation.code);
    expect(codes).toContain('reading_not_projected');
    expect(codes).not.toContain('reading_not_qualified');
  });

  it('waits for evidence to stop moving before it judges what the reading qualified as', async () => {
    const world = new World(series('s1', 3));
    const ports = portsFor(world);
    let reads = 0;
    const report = await runCanary(
      {
        ...ports,
        reads: {
          ...ports.reads,
          // The first read sees an early revision that is not yet qualified, as the worker projects batch by batch.
          evidence: (universeId) => {
            reads += 1;
            const rows = world.evidence(universeId);
            return Promise.resolve(
              reads <= 2
                ? rows.map((row) => ({ ...row, revision: reads, qualification: 'not_qualified' as const }))
                : rows,
            );
          },
        },
      },
      options(['cold-start']),
    );
    expect(report.evaluation.violations).toEqual([]);
    expect(reads).toBeGreaterThan(3);
  });

  it('waits, within its bound, for a Planner run on its way, and then judges', async () => {
    const world = new World(series('s1', 3));
    const polls: number[] = [];
    const ports = portsFor(world);
    const queued: OperatorReads = { ...world.reads, planner: [{ state: 'queued', ended: false, ageSeconds: 3 }] };
    const report = await runCanary(
      {
        ...ports,
        reads: {
          ...ports.reads,
          read: () => {
            polls.push(world.now);
            return Promise.resolve(polls.length < 3 ? queued : world.reads);
          },
        },
      },
      options(['cold-start']),
    );
    expect(polls.length).toBe(3);
    expect(report.evaluation.violations).toEqual([]);
  });
});
