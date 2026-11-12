import {
  contentStems,
  noClaimGround,
  sharedStems,
  type CheckerRules,
  type NoClaimGround,
  type RuleCode,
  type SentenceUnderCheck,
  type SentenceVerdict,
  type UnsupportedKind,
} from './ask-support.js';

/**
 * The support check of a library Scroll (D-415): the check of an ask order's answer (D-250), ported to the prose of a stored
 * Scroll revision. A model reads each sentence against the passages the sentence's own part cites and only proposes. Code
 * judges each verdict on its own sentence (`judgeVerdicts`), keeps what became of every sentence, and decides the
 * revision's verdict from those results with a policy. Nothing here releases, rejects or serves anything: the check informs
 * an operator, and its agreement with the operator's own decisions is measured before anything relies on it. Pure.
 */

/**
 * The rules code applies to each verdict of the library check (D-415).
 * - `oneKeyWordAbout`: a Scroll is written in other words than its sources (nine words in a row may not be copied), so a sentence that is
 *   supported is usually a paraphrase of its passage that keeps one of its key words; the quote needs one key word the sentence shares and
 *   two of its own, as in an ask order's answer (D-306).
 * - `shortNoClaim` off: a figure-free sentence of eight words or fewer may not be marked as stating no fact on its length; a short line can
 *   state a fact ("Distance was never the lever.") and nothing takes a sentence out of a Scroll (D-307).
 * - `ownPassagesOnly`: the quote must come from a passage the sentence's own stop, aside or recap cites. A sentence supported only by another
 *   stop's passage is not supported where the reader reads it. The title and the dek cite every passage the Scroll cites, so they may use any.
 * - `noClaimUnshared` off: a sentence that shares no key word with its passages is not "no fact" on that ground, because that would be the way
 *   past the check for any sentence; it needs a quote like any other, and a "no fact" verdict for it is set aside.
 */
export const LIBRARY_CHECK_RULES: CheckerRules = {
  shortNoClaim: false,
  oneKeyWordAbout: true,
  ownPassagesOnly: true,
  noClaimUnshared: false,
};

/** Where a sentence stands in the Scroll, as a short code: what kind of text it came from. Fixed here, so a stored row never holds free text. */
export const LIBRARY_FIELDS = [
  'title',
  'dek',
  'heading',
  'paragraph',
  'line',
  'simple',
  'guide',
  'prompt',
  'explain',
  'twist',
  'sort',
  'fork',
  'point',
  'aside-title',
  'aside-text',
  'caption',
] as const;
export type LibraryField = (typeof LIBRARY_FIELDS)[number];

/** One sentence of a Scroll as the checker is shown it, with where it stands: the part (a stop, an aside, `recap`, `title`, `dek`) and the kind of text. */
export interface LibrarySentence extends SentenceUnderCheck {
  readonly part: string;
  readonly field: LibraryField;
}

/**
 * What became of one sentence.
 * - `supported`: the checker quoted words of a passage the sentence cites that state it, and code found the quote real and about the sentence.
 * - `unsupported`: the checker found that the cited passages do not state it (`kind`, with a short `problem`).
 * - `unclear`: the checker's verdict broke a rule code applies (the quote was too short, not in a passage the sentence cites or about something
 *   else, or "no fact" had no ground code can see). Nothing shows that a passage states the sentence, and the checker did not say none does.
 * - `no_claim`: the sentence adds no fact, on a ground code can see (a label, a plain admission of a gap), kept as `ground`.
 */
export const LIBRARY_SENTENCE_OUTCOMES = ['supported', 'unsupported', 'unclear', 'no_claim'] as const;
export type LibrarySentenceOutcome = (typeof LIBRARY_SENTENCE_OUTCOMES)[number];

