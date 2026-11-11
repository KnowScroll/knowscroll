/**
 * The rules of the gap loop (#674, D-414), pure: what counts as a hole in the library, how holes are ranked, what a signal may
 * name, what each outcome of a proposing attempt does to a gap, and how the growth budget is counted. Nothing here reads the
 * clock, a database or a model; the scan and the brief job (`application/gap-scan.ts`, `gap-brief.ts`) apply it.
 *
 * Demand is never evidence: nothing in this file is read by ranking, planning, evidence or place formation (`gap-wall.test.ts`).
 */

/** What kind of hole a gap is. `demand` is a hole readers' own reading pointed to, with no structural rule behind it. */
export const GAP_KINDS = ['thin_planet', 'empty_facet', 'shallow_planet', 'demand'] as const;
export type GapKind = (typeof GAP_KINDS)[number];

/** Where a gap stands. `closed` and `rejected` end it; the others are open, and at most one gap per key may be (the table's partial unique index). */
export const GAP_STATUSES = ['open', 'briefed', 'commissioned', 'closed', 'rejected', 'blocked_unknown'] as const;
export type GapStatus = (typeof GAP_STATUSES)[number];

/** Who noticed that content runs out: the Composer's decision, the Planner's demand or a person's ask. Counts only, never words. */
export const SIGNAL_SOURCES = ['last_resort', 'low_headroom', 'planned_demand', 'ask'] as const;
export type SignalSource = (typeof SIGNAL_SOURCES)[number];

/** A catalogue planet and, when it is known, one of its facets. */
export interface GapTarget {
  readonly planet: string;
  readonly facet?: string;
}

/** The planets of the catalogue and the facets of each, as the scan and the signals check names against it. */
export interface CatalogueTopic {
  readonly id: string;
  readonly facets: readonly string[];
}

/**
 * The floors and targets. A planet needs at least `minUnits` released explanations across at least `minFacets` facets, and
 * `depthTarget` is how many it should have before the loop stops calling it shallow (one value, read from configuration).
 */
export interface GapPolicy {
  readonly minUnits: number;
  readonly minFacets: number;
  readonly depthTarget: number;
}
export const DEFAULT_GAP_POLICY: GapPolicy = { minUnits: 3, minFacets: 2, depthTarget: 6 };

/** What the library can serve now, for one planet: its released explanations and, by facet, how many each facet has. */
export interface PlanetFacts {
  readonly units: number;
  readonly facets: ReadonlyMap<string, number>;
}

/** A hole as a scan finds it, before it is stored: what it is, how severe it is and how many readers pointed to it. */
export interface GapCandidate {
  readonly kind: GapKind;
  readonly planet: string;
  readonly facet?: string;
  /** 1 (demand) to 5 (a planet with nothing released): structural severity, which always comes before readers and age. */
  readonly severity: number;
  /** Reader-days counted for it over the window (distinct readers a day, summed over the days). */
  readonly readers: number;
}

/** Severity of each kind; a planet with nothing released at all is worse than one that is only thin. */
const SEVERITY: Readonly<Record<GapKind, number>> = { thin_planet: 4, empty_facet: 3, shallow_planet: 2, demand: 1 };
const SEVERITY_EMPTY_PLANET = 5;

/** The most a bounded log of readers can add to a priority: always below one step of severity. */
const MAX_READER_BAND = 12;

/** The days of signals a scan counts. */
export const SIGNAL_WINDOW_DAYS = 14;

/** A bounded log of the readers: 0 for none, 1 for one, 2 for three, 3 for seven, up to {@link MAX_READER_BAND}. */
export const readerBand = (readers: number): number =>
  Math.min(MAX_READER_BAND, Math.floor(Math.log2(Math.max(0, readers) + 1)));

/**
 * Priority of a gap: structural severity first, then a bounded log of the distinct readers. Age is the last tie-break and is
 * ordered by the store (`first_seen_at`, oldest first). Always in 0 to 1000, as the table checks.
 */
export const priorityOf = (severity: number, readers: number): number => severity * 100 + readerBand(readers);

/** The string a gap's key is the hash of: kind, planet and facet, so one hole has one key however often it is found. */
export const gapIdentity = (kind: GapKind, target: GapTarget): string =>
  ['supply-gap.v1', kind, target.planet, target.facet ?? ''].join('\u0000');

/** The catalogue topic of a planet id, or `undefined` for a name the catalogue does not hold. */
const topicOf = (catalogue: readonly CatalogueTopic[], planet: string) =>
  catalogue.find((topic) => topic.id === planet);

/** Whether a planet, and the facet when there is one, are exactly a planet and a facet of the catalogue. */
export const isCatalogueTarget = (catalogue: readonly CatalogueTopic[], target: GapTarget): boolean => {
  const topic = topicOf(catalogue, target.planet);
  return topic !== undefined && (target.facet === undefined || topic.facets.includes(target.facet));
};

