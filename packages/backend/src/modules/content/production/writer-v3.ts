import type { Claim, ProductionRecord, Source } from '@knowscroll/scroll-model/internal';
import {
  compileWrittenProseV3,
  compileWrittenV3,
  mergeStagingV3,
  numberedProseText,
  REPAIR_HINTS_V3,
  stagingPathsV3,
  WrittenProseV3,
  WrittenScrollV3,
  WrittenStagingV3,
  writtenReferenceV3,
  type WrittenCodeFacts,
  type WrittenCompileInput,
  type WrittenCompileOutcome,
} from '@knowscroll/scroll-model/producer';
import type { ResearchPage } from '../../../infrastructure/research/public-pages.js';
import type { ReasoningRole } from '../../../reasoning/public.js';
import type { AdmissionIssue } from '../application/ports.js';
import { CITATIONS_TOO_MANY, CITATIONS_TOO_MANY_HINT_V3, citationLimitIssuesV3 } from './citation-limits.js';
import { copyRepairNotes } from './copy-repair.js';
import { authoringEvidence, evidenceText, type EvidencePassage } from './evidence.js';
import { bannedNames, readerStrings, type BannedName } from './writer.js';
import { writerInstructionsV3, type WriterV3Plan, type WriterV3Step } from './writer-v3-instructions.js';

/** The versions of the three roles of the document v3 writer: one reply (arm a), prose (arm b step 1), staging (arm b step 2). */
export const WRITER_V3A_VERSION = 'scroll-writer-v3a.v1';
export const WRITER_V3B_VERSION = 'scroll-writer-v3b.v1';
export const STAGER_V3_VERSION = 'scroll-stager-v3.v1';

/** The kicker every v3 spike Scroll carries; a person sets the real one when a recipe is planned as v3. */
const SPIKE_KICKER = 'A closer look';

/** Everything a v3 compile needs about one job: who the Scroll is, what the plan decided, and what it rests on. */
export interface WriterV3Context {
  /** The facts that are code's, never the model's: the publication, kicker, theme, framing, shape and misconception. */
  readonly code: WrittenCodeFacts;
  readonly plan: WriterV3Plan;
  readonly passages: readonly EvidencePassage[];
  readonly pages: readonly ResearchPage[];
}

/** The context of a library recipe's v3 job: factual, themed `worlds`, with the recipe's own asset and explanation. */
export function writerContextV3(
  recipe: { readonly assetId: string; readonly explanationUnitId: string },
  plan: WriterV3Plan,
  passages: readonly EvidencePassage[],
  pages: readonly ResearchPage[],
): WriterV3Context {
  return {
    code: {
      publication: {
        assetId: recipe.assetId,
        revision: 1,
        language: 'en',
        explanationUnitId: recipe.explanationUnitId,
      },
      kicker: SPIKE_KICKER,
      theme: { family: 'worlds' },
      shape: plan.shape,
      framing: { kind: 'factual' },
      misconception: plan.misconception,
    },
    plan,
    passages,
    pages,
  };
}

/** What a compile run only to judge an answer records as its production: the harness does not know the attempt yet. */
const VALIDATION_PRODUCTION: ProductionRecord = { kind: 'fixture', label: 'validated in the harness' };

/** What compiling a reply for one job gives: the document with its citations and provenance, or the findings. */
export type GeneratedScrollV3 =
  | Extract<WrittenCompileOutcome, { kind: 'compiled' }>
  | { readonly kind: 'refused'; readonly issues: readonly AdmissionIssue[] };

/** The research text the copy check compares against: the offered passages and the pages they came from. */
function sourcesOf(context: WriterV3Context): string[] {
  return [
    ...context.passages.map((passage) => passage.text),
    ...context.pages.map((page) => page.passages.map((passage) => passage.text).join('\n')),
  ];
}

/** The claims every offered passage stands for and the sources they come from; the compile keeps what a Scroll cites. */
function evidenceRecord(context: WriterV3Context): { readonly claims: Claim[]; readonly sourceRecords: Source[] } {
  const claims = context.passages.map((passage): Claim => ({
    claimId: passage.claimId,
    statement: passage.text,
    quote: passage.text,
    sourceId: passage.pageId,
    truthState: 'documented',
  }));
  const sourceRecords = context.pages.map((page): Source => ({
    sourceId: page.id,
    title: page.title,
    url: page.url,
    snapshotSha256: page.sha256,
    retrievedAt: page.retrievedAt,
  }));
  return { claims, sourceRecords };
}