/** The result for one sentence as it is stored: the sentence's words, where it stands, what became of it and why. */
export interface LibrarySentenceResult {
  /** 1-based, in reading order across the whole Scroll. */
  readonly n: number;
  readonly part: string;
  readonly field: LibraryField;
  readonly text: string;
  /** A title, a heading or the title of an aside. */
  readonly label?: true;
  readonly outcome: LibrarySentenceOutcome;
  /** For `unsupported`: the checker's kind. */
  readonly kind?: UnsupportedKind;
  /** For `unclear`: the rule the checker's verdict broke. */
  readonly code?: RuleCode;
  /** For `unsupported`: the checker's short note. An operator's note, never shown to a reader. */
  readonly problem?: string;
  /** For `no_claim`: the ground code found for it. */
  readonly ground?: NoClaimGround;
  /**
   * The quote the checker gave for the sentence, kept for a supported sentence and for one code set aside on its quote, with how it stands to
   * the sentence: `keyWords` (the sentence's), `quoteKeyWords` (the quote's) and `shared` (the key words they share). A stricter rule (two shared
   * key words, say) can be applied to these later without asking the checker again.
   */
  readonly quote?: string;
  readonly keyWords?: number;
  readonly quoteKeyWords?: number;
  readonly shared?: number;
}

/** What `resultsOf` needs besides the verdicts: the quote the checker gave for each supported sentence, the words of each passage, and the rules. */
export interface ResultContext {
  /** The quote the checker gave for each sentence it called supported, by sentence number, before any rule was applied. */
  readonly quotes: ReadonlyMap<number, string>;
  /** The words of each passage by handle. */
  readonly passageTexts: ReadonlyMap<string, string>;
  readonly rules?: CheckerRules;
}

/**
 * The results for the sentences, from the verdicts that count (`judgeVerdicts` has already set aside those that broke a rule).
 * A verdict code set aside carries its rule's `code`: it becomes `unclear`, not `unsupported`, because the checker did not say that no passage
 * states the sentence. A `no_claim` keeps the ground code found for it; a quote is kept with its fit to the sentence.
 */
export function resultsOf(
  sentences: readonly LibrarySentence[],
  verdicts: readonly SentenceVerdict[],
  context: ResultContext,
): readonly LibrarySentenceResult[] {
  const verdictOf = new Map(verdicts.map((verdict) => [verdict.number, verdict]));
  const rules = context.rules ?? LIBRARY_CHECK_RULES;
  return sentences.map((sentence): LibrarySentenceResult => {
    const base = {
      n: sentence.number,
      part: sentence.part,
      field: sentence.field,
      text: sentence.text,
      ...(sentence.label === true ? { label: true as const } : {}),
    };
    const quote = context.quotes.get(sentence.number);
    const fit =
      quote === undefined
        ? {}
        : {
            quote,
            keyWords: contentStems(sentence.text).size,
            quoteKeyWords: contentStems(quote).size,
            shared: sharedStems(quote, sentence.text),
          };
    const verdict = verdictOf.get(sentence.number);
    // A sentence with no verdict cannot happen after the shape of the reply is checked; it is never counted as supported.
    if (verdict === undefined) return { ...base, outcome: 'unclear' };
    if (verdict.verdict === 'unsupported')
      return verdict.code === undefined
        ? { ...base, outcome: 'unsupported', kind: verdict.kind, problem: verdict.problem }
        : { ...base, outcome: 'unclear', code: verdict.code, ...fit };
    if (verdict.verdict === 'supported') return { ...base, outcome: 'supported', ...fit };
    const cited = sentence.cites.flatMap((handle) => context.passageTexts.get(handle) ?? []);
    const ground = noClaimGround(sentence, cited, rules);
    return ground === undefined ? { ...base, outcome: 'unclear' } : { ...base, outcome: 'no_claim', ground };
  });
}

/** How many sentences of a Scroll came to each outcome. */
export interface LibraryCounts {
  readonly sentences: number;
  readonly supported: number;
  readonly unsupported: number;
  readonly unclear: number;
  readonly noClaim: number;
  /** How many of the `noClaim` sentences are labels or plain admissions of a gap: no fact is claimed, and nothing was checked for them. */
  readonly noClaimLabel: number;
}

export function countsOf(
  results: readonly { readonly outcome: LibrarySentenceOutcome; readonly ground?: NoClaimGround | undefined }[],
): LibraryCounts {
  const count = (outcome: LibrarySentenceOutcome) => results.filter((result) => result.outcome === outcome).length;
  return {
    sentences: results.length,
    supported: count('supported'),
    unsupported: count('unsupported'),
    unclear: count('unclear'),
    noClaim: count('no_claim'),
    noClaimLabel: results.filter(
      (result) => result.outcome === 'no_claim' && (result.ground === 'label' || result.ground === 'gap'),
    ).length,
  };
}

