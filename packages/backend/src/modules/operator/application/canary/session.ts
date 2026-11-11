import type { EncounterOffer, InteractionEvent, NavigationOutcome } from '@knowscroll/contracts';
import {
  seriesDepth,
  SERIES_UNITS_FOR_PLANET,
  SERIES_UNITS_FOR_SYSTEM,
  type EncounterRecord,
  type FormationReading,
  type MoveMode,
  type MoveRecord,
  type OfferRecord,
  type PersonaRecord,
} from '../../domain/canary/evaluate.js';
import type { PersonaId } from '../../domain/canary/personas.js';
import {
  planReelWatch,
  planScrollReading,
  readingWindow,
  reelSamplesInWindow,
  type ReadingPlan,
  type ReelWatchPlan,
} from '../../domain/canary/reading-plan.js';
import {
  CanaryAborted,
  CanaryApiError,
  type CanaryApi,
  type CanaryReads,
  type NavigationIntent,
  type Pacer,
  type RegionTarget,
} from './ports.js';

/** A report is built at most this often while something is being read, like the client recorder's flush. */
export const REPORT_INTERVAL_MS = 15_000;
const PENDING_ASKS = 6;
const PENDING_WAIT_MS = 4_000;
const POLL_MS = 3_000;
/** How long a worker with nothing to project may leave a reading without evidence before that is a finding. */
const IDLE_GRACE_MS = 6_000;
const FORMATION_POLL_MS = 5_000;
const MAX_EVENTS_PER_BATCH = 40;
const MAX_BLOCKS_PER_COVERAGE = 24;
const MAX_REEL_SAMPLES_PER_EVENT = 48;

/** The share of a Scroll's reading time, and of a Reel's length, the reader spends. */
export interface Shares {
  readonly read: number;
  readonly watch: number;
}

type Envelope = Omit<InteractionEvent, 'kind' | 'payload'>;

/** One reading as a clock of reports: what to say about `(fromMs, toMs]`. */
interface PlaySource {
  readonly durationMs: number;
  events(fromMs: number, toMs: number, envelope: () => Envelope): InteractionEvent[];
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let at = 0; at < items.length; at += size) out.push(items.slice(at, at + size));
  return out;
}

function scrollSource(plan: ReadingPlan): PlaySource {
  return {
    durationMs: plan.durationMs,
    events(fromMs, toMs, envelope) {
      const window = readingWindow(plan, fromMs, toMs);
      const events: InteractionEvent[] = [];
      for (const part of chunks(window.coverage, MAX_BLOCKS_PER_COVERAGE))
        events.push({
          ...envelope(),
          kind: 'scroll.block_coverage',
          payload: {
            blocks: part.map((block) => ({
              blockId: block.unitId,
              intervalsMs: block.intervalsMs.map(([from, to]): [number, number] => [from, to]),
              peakFraction: 1,
            })),
          },
        });
      if (window.dwell.length > 0)
        events.push({
          ...envelope(),
          kind: 'scroll.active_dwell',
          payload: { activeIntervalsMs: window.dwell.map(([from, to]): [number, number] => [from, to]) },
        });
      for (const interaction of window.interactions)
        events.push({
          ...envelope(),
          kind: 'scroll.block_interaction',
          payload: { blockId: interaction.unitId, kind: interaction.kind, atMs: interaction.atMs },
        });
      return events;
    },
  };
}

function reelSource(plan: ReelWatchPlan): PlaySource {
  return {
    durationMs: plan.durationMs,
    events(fromMs, toMs, envelope) {
      return chunks(reelSamplesInWindow(plan, fromMs, toMs), MAX_REEL_SAMPLES_PER_EVENT).map(
        (samples): InteractionEvent => ({
          ...envelope(),
          kind: 'reel.playback',
          payload: {
            samples: samples.map((sample) => ({
              activeMs: [sample.activeMs[0], sample.activeMs[1]] as [number, number],
              mediaMs: [sample.mediaMs[0], sample.mediaMs[1]] as [number, number],
            })),
          },
        }),
      );
    },
  };
}

interface MutableEncounter {
  unitId: string;
  format: 'scroll' | 'reel';
  attendance: 'read' | 'glance';
  seriesId: string | undefined;
  accepted: number;
  duplicates: number;
  rejected: number;
  notRecorded: boolean;
  evidence: EncounterRecord['evidence'];
}

interface CurrentEncounter {
  readonly offerId: string;
  readonly exposureId: string;
  readonly encounter: MutableEncounter;
}