/** What both compiles share. */
function compileBase(
  context: WriterV3Context,
  production: ProductionRecord,
): Omit<WrittenCompileInput, 'reply' | 'plannedKinds'> {
  return {
    code: context.code,
    evidence: authoringEvidence(context.passages),
    sources: sourcesOf(context),
    ...evidenceRecord(context),
    production,
  };
}

const namesOf = (context: WriterV3Context): readonly BannedName[] => bannedNames({ sources: context.pages });

/** Names a reader must not see, found in any of the given parts of a reply, each part at its own path. */
function nameIssues(parts: readonly (readonly [string, unknown])[], names: readonly BannedName[]): AdmissionIssue[] {
  return parts.flatMap(([path, part]) => {
    const texts = [...readerStrings(part)];
    return names
      .filter((name) => texts.some((text) => name.pattern.test(text)))
      .map((name) => ({ code: name.code, path }));
  });
}

/** The parts of an essay (header, items, takeaway, suggestions), each at the path the model wrote it at. */
function essayParts(essay: WrittenProseV3 | WrittenScrollV3): (readonly [string, unknown])[] {
  return [
    ['title', essay.title],
    ['dek', essay.dek],
    ...essay.items.map((item, index): readonly [string, unknown] => [`items.${String(index)}`, item]),
    ['takeaway', essay.takeaway],
    ...essay.askSuggestions.map((text, index): readonly [string, unknown] => [`askSuggestions.${String(index)}`, text]),
  ];
}

const pictureParts = (pictures: WrittenScrollV3['pictures']): (readonly [string, unknown])[] =>
  pictures.map((picture, index) => [`pictures.${String(index)}`, picture]);

const stageParts = (staging: WrittenStagingV3): (readonly [string, unknown])[] => [
  ...pictureParts(staging.pictures),
  ...staging.stage.map((entry, index): readonly [string, unknown] => [`stage.${String(index)}`, entry]),
];

const withoutRepeats = (issues: readonly AdmissionIssue[]): AdmissionIssue[] => {
  const seen = new Set<string>();
  return issues.filter((issue) => {
    const key = `${issue.code}@${issue.path}`;
    return !seen.has(key) && seen.add(key);
  });
};

/**
 * Compiles the model's whole-Scroll reply for one job: the producer's checks (structure, evidence in its strict mode,
 * copying, the writer rules, the document's own admission) plus the writer's (no source or publisher names, and the
 * citation bound of `scroll-provenance.v3`). `production` is who made it. Pure and deterministic; findings are at the
 * model's own items and carry no text.
 */
export function compileGeneratedScrollV3(
  reply: WrittenScrollV3,
  context: WriterV3Context,
  production: ProductionRecord,
): GeneratedScrollV3 {
  const compiled = compileWrittenV3({
    ...compileBase(context, production),
    reply,
    plannedKinds: context.plan.pictures?.map((picture) => picture.kind),
  });
  const own = nameIssues([...essayParts(reply), ...pictureParts(reply.pictures)], namesOf(context));
  if (compiled.kind === 'refused') return { kind: 'refused', issues: withoutRepeats([...compiled.issues, ...own]) };
  // A Scroll whose citations the provenance cannot record is refused here, where the one repair can fix it.
  const tooMany = citationLimitIssuesV3(compiled.citations, context.passages);
  if (own.length > 0 || tooMany.length > 0) return { kind: 'refused', issues: [...own, ...tooMany] };
  return compiled;
}

/** The citation bound over a prose reply, which the prose compile does not return citations for. */
function proseCitationIssues(prose: WrittenProseV3, context: WriterV3Context): AdmissionIssue[] {
  const claimIdOf = new Map(context.passages.map((passage) => [passage.handle, passage.claimId]));
  const claimsOf = (handles: readonly string[]): string[] => handles.flatMap((handle) => claimIdOf.get(handle) ?? []);
  const citations: Record<string, string[]> = { takeaway: claimsOf(prose.takeaway.cites) };
  prose.items.forEach((item, index) => {
    if (item.type !== 'section') citations[`items.${String(index)}`] = claimsOf(item.cites);
  });
  return citationLimitIssuesV3(citations, context.passages);
}

/** Every finding on a prose reply (arm b, first step): the prose checks, the names and the citation bound. */
function proseIssues(prose: WrittenProseV3, context: WriterV3Context): AdmissionIssue[] {
  const compiled = compileWrittenProseV3(prose, compileBase(context, VALIDATION_PRODUCTION));
  return withoutRepeats([
    ...(compiled.kind === 'refused' ? compiled.issues : []),
    ...nameIssues(essayParts(prose), namesOf(context)),
    ...proseCitationIssues(prose, context),
  ]);
}