/**
 * The structural holes of the library: for each planet of the catalogue, from what the library can serve now.
 *
 * - `thin_planet`: fewer released explanations than `minUnits`, or released across fewer than `minFacets` facets. A planet with
 *   nothing released is the most severe.
 * - `empty_facet`: a facet with no released explanation. Only for a planet that is not thin: a thin planet is asked for as a
 *   whole, and the facets it still lacks are looked at once it is not.
 * - `shallow_planet`: a planet that is not thin, has no empty facet and is below the depth target.
 *
 * Deterministic and ordered by planet, then facet.
 */
export function structuralGaps(
  catalogue: readonly CatalogueTopic[],
  facts: ReadonlyMap<string, PlanetFacts>,
  policy: GapPolicy,
): readonly GapCandidate[] {
  const found: GapCandidate[] = [];
  for (const topic of [...catalogue].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    const planet = facts.get(topic.id) ?? { units: 0, facets: new Map<string, number>() };
    const covered = topic.facets.filter((facet) => (planet.facets.get(facet) ?? 0) > 0).length;
    // A planet with no facet to cover cannot be asked for by facet; only the floor on explanations applies to it.
    const needFacets = Math.min(policy.minFacets, topic.facets.length);
    if (planet.units < policy.minUnits || covered < needFacets) {
      found.push({
        kind: 'thin_planet',
        planet: topic.id,
        severity: planet.units === 0 ? SEVERITY_EMPTY_PLANET : SEVERITY.thin_planet,
        readers: 0,
      });
      continue;
    }
    const empty = topic.facets.filter((facet) => (planet.facets.get(facet) ?? 0) === 0);
    for (const facet of empty)
      found.push({ kind: 'empty_facet', planet: topic.id, facet, severity: SEVERITY.empty_facet, readers: 0 });
    if (empty.length === 0 && planet.units < policy.depthTarget)
      found.push({ kind: 'shallow_planet', planet: topic.id, severity: SEVERITY.shallow_planet, readers: 0 });
  }
  return found;
}

/** The distinct readers of one day (or of the window) who pointed to a planet and, when known, a facet. */
export interface DemandSignal extends GapTarget {
  readonly readers: number;
}

/**
 * Adds the readers' signals to the structural holes. A signal joins the hole of its own planet and facet, else the hole of the whole
 * planet it names (a thin or shallow planet is asked for as a whole), and otherwise opens a `demand` gap of its own. A signal that
 * names no planet or facet of the catalogue is dropped: a name the catalogue lacks cannot become a gap. Readers of signals that join
 * the same gap add up. Order: the structural gaps as they came, then the new demand gaps by planet and facet.
 */
export function mergeDemand(
  catalogue: readonly CatalogueTopic[],
  structural: readonly GapCandidate[],
  signals: readonly DemandSignal[],
): readonly GapCandidate[] {
  const merged = structural.map((gap) => ({ ...gap }));
  const added = new Map<string, GapCandidate>();
  const same = (gap: GapCandidate, planet: string, facet: string | undefined) =>
    gap.planet === planet && gap.facet === facet;
  for (const signal of signals) {
    if (!isCatalogueTarget(catalogue, signal) || signal.readers < 1) continue;
    const exact = merged.find((gap) => same(gap, signal.planet, signal.facet));
    const whole = merged.find((gap) => same(gap, signal.planet, undefined) && gap.kind !== 'demand');
    const target = exact ?? whole;
    if (target) {
      merged[merged.indexOf(target)] = { ...target, readers: target.readers + signal.readers };
      continue;
    }
    const key = `${signal.planet}\u0000${signal.facet ?? ''}`;
    const previous = added.get(key);
    added.set(key, {
      kind: 'demand',
      planet: signal.planet,
      ...(signal.facet === undefined ? {} : { facet: signal.facet }),
      severity: SEVERITY.demand,
      readers: (previous?.readers ?? 0) + signal.readers,
    });
  }
  const demand = [...added.values()].sort((a, b) =>
    `${a.planet}\u0000${a.facet ?? ''}` < `${b.planet}\u0000${b.facet ?? ''}` ? -1 : 1,
  );
  return [...merged, ...demand];
}

/**
 * The readers who pointed to a hole after a given UTC day: the counted signals of its planet (of its facet too when it has one) on
 * days after `afterDay`. A rejected key is opened again only by these, never by the structure that was there when it was rejected.
 */
export function newReadersOf(
  signals: readonly (GapTarget & { readonly day: string; readonly readers: number })[],
  hole: GapTarget,
  afterDay: string,
): number {
  return signals
    .filter(
      (signal) =>
        signal.day > afterDay &&
        signal.planet === hole.planet &&
        (hole.facet === undefined || signal.facet === hole.facet),
    )
    .reduce((total, signal) => total + signal.readers, 0);
}