/** What the formation read must show once the reader's qualified units entitle a place. */
function formationSatisfied(depth: number, reading: FormationReading): boolean {
  if (depth >= SERIES_UNITS_FOR_PLANET) return reading.planets >= 1;
  if (depth >= SERIES_UNITS_FOR_SYSTEM) return reading.systems >= 1;
  return true;
}

/**
 * One persona's session with the product, written the way a client behaves (blueprint §18, §19): it opens, asks
 * the system to move, activates the offer it is shown, reads or watches while reporting observations in the
 * recorder's wire shapes, and moves on. It keeps what it has met, so the no-re-read rule can be judged from outside.
 * Every call goes through the public API; a refusal is recorded as a stable code and ends only that step.
 */
export class ReaderSession {
  private readonly met = new Set<string>();
  private readonly moves: MoveRecord[] = [];
  private readonly encounters: MutableEncounter[] = [];
  private readonly problems: { route: string; status: number; code: string }[] = [];
  private readonly media = { checked: 0, failed: 0 };
  private readonly unprojected: { exposureId: string; encounter: MutableEncounter }[] = [];
  private generation = 1;
  private sessionId: string | undefined;
  private intentRevision = 0;
  private current: CurrentEncounter | undefined;
  private regions: readonly RegionTarget[] = [];
  private formation: FormationReading | undefined;
  private regionSwitch: PersonaRecord['regionSwitch'] = 'not_attempted';

  constructor(
    readonly persona: PersonaId,
    private readonly api: CanaryApi,
    private readonly reads: Pick<CanaryReads, 'evidence'>,
    private readonly pacer: Pacer,
    private readonly newId: () => string,
    private readonly shares: Shares,
    private readonly signal?: AbortSignal,
  ) {}

  /** Ends the journey the moment the run is told to stop, at the next step it takes. */
  private checkpoint(): void {
    if (this.signal?.aborted === true) throw new CanaryAborted();
  }

  private sleep(ms: number): Promise<void> {
    return this.pacer.sleep(ms, this.signal);
  }

  /** Runs one call; a refusal is recorded and answers `undefined`, so a journey ends its step, not the run. */
  private async guard<T>(call: () => Promise<T>): Promise<T | undefined> {
    try {
      return await call();
    } catch (error) {
      if (!(error instanceof CanaryApiError)) throw error;
      this.problems.push({ route: error.route, status: error.status, code: error.code });
      return undefined;
    }
  }

  /** Reads the recording policy the commands and batches must carry. */
  async begin(): Promise<boolean> {
    const policy = await this.guard(() => this.api.recordingPolicy());
    if (policy === undefined) return false;
    if (!policy.on) {
      this.problems.push({ route: 'recording.read', status: 200, code: 'recording_off' });
      return false;
    }
    this.generation = policy.generation;
    return true;
  }

  /** The first open: the system chooses. */
  open(): Promise<EncounterOffer | undefined> {
    return this.ask('discover', (commandId) => this.api.discover({ commandId, recordingGeneration: this.generation }));
  }

  /** A move from the encounter in front of the reader. */
  step(mode: Exclude<MoveMode, 'discover' | 'region'>, intent: NavigationIntent): Promise<EncounterOffer | undefined> {
    const current = this.current;
    const sessionId = this.sessionId;
    if (current === undefined || sessionId === undefined) return Promise.resolve(undefined);
    return this.ask(mode, (commandId) =>
      this.api.navigate({
        commandId,
        sessionId,
        expectedIntentRevision: this.intentRevision,
        from: { offerId: current.offerId, exposureId: current.exposureId },
        intent,
        recordingGeneration: this.generation,
      }),
    );
  }

  private offerRecord(offer: EncounterOffer, at: number): OfferRecord {
    return {
      unitId: offer.explanationUnitId,
      format: offer.metadata.kind,
      relation: offer.relation.kind,
      seriesId: offer.relation.kind === 'series_step' ? offer.relation.seriesId : undefined,
      alreadyMet: this.met.has(offer.explanationUnitId),
      readyReelVariant: offer.variants.some((variant) => variant.kind === 'reel' && variant.status === 'ready'),
      at,
    };
  }

