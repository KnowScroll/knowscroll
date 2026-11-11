/**
 * The numbers of policy v3's long-term interest (D-420): a topic's interest is shrunk toward its system's and toward the
 * person's overall level, so a topic never met in a system the person loves scores above an unknown one, an old interest decays
 * toward its prior and never below an unknown topic, and a topic met once scores above one never met. Bench values for testing,
 * not calibrated parameters; every one is part of the policy and a change is a new policy label.
 *
 * Every activity here is reading-derived routing activity, decayed to the decision's evaluation time (D-063: no result, spark
 * or tier is an input).
 */
export interface InterestModel {
  /** The interest of a topic nothing is known about: policy v0 to v2 call it the neutral 0.5. */
  readonly base: number;
  /** Activity at which the topic's own evidence has half its say: `A / (A + h)`. v0 to v2's `A / (1 + A)` is `h = 1`. */
  readonly topicHalfSaturation: number;
  /** The same for the rest of the system (the system's activity less this topic's). A system gathers several topics, so it is larger. */
  readonly systemHalfSaturation: number;
  /** The same for the person's overall activity. */
  readonly personHalfSaturation: number;
  /** How much of the way from the person's level to 1 a fully loved system moves a never-met topic of it. In (0, 1]. */
  readonly systemWeight: number;
  /** How much of the way from `base` to 1 a person's overall level moves every topic's prior. In [0, 1): a heavy reader's unknowns are not all loved. */
  readonly personWeight: number;
}

/** What the interest of one topic reads, all decayed to the decision's evaluation time. */
export interface InterestInput {
  /** The topic's own activity; 0 for a topic the person has not met. */
  readonly topicActivity: number;
  /** The activity of the topic's system less the topic's own (the rest of the system); 0 when the system is unknown. */
  readonly systemRestActivity: number;
  /** The person's overall activity; 0 when none is known. */
  readonly personActivity: number;
}

const saturating = (activity: number, halfSaturation: number): number => {
  const value = Math.max(0, activity);
  return value / (value + halfSaturation);
};

/**
 * The interest of a topic in [0, 1], as shrinkage from the general to the particular:
 *
 * ```
 * person  = base   + (1 - base)   * personWeight * A_person / (A_person + h_person)
 * system  = person + (1 - person) * systemWeight * A_rest   / (A_rest   + h_system)
 * topic   = system + (1 - system) *                A_topic  / (A_topic  + h_topic)
 * ```
 *
 * It is monotone in every activity and equals `base` with none, so a topic with any activity scores at least as high as one with
 * none, a never-met topic in a system with activity scores above an unknown one, and as the activities decay the interest falls
 * to the level of its system and then of the person, never below `base`. Pure.
 */
export function shrunkInterest(model: InterestModel, input: InterestInput): number {
  const person =
    model.base + (1 - model.base) * model.personWeight * saturating(input.personActivity, model.personHalfSaturation);
  const system =
    person + (1 - person) * model.systemWeight * saturating(input.systemRestActivity, model.systemHalfSaturation);
  return system + (1 - system) * saturating(input.topicActivity, model.topicHalfSaturation);
}

/** Qualified responses over measured encounters of one kind: reading only, never correctness (D-063). */
export interface FormatCounts {
  readonly measured: number;
  readonly qualified: number;
}

/**
 * The numbers of policy v3's format learning (D-420): the rate at which a person qualifies a kind is estimated per topic, shrunk
 * toward the same rate in the topic's system, then in the person overall, then toward a global prior chosen by the candidate's
 * duration. Bench values for testing, not calibrated parameters.
 */