/** One recipe that would serve a gap's planet, as the brief step needs to know it. */
export interface RecipeFact {
  readonly key: string;
  /** Stored in the database: a proposal of the loop or an operator's, not a recipe of the library plan. */
  readonly stored: boolean;
  readonly facetId: string;
  readonly state: 'not_started' | 'running' | 'published' | 'held' | 'retryable' | 'stopped';
  readonly take?: number;
}

/**
 * How many recipes of one planet may be in the pipeline (running, or produced and waiting for an operator's read) before the loop
 * proposes no more for it. A thin planet needs three explanations, so three in the pipeline fill it: more would only pile up
 * work for the one thing that is slow, the read.
 */
export const PIPELINE_LIMIT = 3;

/** What the brief job does for one gap, from the recipes that would serve it. */
export type GapStep =
  /** The hole is already being filled: these recipes are running or held for a read. Nothing is spent. */
  | { readonly kind: 'wait'; readonly recipes: readonly string[] }
  /** Stored recipes wait to be produced: commission these, at most one for each facet, without asking a model. */
  | { readonly kind: 'commission'; readonly recipes: readonly RecipeFact[] }
  /** Nothing in the pipeline and nothing to produce: ask the brief role for recipes. */
  | { readonly kind: 'propose' };

/**
 * Chooses the next step for a gap (see {@link PIPELINE_LIMIT}): wait while the pipeline already holds enough for it (one recipe for
 * a facet, three for a planet), else commission the stored recipes that are waiting to be produced, else propose. A recipe of the
 * library plan that has not been produced is the operator's to make; it neither fills the pipeline nor is commissioned here.
 */
export function decideGapStep(gap: { readonly facet?: string }, recipes: readonly RecipeFact[]): GapStep {
  const serving = gap.facet === undefined ? recipes : recipes.filter((recipe) => recipe.facetId === gap.facet);
  const live = serving.filter((recipe) => recipe.state === 'running' || recipe.state === 'held');
  if (live.length >= (gap.facet === undefined ? PIPELINE_LIMIT : 1))
    return { kind: 'wait', recipes: live.map((recipe) => recipe.key).slice(0, MAX_GAP_RECIPES) };
  const waiting = serving.filter(
    (recipe) =>
      recipe.stored && (recipe.state === 'not_started' || recipe.state === 'retryable') && recipe.take !== undefined,
  );
  const room = Math.max(0, (gap.facet === undefined ? PIPELINE_LIMIT : 1) - live.length);
  const onePerFacet = waiting.filter(
    (recipe, index) => waiting.findIndex((r) => r.facetId === recipe.facetId) === index,
  );
  if (onePerFacet.length > 0) return { kind: 'commission', recipes: onePerFacet.slice(0, room) };
  return { kind: 'propose' };
}

/** How many failed proposing attempts end a gap as `rejected`. */
export const MAX_GAP_ATTEMPTS = 2;

/** The most recipes a gap names (the table checks it): what one proposal may store, and what a wait records. */
export const MAX_GAP_RECIPES = 3;

/**
 * What the brief job learned from one proposing attempt, as the application maps the content module's answer. Never the model's text:
 * only recipe keys and codes.
 */
export type ProposalResult =
  /** Recipes were stored (by this attempt or an earlier delivery of it). */
  | { readonly kind: 'recipes'; readonly runId?: string; readonly keys: readonly string[] }
  /** Nothing was sent: the planet, the facet or the pages are not there. A retry meets the same wall. */
  | {
      readonly kind: 'refused';
      readonly code: 'topic_unknown' | 'facet_unknown' | 'no_candidate_pages' | 'retry_out_of_range';
    }
  /** The run ended and stored nothing: the model's drafts were all refused, or its answer was unusable. */
  | { readonly kind: 'failed'; readonly code: 'nothing_accepted' | 'model_failed' | 'closed'; readonly runId?: string }
  /** A daily budget or the provider's quota is used up: nothing was sent, and the attempt is not spent. */
  | { readonly kind: 'paused'; readonly code: string }
  /** An attempt of unknown outcome, or a refusal that may have reached the provider: never resent. */
  | { readonly kind: 'unknown'; readonly code: string; readonly runId?: string };

/** What the outcome does to the gap. `keep` changes nothing and ends the pass: the budget is spent. */
export type GapTransition =
  | { readonly kind: 'briefed'; readonly recipes: readonly string[]; readonly runId?: string }
  | { readonly kind: 'failed'; readonly attempts: number; readonly reason: string }
  | { readonly kind: 'rejected'; readonly attempts: number; readonly reason: string }
  /** Nothing was sent and no retry could change it: the gap is rejected at once, and no attempt is spent or counted. */
  | { readonly kind: 'refused'; readonly reason: string }
  | { readonly kind: 'blocked'; readonly reason: string }
  | { readonly kind: 'keep'; readonly reason: string };