  /**
   * Asks for an offer and records the answer. A `buffer_preparing` answer is asked again as a client would, with a
   * new command, because a replay keeps its original pending answer. Returns the offer to open, when there is one.
   */
  private async ask(
    mode: MoveMode,
    call: (commandId: string) => Promise<NavigationOutcome | undefined>,
  ): Promise<EncounterOffer | undefined> {
    const metBefore = [...this.met];
    const sourceSeriesId = this.current?.encounter.seriesId;
    let retries = 0;
    for (;;) {
      this.checkpoint();
      const outcome = await this.guard(() => call(this.newId()));
      // No answer: a refusal was recorded, or the region said it has nothing to open (no move happened).
      if (outcome === undefined) return undefined;
      // Every answer moves the session's intent on, even one that offers nothing: the next command must name it.
      this.sessionId = outcome.sessionId;
      this.intentRevision = outcome.intentRevision;
      if (outcome.status === 'pending' && outcome.reason === 'buffer_preparing' && retries < PENDING_ASKS) {
        retries += 1;
        await this.sleep(PENDING_WAIT_MS);
        continue;
      }
      const offers = outcome.status === 'ready' ? [outcome.offer, ...outcome.bufferedOffers] : [];
      const at = this.pacer.nowMs();
      this.moves.push({
        mode,
        at,
        outcome: outcome.status,
        offers: offers.map((offer) => this.offerRecord(offer, at)),
        metBefore,
        sourceSeriesId,
        retries,
      });
      if (outcome.status !== 'ready') return undefined;
      const relation = outcome.offer.relation;
      if (mode === 'series' && relation.kind === 'series_step' && this.current !== undefined)
        this.current.encounter.seriesId ??= relation.seriesId;
      return outcome.offer;
    }
  }

  /** A deliberate open of one region of a place the reader has: the preview card, then the open command. */
  async openRegion(): Promise<EncounterOffer | undefined> {
    const target = this.regions[0];
    if (target === undefined) {
      this.regionSwitch = 'none_available';
      return undefined;
    }
    let unavailable = false;
    const offer = await this.ask('region', async (commandId) => {
      const answer = await this.api.openRegion({ commandId, target, recordingGeneration: this.generation });
      if (answer.status === 'unavailable') {
        unavailable = true;
        return undefined;
      }
      return answer;
    });
    this.regionSwitch = offer === undefined ? 'none_available' : 'opened';
    return unavailable ? undefined : offer;
  }

  /**
   * Activates the offer, as the client does when it is in front, and reads or watches it. A glance opens the
   * encounter and moves on without reporting anything, which is the only way to leave an offer one is shown.
   */
  async meet(offer: EncounterOffer, attendance: 'read' | 'glance'): Promise<boolean> {
    this.checkpoint();
    const sessionId = this.sessionId;
    if (sessionId === undefined) return false;
    const activateId = this.newId();
    const activated = await this.guard(() =>
      this.api.activate({
        commandId: activateId,
        sessionId,
        offerId: offer.offerId,
        expectedIntentRevision: this.intentRevision,
        recordingGeneration: this.generation,
      }),
    );
    if (activated === undefined) return false;
    this.intentRevision = activated.intentRevision;
    this.met.add(offer.explanationUnitId);
    const encounter: MutableEncounter = {
      unitId: offer.explanationUnitId,
      format: offer.metadata.kind,
      attendance,
      seriesId: offer.relation.kind === 'series_step' ? offer.relation.seriesId : undefined,
      accepted: 0,
      duplicates: 0,
      rejected: 0,
      notRecorded: false,
      evidence: attendance === 'read' ? 'not_projected' : 'not_applicable',
    };
    this.encounters.push(encounter);
    this.current = { offerId: offer.offerId, exposureId: activated.exposureId, encounter };
    if (attendance === 'read') {
      this.unprojected.push({ exposureId: activated.exposureId, encounter });
      await this.record(offer, activated.exposureId, activateId, encounter);
    }
    return true;
  }

  private async record(
    offer: EncounterOffer,
    exposureId: string,
    sessionId: string,
    encounter: MutableEncounter,
  ): Promise<void> {
    let source: PlaySource | undefined;
    if (offer.metadata.kind === 'scroll') {
      const units = await this.guard(() => this.api.readingUnits(exposureId));
      if (units !== undefined) source = scrollSource(planScrollReading(units, this.shares.read));
    } else {
      const grant = await this.guard(() => this.api.reelGrant(exposureId));
      if (grant !== undefined) {
        this.media.checked += 1;
        if (!(await this.api.reelBytesServed(grant.path))) this.media.failed += 1;
        source = reelSource(planReelWatch(grant.durationMs, this.shares.watch));
      }
    }
    if (source === undefined) return;
    await this.play(
      source,
      { exposureId, assetId: offer.assetId, assetRevision: offer.assetRevision, sessionId },
      encounter,
    );
  }

