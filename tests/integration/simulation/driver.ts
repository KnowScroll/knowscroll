import { sql } from 'kysely';
import type { NavigationOutcome } from '@knowscroll/contracts';
import { textCapabilities } from '../support/scroll.js';
import { setRecording } from '../support/recording-person.js';
import type { FixturePerson } from '../support/fixtures.js';
import { addReports, emptyReport, type DrainReport } from './drain.js';
import type { EncounterRecord, FormationPoint, MoveKind, MoveRecord, OfferView, Format } from './model.js';
import type { PersonaMemory, PersonaSpec, StepContext } from './persona.js';
import { activatedMsAgo, reelReading, scrollReading, type ReadingKind } from './reading.js';
import type { Rng } from './rng.js';
import type { SimWorld } from './world.js';

/** A client that renders both formats, as the app's encounter controller does. */
const CAPABILITIES = { ...textCapabilities, documentSchemas: ['scroll-document.v1', 'reel-document.v1'] };

type Ready = Extract<NavigationOutcome, { status: 'ready' }>;

interface Standing {
  readonly sessionId: string;
  readonly intentRevision: number;
  readonly offerId: string;
  readonly exposureId: string;
  readonly kind: Format;
}

/** The person's recording state as the client holds it: its generation, and whether recording is on. */
interface Recording {
  generation: number;
  on: boolean;
}

/**
 * One persona living one session against the world. `step` is one encounter: the person moves, the
 * system answers with offers, the person activates one and reads it, the recorder reports, and the
 * worker's consumers are drained, exactly in the order the product does them. Nothing is asserted
 * here; the run only records what the product answered so the invariants can judge it afterwards.
 */
export class PersonaRun {
  readonly moves: MoveRecord[] = [];
  readonly encounters: EncounterRecord[] = [];
  readonly formation: FormationPoint[] = [];
  readonly met = new Set<string>();
  readonly memory: PersonaMemory = {
    regionsOpened: 0,
    seenTopics: new Set<string>(),
    touchedTopics: new Set<string>(),
  };
  readonly reportedExposures = new Set<string>();
  readonly activatedExposures: string[] = [];
  readonly likes: { assetId: string; kind: 'like' | 'save' }[] = [];
  drains: DrainReport = emptyReport;
  /** Milliseconds spent in the product's own use cases (navigation, activation, intake), by step kind. */
  readonly timings = { navigate: 0, activate: 0, ingest: 0, drain: 0 };
  private standing: Standing | undefined;
  private recording: Recording = { generation: 1, on: true };
  private finished = false;
  /** Regions on the person's map as of the start of the step, for a persona that opens them. */
  private regionCache = 0;
  /** Consecutive moves the system answered with nothing to offer. */
  private empties = 0;
  /** True while the person is moving inside a region they opened. */
  private inRegion = false;

  constructor(
    private readonly world: SimWorld,
    readonly spec: PersonaSpec,
    readonly person: FixturePerson,
    private readonly rng: Rng,
    private readonly total: number,
  ) {}

  get done(): boolean {
    return this.finished || this.encounters.length >= this.total;
  }

  private context(): StepContext {
    return {
      index: this.encounters.length,
      rng: this.rng,
      library: this.world.library,
      config: this.world.config,
      met: this.met,
      format: this.standing?.kind,
      memory: this.memory,
      hasRegion: this.regionCache > 0,
    };
  }