/**
 * The transition an attempt's outcome causes (#674, D-414). Recipes stored: the gap is `briefed`. A refusal no retry can change
 * rejects it at once, with the code. A run that stored nothing is a failed attempt, and the second one rejects the gap with the
 * reason code. A spent budget keeps it as it is. An attempt of unknown outcome blocks it: it is never resent.
 */
export function afterProposal(gap: { readonly attempts: number }, result: ProposalResult): GapTransition {
  switch (result.kind) {
    case 'recipes':
      return result.keys.length > 0
        ? {
            kind: 'briefed',
            recipes: result.keys.slice(0, MAX_GAP_RECIPES),
            ...(result.runId === undefined ? {} : { runId: result.runId }),
          }
        : failedAttempt(gap.attempts, 'nothing_accepted');
    case 'refused':
      return { kind: 'refused', reason: result.code };
    case 'failed':
      return failedAttempt(gap.attempts, result.code);
    case 'paused':
      return { kind: 'keep', reason: reasonCode(result.code) };
    case 'unknown':
      return { kind: 'blocked', reason: reasonCode(result.code) };
  }
}

function failedAttempt(attempts: number, reason: string): GapTransition {
  const next = attempts + 1;
  return next >= MAX_GAP_ATTEMPTS
    ? { kind: 'rejected', attempts: next, reason }
    : { kind: 'failed', attempts: next, reason };
}

/** A reason code in the shape the table checks: lower case, digits and underscores, at most 48 characters, never empty. */
export function reasonCode(code: string): string {
  const cleaned = code
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '_')
    .replaceAll(/^_+|_+$/g, '')
    .slice(0, 48);
  return /^[a-z]/.test(cleaned) ? cleaned : 'unknown';
}

/**
 * When a key that was rejected may open a fresh gap, by the reason it was rejected for (#674, D-414). `signal`: the model's side failed and
 * another day may not, so readers who pointed to the key since may open it again. `cooldown`: what was missing may have arrived (a planet
 * that held no page gets one when an operator produces its first recipe), so the structure alone may open it again, at no cost, once the
 * cooldown has passed. Any other reason (a name the catalogue no longer holds) never does.
 */
const REOPEN_RULES: Readonly<Record<string, 'signal' | 'cooldown'>> = {
  nothing_accepted: 'signal',
  model_failed: 'signal',
  closed: 'signal',
  no_candidate_pages: 'cooldown',
};

/** How long a rejected key rests before it may open again. */
export const REOPEN_COOLDOWN_DAYS = 7;

const DAY_MS = 86_400_000;

/**
 * Whether a key that was rejected may open a fresh gap now: only when its reason allows it ({@link REOPEN_RULES}) and the cooldown has
 * passed, and, for a reason that waits for readers, only when readers pointed to it since. The caller passes only the readers counted
 * after the rejection: the structure that was there when it was rejected never reopens a key by itself unless the reason is a cooldown.
 */
export function mayReopen(
  rejected: { readonly reason: string; readonly endedAt: Date },
  newReaders: number,
  now: Date,
): boolean {
  const rule = REOPEN_RULES[rejected.reason];
  if (rule === undefined || now.getTime() - rejected.endedAt.getTime() < REOPEN_COOLDOWN_DAYS * DAY_MS) return false;
  return rule === 'cooldown' || newReaders > 0;
}

/** What a scan does with a commissioned gap, from where its recipes' production stands. */
export type CommissionedOutcome = 'close' | 'reopen' | 'keep';

/**
 * A commissioned gap closes when one of its recipes was released, goes back to `open` when every one of them ended without a
 * release (an operator rejected them, the takes ran out), and waits otherwise. A recipe the library no longer holds counts as ended.
 */
export function settleCommissioned(states: readonly (RecipeFact['state'] | undefined)[]): CommissionedOutcome {
  if (states.some((state) => state === 'published')) return 'close';
  if (states.every((state) => state === undefined || state === 'stopped')) return 'reopen';
  return 'keep';
}

/** The growth room left today: what the day's cap allows less the groups of stored recipes already started. */
export const growthRoom = (cap: number, startedToday: number): number => Math.max(0, cap - startedToday);

/**
 * Whether the loop may ask the brief role for recipes now: only while the growth cap leaves room to produce what comes back, and
 * while the day's proposing attempts are fewer than the cap, so a run of failures cannot spend model budget the cap never meets.
 */
export const mayPropose = (cap: number, startedToday: number, attemptsToday: number): boolean =>
  cap > 0 && growthRoom(cap, startedToday) > 0 && attemptsToday < cap;

/** The most gaps one pass of the brief job works on, and at most one of them for any planet. */
export const GAPS_PER_PASS = 3;