/**
 * What code lets a check say about a revision. The first policy is the strictest one that is still a rule: no sentence the
 * checker found unsupported and none left unclear, and at most `maxLabelNoClaim` labels and admissions passed as stating no fact (a title,
 * a heading or an aside's title of a few words passes without a quote, so a Scroll may not lean on them). A looser policy is a new version,
 * measured against the operator's decisions before it is chosen (`agreementOf` reports the same stored results under looser limits).
 * `null` means no limit.
 */
export interface SupportPolicy {
  readonly id: string;
  readonly maxUnsupported: number | null;
  readonly maxUnclear: number | null;
  readonly maxLabelNoClaim: number | null;
}

export const LIBRARY_SUPPORT_POLICY: SupportPolicy = {
  id: 'library-support-policy.v2',
  maxUnsupported: 0,
  maxUnclear: 0,
  maxLabelNoClaim: 8,
};

/** What a check that gave results says about the revision: `passed` clears the policy, `flagged` does not. A check with no results is `unchecked` (below). */
export type RevisionVerdict = 'passed' | 'flagged';

/** What the check says about a revision, including a check that gave nothing. */
export type CheckVerdict = RevisionVerdict | 'unchecked';

const within = (count: number, limit: number | null): boolean => limit === null || count <= limit;

/** The revision's verdict from its sentences' outcomes. Code decides; the checker's words never do. */
export function decideRevision(counts: LibraryCounts, policy: SupportPolicy = LIBRARY_SUPPORT_POLICY): RevisionVerdict {
  return within(counts.unsupported, policy.maxUnsupported) &&
    within(counts.unclear, policy.maxUnclear) &&
    within(counts.noClaimLabel, policy.maxLabelNoClaim)
    ? 'passed'
    : 'flagged';
}

/** What an operator decided about a revision at the review gate. */
export type HumanDecision = 'released' | 'rejected';

/**
 * One revision the operator decided, with what the check said about it: `counts` is `null` when it was not checked (`code` says why).
 * `checkedAt` is when the stored result was made, `decidedAt` when the operator decided: a result made after the decision cannot have
 * influenced it.
 */
export interface DecidedCheck {
  readonly decision: HumanDecision;
  /** The system of the revision's recipe (`earth`, `space`, …), or `other` for an asset the plan does not name. */
  readonly family: string;
  readonly decidedAt: string;
  readonly checkedAt: string | null;
  readonly counts: LibraryCounts | null;
  readonly code?: string;
}

/** The check against the decision, for the revisions that were checked. `rejectedPassed` is the dangerous number. */
export interface Confusion {
  readonly releasedPassed: number;
  readonly releasedFlagged: number;
  readonly rejectedPassed: number;
  readonly rejectedFlagged: number;
}

/** A count out of a number, with how far it can be trusted: the Wilson 95% interval, and the rule of three (3 / n) when none happened. */
export interface Rate {
  readonly k: number;
  readonly n: number;
  readonly rate: number | null;
  readonly wilsonLower: number | null;
  readonly wilsonUpper: number | null;
  readonly ruleOfThree: number | null;
}

const WILSON_Z = 1.96;
const thousandths = (value: number): number => Math.round(value * 1000) / 1000;

