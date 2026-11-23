import type { ReviewListItem, ReviewRejectResult, ReviewReleaseResult, ReviewShow } from '@knowscroll/contracts';

/** How a line of findings reads: fine, worth knowing, or something to read before deciding. */
export type FindingTone = 'ok' | 'note' | 'attention';

export interface Finding {
  readonly id: 'answers' | 'support' | 'coverage' | 'topic';
  readonly tone: FindingTone;
  /** Plain words, one or two sentences. */
  readonly text: string;
}

const plural = (count: number, one: string, many = `${one}s`) => `${String(count)} ${count === 1 ? one : many}`;

function answerFinding(review: ReviewShow, isV3: boolean): Finding {
  const check = review.answerCheck;
  if (check === null)
    return isV3
      ? { id: 'answers', tone: 'note', text: 'Answer check: none. A document v3 Scroll has no calls to check.' }
      : { id: 'answers', tone: 'attention', text: 'Answer check: not run for this revision. Read every call.' };
  const flagged = check.flags
    .map((flag) => `${flag.id}${flag.problem === null ? '' : ` (${flag.problem})`}`)
    .join('; ');
  switch (check.outcome) {
    case 'passed':
      return {
        id: 'answers',
        tone: 'ok',
        text: `Answer check: passed. All ${plural(check.calls ?? 0, 'call')} agree with their answer keys.`,
      };
    case 'repaired':
      return {
        id: 'answers',
        tone: 'note',
        text: `Answer check: repaired. The first draft had ${plural(check.flags.length, 'flagged call')}${flagged === '' ? '' : `: ${flagged}`}. The writer corrected them once and the final ${plural(check.calls ?? 0, 'call')} passed.`,
      };
    case 'flagged':
      return {
        id: 'answers',
        tone: 'attention',
        text: `Answer check: flagged. ${plural(check.flags.length, 'call')} flagged and not cleared${flagged === '' ? '' : `: ${flagged}`}.`,
      };
    case 'unchecked':
      return {
        id: 'answers',
        tone: 'attention',
        text: `Answer check: not checked${check.code === null ? '' : ` (${check.code})`}. The checker gave no usable answer, so read every call's answer key yourself.`,
      };
  }
}

function supportFinding(review: ReviewShow): Finding {
  const check = review.supportCheck;
  if (check === null)
    return {
      id: 'support',
      tone: 'attention',
      text: 'Support check: not run yet. Read every sentence against its sources.',
    };
  if (check.verdict === 'unchecked')
    return {
      id: 'support',
      tone: 'attention',
      text: `Support check: not checked${check.code === null ? '' : ` (${check.code})`}. No sentence has a verdict, so read every sentence against its sources.`,
    };
  const { counts } = check;
  const tally = `${plural(counts.sentences, 'sentence')}: ${String(counts.supported)} supported, ${String(counts.unsupported)} unsupported, ${String(counts.unclear)} unclear, ${String(counts.noClaim)} state no fact.`;
  return check.verdict === 'passed'
    ? { id: 'support', tone: 'ok', text: `Support check: passed. ${tally}` }
    : {
        id: 'support',
        tone: 'attention',
        text: `Support check: flagged. ${tally}${check.attention.length === 0 ? '' : ' Read the sentences listed below first.'}`,
      };
}

function coverageFinding(review: ReviewShow, isV3: boolean): Finding {
  if (review.coverage === 'mapped')
    return { id: 'coverage', tone: 'ok', text: 'Coverage: mapped, so reading it can form a place in a Universe.' };
  return isV3
    ? {
        id: 'coverage',
        tone: 'attention',
        text: 'Coverage: not mapped. A document v3 Scroll cannot be released until it is, and the gate will refuse. Map it first with the CLI’s content readmit-coverage.',
      }
    : {
        id: 'coverage',
        tone: 'note',
        text: 'Coverage: not mapped. It can be released, but it forms nothing in a Universe until it is mapped.',
      };
}