  /** One encounter. Returns false when the persona has nothing more to do. */
  async step(): Promise<boolean> {
    if (this.done) return false;
    const { spec } = this;
    await this.applyRecordingChange();
    this.regionCache = await this.regionCount();
    const context = this.context();
    if (spec.until?.(context)) {
      this.finished = true;
      return false;
    }
    let target: { assetId: string; assetRevision: number } | undefined;
    let move: MoveKind;
    if (spec.script) {
      const link = spec.script(this.world.library)[this.encounters.length];
      if (!link) {
        this.finished = true;
        return false;
      }
      const unit = this.world.library.unit(link.unitId);
      const asset = link.kind === 'reel' ? unit.reel! : unit.scroll;
      target = { assetId: asset.assetId, assetRevision: asset.revision };
      move = 'open';
    } else {
      const wanted: MoveKind = spec.move?.(context) ?? 'vertical';
      // Someone who found nothing to be offered taps "Somewhere new", once; a second empty answer ends the session.
      move = this.standing === undefined || this.empties === 1 ? 'discover' : wanted;
    }
    let answer = await this.navigateTimed(move, target);
    // A person who finds nothing to their taste among the choices taps "Somewhere new" again.
    for (
      let browse = 1;
      move === 'discover' && answer.status === 'ready' && browse < (spec.maxBrowses ?? 1);
      browse++
    ) {
      const choices = [answer.outcome.offer, ...answer.outcome.bufferedOffers].map((offer) => this.view(offer));
      if (spec.choose?.(choices, context) !== undefined) break;
      this.recordMove(move, answer.outcome, answer.millis);
      answer = await this.navigateTimed(move, target);
    }
    if (answer.status !== 'ready') {
      this.moves.push({
        index: this.moves.length,
        move,
        ...(this.standing ? { asked: this.standing.kind } : {}),
        status: answer.status,
        ...(answer.reason ? { reason: answer.reason } : {}),
        offers: [],
        metBefore: [...this.met],
        unseenBefore: this.world.library.units.length - this.met.size,
        unseenLeftOut: 0,
        millis: answer.millis,
      });
      if (answer.status === 'pending') {
        // The buffer is still being prepared: the worker finishes it and the person tries once more.
        await this.drain();
        const retry = await this.navigateTimed(move, target);
        if (retry.status === 'ready') return this.activateAndRead(move, retry.outcome, context, retry.millis);
      }
      this.empties += 1;
      this.finished = spec.stopsWhenEmpty !== false || this.empties >= 2;
      return !this.finished;
    }
    return this.activateAndRead(move, answer.outcome, context, answer.millis);
  }

  private async navigateTimed(move: MoveKind, target?: { assetId: string; assetRevision: number }) {
    const startedAt = performance.now();
    const answer = await this.navigate(move, target);
    const millis = performance.now() - startedAt;
    this.timings.navigate += millis;
    return { ...answer, millis };
  }

  /** Records an answer the person was shown, whether or not they took one of its offers. */
  private recordMove(move: MoveKind, outcome: Ready, millis: number): readonly OfferView[] {
    const offers = [outcome.offer, ...outcome.bufferedOffers].map((offer) => this.view(offer));
    const unseenOffered = new Set(offers.filter((offer) => !offer.alreadyMet).map((offer) => offer.unitId));
    this.moves.push({
      index: this.moves.length,
      // A move inside a region the person opened continues their own ask for that place; the Composer offers only what the
      // region holds, so it is recorded as the region's.
      move: this.inRegion && move === 'vertical' ? 'region' : move,
      ...(this.standing ? { asked: this.standing.kind } : {}),
      status: 'ready',
      decisionId: outcome.decisionId,
      offers,
      metBefore: [...this.met],
      unseenBefore: this.world.library.units.length - this.met.size,
      unseenLeftOut: this.world.library.units.length - this.met.size - unseenOffered.size,
      millis,
    });
    return offers;
  }