/** `k` of `n` with its Wilson 95% interval; every field but the counts is `null` when `n` is zero. */
export function rateOf(k: number, n: number): Rate {
  if (n === 0) return { k, n, rate: null, wilsonLower: null, wilsonUpper: null, ruleOfThree: null };
  const p = k / n;
  const z2 = WILSON_Z * WILSON_Z;
  const centre = (p + z2 / (2 * n)) / (1 + z2 / n);
  const half = (WILSON_Z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / (1 + z2 / n);
  return {
    k,
    n,
    rate: thousandths(p),
    wilsonLower: thousandths(Math.max(0, centre - half)),
    wilsonUpper: thousandths(Math.min(1, centre + half)),
    ruleOfThree: k === 0 ? thousandths(Math.min(1, 3 / n)) : null,
  };
}

/** The most the rejected revisions a check passes may be, at the upper end of the interval, for the measure to say the check is good enough to consider. */
export const MAX_DANGEROUS_RATE = 0.1;

/** The fewest rejected revisions in the older half that a policy may be chosen from. */
export const MIN_REJECTED_TO_CHOOSE = 3;

/** The same stored results under a looser policy: counts only, so the table of choices costs nothing to read. */
export interface PolicyChoice extends Confusion {
  readonly maxUnsupported: number | null;
  readonly maxUnclear: number | null;
}

type Counted<T> = T & { readonly checked: number };

/** A confusion with how many revisions it covers and how far the dangerous number can be trusted. */
export interface Measured extends Confusion {
  readonly checked: number;
  readonly rejectedPassedRate: Rate;
  readonly releasedFlaggedRate: Rate;
  readonly flagRate: Rate;
}

/** The older decisions choose a policy and the newer ones report it: what each half holds and what the chosen policy did on the newer. */
export interface TimeSplit {
  readonly selection: { readonly n: number; readonly rejected: number; readonly until: string | null };
  readonly evaluation: { readonly n: number; readonly rejected: number; readonly from: string | null };
  /** The loosest limits that passed none of the older half's rejected revisions, or `null` when the older half cannot choose (`chosenReason` says why). */
  readonly chosen: PolicyChoice | null;
  readonly chosenReason: string;
  /** The active policy on the newer half. */
  readonly evaluationUnderPolicy: Measured;
  /** The chosen limits on the newer half, never used to choose. */
  readonly evaluationUnderChosen: Measured | null;
}

export interface AgreementReport extends Confusion {
  readonly policy: string;
  /** Human decisions read. */
  readonly decided: number;
  /** Revisions that were checked and decided with no result in existence: the matrix is over these alone. */
  readonly checked: number;
  /** Revisions that were checked before the operator decided: a result existed that the operator could have seen. Kept apart, never in the matrix. */
  readonly exposed: Counted<Confusion>;
  readonly notChecked: { readonly total: number; readonly byCode: Readonly<Record<string, number>> };
  /** How many of the checked revisions were released and how many rejected. */
  readonly released: number;
  readonly rejected: number;
  readonly rejectedPassedRate: Rate;
  readonly releasedFlaggedRate: Rate;
  /** The share of checked revisions the check flags. */
  readonly flagRate: Rate;
  /** The share of rejected revisions the check flags, or `null` with none. */
  readonly rejectedCaught: number | null;
  /** The share of released revisions the check passes, or `null` with none. */
  readonly releasedPassedShare: number | null;
  /** The share of checked revisions on which check and operator agree (released and passed, rejected and flagged). */
  readonly agreement: number | null;
}

export interface AgreementSummary extends AgreementReport {
  readonly byFamily: Readonly<Record<string, Counted<Confusion>>>;
  readonly choices: readonly PolicyChoice[];
  readonly split: TimeSplit;
  /** Whether the measure can say the check is good enough to consider, and plainly what it can and cannot say. */
  readonly conclusion: { readonly enough: boolean; readonly statement: string };
}

/** The limits tried by the table of choices. Looser than the policy only: the strictest is the policy itself. */
const CHOICE_UNSUPPORTED: readonly (number | null)[] = [0, 1, 2];
const CHOICE_UNCLEAR: readonly (number | null)[] = [0, 2, null];

const share = (part: number, whole: number): number | null => (whole === 0 ? null : thousandths(part / whole));

function confusionOf(rows: readonly DecidedCheck[], policy: SupportPolicy): Counted<Confusion> {
  let releasedPassed = 0;
  let releasedFlagged = 0;
  let rejectedPassed = 0;
  let rejectedFlagged = 0;
  for (const row of rows) {
    if (row.counts === null) continue;
    const passed = decideRevision(row.counts, policy) === 'passed';
    if (row.decision === 'released') {
      if (passed) releasedPassed += 1;
      else releasedFlagged += 1;
    } else if (passed) rejectedPassed += 1;
    else rejectedFlagged += 1;
  }
  return {
    releasedPassed,
    releasedFlagged,
    rejectedPassed,
    rejectedFlagged,
    checked: releasedPassed + releasedFlagged + rejectedPassed + rejectedFlagged,
  };
}

function measured(rows: readonly DecidedCheck[], policy: SupportPolicy): Measured {
  const matrix = confusionOf(rows, policy);
  return {
    ...matrix,
    rejectedPassedRate: rateOf(matrix.rejectedPassed, matrix.rejectedPassed + matrix.rejectedFlagged),
    releasedFlaggedRate: rateOf(matrix.releasedFlagged, matrix.releasedPassed + matrix.releasedFlagged),
    flagRate: rateOf(matrix.releasedFlagged + matrix.rejectedFlagged, matrix.checked),
  };
}

/** The table of looser limits over these rows, from the policy's other limits. */
function choicesOf(rows: readonly DecidedCheck[], policy: SupportPolicy): readonly PolicyChoice[] {
  return CHOICE_UNSUPPORTED.flatMap((maxUnsupported) =>
    CHOICE_UNCLEAR.map((maxUnclear): PolicyChoice => {
      const { checked: _checked, ...confusion } = confusionOf(rows, { ...policy, maxUnsupported, maxUnclear });
      return { maxUnsupported, maxUnclear, ...confusion };
    }),
  );
}

const rank = (limit: number | null): number => (limit === null ? Number.POSITIVE_INFINITY : limit);

/**
 * The limits chosen from the older half: of those that pass none of its rejected revisions, the one that passes the most of its released ones
 * (the stricter limits win a tie). Only when the older half holds enough rejected revisions to choose from.
 */
function chooseFrom(
  rows: readonly DecidedCheck[],
  policy: SupportPolicy,
): { readonly chosen: PolicyChoice | null; readonly reason: string } {
  const rejected = rows.filter((row) => row.decision === 'rejected' && row.counts !== null).length;
  if (rejected < MIN_REJECTED_TO_CHOOSE)
    return {
      chosen: null,
      reason: `The older half holds ${String(rejected)} rejected revision(s); a policy is chosen from at least ${String(MIN_REJECTED_TO_CHOOSE)}, so none was chosen.`,
    };
  const safe = choicesOf(rows, policy)
    .filter((choice) => choice.rejectedPassed === 0)
    .sort(
      (a, b) =>
        b.releasedPassed - a.releasedPassed ||
        rank(a.maxUnsupported) - rank(b.maxUnsupported) ||
        rank(a.maxUnclear) - rank(b.maxUnclear),
    );
  const [best] = safe;
  return best === undefined
    ? { chosen: null, reason: 'No limits pass none of the older half’s rejected revisions, so none was chosen.' }
    : {
        chosen: best,
        reason: 'The limits that pass none of the older half’s rejected revisions and pass most of its released ones.',
      };
}

const percent = (value: number | null): string => (value === null ? 'n/a' : `${String(thousandths(value * 100))}%`);

/** What the measure can and cannot say: the newer half's rejected revisions the active policy passed, with the upper end of the interval. */
function concludeFrom(evaluation: Measured): { readonly enough: boolean; readonly statement: string } {
  const { rejectedPassedRate: rate } = evaluation;
  if (rate.n === 0 || rate.wilsonUpper === null)
    return {
      enough: false,
      statement:
        'Not enough to conclude: the newer half holds no rejected revision that was checked blind, so the number of rejected revisions the check passes cannot be measured. Do not step review down on this.',
    };
  const bound = `${String(rate.k)} of ${String(rate.n)} rejected revision(s) in the newer half passed; the 95% upper bound of the rate is ${percent(rate.wilsonUpper)}`;
  return rate.wilsonUpper <= MAX_DANGEROUS_RATE
    ? {
        enough: true,
        statement: `${bound}, at most ${percent(MAX_DANGEROUS_RATE)}. That is evidence about these revisions only: read it with byFamily, and it does not make the check safe for another subject.`,
      }
    : {
        enough: false,
        statement: `Not enough to conclude: ${bound}, and it must be at most ${percent(MAX_DANGEROUS_RATE)} (about 30 rejected revisions with none passed). Do not step review down on this.`,
      };
}

/**
 * How the check agrees with the operator's own decisions (D-415): for the revisions the operator released or rejected, what the
 * check said under `policy`. The dangerous number is `rejectedPassed`, the revisions the operator rejected and the check would have
 * passed; `releasedFlagged` is the cost of the other mistake, a Scroll the operator served and the check would have held back.
 *
 * Only decisions made with no result in existence count (`checkedAt` at or after `decidedAt`): a result that existed before the decision could
 * have been seen, so those are reported apart (`exposed`). A revision that was not checked is counted apart with its reason and is in
 * neither: nothing is known about it. Each rate carries its Wilson interval, the older half of the decisions chooses limits and the newer half
 * reports them, and `conclusion` says plainly whether the number of rejected revisions is enough to conclude anything. Results of one checker
 * version only (the caller reads them so).
 */
export function agreementOf(
  rows: readonly DecidedCheck[],
  policy: SupportPolicy = LIBRARY_SUPPORT_POLICY,
): AgreementSummary {
  const isBlind = (row: DecidedCheck): boolean =>
    row.counts !== null && row.checkedAt !== null && Date.parse(row.checkedAt) >= Date.parse(row.decidedAt);
  const blind = rows.filter(isBlind);
  const exposedRows = rows.filter((row) => row.counts !== null && !isBlind(row));
  const total = measured(blind, policy);
  const byCode: Record<string, number> = {};
  for (const row of rows)
    if (row.counts === null) {
      const code = row.code ?? 'unknown';
      byCode[code] = (byCode[code] ?? 0) + 1;
    }
  const byFamily = Object.fromEntries(
    [...new Set(blind.map((row) => row.family))].sort().map((family) => [
      family,
      confusionOf(
        blind.filter((row) => row.family === family),
        policy,
      ),
    ]),
  );

  const ordered = [...blind].sort((a, b) => Date.parse(a.decidedAt) - Date.parse(b.decidedAt));
  const older = ordered.slice(0, Math.floor(ordered.length / 2));
  const newer = ordered.slice(older.length);
  const { chosen, reason } = chooseFrom(older, policy);
  const evaluationUnderPolicy = measured(newer, policy);
  const rejectedIn = (set: readonly DecidedCheck[]) => set.filter((row) => row.decision === 'rejected').length;
  const split: TimeSplit = {
    selection: { n: older.length, rejected: rejectedIn(older), until: older.at(-1)?.decidedAt ?? null },
    evaluation: { n: newer.length, rejected: rejectedIn(newer), from: newer[0]?.decidedAt ?? null },
    chosen,
    chosenReason: reason,
    evaluationUnderPolicy,
    evaluationUnderChosen:
      chosen === null
        ? null
        : measured(newer, { ...policy, maxUnsupported: chosen.maxUnsupported, maxUnclear: chosen.maxUnclear }),
  };

  const { checked, rejectedPassedRate, releasedFlaggedRate, flagRate, ...confusion } = total;
  const { checked: _exposedChecked, ...exposedConfusion } = confusionOf(exposedRows, policy);
  return {
    policy: policy.id,
    decided: rows.length,
    checked,
    exposed: { ...exposedConfusion, checked: exposedRows.length },
    notChecked: { total: rows.length - blind.length - exposedRows.length, byCode },
    ...confusion,
    released: confusion.releasedPassed + confusion.releasedFlagged,
    rejected: confusion.rejectedPassed + confusion.rejectedFlagged,
    rejectedPassedRate,
    releasedFlaggedRate,
    flagRate,
    rejectedCaught: share(confusion.rejectedFlagged, confusion.rejectedFlagged + confusion.rejectedPassed),
    releasedPassedShare: share(confusion.releasedPassed, confusion.releasedPassed + confusion.releasedFlagged),
    agreement: share(confusion.releasedPassed + confusion.rejectedFlagged, checked),
    byFamily,
    choices: choicesOf(blind, policy),
    split,
    conclusion: concludeFrom(evaluationUnderPolicy),
  };
}
