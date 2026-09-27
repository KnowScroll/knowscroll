/**
 * #131 — revisable personal hypotheses (`hypothesis-rules-v1`, ADR-0032 §2). Pure.
 *
 * A hypothesis is a typed, evidence-linked, decaying proposal with at least one competing
 * alternative and explicit permitted uses. It stages encounters; it never declares who someone is.
 * Rules propose from attention accounts; a model may later propose through `validateHypothesis`
 * (#132). A reader's correction is counterevidence: it contests the hypothesis and suspends its uses.
 */
import type { AttentionAccount } from './attention.ts';

export const HYPOTHESIS_RULES_V1 = 'hypothesis-rules-v1';

export type HypothesisKind = 'direction' | 'open_question';
export type PermittedUse = 'composer.family_prior' | 'composer.continuity' | 'steward.context' | 'chronicle.wording';
export type EvidenceRef = { kind: 'exposure' | 'mark' | 'ask' | 'feedback'; ref: string };
export type HypothesisStatus = 'active' | 'contested' | 'decayed';

export interface HypothesisProposal {
  kind: HypothesisKind;
  concept: string;
  statement: string;
  confidenceLabel: 'low' | 'medium';
  status: HypothesisStatus;
  evidence: EvidenceRef[];
  alternatives: { statement: string; evidence: EvidenceRef[] }[];
  counterevidence: EvidenceRef[];
  permittedUses: PermittedUse[];
  decay: { halfLifeDays: number | null };
  ruleVersion: string;
}

export interface HypothesisRulePolicy { directionWindowDays: number; directionMinMarks: number; contestWindowDays: number; directionHalfLifeDays: number }
export const HYPOTHESIS_RULES: HypothesisRulePolicy = { directionWindowDays: 7, directionMinMarks: 2, contestWindowDays: 14, directionHalfLifeDays: 7 };

export interface RuleInputs {
  nowMs: number;
  accounts: ReadonlyMap<string, AttentionAccount>;
  conceptNames: ReadonlyMap<string, string>;
  /** Voluntary marks with their concept credit, for windowed counts and per-asset concentration. */
  marks: readonly { eventId: string; atMs: number; assetId: string; exposureId: string; concepts: readonly string[] }[];
  /** System-offered episode ids per concept, the evidence for the "the feed offered it" alternative. */
  offeredEpisodes: ReadonlyMap<string, readonly string[]>;
  asks: readonly { askEventId: string; exposureId: string; atMs: number; concept: string | null; resolved: boolean }[];
  feedback: readonly { ref: string; atMs: number; concepts: readonly string[] }[];
}

const DAY = 86_400_000;