  private async activateAndRead(move: MoveKind, outcome: Ready, context: StepContext, navigateMs: number) {
    const { spec, person } = this;
    const c = this.world.geo.c;
    this.empties = 0;
    const offers = this.recordMove(move, outcome, navigateMs);
    const chosen = move === 'discover' ? (spec.choose?.(offers, context) ?? offers[0]!) : offers[0]!;
    const chosenOffer = [outcome.offer, ...outcome.bufferedOffers].find((offer) => offer.offerId === chosen.offerId)!;
    const activatedAt = performance.now();
    // The recorder session of a recorded encounter is named by the command that activated it.
    const activationCommandId = this.rng.uuid();
    const activated = await c.activateOffer(person.authority, {
      commandId: activationCommandId,
      target: {
        kind: 'offer',
        sessionId: outcome.sessionId,
        offerId: chosenOffer.offerId,
        expectedIntentRevision: outcome.intentRevision,
      },
      ...this.generationField(),
    });
    this.timings.activate += performance.now() - activatedAt;
    if (activated.kind !== 'accepted') throw new Error(`SIM_ACTIVATION_REFUSED ${JSON.stringify(activated)}`);
    const exposureId = activated.outcome.exposureId;
    this.standing = {
      sessionId: outcome.sessionId,
      intentRevision: outcome.intentRevision,
      offerId: chosenOffer.offerId,
      exposureId,
      kind: chosen.kind,
    };
    this.inRegion = move === 'region' || (this.inRegion && move === 'vertical');
    this.activatedExposures.push(exposureId);
    this.memory.seenTopics.add(chosen.topicId);
    // What a person opens while recording is paused stays out of their history, so it is not a unit they have met.
    if (this.recording.on) this.met.add(chosen.unitId);
    // The worker prepares the next buffer as soon as the offer is activated, before the reading's own evidence exists.
    await this.drain();

    const reading = spec.reading(chosen, { ...context, format: chosen.kind });
    // A later generation's recorder names the session after its activation command; a first-generation recorder
    // reports under a session of its own, and the intake refuses a legacy batch that names a recorder session.
    const sessionId = this.recording.generation === 1 ? this.rng.uuid() : activationCommandId;
    const record = await this.read(chosen, exposureId, sessionId, reading, move);
    this.encounters.push(record);
    await this.react(chosen, exposureId, reading, context);
    await this.drain();
    await this.recordFormation();
    return true;
  }

  private view(offer: Ready['offer']): OfferView {
    const found = this.world.library.ofAsset(offer.assetId);
    if (!found) throw new Error(`SIM_OFFER_OUTSIDE_LIBRARY ${offer.assetId}`);
    return {
      offerId: offer.offerId,
      assetId: offer.assetId,
      assetRevision: offer.assetRevision,
      unitId: found.unit.unitId,
      kind: found.kind,
      topicId: found.unit.topicId,
      systemId: found.unit.systemId,
      alreadyMet: this.met.has(found.unit.unitId),
    };
  }

  /**
   * A person who has never paused is on the first generation, which commands may leave unnamed. Once the person has
   * paused, every command and every batch names the generation the client holds, as the app's recorder does.
   */
  private generationField(): { recordingGeneration?: number } {
    return this.recording.generation === 1 ? {} : { recordingGeneration: this.recording.generation };
  }

  /** True once the person has paused and resumed: the recorder is then on a later generation's session protocol. */
  private get resumed(): boolean {
    return this.recording.generation > 1 && this.recording.on;
  }

