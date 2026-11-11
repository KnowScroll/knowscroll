import {
  type CheckerRules,
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
 * The rules code applies to each verdict of the library check (D-415). A Scroll is written in other words than its sources (nine words in a
 * row may not be copied), so a sentence that is supported is usually a paraphrase of its passage that keeps one of its key words: the quote
 * needs one key word the sentence shares and two of its own (`oneKeyWordAbout`, D-306), as in an ask order's answer. A figure-free sentence
 * of eight words or fewer may not be marked as stating no fact on its length (`shortNoClaim` off, D-307): nothing takes a sentence out of a
 * Scroll, and a short line can state a fact ("Distance was never the lever."), so it needs a quote like any other sentence.
 */
export const LIBRARY_CHECK_RULES: CheckerRules = { shortNoClaim: false, oneKeyWordAbout: true };

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
 * - `supported`: the checker quoted words of a cited passage that state it, and code found the quote real and about the sentence.
 * - `unsupported`: the checker found that the cited passages do not state it (`kind`, with a short `problem`).
 * - `unclear`: the checker's verdict broke a rule code applies (the quote was too short, not in a cited passage or about something
 *   else, or "no fact" had no ground code can see). Nothing shows that a passage states the sentence, and the checker did not say none does.
 * - `no_claim`: the sentence adds no fact, on a ground code can see (a label, a plain admission of a gap).
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
}

/**
 * The results for the sentences, from the verdicts that count (`judgeVerdicts` has already set aside those that broke a rule).
 * A verdict code set aside carries its rule's `code`: it becomes `unclear`, not `unsupported`, because the checker did not say that no passage
 * states the sentence.
 */
export function resultsOf(
  sentences: readonly LibrarySentence[],
  verdicts: readonly SentenceVerdict[],
): readonly LibrarySentenceResult[] {
  const verdictOf = new Map(verdicts.map((verdict) => [verdict.number, verdict]));
  return sentences.map((sentence): LibrarySentenceResult => {
    const base = {
      n: sentence.number,
      part: sentence.part,
      field: sentence.field,
      text: sentence.text,
      ...(sentence.label === true ? { label: true as const } : {}),
    };
    const verdict = verdictOf.get(sentence.number);
    if (verdict === undefined || verdict.verdict === 'unsupported') {
      if (verdict?.code !== undefined) return { ...base, outcome: 'unclear', code: verdict.code };
      // A sentence with no verdict cannot happen after the shape of the reply is checked; it is never counted as supported.
      return verdict === undefined
        ? { ...base, outcome: 'unclear' }
        : { ...base, outcome: 'unsupported', kind: verdict.kind, problem: verdict.problem };
    }
    return { ...base, outcome: verdict.verdict === 'supported' ? 'supported' : 'no_claim' };
  });
}

/** How many sentences of a Scroll came to each outcome. */
export interface LibraryCounts {
  readonly sentences: number;
  readonly supported: number;
  readonly unsupported: number;
  readonly unclear: number;
  readonly noClaim: number;
}

export function countsOf(results: readonly { readonly outcome: LibrarySentenceOutcome }[]): LibraryCounts {
  const count = (outcome: LibrarySentenceOutcome) => results.filter((result) => result.outcome === outcome).length;
  return {
    sentences: results.length,
    supported: count('supported'),
    unsupported: count('unsupported'),
    unclear: count('unclear'),
    noClaim: count('no_claim'),
  };
}

/**
 * What code lets a check say about a revision. The first policy is the strictest one that is still a rule: no sentence the
 * checker found unsupported and none left unclear. A looser policy is a new version, measured against the operator's decisions
 * before it is chosen (`agreementOf` reports the same stored results under looser ones). `null` means no limit.
 */
export interface SupportPolicy {
  readonly id: string;
  readonly maxUnsupported: number | null;
  readonly maxUnclear: number | null;
}

export const LIBRARY_SUPPORT_POLICY: SupportPolicy = {
  id: 'library-support-policy.v1',
  maxUnsupported: 0,
  maxUnclear: 0,
};

/** What a check that gave results says about the revision: `passed` clears the policy, `flagged` does not. A check with no results is `unchecked` (below). */
export type RevisionVerdict = 'passed' | 'flagged';

/** What the check says about a revision, including a check that gave nothing. */
export type CheckVerdict = RevisionVerdict | 'unchecked';

const within = (count: number, limit: number | null): boolean => limit === null || count <= limit;