/**
 * What the checks and the revision's facts say, in plain words, in the order an operator reads them: the answer check, the
 * support check, coverage and topic. The checks are a model's opinion that informs the read and decides nothing. Pure.
 */
export function findingsOf(review: ReviewShow): readonly Finding[] {
  const isV3 = review.document.schemaVersion === 'scroll-document.v3';
  return [
    answerFinding(review, isV3),
    supportFinding(review),
    coverageFinding(review, isV3),
    review.topic === null
      ? { id: 'topic', tone: 'note', text: 'Topic: none attributed yet.' }
      : { id: 'topic', tone: 'ok', text: `Topic: ${review.topic}.` },
  ];
}

/** The one tone a row's chips are drawn in: the worst of its findings. */
export function worstTone(findings: readonly Finding[]): FindingTone {
  if (findings.some((finding) => finding.tone === 'attention')) return 'attention';
  return findings.some((finding) => finding.tone === 'note') ? 'note' : 'ok';
}

/** The words of a list row's answer check chip. */
export function answerChip(verdict: ReviewListItem['answerCheck']): {
  readonly text: string;
  readonly tone: FindingTone;
} {
  switch (verdict) {
    case null:
      return { text: 'Answers: none', tone: 'note' };
    case 'passed':
      return { text: 'Answers: passed', tone: 'ok' };
    case 'repaired':
      return { text: 'Answers: repaired', tone: 'note' };
    case 'flagged':
      return { text: 'Answers: flagged', tone: 'attention' };
    case 'unchecked':
      return { text: 'Answers: not checked', tone: 'attention' };
  }
}

/** The words of a list row's support check chip; `null` is a check that has not run yet. */
export function supportChip(verdict: ReviewListItem['supportCheck']): {
  readonly text: string;
  readonly tone: FindingTone;
} {
  switch (verdict) {
    case null:
      return { text: 'Support: not run', tone: 'attention' };
    case 'passed':
      return { text: 'Support: passed', tone: 'ok' };
    case 'flagged':
      return { text: 'Support: flagged', tone: 'attention' };
    case 'unchecked':
      return { text: 'Support: not checked', tone: 'attention' };
  }
}

/** When it was held, to the minute and in UTC, so the same row reads the same wherever it is opened. */
export function heldSince(iso: string): string {
  return `held ${iso.slice(0, 16).replace('T', ' ')} UTC`;
}

/** Why the gate refused a release or a reject, in words an operator can act on. */
export function refusalWords(reason: ReviewReleaseResult['reason'] | ReviewRejectResult['reason']): string {
  switch (reason) {
    case 'coverage_missing':
      return 'It was not released: its coverage is not mapped. Run content readmit-coverage with the CLI, then release it.';
    case 'not_newer_than_served':
      return 'It was not released: readers already have this revision or a newer one.';
    case 'asset_withdrawn':
      return 'It was not released: the Scroll was withdrawn.';
    case 'revision_rejected':
      return 'It was not released: this revision was rejected meanwhile.';
    case 'revision_released':
      return 'It was not rejected: this revision was released meanwhile.';
    case null:
      return 'The gate refused the decision.';
  }
}

/** The chips a folded findings panel shows: the three checks of a held revision in a few words each. */
export function findingChips(review: ReviewShow): readonly { readonly text: string; readonly tone: FindingTone }[] {
  const findings = findingsOf(review);
  const toneOf = (id: Finding['id']) => findings.find((finding) => finding.id === id)?.tone ?? 'note';
  return [
    { ...answerChip(review.answerCheck?.outcome ?? null), tone: toneOf('answers') },
    { ...supportChip(review.supportCheck?.verdict ?? null), tone: toneOf('support') },
    {
      text: review.coverage === 'mapped' ? 'Coverage: mapped' : 'Coverage: not mapped',
      tone: toneOf('coverage'),
    },
  ];
}