  private async navigate(
    move: MoveKind,
    target?: { assetId: string; assetRevision: number },
  ): Promise<
    | { status: 'ready'; outcome: Ready; reason?: undefined }
    | { status: 'pending' | 'exhausted' | 'refused'; reason?: string; outcome?: undefined }
  > {
    const { person } = this;
    const c = this.world.geo.c;
    const generation = this.generationField();
    let outcome: NavigationOutcome | undefined;
    if (move === 'region') {
      const target = await this.regionTarget();
      if (!target) return { status: 'refused', reason: 'no_region' };
      const result = await c.regionEncounters!.open(person.authority, {
        version: 'region-encounter-open.v1',
        commandId: this.rng.uuid(),
        target,
        capabilities: CAPABILITIES,
        ...generation,
      });
      if (result.kind !== 'accepted') return { status: 'refused', reason: result.kind };
      outcome = result.value.outcome;
      this.memory.regionsOpened += 1;
    } else if (move === 'open') {
      const result = await c.navigate(person.authority, {
        commandId: this.rng.uuid(),
        target: { kind: 'return', ...target! },
        capabilities: CAPABILITIES,
        ...generation,
      });
      if (result.kind !== 'accepted') return { status: 'refused', reason: result.kind };
      outcome = result.outcome;
    } else {
      const standing = this.standing;
      const result = await c.navigate(
        person.authority,
        standing === undefined || move === 'discover'
          ? { commandId: this.rng.uuid(), target: { kind: 'discover' }, capabilities: CAPABILITIES, ...generation }
          : {
              commandId: this.rng.uuid(),
              sessionId: standing.sessionId,
              expectedIntentRevision: standing.intentRevision,
              from: { offerId: standing.offerId, exposureId: standing.exposureId },
              intent: { mode: 'vertical', direction: 'next', format: standing.kind },
              ...generation,
            },
      );
      if (result.kind !== 'accepted') return { status: 'refused', reason: result.kind };
      outcome = result.outcome;
    }
    if (outcome.status === 'ready') return { status: 'ready', outcome };
    return { status: outcome.status, reason: outcome.reason };
  }

  private async regionTarget() {
    const database = this.world.geo.database.db;
    const universeId = this.person.universeId;
    const regions = (
      await sql<{ id: string; payload: { objectRevision: number } }>`
        select id, payload from geography.objects where universe_id = ${universeId}::uuid and semantic_key like 'region:%' order by semantic_key`.execute(
        database,
      )
    ).rows;
    if (regions.length === 0) return undefined;
    // The person opens the first region of their map.
    const region = regions[0]!;
    const state = await sql<{ revision: number }>`
      select revision from geography.state where universe_id = ${universeId}::uuid`.execute(database);
    return {
      kind: 'region' as const,
      regionId: region.id,
      expectedObjectRevision: region.payload.objectRevision,
      expectedGeographyRevision: state.rows[0]!.revision,
    };
  }

  private async regionCount(): Promise<number> {
    // Only a persona that chooses its own moves can ask for a region, so the others skip the query.
    if (!this.spec.move) return 0;
    const result = await sql<{ n: number }>`
      select count(*)::int n from geography.objects
      where universe_id = ${this.person.universeId}::uuid and semantic_key like 'region:%'`.execute(
      this.world.geo.database.db,
    );
    return result.rows[0]!.n;
  }

  private async read(
    offer: OfferView,
    exposureId: string,
    sessionId: string,
    reading: ReadingKind,
    move: MoveKind,
  ): Promise<EncounterRecord> {
    const { library } = this.world;
    const unit = library.unit(offer.unitId);
    const fixture = { exposureId, assetId: offer.assetId, assetRevision: offer.assetRevision };
    const result =
      offer.kind === 'scroll'
        ? scrollReading(fixture, sessionId, unit.scroll, reading, this.rng)
        : reelReading(fixture, sessionId, unit.reel!, reading, this.rng);
    let events = 0;
    if (result.events.length > 0) {
      if (!this.resumed) await activatedMsAgo(this.world.geo.database.db, exposureId, result.elapsedMs);
      const startedAt = performance.now();
      const ingested = await this.world.geo.c.ingestObservations(
        this.person.authority,
        this.recording.generation === 1
          ? { instrumentationVersion: 1, events: result.events }
          : {
              version: 'observation-batch.v2',
              recordingGeneration: this.recording.generation,
              instrumentationVersion: 1,
              events: result.events,
            },
      );
      this.timings.ingest += performance.now() - startedAt;
      if (ingested.kind === 'ingested') {
        events = ingested.accepted;
        if (ingested.accepted > 0) this.reportedExposures.add(exposureId);
      }
    }
    return {
      index: this.encounters.length,
      exposureId,
      offer,
      move,
      reading,
      // After a resume the recorder's session can claim only the time that really passed, which is none to speak of.
      expectQualified: result.expectQualified && this.recording.on && !this.resumed,
      recorded: this.recording.on,
      events,
    };
  }

