import { describe, expect, it } from 'vitest';
import {
  RecordingObservationBatchRequestSchema,
  type EncounterOffer,
  type InteractionEvent,
  type NavigationOutcome,
} from '@knowscroll/contracts';
import {
  SCROLL_RECORDING_QUALIFICATION_POLICY,
  qualifyScrollReading,
  summariseRecordingReading,
  type EvidenceReadingFacts,
  type ObservationRecord,
} from '../../../evidence/public.js';
import type { OperatorReads } from '../../domain/canary/evaluate.js';
import { canaryAddressFor, type PersonaId } from '../../domain/canary/personas.js';
import type { ReadingUnit } from '../../domain/canary/reading-plan.js';
import {
  CanaryApiError,
  type CanaryApi,
  type CanaryOptions,
  type CanaryPorts,
  type EvidenceRead,
  type MintResult,
} from './ports.js';
import { CanaryRunFailed, runCanary, type CanaryReport } from './run-canary.js';

/**
 * The canary driven against a scripted world, on a virtual clock. The world plays the server's part where the
 * canary's honesty depends on it: it validates each batch against the real wire contract, bounds every claim by the
 * time since activation as the intake does, and judges a reading with the product's own `summariseRecordingReading`
 * and `qualifyScrollReading` under its recording policy (only the reading facts of the stops are derived here, as the
 * content module derives them), so a canary that claimed too much, too little or the wrong shape would fail here
 * before it ever ran against dev.
 */

const ELAPSED_TOLERANCE_MS = 2_000;

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

/** The reading facts of the stops as content derives them for a v2 Scroll: a stop is read once visible for 40% of its words' time. */
const facts: EvidenceReadingFacts = {
  totalWeight: stops
    .filter((stop) => stop.kind === 'read')
    .reduce((sum, stop) => sum + Math.round(stop.nominalMs / 1000), 0),
  estimatedReadingMs: estimatedMs,
  blocks: stops.map((stop) => ({
    id: stop.id,
    weight: stop.kind === 'read' ? Math.round(stop.nominalMs / 1000) : 0,
    seen:
      stop.kind === 'read'
        ? { kind: 'visible' as const, minVisibleMs: Math.max(500, Math.round(stop.nominalMs * 0.4)) }
        : { kind: 'interaction' as const, interactions: ['locked', 'revealed'] },
  })),
  nested: [],
};

interface Exposure {
  readonly unit: LibraryUnit;
  readonly activatedAt: number;
  readonly activateId: string;
  /** Every stored observation, in the shape Evidence projects from. */
  readonly observations: ObservationRecord[];
  lastReceivedAt: number;
}

