import { wordsKey, type Assumption } from './assumptions.js';
import type { Step } from './exploration.js';

/** How an ordered Scroll is framed for its reader: copied by code, never written by the model. */
export type BranchFraming =
  | { readonly kind: 'hypothetical'; readonly assumptions: string[]; readonly kept: string[] }
  | { readonly kind: 'perspective'; readonly lens: string };

/** What a Scroll of a branch is told about where it comes from. All of it is short, plain and checked. */
export interface BranchFacts {
  readonly step: Step;
  /** The direction's title and what exploring it shows. */
  readonly title: string;
  readonly explanation?: string | undefined;
  /** The thread root's title and summary: public metadata of the explanation being continued. */
  readonly subjectTitle: string;
  readonly subjectSummary: string;
  /** The branch this one continues, when it continues one. */
  readonly parentTitle?: string | undefined;
}

/**
 * The framing of a branch's Scroll. A branch with premises (a what-if, or anything below one) states
 * them as hypothetical assumptions and what it keeps; a perspective on the real subject names its lens.
 * `assumptions` is what holds after the step, so a deep branch states its whole premise.
 */
export function framingOf(step: Step): BranchFraming {
  if (step.hypothetical) {
    // What an earlier branch already assumes is listed once, among the assumptions, never again as "kept".
    const assumed = new Set(step.assumptions.map((assumption) => wordsKey(assumption.subject)));
    return {
      kind: 'hypothetical',
      assumptions: step.assumptions.map((assumption) => assumption.statement),
      kept: step.kept.filter((kept) => !assumed.has(wordsKey(kept.subject))).map((kept) => kept.statement),
    };
  }
  return { kind: 'perspective', lens: step.lens ?? '' };
}

/** The kicker over the title: the kind of branch in the reader's words. */
export const kickerOf = (step: Step): string => (step.kind === 'what_if' ? 'What if' : 'Another perspective');

const bullets = (items: readonly Assumption[]): string[] => items.map((item) => `- ${item.statement}`);

/**
 * The brief the writer receives, built by code from the checked parts of a branch. The member's own
 * words are not in it: the direction (title and explanation), the premises and the public subject are.
 * The writer's instructions say how to treat each section (D-049).
 */
export function writerBrief(facts: BranchFacts): string {
  const { step } = facts;
  const lines = [
    step.kind === 'what_if' ? 'KIND: What if' : 'KIND: Another perspective',
    `SUBJECT: ${facts.subjectTitle}. ${facts.subjectSummary}`,
    `DIRECTION: ${facts.title}${facts.explanation === undefined ? '' : `. ${facts.explanation}`}`,
  ];
  if (facts.parentTitle !== undefined) lines.push(`CONTINUES THE BRANCH: ${facts.parentTitle}`);
  if (step.kind === 'perspective' && step.lens !== undefined) lines.push(`LENS: ${step.lens}`);
  if (step.kind === 'what_if')
    lines.push('PREMISE (what this idea changes; it is not true of the real world):', ...bullets(step.changes));
  const inherited = step.assumptions.filter(
    (assumption) => !step.changes.some((change) => wordsKey(change.subject) === wordsKey(assumption.subject)),
  );
  if (inherited.length > 0)
    lines.push('PREMISES INHERITED FROM EARLIER BRANCHES (also hypothetical):', ...bullets(inherited));
  if (step.kept.length > 0) lines.push('KEPT THE SAME:', ...bullets(step.kept));
  return lines.join('\n');
}