export function proposeHypotheses(input: RuleInputs, policy: HypothesisRulePolicy = HYPOTHESIS_RULES): HypothesisProposal[] {
  const out: HypothesisProposal[] = [];
  const name = (code: string) => input.conceptNames.get(code) ?? code;

  for (const [code, account] of [...input.accounts].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const recent = input.marks.filter(m => m.concepts.includes(code) && input.nowMs - m.atMs <= policy.directionWindowDays * DAY);
    const everMarked = input.marks.filter(m => m.concepts.includes(code));
    if (everMarked.length === 0) continue;
    const counter = input.feedback.filter(f => f.concepts.includes(code) && input.nowMs - f.atMs <= policy.contestWindowDays * DAY);
    const counterevidence: EvidenceRef[] = counter.map(f => ({ kind: 'feedback', ref: f.ref }));
    const active = recent.length >= policy.directionMinMarks;
    const status: HypothesisStatus = !active ? 'decayed' : counter.length > 0 ? 'contested' : 'active';
    // Only concepts that once met the rule are carried as decayed; others never become hypotheses.
    if (!active && everMarked.length < policy.directionMinMarks) continue;

    const alternatives: HypothesisProposal['alternatives'] = [];
    const offered = input.offeredEpisodes.get(code) ?? [];
    if (account.exposureShare >= 0.5 && offered.length > 0) {
      alternatives.push({ statement: `The feed offered ${name(code)} often; these acts may follow what was shown.`, evidence: offered.map(ref => ({ kind: 'exposure', ref })) });
    }
    const assets = new Set(everMarked.map(m => m.assetId));
    if (assets.size === 1) {
      alternatives.push({ statement: `The acts all concern one encounter and may not reach beyond it.`, evidence: everMarked.map(m => ({ kind: 'exposure', ref: m.exposureId })) });
    }
    if (account.returns === 0) {
      alternatives.push({ statement: `This may be passing curiosity: nothing yet shows a return on another day.`, evidence: everMarked.map(m => ({ kind: 'mark', ref: m.eventId })) });
    }
    if (alternatives.length === 0) {
      alternatives.push({ statement: `Another idea may explain these returns; the evidence only shows where they happened.`, evidence: everMarked.map(m => ({ kind: 'mark', ref: m.eventId })) });
    }
    const medium = account.daysActive >= 2 && account.sourceFamilies >= 2;
    out.push({
      kind: 'direction', concept: code,
      statement: `Recent voluntary acts gather around ${name(code)}.`,
      confidenceLabel: medium ? 'medium' : 'low', status,
      evidence: (active ? recent : everMarked).map(m => ({ kind: 'mark' as const, ref: m.eventId })),
      alternatives, counterevidence,
      // A contested or decayed hypothesis keeps its record but loses every permitted use.
      permittedUses: status === 'active' ? ['composer.family_prior'] : [],
      decay: { halfLifeDays: policy.directionHalfLifeDays }, ruleVersion: HYPOTHESIS_RULES_V1,
    });
  }

  const byConcept = new Map<string, RuleInputs['asks'][number][]>();
  for (const ask of input.asks) if (ask.concept) byConcept.set(ask.concept, [...(byConcept.get(ask.concept) ?? []), ask]);
  for (const [code, asks] of [...byConcept].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const open = asks.filter(a => !a.resolved);
    const counter = input.feedback.filter(f => f.concepts.includes(code) && input.nowMs - f.atMs <= policy.contestWindowDays * DAY);
    const status: HypothesisStatus = open.length === 0 ? 'decayed' : counter.length > 0 ? 'contested' : 'active';
    out.push({
      kind: 'open_question', concept: code,
      statement: `A question is open near ${name(code)}.`,
      confidenceLabel: 'medium', status,
      evidence: asks.map(a => ({ kind: 'ask' as const, ref: a.askEventId })),
      alternatives: [{ statement: `The Scroll it was asked on may already answer it.`, evidence: asks.map(a => ({ kind: 'exposure' as const, ref: a.exposureId })) }],
      counterevidence: counter.map(f => ({ kind: 'feedback' as const, ref: f.ref })),
      permittedUses: status === 'active' ? ['composer.continuity'] : [],
      decay: { halfLifeDays: null }, ruleVersion: HYPOTHESIS_RULES_V1,
    });
  }
  return out;
}

export type HypothesisRejection =
  | 'kind_prohibited' | 'statement_characterizes_person' | 'evidence_missing' | 'evidence_unresolved'
  | 'alternative_missing' | 'use_not_permitted' | 'concept_unknown';

/** Words that turn an observation into a claim about the person. Deterministic and conservative:
 * a statement must describe acts and evidence, never belief, mastery, identity or character. */
const CHARACTERIZING = /\b(you are|you're|they are|you (?:like|love|hate|believe|prefer|understand|know|want|need|feel)|mastered|mastery|expert|personality|diagnos|depress|anxious|addict|insecure|autis|trauma|conservative|liberal|religious|ambitious)\b/i;

export function validateHypothesis(
  p: HypothesisProposal,
  context: { proposer: 'rule' | 'model'; knownEvidence: ReadonlySet<string>; knownConcepts: ReadonlySet<string> },
): { ok: true } | { ok: false; reasons: HypothesisRejection[] } {
  const reasons: HypothesisRejection[] = [];
  if (!['direction', 'open_question'].includes(p.kind)) reasons.push('kind_prohibited');
  if (CHARACTERIZING.test(p.statement) || p.alternatives.some(a => CHARACTERIZING.test(a.statement))) reasons.push('statement_characterizes_person');
  if (!context.knownConcepts.has(p.concept)) reasons.push('concept_unknown');
  if (p.evidence.length === 0) reasons.push('evidence_missing');
  const refs = [...p.evidence, ...p.counterevidence, ...p.alternatives.flatMap(a => a.evidence)];
  if (refs.some(r => !context.knownEvidence.has(`${r.kind}:${r.ref}`))) reasons.push('evidence_unresolved');
  if (p.alternatives.length === 0 || p.alternatives.some(a => a.evidence.length === 0)) reasons.push('alternative_missing');
  const allowed: PermittedUse[] = context.proposer === 'rule'
    ? (p.kind === 'direction' ? ['composer.family_prior'] : ['composer.continuity'])
    : ['steward.context', 'chronicle.wording'];
  if (p.permittedUses.some(u => !allowed.includes(u))) reasons.push('use_not_permitted');
  return reasons.length ? { ok: false, reasons } : { ok: true };
}