/** The product's own judgement of what was stored: the recording policy's summary, then its qualification. */
function qualification(exposure: Exposure): 'qualified' | 'not_qualified' | 'unknown' {
  const summary = summariseRecordingReading(
    exposure.observations,
    facts,
    SCROLL_RECORDING_QUALIFICATION_POLICY,
    Math.max(0, exposure.lastReceivedAt - exposure.activatedAt),
  );
  return qualifyScrollReading(summary, SCROLL_RECORDING_QUALIFICATION_POLICY).qualification;
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
  /** A route that fails the way a bug does (not a refusal the contract knows). */
  crashOn: string | undefined;
  /** The persona whose subject moves are served the unit it is already on, whatever it has met. */
  repeatFor: string | undefined;
  reads: OperatorReads = {
    planner: [{ state: 'accepted', ended: true, ageSeconds: 1 }],
    geography: [{ state: 'accepted', ended: true, ageSeconds: 1 }],
    jobs: [],
    policies: [{ label: 'composer-policy.v2', count: 1 }],
    supply: { requests: 0, commissionedWork: 0 },
    attempts: [],
  };
  /** How much of a stop's real reading time the canary believes it has: below 1 it under-reads. */
  unitScale = 1;
  /** The worker's projection backlog: this many evidence reads answer that projections are still pending. */
  projectionsPendingReads = 0;
  /** Runs at each virtual sleep: a scenario's way to stop the run at a chosen time. */
  onSleep: ((now: number) => void) | undefined;

  /** The exposures each universe opened: what the operator view reads evidence from. */
  readonly exposures = new Map<string, Map<string, Exposure>>();

  constructor(readonly library: readonly LibraryUnit[]) {}

  evidence(universeId: string): EvidenceRead {
    const pending = this.projectionsPendingReads > 0;
    if (pending) this.projectionsPendingReads -= 1;
    return {
      projectionsPending: pending ? 1 : 0,
      rows: [...(this.exposures.get(universeId) ?? new Map<string, Exposure>())].flatMap(([exposureId, exposure]) =>
        exposure.observations.length === 0
          ? []
          : [
              {
                exposureId,
                revision: exposure.observations.length,
                qualification: exposure.unit.format === 'reel' ? ('qualified' as const) : qualification(exposure),
              },
            ],
      ),
    };
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
    if (world.crashOn === route) throw new TypeError('boom');
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
        observations: [],
        lastReceivedAt: world.now,
      });
      revision += 1;
      return Promise.resolve({ exposureId, intentRevision: revision });
    },
    readingUnits: () =>
      Promise.resolve(stops.map((stop) => ({ ...stop, nominalMs: Math.round(stop.nominalMs * world.unitScale) }))),
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
        exposure.lastReceivedAt = world.now;
        const record = (body: ObservationRecord['body']): void => {
          exposure.observations.push({
            seq: exposure.observations.length + 1,
            sessionId: event.sessionId,
            deviceSequence: event.deviceSequence,
            instrumentationVersion: parsed.instrumentationVersion,
            body,
          });
        };
        if (event.kind === 'scroll.block_coverage') {
          for (const block of event.payload.blocks)
            for (const [, to] of block.intervalsMs) if (to > cap) world.problems.push('claim_beyond_wall_clock');
          record({
            kind: 'scroll.block_coverage',
            blocks: event.payload.blocks.map((block) => ({
              blockId: block.blockId,
              intervalsMs: block.intervalsMs,
              peakFraction: block.peakFraction,
            })),
          });
        }
        if (event.kind === 'scroll.active_dwell') {
          for (const [, to] of event.payload.activeIntervalsMs)
            if (to > cap) world.problems.push('claim_beyond_wall_clock');
          record({ kind: 'scroll.active_dwell', activeIntervalsMs: event.payload.activeIntervalsMs });
        }
        if (event.kind === 'scroll.block_interaction')
          record({
            kind: 'scroll.block_interaction',
            blockId: event.payload.blockId,
            interaction: event.payload.kind,
            atMs: event.payload.atMs,
          });
        if (event.kind === 'reel.playback') {
          for (const sample of event.payload.samples)
            if (sample.activeMs[1] > cap) world.problems.push('claim_beyond_wall_clock');
          record({ kind: 'reel.playback', samples: event.payload.samples });
        }
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
      listCanaryAddresses: () => Promise.resolve([...world.accounts]),
    },
    reads: {
      read: () => Promise.resolve(world.reads),
      evidence: (universeId) => Promise.resolve(world.evidence(universeId)),
    },
    pacer: {
      nowMs: () => world.now,
      sleep: (ms, signal) => {
        if (signal?.aborted === true) return Promise.resolve();
        world.now += ms;
        world.onSleep?.(world.now);
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
  strict: false,
  waitSeconds: 30,
  addressFor: (persona) => canaryAddressFor('*@test.example', 'abcd1234', persona) ?? '',
  ...extra,
});

/** A run that finished and was judged, as opposed to one that was told to stop. */
function judged(report: CanaryReport) {
  if (report.kind !== 'completed') throw new Error(`the run was ${report.kind}, not judged`);
  return report;
}

const judgedRun = async (...args: Parameters<typeof runCanary>) => judged(await runCanary(...args));