/** Every finding on a staging reply over fixed prose (arm b, second step), at the staging reply's own paths. */
function stagingIssues(staging: WrittenStagingV3, prose: WrittenProseV3, context: WriterV3Context): AdmissionIssue[] {
  const merged = mergeStagingV3(prose, staging);
  const compiled = compileWrittenV3({
    ...compileBase(context, VALIDATION_PRODUCTION),
    reply: merged.reply,
    plannedKinds: context.plan.pictures?.map((picture) => picture.kind),
  });
  return withoutRepeats([
    ...merged.issues,
    ...(compiled.kind === 'refused' ? stagingPathsV3(compiled.issues, merged.stageOfItem) : []),
    ...nameIssues(stageParts(staging), namesOf(context)),
    // The prose is fixed, so what the staging can still change is the pictures' own citations.
    ...(compiled.kind === 'compiled' ? citationLimitIssuesV3(compiled.citations, context.passages, 'pictures') : []),
  ]);
}

/**
 * The staged Scroll of arm b: the fixed prose with the staging put on it, compiled for one job. This is what the
 * stager's accepted reply stands for.
 */
export function compileStagedScrollV3(
  prose: WrittenProseV3,
  staging: WrittenStagingV3,
  context: WriterV3Context,
  production: ProductionRecord,
): GeneratedScrollV3 {
  const merged = mergeStagingV3(prose, staging);
  if (merged.issues.length > 0) return { kind: 'refused', issues: merged.issues };
  return compileGeneratedScrollV3(merged.reply, context, production);
}

/** The value at a dotted path of a refused answer (`items.4`, `pictures.0`, `title`), or undefined. */
function valueAt(root: unknown, path: string): unknown {
  let value = root;
  for (const part of path.split('.')) {
    if (typeof value !== 'object' || value === null) return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

/**
 * What the repair is told about a copy finding: the copied words themselves (`copyRepairNotes`), cut from the research
 * text and never from the model's own words. Rebuilt from the refused answer with the same checks that refused it.
 */
function copyNotes<T>(
  previousAnswer: string,
  context: WriterV3Context,
  read: (json: unknown) => T | undefined,
  issuesOf: (answer: T) => readonly AdmissionIssue[],
): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(previousAnswer);
  } catch {
    return undefined;
  }
  const answer = read(parsed);
  if (answer === undefined) return undefined;
  const places = issuesOf(answer)
    .filter((issue) => issue.code === 'copied_passage')
    .map((issue) => ({
      where: issue.path.replace(/\.(\d+)/gu, '[$1]'),
      texts: [...readerStrings(valueAt(answer, issue.path))],
    }));
  return copyRepairNotes(places, sourcesOf(context));
}

/** The fixed hints of a v3 role: the writer's catalogue, the citation bound and one per name a reader must not see. */
function safeIssuesOf(context: WriterV3Context): Readonly<Record<string, string>> {
  return Object.freeze({
    ...REPAIR_HINTS_V3,
    [CITATIONS_TOO_MANY]: CITATIONS_TOO_MANY_HINT_V3,
    ...Object.fromEntries(namesOf(context).map((name) => [name.code, name.hint])),
  });
}

/** A finding as the schema reports it, so the harness hands the repair a fixed, path-located line. */
function refusal(issue: AdmissionIssue, safe: Readonly<Record<string, string>>) {
  return {
    code: 'custom' as const,
    path: issue.path === '$' ? [] : issue.path.split('.').map((part) => (/^\d+$/u.test(part) ? Number(part) : part)),
    message: 'Writer validation refused.',
    ...(Object.hasOwn(safe, issue.code) ? { params: { safeCode: issue.code } } : {}),
  };
}

/** What the three roles share: the ceiling, the effort, one repair that carries the refused answer, and the fixed hints. */
function sharedRole(context: WriterV3Context) {
  return {
    safeCustomIssues: safeIssuesOf(context),
    // Thinking tokens count against this ceiling, besides about 5,000 tokens of JSON.
    maxOutputTokens: 16_000,
    effort: 'medium' as const,
    repairWithPreviousAnswer: true,
  };
}

const instructionsOf = (context: WriterV3Context, step: WriterV3Step): string =>
  writerInstructionsV3(step, context.plan, writtenReferenceV3(step));