export interface FormatModel {
  /** Pseudo-encounters of weight the person's other systems' rate carries against the global prior. */
  readonly personStrength: number;
  /** The same for the rest of the system against the person's rate. */
  readonly systemStrength: number;
  /** The same for the rest of the topic against its system's rate. */
  readonly topicStrength: number;
  /** The same for a play-level cell against the rest of its topic (policy v1's prior strength). */
  readonly cellStrength: number;
  /** A candidate under this many minutes is `short`. A Reel is always short (20 to 60 seconds). */
  readonly shortBelowMinutes: number;
  /** A candidate of at least this many minutes is `long`. */
  readonly longFromMinutes: number;
  /**
   * The qualified-response rate expected of a candidate of a duration before anything is known: the global prior the chain
   * ends in. It is flat (0.5) in policy v3, because nothing measured supports a tilt and duration is not independent of format
   * (a Reel is always short, so any difference between buckets would be a preference between formats at a cold start, against
   * the equal-status rule: an earlier draft with short 0.55 and long 0.45 sent the lab's cold-start reader to Reels). The buckets
   * are in the policy so a table measured later is a new policy label and not a change of code.
   */
  readonly prior: Readonly<Record<DurationBucket, number>>;
}

export type DurationBucket = 'short' | 'medium' | 'long';

/** The duration bucket of a candidate: a Reel is short; a Scroll by its reading minutes, or medium when it states none. */
export function durationBucketOf(
  encounter: { readonly kind: 'reel' | 'scroll'; readonly traits?: { readonly readingMinutes?: number } },
  model: Pick<FormatModel, 'shortBelowMinutes' | 'longFromMinutes'>,
): DurationBucket {
  if (encounter.kind === 'reel') return 'short';
  const minutes = encounter.traits?.readingMinutes;
  if (minutes === undefined) return 'medium';
  return minutes < model.shortBelowMinutes ? 'short' : minutes >= model.longFromMinutes ? 'long' : 'medium';
}

const NONE: FormatCounts = { measured: 0, qualified: 0 };

/** `whole` less `part`, the counts that belong to the rest: never below zero, never more qualified than measured. */
function without(whole: FormatCounts, part: FormatCounts): FormatCounts {
  const measured = Math.max(0, whole.measured - part.measured);
  return { measured, qualified: Math.min(measured, Math.max(0, whole.qualified - part.qualified)) };
}

/** The estimate of a rate from its own counts and a prior that carries `strength` encounters of weight. */
const shrink = (counts: FormatCounts, strength: number, prior: number): number =>
  (counts.qualified + strength * prior) / (counts.measured + strength);

/** The counts the hierarchy reads for one candidate's topic and kind; a level the input does not hold is absent. */
export interface FormatLevels {
  readonly person?: FormatCounts;
  readonly system?: FormatCounts;
  readonly topic?: FormatCounts;
  /** The play-level cell of the candidate within the topic (D-192). */
  readonly cell?: FormatCounts;
}

/**
 * The format fit of one topic for a candidate's kind in [0, 1]: a chain of shrinkages from the general to the particular.
 *
 * ```
 * person = (Q_person − Q_system + m_p * prior) / (O_person − O_system + m_p)        prior from the candidate's duration
 * system = (Q_system − Q_topic  + m_s * person) / (O_system − O_topic  + m_s)
 * topic  = (Q_topic  − Q_cell   + m_t * system) / (O_topic  − O_cell   + m_t)
 * fit    = (Q_cell              + m_c * topic ) / (O_cell              + m_c)
 * ```
 *
 * Each level is the rest of its parent, so no encounter is counted twice, and a level with no counts equals the level above.
 * With nothing known it is the duration prior. A system that is not known skips its step. Pure.
 */
export function hierarchicalFormatFit(model: FormatModel, levels: FormatLevels, prior: number): number {
  const topic = levels.topic ?? NONE;
  const cell = levels.cell ?? NONE;
  const person = shrink(without(levels.person ?? NONE, levels.system ?? topic), model.personStrength, prior);
  const system =
    levels.system === undefined ? person : shrink(without(levels.system, topic), model.systemStrength, person);
  const topicRate = shrink(without(topic, cell), model.topicStrength, system);
  return shrink(cell, model.cellStrength, topicRate);
}