describe('runCanary on a scripted world', () => {
  it('drives cold-start and deep-reader honestly, judges them green and deletes both accounts', async () => {
    const world = new World([...series('s1', 3), ...series('s2', 2)]);
    const report = await judgedRun(portsFor(world), options(['cold-start', 'deep-reader']));
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
      const report = await judgedRun(portsFor(world), options(['deep-reader'], { speed }));
      expect(report.evaluation.personas[0]?.qualified, JSON.stringify(speed)).toBeGreaterThanOrEqual(3);
      expect(report.evaluation.passed).toBe(true);
    }
  });

  it('keeps the accounts with --keep, and says nothing was deleted', async () => {
    const world = new World(series('s1', 3));
    const report = await judgedRun(portsFor(world), options(['cold-start'], { keep: true }));
    expect(world.deleted.size).toBe(0);
    expect(report.cleanup).toEqual({ kept: true, requested: 0, completed: 0 });
    expect(report.evaluation.passed).toBe(true);
  });

  it('watches a Reel for more than 60% of its length, in samples the intake accepts', async () => {
    const [first, second] = series('s1', 2);
    const world = new World([first!, reelTwin(first!), second!]);
    const report = await judgedRun(portsFor(world), options(['reel-watcher']));
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
    const report = await judgedRun(portsFor(world), options(['many-reads', 'cold-start']));
    expect(report.evaluation.passed).toBe(false);
    expect(report.evaluation.violations.map((violation) => violation.code)).toContain('repeat_while_unseen_exists');
    expect(world.deleted).toEqual(world.accounts);
  });

  it('records a refused route as api_refused, ends only that step, and still cleans up', async () => {
    const world = new World(series('s1', 3));
    world.failOn = 'activate';
    const report = await judgedRun(portsFor(world), options(['cold-start']));
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
    const report = await judgedRun(
      { ...ports, reads: { ...ports.reads, read: () => Promise.reject(new Error('db down')) } },
      options(['cold-start']),
    );
    expect(report.evaluation.violations.map((violation) => violation.code)).toContain('operator_reads_failed');
  });

  it('reports a reading with no evidence and nothing left to project as not projected, without waiting its whole bound', async () => {
    const world = new World(series('s1', 3));
    const ports = portsFor(world);
    const before = world.now;
    const report = await judgedRun(
      { ...ports, reads: { ...ports.reads, evidence: () => Promise.resolve({ rows: [], projectionsPending: 0 }) } },
      options(['cold-start'], { waitSeconds: 600 }),
    );
    const codes = report.evaluation.violations.map((violation) => violation.code);
    expect(codes).toContain('reading_not_projected');
    expect(codes).not.toContain('reading_not_qualified');
    // The reading took about two minutes; giving up on evidence took seconds, not the ten-minute bound.
    expect(world.now - before).toBeLessThan(5 * 60_000);
  });

  it('waits while the worker still has projections pending, then judges what the reading qualified as', async () => {
    const world = new World(series('s1', 3));
    world.projectionsPendingReads = 3;
    const report = await judgedRun(portsFor(world), options(['cold-start']));
    expect(report.evaluation.violations).toEqual([]);
    expect(report.evaluation.personas[0]).toMatchObject({ qualified: 2, inconclusive: 0 });
  });

  it('calls a reading inconclusive, not red, when projections are still pending as the wait runs out', async () => {
    const world = new World(series('s1', 3));
    world.projectionsPendingReads = Number.POSITIVE_INFINITY;
    const report = await judgedRun(portsFor(world), options(['cold-start'], { waitSeconds: 20 }));
    expect(report.evaluation.violations).toEqual([]);
    expect(report.evaluation.passed).toBe(true);
    expect(report.evaluation.personas[0]).toMatchObject({ qualified: 0, inconclusive: 2 });
    expect(report.evaluation.checks.find((check) => check.code === 'reading_not_qualified')?.status).toBe(
      'inconclusive',
    );
  });

  it("judges a reading by the product's own policy: a canary that reads too little is caught, not believed", async () => {
    const world = new World(series('s1', 3));
    // The canary believes every stop is short, so it reports a third of the time the real facts need.
    world.unitScale = 0.3;
    const report = await judgedRun(portsFor(world), options(['cold-start']));
    expect(report.evaluation.violations.map((violation) => violation.code)).toContain('reading_not_qualified');
    expect(report.evaluation.personas[0]?.qualified).toBe(0);
  });

  it('fails a --strict run in which an invariant was never exercised, and only then', async () => {
    const lenient = await judgedRun(portsFor(new World(series('s1', 3))), options(['cold-start']));
    expect(lenient.evaluation.passed).toBe(true);
    expect(lenient.evaluation.notExercised).toContain('formation_system_missing');
    const strict = await judgedRun(portsFor(new World(series('s1', 3))), options(['cold-start'], { strict: true }));
    expect(strict.evaluation.passed).toBe(false);
    expect(strict.evaluation.violations).toEqual([]);
  });

  it('reports what the run asked of shared supply and of models, and fails when it commissioned work', async () => {
    const world = new World(series('s1', 3));
    world.reads = { ...world.reads, attempts: [{ role: 'planner', count: 3 }] };
    const quiet = await judgedRun(portsFor(world), options(['cold-start']));
    expect(quiet.evaluation.spend).toEqual({
      supplyRequests: 0,
      commissionedWork: 0,
      modelAttempts: { planner: 3 },
    });
    world.reads = { ...world.reads, supply: { requests: 2, commissionedWork: 1 } };
    const spent = await judgedRun(portsFor(world), options(['cold-start']));
    expect(spent.evaluation.violations.map((violation) => violation.code)).toEqual(['shared_supply_touched']);
  });

  it('waits, within its bound, for a Planner run on its way, and then judges', async () => {
    const world = new World(series('s1', 3));
    const polls: number[] = [];
    const ports = portsFor(world);
    const queued: OperatorReads = { ...world.reads, planner: [{ state: 'queued', ended: false, ageSeconds: 3 }] };
    const report = await judgedRun(
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

  describe('when the run is stopped or something breaks', () => {
    it('stops at a signal: the journeys end, nothing is judged and every account is deleted', async () => {
      const world = new World(series('s1', 4));
      const controller = new AbortController();
      world.onSleep = (now) => {
        if (now > 30_000) controller.abort('sigterm');
      };
      const report = await runCanary(portsFor(world), options(['cold-start', 'deep-reader']), controller.signal);
      expect(report).toMatchObject({
        kind: 'aborted',
        reason: 'sigterm',
        cleanup: { kept: false, requested: 2, completed: 2 },
      });
      expect(world.deleted).toEqual(world.accounts);
      // It really stopped reading: a full run of the two personas takes far longer than this.
      expect(world.now).toBeLessThan(90_000);
    });

    it('reports the reason it was stopped for, including the overall time limit', async () => {
      for (const reason of ['sigint', 'sighup', 'timeout'] as const) {
        const world = new World(series('s1', 4));
        const controller = new AbortController();
        world.onSleep = () => controller.abort(reason);
        const report = await runCanary(portsFor(world), options(['cold-start']), controller.signal);
        expect(report).toMatchObject({ kind: 'aborted', reason });
        expect(world.deleted).toEqual(world.accounts);
      }
    });

    it('makes no account at all when it is stopped before the first mint', async () => {
      const world = new World(series('s1', 4));
      const controller = new AbortController();
      controller.abort('sigint');
      const report = await runCanary(portsFor(world), options(['cold-start', 'deep-reader']), controller.signal);
      expect(report).toMatchObject({ kind: 'aborted', cleanup: { requested: 0, completed: 0 } });
      expect(world.accounts.size).toBe(0);
    });

    it('leaves the accounts of a stopped run when it was told to keep them', async () => {
      const world = new World(series('s1', 4));
      const controller = new AbortController();
      world.onSleep = () => controller.abort('sigterm');
      const report = await runCanary(portsFor(world), options(['cold-start'], { keep: true }), controller.signal);
      expect(report).toMatchObject({ kind: 'aborted', cleanup: { kept: true, requested: 0, completed: 0 } });
      expect(world.deleted.size).toBe(0);
    });

    it('does not judge a run it stopped, and does not wait for the Planner', async () => {
      const world = new World(series('s1', 4));
      const controller = new AbortController();
      world.onSleep = () => controller.abort('sigterm');
      let reads = 0;
      const ports = portsFor(world);
      await runCanary(
        {
          ...ports,
          reads: {
            ...ports.reads,
            read: () => {
              reads += 1;
              return Promise.resolve(world.reads);
            },
          },
        },
        options(['cold-start']),
        controller.signal,
      );
      expect(reads).toBe(0);
    });

    it('records a failure that is not a refused route, ends only that journey, and still cleans up', async () => {
      const world = new World(series('s1', 4));
      world.crashOn = 'activate';
      const report = await judgedRun(portsFor(world), options(['cold-start', 'deep-reader']));
      expect(report.evaluation.violations.map((violation) => violation.code)).toContain('api_refused');
      expect(world.deleted).toEqual(world.accounts);
    });

    it('deletes the accounts already made when something unexpected is thrown between steps, then throws it', async () => {
      const world = new World(series('s1', 4));
      let minted = 0;
      const ports = portsFor(world, () => {
        if (++minted === 2) throw new Error('database went away');
        return { kind: 'issued', link: 'link' };
      });
      await expect(runCanary(ports, options(['cold-start', 'deep-reader']))).rejects.toThrow('database went away');
      expect(world.deleted.size).toBe(1);
      expect(world.deleted).toEqual(world.accounts.size === 1 ? world.accounts : new Set([[...world.accounts][0]!]));
    });
  });
});