/**
 * Arm (a): one call that reads the passages and the brief and returns the whole Scroll, pictures included. The schema
 * is the reply's shape plus the whole compile, so a refusal reaches the harness as fixed, path-located findings for
 * its single repair. The role id is the writer's: it is the same role (and the same budget) at a new version.
 */
export function writerRoleV3One(context: WriterV3Context): ReasoningRole<WrittenScrollV3> {
  const shared = sharedRole(context);
  const issuesOf = (reply: WrittenScrollV3): readonly AdmissionIssue[] => {
    const outcome = compileGeneratedScrollV3(reply, context, VALIDATION_PRODUCTION);
    return outcome.kind === 'refused' ? outcome.issues : [];
  };
  return {
    ...shared,
    id: 'content.scroll-writer',
    version: WRITER_V3A_VERSION,
    repairNotes: (previousAnswer) =>
      copyNotes(
        previousAnswer,
        context,
        (json) => {
          const reply = WrittenScrollV3.safeParse(json);
          return reply.success ? reply.data : undefined;
        },
        issuesOf,
      ),
    instructions: instructionsOf(context, 'one'),
    outputSchema: WrittenScrollV3.superRefine((reply, ctx) => {
      for (const issue of issuesOf(reply)) ctx.addIssue(refusal(issue, shared.safeCustomIssues));
    }),
  };
}

/**
 * Arm (b), first step: the essay without its pictures. The schema runs every check of the compile that is about the
 * prose (and none about pictures), so the prose it accepts is the prose the second step stages.
 */
export function writerRoleV3Prose(context: WriterV3Context): ReasoningRole<WrittenProseV3> {
  const shared = sharedRole(context);
  return {
    ...shared,
    id: 'content.scroll-writer',
    version: WRITER_V3B_VERSION,
    repairNotes: (previousAnswer) =>
      copyNotes(
        previousAnswer,
        context,
        (json) => {
          const prose = WrittenProseV3.safeParse(json);
          return prose.success ? prose.data : undefined;
        },
        (prose) => proseIssues(prose, context),
      ),
    instructions: instructionsOf(context, 'prose'),
    outputSchema: WrittenProseV3.superRefine((prose, ctx) => {
      for (const issue of proseIssues(prose, context)) ctx.addIssue(refusal(issue, shared.safeCustomIssues));
    }),
  };
}

/**
 * Arm (b), second step: the pictures, and what each paragraph shows, for prose that is already accepted and fixed. The
 * schema merges the staging onto that prose and runs the whole compile; each finding is reported where the staging model
 * wrote the cause (`stage.K`, `pictures.N`). There is no copy note: the prose cannot copy, and a copied picture string
 * is named by its path.
 */
export function stagerRoleV3(context: WriterV3Context, prose: WrittenProseV3): ReasoningRole<WrittenStagingV3> {
  const shared = sharedRole(context);
  return {
    ...shared,
    id: 'content.scroll-stager',
    version: STAGER_V3_VERSION,
    instructions: instructionsOf(context, 'staging'),
    outputSchema: WrittenStagingV3.superRefine((staging, ctx) => {
      for (const issue of stagingIssues(staging, prose, context)) ctx.addIssue(refusal(issue, shared.safeCustomIssues));
    }),
  };
}

/** What a request of the staging step shows the model besides its instructions: the plan in plain lines. */
function planText(plan: WriterV3Plan): string {
  const pictures =
    plan.pictures === undefined || plan.pictures.length === 0
      ? ['Pictures: choose one to three kinds by what the passages hold.']
      : [
          'Pictures, in this order:',
          ...plan.pictures.map((picture, index) => `${String(index + 1)}. a ${picture.kind}: ${picture.purpose}`),
        ];
  return [
    `Shape: ${plan.shape}`,
    'Sections, each with its intent:',
    ...plan.sections.map((intent, index) => `${String(index + 1)}. ${intent}`),
    ...pictures,
  ].join('\n');
}

/** The items of a staging request's context, in the order the staging model reads them. */
export function stagerContextItems(
  context: WriterV3Context,
  prose: WrittenProseV3,
  label: string,
): readonly { readonly ref: string; readonly kind: string; readonly text: string }[] {
  return [
    { ref: `prose:${label}`, kind: 'written_prose', text: numberedProseText(prose) },
    { ref: `evidence:${label}`, kind: 'public_research_passages', text: evidenceText(context.passages) },
    { ref: `plan:${label}`, kind: 'scroll_plan', text: planText(context.plan) },
  ];
}