/** The revision's verdict from its sentences' outcomes. Code decides; the checker's words never do. */
export function decideRevision(counts: LibraryCounts, policy: SupportPolicy = LIBRARY_SUPPORT_POLICY): RevisionVerdict {
  return within(counts.unsupported, policy.maxUnsupported) && within(counts.unclear, policy.maxUnclear)
    ? 'passed'
    : 'flagged';
}

/** What an operator decided about a revision at the review gate. */
export type HumanDecision = 'released' | 'rejected';

/** One revision the operator decided, with what the check said about it: `counts` is `null` when it was not checked (`code` says why). */
export interface DecidedCheck {
  readonly decision: HumanDecision;
  /** The system of the revision's recipe (`earth`, `space`, …), or `other` for an asset the plan does not name. */
  readonly family: string;
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

export interface AgreementReport extends Confusion {
  readonly policy: string;
  readonly decided: number;
  readonly checked: number;
  readonly notChecked: { readonly total: number; readonly byCode: Readonly<Record<string, number>> };
  /** The share of rejected revisions the check flags, or `null` with none. */
  readonly rejectedCaught: number | null;
  /** The share of released revisions the check passes, or `null` with none. */
  readonly releasedPassedShare: number | null;
  /** The share of checked revisions on which check and operator agree (released and passed, rejected and flagged). */
  readonly agreement: number | null;
}

/** The same stored results under a looser policy: counts only, so the table of choices costs nothing to read. */
export interface PolicyChoice extends Confusion {
  readonly maxUnsupported: number | null;
  readonly maxUnclear: number | null;
}

export interface AgreementSummary extends AgreementReport {
  readonly byFamily: Readonly<Record<string, Confusion & { readonly checked: number }>>;
  readonly choices: readonly PolicyChoice[];
}

/** The limits tried by the table of choices. Looser than the policy only: the strictest is the policy itself. */
const CHOICE_UNSUPPORTED: readonly (number | null)[] = [0, 1, 2];
const CHOICE_UNCLEAR: readonly (number | null)[] = [0, 2, null];

const share = (part: number, whole: number): number | null =>
  whole === 0 ? null : Math.round((part / whole) * 1000) / 1000;

function confusionOf(rows: readonly DecidedCheck[], policy: SupportPolicy): Confusion & { readonly checked: number } {
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

/**
 * How the check agrees with the operator's own decisions (D-415): for the revisions the operator released or rejected, what the
 * check said under `policy`. The dangerous number is `rejectedPassed`, the revisions the operator rejected and the check would have
 * passed; `releasedFlagged` is the cost of the other mistake, a Scroll the operator served and the check would have held back. A
 * revision that was not checked is counted apart with its reason and is in neither: nothing is known about it. Results of one
 * checker version only (the caller reads them so); the table of choices reads the same results under looser limits.
 */
export function agreementOf(
  rows: readonly DecidedCheck[],
  policy: SupportPolicy = LIBRARY_SUPPORT_POLICY,
): AgreementSummary {
  const total = confusionOf(rows, policy);
  const byCode: Record<string, number> = {};
  for (const row of rows)
    if (row.counts === null) {
      const code = row.code ?? 'unknown';
      byCode[code] = (byCode[code] ?? 0) + 1;
    }
  const families = [...new Set(rows.map((row) => row.family))].sort();
  const byFamily = Object.fromEntries(
    families.map((family) => [
      family,
      confusionOf(
        rows.filter((row) => row.family === family),
        policy,
      ),
    ]),
  );
  const choices = CHOICE_UNSUPPORTED.flatMap((maxUnsupported) =>
    CHOICE_UNCLEAR.map((maxUnclear): PolicyChoice => {
      const { checked: _checked, ...confusion } = confusionOf(rows, { id: policy.id, maxUnsupported, maxUnclear });
      return { maxUnsupported, maxUnclear, ...confusion };
    }),
  );
  const { checked, ...confusion } = total;
  return {
    policy: policy.id,
    decided: rows.length,
    checked,
    notChecked: { total: rows.length - checked, byCode },
    ...confusion,
    rejectedCaught: share(confusion.rejectedFlagged, confusion.rejectedFlagged + confusion.rejectedPassed),
    releasedPassedShare: share(confusion.releasedPassed, confusion.releasedPassed + confusion.releasedFlagged),
    agreement: share(confusion.releasedPassed + confusion.rejectedFlagged, checked),
    byFamily,
    choices,
  };
}