  private async react(offer: OfferView, exposureId: string, reading: ReadingKind, context: StepContext) {
    const kind = this.spec.react?.(offer, reading, context);
    if (kind === undefined) return;
    const applied = await this.world.geo.c.applyEncounterAction(this.person.authority, {
      commandId: this.rng.uuid(),
      kind,
      target: { assetId: offer.assetId, assetRevision: offer.assetRevision },
      exposureId,
      ...this.generationField(),
    });
    if (applied.kind === 'applied') this.likes.push({ assetId: offer.assetId, kind });
  }

  private async applyRecordingChange() {
    const plan = this.spec.recording;
    if (!plan) return;
    const { database } = this.world.geo;
    const index = this.encounters.length;
    if (index === plan.pauseBefore && this.recording.on) {
      await setRecording(database, this.person, this.recording.generation, false);
      this.recording = { generation: this.recording.generation + 1, on: false };
    } else if (index === plan.resumeBefore && !this.recording.on) {
      await setRecording(database, this.person, this.recording.generation, true);
      this.recording = { generation: this.recording.generation + 1, on: true };
    }
  }

  async drain(): Promise<DrainReport> {
    const startedAt = performance.now();
    const report = await this.world.drain();
    this.timings.drain += performance.now() - startedAt;
    this.drains = addReports(this.drains, report);
    return report;
  }

  /** What Geography and Personal Context hold for the person right now. */
  async recordFormation() {
    const db = this.world.geo.database.db;
    const u = this.person.universeId;
    const rows = await sql<{
      systems: number;
      planets: number;
      regions: number;
      supports: number;
      references: number;
    }>`select
        (select count(*)::int from geography.objects where universe_id = ${u}::uuid and semantic_key like 'system:%') systems,
        (select count(*)::int from geography.objects where universe_id = ${u}::uuid and semantic_key like 'planet:%') planets,
        (select count(*)::int from geography.objects where universe_id = ${u}::uuid and semantic_key like 'region:%') regions,
        (select count(*)::int from personal_context.coverage_supports where universe_id = ${u}::uuid) supports,
        (select count(*)::int from personal_context.coverage_references where universe_id = ${u}::uuid)
          + (select count(*)::int from personal_context.recording_coverage_references where universe_id = ${u}::uuid) as references`.execute(
      db,
    );
    const outcomes = await sql<{ outcome: string; n: number }>`
      select coalesce(outcome, 'none') outcome, count(*)::int n from geography.runs
      where universe_id = ${u}::uuid and status = 'insufficient' group by 1`.execute(db);
    const row = rows.rows[0]!;
    this.formation.push({
      encounter: this.encounters.length,
      systems: row.systems,
      planets: row.planets,
      regions: row.regions,
      trustedSupports: row.supports,
      references: row.references,
      insufficientOutcomes: Object.fromEntries(outcomes.rows.map((entry) => [entry.outcome, entry.n])),
    });
  }

  /** Reads the evidence rules' answer for each encounter the person reported. */
  async readQualifications() {
    const rows = await sql<{ exposure_id: string; qualification: 'qualified' | 'not_qualified' | 'unknown' }>`
      select distinct on (exposure_id) exposure_id, qualification
      from evidence.encounter_evidence where universe_id = ${this.person.universeId}::uuid
      order by exposure_id, revision desc`.execute(this.world.geo.database.db);
    const byExposure = new Map(rows.rows.map((row) => [row.exposure_id, row.qualification]));
    for (const encounter of this.encounters) {
      const answer = byExposure.get(encounter.exposureId);
      if (answer !== undefined) encounter.qualification = answer;
    }
  }
}