  /** Plays a reading in real time: waits until each report's time has passed, then says what happened in it. */
  private async play(
    source: PlaySource,
    exposure: { exposureId: string; assetId: string; assetRevision: number; sessionId: string },
    encounter: MutableEncounter,
  ): Promise<void> {
    const startedAt = this.pacer.nowMs();
    let reported = 0;
    let sequence = 0;
    const envelope = (): Envelope => {
      sequence += 1;
      return {
        schemaVersion: 'interaction.v1',
        eventId: this.newId(),
        sessionId: exposure.sessionId,
        deviceSequence: sequence,
        exposureId: exposure.exposureId,
        assetId: exposure.assetId,
        assetRevision: exposure.assetRevision,
        occurredAt: new Date().toISOString(),
      };
    };
    while (reported < source.durationMs) {
      this.checkpoint();
      const target = Math.min(source.durationMs, reported + REPORT_INTERVAL_MS);
      const wait = startedAt + target - this.pacer.nowMs();
      if (wait > 0) await this.sleep(wait);
      this.checkpoint();
      const events = source.events(reported, target, envelope);
      reported = target;
      for (const batch of chunks(events, MAX_EVENTS_PER_BATCH)) {
        const response = await this.guard(() =>
          this.api.submitBatch({
            version: 'observation-batch.v2',
            recordingGeneration: this.generation,
            instrumentationVersion: 1,
            events: batch,
          }),
        );
        if (response === undefined) return;
        if (response.result === 'not_recorded') {
          encounter.notRecorded = true;
          return;
        }
        encounter.accepted += response.accepted;
        encounter.duplicates += response.duplicates;
        encounter.rejected += response.rejected;
      }
    }
  }

  /**
   * Waits, within the deadline, until the worker has nothing left to project for this reader, then notes what each
   * reading qualified as. Each accepted batch queued a projection in the same transaction, which projects the
   * exposure's whole watermark when it runs, so evidence is final once none is queued, retrying or running. If time
   * runs out first, a reading with evidence so far is `inconclusive` (not red), and one with none is too: the
   * worker had not got to it. With nothing pending and no evidence, it is `not_projected`.
   */
  async settleEvidence(deadlineMs: number): Promise<void> {
    const pending = this.unprojected.splice(0);
    if (pending.length === 0) return;
    let idleSince: number | undefined;
    for (;;) {
      this.checkpoint();
      const read = await this.reads.evidence(this.api.account.universeId);
      const latest = new Map(read.rows.map((row) => [row.exposureId, row]));
      const now = this.pacer.nowMs();
      const idle = read.projectionsPending === 0;
      idleSince = idle ? (idleSince ?? now) : undefined;
      const complete = idle && pending.every((item) => latest.has(item.exposureId));
      // Idle with evidence missing is given a moment (a job may be about to be queued), then it is a finding.
      const gaveUp = idleSince !== undefined && now - idleSince >= IDLE_GRACE_MS;
      if (complete || gaveUp || now >= deadlineMs) {
        for (const item of pending) {
          const row = latest.get(item.exposureId);
          if (!idle) item.encounter.evidence = 'inconclusive';
          else if (row !== undefined) item.encounter.evidence = row.qualification;
        }
        return;
      }
      await this.sleep(POLL_MS);
    }
  }

  /** Reads the reader's places; waits, within the deadline, while its qualified units entitle one that is not there. */
  async settleFormation(deadlineMs: number): Promise<void> {
    for (;;) {
      this.checkpoint();
      const read = await this.guard(() => this.api.formation());
      if (read === undefined) return;
      this.formation = read.reading;
      this.regions = read.regions;
      if (formationSatisfied(seriesDepth(this.snapshot()), read.reading) || this.pacer.nowMs() >= deadlineMs) return;
      await this.sleep(FORMATION_POLL_MS);
    }
  }

  /** The reader's own account, for deletion. */
  get account(): CanaryApi['account'] {
    return this.api.account;
  }

  /** A failure the journey did not expect, kept as a stable code so the run still reports. */
  noteUnexpected(): void {
    this.problems.push({ route: 'canary', status: 0, code: 'unexpected' });
  }

  /** What the session has seen so far, as the evaluator reads it. */
  snapshot(): PersonaRecord {
    return {
      persona: this.persona,
      moves: [...this.moves],
      encounters: this.encounters.map((encounter) => ({ ...encounter })),
      problems: [...this.problems],
      formation: this.formation,
      media: { ...this.media },
      regionSwitch: this.regionSwitch,
    };
  }
}
